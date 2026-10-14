#!/usr/bin/env bash
# buzz-prod 릴레이에 허들 녹음을 켜거나 되돌린다. relay 컨테이너 하나만 다시 만든다.
#   preflight <후보 repo@sha256:…>   컨테이너는 안 건드리고 점검만 (이미지 받기·run_dir·JOURNAL 은 생김)
#   apply     <후보 repo@sha256:…>   점검 → 교체 → 확인. 확인 실패나 중간 종료면 자동으로 되돌림
#   rollback                        녹음을 끄고 이전 이미지로
# ssh 에 매달지 말고 VM 안에서 떼어서 돌린다. 도는 동안 unit 을 stop 하지 않는다
# (멈추고 싶으면 끝난 뒤 rollback 모드로):
#   sudo systemd-run --unit=buzz-huddle-apply --collect -p TimeoutStopSec=900 --setenv=HOME=/root \
#     bash <run_dir>/deploy-huddle-recording.sh apply <후보>
# 비밀 값은 찍지 않는다. 환경은 이름과 해시로만 비교한다.
set -Eeuo pipefail
export LC_ALL=C
trap '' HUP PIPE

mode=${1:?preflight|apply|rollback}
candidate_ref=${2:-}

run_dir=/srv/a2d2-huddle-recording/RUN_20261012
base=/opt/buzz/src/deploy/compose
cutover_env=/srv/a2d2-cutover-inputs/RUN_20260921T033433Z/relay.env
hotfix=/srv/a2d2-engine-session-hotfix-package/RUN_20260921T055000Z-88F9/relay.engine-session.override.yml
prior_id=sha256:4baba1f1945d38baa8bac693b8922d8417bc15ad18cd455e119967910f591f76
prior_tag=a2d2/buzz-relay:prior-20261012
container=buzz-prod-relay-1
postgres=buzz-prod-postgres-1
project=buzz-prod
override="$run_dir/relay.huddle-recording.override.yml"
recording_env="$run_dir/recording.env"
state="$run_dir/state"
journal="$run_dir/JOURNAL"
recording_keys="BUZZ_HUDDLE_RECORDING BUZZ_HUDDLE_RECORDING_ACCESS_KEY BUZZ_HUDDLE_RECORDING_BUCKET BUZZ_HUDDLE_RECORDING_ENDPOINT BUZZ_HUDDLE_RECORDING_PREFIX BUZZ_HUDDLE_RECORDING_REGION BUZZ_HUDDLE_RECORDING_SECRET_KEY"
build_identity_keys="BUZZ_BUILD_ID BUZZ_BUILD_URL BUZZ_SOURCE_SHA"
expected_env_files="$base/.env,$cutover_env"
expected_config_files="$base/compose.yml,$base/compose.engine-projection.yml,$hotfix"
min_free_gb=8

current=(docker compose --project-directory "$base" --env-file "$base/.env" --env-file "$cutover_env"
  -p "$project" -f "$base/compose.yml" -f "$base/compose.engine-projection.yml" -f "$hotfix")
candidate=("${current[@]}" -f "$override")
up_flags=(up -d --no-deps --force-recreate --pull never --no-build)

mkdir -p "$run_dir" "$state"
chmod 700 "$run_dir" "$state"

log() {
  local line
  line="$(date -u +%FT%TZ)|$mode|$*"
  printf '%s\n' "$line" >>"$journal" 2>/dev/null || true
  printf '%s\n' "$line" 2>/dev/null || true
}
die() { log "FAIL $*"; exit 1; }

# 두 개가 동시에 돌지 않게.
exec 9>"$run_dir/.lock"
flock -n 9 || die "다른 실행이 돌고 있음"

changed=0 # relay 를 건드리기 시작했으면 1
settled=0 # 성공 확인이나 되돌리기까지 끝났으면 1

on_exit() {
  local rc=$?
  set +e
  if [ "$changed" = 1 ] && [ "$settled" = 0 ]; then
    log "중간에 끝남(rc=$rc) → 되돌림"
    rollback auto || exit 70
  fi
}
trap on_exit EXIT

nip11_ok() {
  curl -fsS -m 5 -H 'Accept: application/nostr+json' http://127.0.0.1:3000/ >/dev/null 2>&1
}

live_has_recording() {
  docker inspect "$container" --format '{{json .Config.Env}}' |
    python3 -c 'import json,sys; sys.exit(0 if any(e.startswith("BUZZ_HUDDLE_RECORDING=") for e in json.load(sys.stdin)) else 1)'
}

# "개수:최대 version". 못 읽으면 몇 번 다시 해 보고 빈 값.
migrations() {
  local out
  for _ in 1 2 3 4 5; do
    out=$(docker exec "$postgres" psql -U buzz -d buzz -At \
      -c "select count(*)||':'||coalesce(max(version),0) from _sqlx_migrations" 2>/dev/null || true)
    if [ -n "$out" ]; then
      printf '%s' "$out"
      return 0
    fi
    sleep 2
  done
  return 1
}

# relay 를 뺀 같은 프로젝트 컨테이너: ID·이름·시작 시각·재시작 수.
other_services() {
  local id
  docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' |
    while read -r id; do
      docker inspect -f '{{.Id}} {{.Name}} {{.State.Status}} {{.State.StartedAt}} {{.RestartCount}}' "$id"
    done | awk -v c="/$container" '$2 != c' | sort
}

relay_state_ok() { # $1 = 기대 이미지 ID, $2 = yes|no (녹음 켜짐 여부)
  local st hs
  st=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)
  hs=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)
  [ "$st" = running ] && [ "$hs" = healthy ] || return 1
  [ "$(docker inspect -f '{{.Image}}' "$container")" = "$1" ] || return 1
  if [ "$2" = yes ]; then live_has_recording || return 1; else ! live_has_recording || return 1; fi
  nip11_ok || return 1
  # compose 가 다시 만들다 남긴 임시 컨테이너(<hash>_buzz-prod-relay-1)가 없어야 함
  [ "$(docker ps -a --format '{{.Names}}' | grep -c "_${container}\$" || true)" = 0 ]
}

# 기다리는 동안 30초마다 상태를 한 줄씩 찍는다. 죽거나 재시작하거나 unhealthy 면 바로 실패로 본다.
wait_healthy() {
  local limit=${1:-240} deadline next st hs rc
  deadline=$((SECONDS + limit))
  next=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    st=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)
    hs=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)
    rc=$(docker inspect -f '{{.RestartCount}}' "$container" 2>/dev/null || echo 0)
    if [ "$st" = running ] && [ "$hs" = healthy ]; then
      return 0
    fi
    if [ "${rc:-0}" -gt 0 ]; then
      log "컨테이너가 재시작함(재시작 $rc번) → 실패로 봄"
      return 1
    fi
    if [ "$hs" = unhealthy ]; then
      log "컨테이너가 unhealthy → 실패로 봄"
      return 1
    fi
    if [ "$st" != running ] && [ "$st" != created ]; then
      log "컨테이너 상태가 $st → 실패로 봄"
      return 1
    fi
    if [ "$SECONDS" -ge "$next" ]; then
      log "기다리는 중: 상태 $st, health ${hs:-없음}"
      next=$((SECONDS + 30))
    fi
    sleep 3
  done
  log "${limit}초 안에 healthy 가 안 됨"
  return 1
}

# 살아 있는 컨테이너 환경과 "이미지 ENV 위에 렌더된 환경을 덮은 것"이 양쪽으로 같은지 본다.
# 다르면 이름만 찍는다. 렌더된 값의 $$ 는 compose 가 두 배로 찍은 것이라 $ 로 돌린다.
env_matches_live() { # $1 = 이미지, $2 = A2D2_RELAY_IMAGE 값, 나머지 = compose 명령
  local img=$1 relay_image=$2
  shift 2
  python3 - 3< <(docker image inspect "$img" --format '{{json .Config.Env}}') \
    4< <(env A2D2_RELAY_IMAGE="$relay_image" "$@" config --format json 2>/dev/null) \
    5< <(docker inspect "$container" --format '{{json .Config.Env}}') <<'PY'
import json, os, sys

def as_dict(items):
    out = {}
    for e in items or []:
        k, sep, v = e.partition("=")
        out[k] = v if sep else None
    return out

img = as_dict(json.load(os.fdopen(3)))
rendered = json.load(os.fdopen(4))["services"]["relay"].get("environment") or {}
if isinstance(rendered, list):
    rendered = as_dict(rendered)
live = as_dict(json.load(os.fdopen(5)))

expected = dict(img)
nulls = []
for k, v in rendered.items():
    if v is None:
        nulls.append(k)
        continue
    expected[k] = v.replace("$$", "$")
for k in nulls:
    if k in live:
        expected[k] = live[k]
    else:
        expected.pop(k, None)

only_expected = sorted(set(expected) - set(live))
only_live = sorted(set(live) - set(expected))
differ = sorted(k for k in set(expected) & set(live) if expected[k] != live[k])
if only_expected or only_live or differ:
    print("환경 다름 - 기대에만:", only_expected, "| 살아 있는 쪽에만:", only_live, "| 값 다름:", differ, file=sys.stderr)
    sys.exit(1)
PY
}

# recording.env 는 KEY='값' 꼴만 받는다. 틀린 줄은 번호만 찍는다(값이 이름 자리에 찍히지 않게).
recording_env_shape_ok() {
  python3 - "$recording_keys" "$recording_env" <<'PY'
import re, sys
keys = set(sys.argv[1].split())
pat = re.compile(r"^([A-Z][A-Z0-9_]*)='([^']*)'$")
seen, bad = [], []
for n, line in enumerate(open(sys.argv[2], encoding="utf-8").read().split("\n"), 1):
    if line == "":
        continue
    m = pat.match(line)
    if not m:
        bad.append(n)
        continue
    seen.append(m.group(1))
if bad:
    print("recording.env 형식이 틀린 줄 번호:", bad, file=sys.stderr)
    sys.exit(1)
missing = sorted(keys - set(seen))
extra = sorted(k for k in set(seen) - keys)
if missing or extra or len(seen) != len(set(seen)):
    print("recording.env 이름 목록 다름 - 빠짐:", missing, "| 남음:", extra, "| 겹침:", len(seen) != len(set(seen)), file=sys.stderr)
    sys.exit(1)
PY
}

# 후보 렌더 결과가 "지금 렌더 + 녹음 7개"뿐인지, 녹음 값이 recording.env 그대로 살아남는지 본다.
candidate_env_ok() { # $1 = 지금 A2D2_RELAY_IMAGE 값, $2 = 후보 A2D2_RELAY_IMAGE 값
  python3 - "$recording_keys" "$recording_env" \
    3< <(env A2D2_RELAY_IMAGE="$1" "${current[@]}" config --format json 2>/dev/null) \
    4< <(env A2D2_RELAY_IMAGE="$2" "${candidate[@]}" config --format json 2>/dev/null) <<'PY'
import json, os, re, sys

keys = set(sys.argv[1].split())
pat = re.compile(r"^([A-Z][A-Z0-9_]*)='([^']*)'$")

def env_of(fd):
    e = json.load(os.fdopen(fd))["services"]["relay"].get("environment") or {}
    if isinstance(e, list):
        e = {k: v for k, _, v in (x.partition("=") for x in e)}
    return {k: (None if v is None else v.replace("$$", "$")) for k, v in e.items()}

cur, cand = env_of(3), env_of(4)
overlap = sorted(keys & set(cur))
if overlap:
    print("지금 환경에 녹음 이름이 이미 있음:", overlap, file=sys.stderr)
    sys.exit(1)
if set(cand) != set(cur) | keys:
    print("후보 환경 이름이 '지금 + 녹음 7개'와 다름:", sorted(set(cand) ^ (set(cur) | keys)), file=sys.stderr)
    sys.exit(1)
changed = sorted(k for k in cur if cur[k] != cand[k])
if changed:
    print("후보에서 녹음 말고 다른 값이 바뀜:", changed, file=sys.stderr)
    sys.exit(1)
want = {}
for line in open(sys.argv[2], encoding="utf-8").read().split("\n"):
    m = pat.match(line)
    if m:
        want[m.group(1)] = m.group(2)
lost = sorted(k for k in keys if cand.get(k) != want.get(k))
if lost:
    print("녹음 값이 렌더 결과에서 다름(다른 설정에 묻힘):", lost, file=sys.stderr)
    sys.exit(1)
if cand.get("BUZZ_HUDDLE_RECORDING") != "s3":
    print("BUZZ_HUDDLE_RECORDING 이 s3 가 아님", file=sys.stderr)
    sys.exit(1)
PY
}

# 이미지 실행 설정이 같은지(빌드 식별 ENV 만 빼고) 본다.
image_config_same() { # $1 = 이전 이미지, $2 = 후보 이미지
  python3 - "$build_identity_keys" 3< <(docker image inspect "$1" --format '{{json .Config}}') \
    4< <(docker image inspect "$2" --format '{{json .Config}}') <<'PY'
import json, os, sys
skip = set(sys.argv[1].split())
a, b = json.load(os.fdopen(3)), json.load(os.fdopen(4))
bad = [k for k in ("Entrypoint", "Cmd", "User", "WorkingDir", "Healthcheck", "ExposedPorts", "Volumes")
       if a.get(k) != b.get(k)]
ea = {k: v for k, _, v in (e.partition("=") for e in a.get("Env") or []) if k not in skip}
eb = {k: v for k, _, v in (e.partition("=") for e in b.get("Env") or []) if k not in skip}
env_bad = sorted(k for k in set(ea) | set(eb) if ea.get(k) != eb.get(k))
if bad or env_bad:
    print("이미지 실행 설정 다름:", bad, "ENV:", env_bad, file=sys.stderr)
    sys.exit(1)
PY
}

write_override() {
  umask 077
  printf 'services:\n  relay:\n    env_file:\n      - %s\n' "$recording_env" >"$override"
}

preflight() {
  log "스크립트 sha256 $(sha256sum "$0" | cut -c1-16)"
  [ "$(docker inspect -f '{{.Image}}' "$container")" = "$prior_id" ] || die "운영 이미지가 예상과 다름"
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$container")" = "$expected_env_files" ] ||
    die "env 파일 목록이 예상과 다름"
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")" = "$expected_config_files" ] ||
    die "compose 파일 목록이 예상과 다름"
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = healthy ] || die "지금 relay 가 healthy 아님"
  nip11_ok || die "지금 relay NIP-11 응답 없음"
  local f
  for f in "$base/.env" "$cutover_env"; do
    if grep -qE '^[[:space:]]*(export[[:space:]]+)?COMPOSE_REMOVE_ORPHANS=' "$f"; then die "$f 에 COMPOSE_REMOVE_ORPHANS 가 있음"; fi
  done
  [ -z "${COMPOSE_REMOVE_ORPHANS:-}" ] || die "COMPOSE_REMOVE_ORPHANS 환경 변수가 켜져 있음"

  prior_ref=$(docker inspect -f '{{.Config.Image}}' "$container")
  printf '%s' "$prior_ref" >"$state/prior_image_ref"
  log "지금 이미지 지정 값: $prior_ref"
  [ "$(docker image inspect -f '{{.Id}}' "$prior_ref" 2>/dev/null)" = "$prior_id" ] ||
    die "이전 이미지 지정 값이 로컬에서 $prior_id 로 풀리지 않음(되돌릴 수 없음)"

  local mig
  mig=$(migrations) || die "마이그레이션 수를 못 읽음"
  log "마이그레이션 $mig"

  # info 로그가 켜져 있는지(apply 뒤 '녹음 켜짐' 확인에 씀).
  if [ "$(docker logs --since 6h "$container" 2>&1 | grep -cE '"level":"INFO"| INFO ' || true)" -ge 1 ]; then
    printf 'yes' >"$state/info_logs"
  else
    printf 'no' >"$state/info_logs"
    log "주의: 최근 6시간 INFO 로그가 없음 → apply 뒤 '녹음 켜짐' 로그 확인은 건너뜀"
  fi

  # compose 가 남긴 설정 해시로 "지금 명령 = 살아 있는 컨테이너"를 본다(환경·포트·볼륨·healthcheck 전부).
  local want got
  want=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")
  got=$(env A2D2_RELAY_IMAGE="$prior_ref" "${current[@]}" config --hash relay 2>/dev/null | awk '$1 == "relay" {print $2}') ||
    die "지금 compose 설정 해시를 못 구함"
  [ -n "$want" ] && [ "$got" = "$want" ] || die "compose 설정 해시가 살아 있는 컨테이너와 다름"
  env_matches_live "$prior_id" "$prior_ref" "${current[@]}" || die "지금 compose 환경이 살아 있는 컨테이너와 다름"
  log "ok 지금 상태 재현 확인(설정 해시 ${want:0:12}, 환경 양방향 같음)"

  [ -n "$candidate_ref" ] || return 0
  case "$candidate_ref" in *@sha256:*) ;; *) die "후보는 repo@sha256:… 꼴이어야 함" ;; esac
  [ -f "$recording_env" ] || die "recording.env 없음"
  [ "$(stat -c '%U %a' "$recording_env")" = "root 600" ] || die "recording.env 권한이 root 600 아님"
  recording_env_shape_ok || die "recording.env 형식 점검 실패"
  write_override

  local free
  free=$(df --output=avail -BG /var/lib/docker | tail -1 | tr -dc '0-9')
  [ "${free:-0}" -ge "$min_free_gb" ] || die "/var/lib/docker 남은 공간 ${free}G (< ${min_free_gb}G)"
  docker pull -q "$candidate_ref" >/dev/null 2>&1 || die "후보 이미지 받기 실패"
  candidate_id=$(docker image inspect -f '{{.Id}}' "$candidate_ref") || die "후보 이미지 ID 못 읽음"
  printf '%s' "$candidate_id" >"$state/candidate_id"
  image_config_same "$prior_id" "$candidate_id" || die "이전·후보 이미지 실행 설정이 다름"
  candidate_env_ok "$prior_ref" "$candidate_ref" || die "후보 환경 점검 실패"

  local dry recreate others
  dry=$(env A2D2_RELAY_IMAGE="$candidate_ref" "${candidate[@]}" --dry-run "${up_flags[@]}" relay 2>&1) ||
    die "dry-run 실패"
  printf '%s\n' "$dry" | grep -E 'Container|Network|Volume' >>"$journal" 2>/dev/null || true
  recreate=$(printf '%s\n' "$dry" | grep -cE "Container ${container} +Recreate" || true)
  # 다시 만들 때 compose 는 새 컨테이너를 잠깐 <12자리 hex>_buzz-prod-relay-1 로 띄운다. 그것도 relay 다.
  others=$(printf '%s\n' "$dry" | grep -E 'Container [^ ]+' | grep -cvE "Container ([0-9a-f]{12}_)?${container}( |$)" || true)
  [ "${recreate:-0}" -ge 1 ] || die "dry-run 에 relay 다시 만들기 줄이 없음(출력 모양을 JOURNAL 에서 확인)"
  [ "${others:-0}" = 0 ] || die "dry-run 이 relay 말고 다른 컨테이너를 건드림"
  log "ok 후보 점검 통과(이미지 ${candidate_id:7:12}, 녹음 이름 7개만 더해짐, dry-run 은 relay 다시 만들기만)"
}

rollback() { # $1 = auto 면 relay 가 이전 상태 그대로 멀쩡할 때만 건너뜀
  local -
  set +e
  local prior_ref_saved
  prior_ref_saved=$(cat "$state/prior_image_ref" 2>/dev/null)
  [ -n "$prior_ref_saved" ] || prior_ref_saved=$prior_id
  if [ "${1:-}" = auto ] && relay_state_ok "$prior_id" no; then
    log "relay 가 이전 이미지로 멀쩡히 돌고 있어 되돌릴 것 없음"
    settled=1
    return 0
  fi
  log "rollback 시작: $prior_ref_saved"
  env A2D2_RELAY_IMAGE="$prior_ref_saved" "${current[@]}" "${up_flags[@]}" -t 30 relay >>"$journal" 2>&1
  if wait_healthy 240 && relay_state_ok "$prior_id" no &&
    env_matches_live "$prior_id" "$prior_ref_saved" "${current[@]}"; then
    if [ -f "$state/others_before" ] && [ "$(other_services)" != "$(cat "$state/others_before")" ]; then
      log "rollback 됐지만 다른 서비스 상태가 apply 전과 다름: 사람이 봐야 함"
    fi
    log "rollback 끝: 이전 이미지 healthy, 녹음 꺼짐, 환경이 apply 전과 같음"
    settled=1
    return 0
  fi
  log "rollback 실패: 사람이 봐야 함"
  settled=1
  return 70
}

case "$mode" in
  preflight)
    [ -n "$candidate_ref" ] || die "후보 이미지가 필요함"
    preflight
    log "preflight 끝: 컨테이너는 그대로"
    ;;
  apply)
    [ -n "$candidate_ref" ] || die "후보 이미지가 필요함"
    preflight
    docker tag "$prior_id" "$prior_tag" || die "이전 이미지 태그 실패"
    mig_before=$(migrations) || die "마이그레이션 수를 못 읽음"
    other_services >"$state/others_before"
    up_at=$(date -u +%FT%TZ)
    log "apply 시작: relay 하나만 ${candidate_id:7:12} 로 다시 만듦(마이그레이션 $mig_before)"
    changed=1
    ok=0
    if env A2D2_RELAY_IMAGE="$candidate_ref" "${candidate[@]}" "${up_flags[@]}" relay >>"$journal" 2>&1 &&
      wait_healthy 240 &&
      relay_state_ok "$candidate_id" yes &&
      env_matches_live "$candidate_id" "$candidate_ref" "${candidate[@]}"; then
      sleep 2
      log_ok=yes
      if [ "$(cat "$state/info_logs")" = yes ] &&
        [ "$(docker logs --since "$up_at" "$container" 2>&1 | grep -c 'Huddle recording enabled' || true)" -lt 1 ]; then
        log_ok=no
        log "'Huddle recording enabled' 로그가 없음"
      fi
      mig_after=$(migrations || true)
      if [ "$log_ok" = yes ] &&
        [ "$(other_services)" = "$(cat "$state/others_before")" ] &&
        [ "$mig_after" = "$mig_before" ]; then
        ok=1
      fi
    fi
    if [ "$ok" = 1 ]; then
      settled=1
      log "apply 끝: 새 이미지 healthy, 환경 양방향 같음, 녹음 켜짐, 다른 서비스·마이그레이션 그대로"
      log "아직 '됐다'가 아님: 짧은 허들 한 번 뒤 gs://a2d2-huddle-recordings 에 조각이 생겼는지 봐야 함"
    else
      mig_now=$(migrations || true)
      if [ -z "$mig_now" ]; then
        log "마이그레이션 수를 못 읽음 → 바뀌었는지 모르니 그대로 되돌림"
      elif [ "$mig_now" != "$mig_before" ]; then
        settled=1
        log "마이그레이션 수가 바뀜($mig_before → $mig_now) → 자동으로 안 되돌림. 사람이 봐야 함"
        exit 75
      fi
      log "apply 확인 실패 → 되돌림"
      rollback || exit 70
      exit 1
    fi
    ;;
  rollback)
    rollback || exit 70
    ;;
  *) die "모르는 mode: $mode" ;;
esac

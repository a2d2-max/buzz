#!/usr/bin/env bash
# 회의록 작업기를 Cloud Run 작업 + Cloud Scheduler(10분마다)로 만든다.
#   create-huddle-minutes.sh <이미지 repo@sha256:…>
# 기본은 할 일을 찍기만 한다. 정말 만들려면: APPLY=1 create-huddle-minutes.sh …
# 다시 돌려도 된다(있는 것은 그대로 두거나 같은 값으로 고친다).
# 되돌리기 짝: delete-huddle-minutes.sh (여기서 만든 것만 이름으로 지운다).
#
# 작업기는 `process` 하나만 인자로 받고 나머지는 BUZZ_MINUTES_* 환경 변수로 받는다
# (docs/huddle-minutes-worker.md "실행 (Cloud Run 작업)"). 값은 common.sh 의
# job_env. 노션 토큰은 Secret Manager 를 NOTION_TOKEN 으로, 회의록 봇 키는
# BUZZ_MINUTES_SCRIBE_NSEC 로 붙인다.
# 스케줄러는 기본으로 켠 채 만든다(common.sh scheduler_state). SCHEDULER_STATE=paused 로
# 멈춰 둔 동안은 손으로 한 번씩 돌린다(--all 이라 끝난 회의를 모두 처리한다):
#   gcloud run jobs execute a2d2-huddle-minutes --project a2d2-lab --region asia-northeast3 --wait
set -Eeuo pipefail
export LC_ALL=C

image=${1:?이미지 repo@sha256:…}
case "$image" in
  *@sha256:*) ;;
  *) echo "이미지는 digest 로 준다 (repo@sha256:…): $image" >&2; exit 2 ;;
esac
# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

# ─── 0. 점검(아무것도 바꾸지 않는다) ─────────────────────────────────────────
log "계정 $(gcloud config get-value account 2>/dev/null) / 프로젝트 $project / APPLY=${APPLY:-0} / 스케줄러 $scheduler_state"
case "$scheduler_state" in
  paused | enabled) ;;
  *) echo "SCHEDULER_STATE 는 paused 나 enabled: $scheduler_state" >&2; exit 2 ;;
esac
gcloud artifacts docker images describe "$image" --project "$project" --format='value(image_summary.digest)' >/dev/null
gcloud storage buckets describe "gs://$recordings_bucket" --format='value(name)' >/dev/null
gcloud storage buckets describe "gs://$minutes_bucket" --format='value(name)' >/dev/null
gcloud secrets describe "$notion_secret" --project "$project" --format='value(name)' >/dev/null
gcloud secrets describe "$scribe_secret" --project "$project" --format='value(name)' >/dev/null
# 작업은 두 비밀을 :latest 로 붙인다. latest 판이 없거나 꺼져 있으면 Cloud Run 작업이 아예 안
# 떠서 회의록 전체가 멈춘다(봇 키는 이름 꾸밈에만 쓰는데도). 키를 바꿀 때는 새 판을 먼저 넣고
# 확인한 뒤 옛 판을 끈다(docs/huddle-minutes-worker.md "참석자 이름").
for secret in "$notion_secret" "$scribe_secret"; do
  latest_state="$(gcloud secrets versions describe latest --secret "$secret" --project "$project" --format='value(state)' 2>/dev/null || true)"
  if [ "$latest_state" != ENABLED ]; then
    echo "비밀 $secret 의 latest 판이 켜져 있지 않다(${latest_state:-없음}): 판을 넣거나 켠 뒤 다시 돌린다" >&2
    exit 3
  fi
done

# ─── 1. 서비스 계정 ──────────────────────────────────────────────────────────
for pair in "$sa_name:Huddle minutes worker (Cloud Run job)" "$invoker_name:Huddle minutes invoker (Cloud Scheduler)"; do
  name=${pair%%:*}
  if gcloud iam service-accounts describe "$name@$project.iam.gserviceaccount.com" --project "$project" >/dev/null 2>&1; then
    log "서비스 계정 $name 있음"
  else
    run gcloud iam service-accounts create "$name" --project "$project" --display-name "${pair#*:}"
  fi
done

# ─── 2. 맞춤 역할: recognize + Gemini 호출만 ─────────────────────────────────
role_state="$(gcloud iam roles describe "$role_id" --project "$project" --format='value(deleted)' 2>/dev/null || echo absent)"
case "$role_state" in
  absent)
    run gcloud iam roles create "$role_id" --project "$project" \
      --title "Huddle minutes worker" \
      --description "Speech-to-Text v2 recognize and Vertex AI generateContent for a2d2-huddle-minutes" \
      --permissions "$role_permissions" --stage GA ;;
  True)
    # 지운 역할은 7일 안에 되살릴 수 있고, 37일 동안 같은 이름으로 못 만든다.
    run gcloud iam roles undelete "$role_id" --project "$project"
    run gcloud iam roles update "$role_id" --project "$project" --permissions "$role_permissions" ;;
  *)
    run gcloud iam roles update "$role_id" --project "$project" --permissions "$role_permissions" ;;
esac

# ─── 3. 권한 ─────────────────────────────────────────────────────────────────
member="serviceAccount:$sa"
if gcloud projects get-iam-policy "$project" --format=json | has_binding "$member" "$role"; then
  log "프로젝트 $role 있음"
else
  run gcloud projects add-iam-policy-binding "$project" --member "$member" --role "$role" --condition None
fi

bucket_bind() { # 버킷 역할 [조건 제목 조건]
  local bucket=$1 role=$2 title=${3:-} condition=${4:-}
  if gcloud storage buckets get-iam-policy "gs://$bucket" --format=json | has_binding "$member" "$role" "$title"; then
    log "gs://$bucket $role${title:+ ($title)} 있음"
  elif [ -n "$condition" ]; then
    run gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member "$member" --role "$role" --condition "$condition"
  else
    run gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member "$member" --role "$role"
  fi
}
# 녹음 버킷: 읽기 + 섞은 오디오(.wav) 만들기만
bucket_bind "$recordings_bucket" roles/storage.objectViewer
bucket_bind "$recordings_bucket" "$mixed_role" "$mixed_condition_title" "$mixed_condition"
# 분 버킷: 만들기·읽기·지우기(lease 를 지워야 해서)
bucket_bind "$minutes_bucket" roles/storage.objectUser

# 비밀 읽기: 노션 토큰, 회의록 봇 키
for secret in "$notion_secret" "$scribe_secret"; do
  if gcloud secrets get-iam-policy "$secret" --project "$project" --format=json | has_binding "$member" roles/secretmanager.secretAccessor; then
    log "비밀 $secret 읽기 있음"
  else
    run gcloud secrets add-iam-policy-binding "$secret" --project "$project" --member "$member" --role roles/secretmanager.secretAccessor
  fi
done

# ─── 4. Cloud Run 작업 ───────────────────────────────────────────────────────
run gcloud run jobs deploy "$job" --project "$project" --region "$region" \
  --image "$image" \
  --service-account "$sa" \
  --cpu "$job_cpu" --memory "$job_memory" \
  --task-timeout "$job_task_timeout" \
  --max-retries "$job_max_retries" \
  --tasks "$job_tasks" --parallelism "$job_parallelism" \
  --labels "$labels" \
  --set-env-vars "$(IFS=,; echo "${job_env[*]}")" \
  --set-secrets "$notion_env=$notion_secret:latest,$scribe_env=$scribe_secret:latest" \
  --args "$job_command"

# 스케줄러 계정은 이 작업 하나만 부를 수 있다.
run gcloud run jobs add-iam-policy-binding "$job" --project "$project" --region "$region" \
  --member "serviceAccount:$invoker" --role roles/run.invoker

# ─── 5. Cloud Scheduler (10분마다, UTC; 기본은 켠 채) ───────────────────────
uri="https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$job:run"
verb=create
if gcloud scheduler jobs describe "$scheduler" --project "$project" --location "$region" >/dev/null 2>&1; then
  verb=update
fi
# 새로 만들면 바로 켜진 상태라, 다음 10분 경계 직전이면 그 경계를 넘긴 뒤 만든다.
# 그래야 멈추기 전에 한 번 도는 일이 없다.
if [ "$verb" = create ] && [ "$scheduler_state" = paused ]; then
  now=$(date -u +%s)
  wait_s=$(((now / 600 + 1) * 600 - now))
  if [ "$wait_s" -lt 120 ]; then
    log "다음 10분 경계까지 ${wait_s}s: 넘긴 뒤 만든다"
    if [ "${APPLY:-0}" = 1 ]; then sleep $((wait_s + 5)); fi
  fi
fi
run gcloud scheduler jobs "$verb" http "$scheduler" --project "$project" --location "$region" \
  --schedule "$schedule" --time-zone "$schedule_time_zone" \
  --uri "$uri" --http-method POST \
  --oauth-service-account-email "$invoker" \
  --oauth-token-scope https://www.googleapis.com/auth/cloud-platform \
  --attempt-deadline 60s

state() { gcloud scheduler jobs describe "$scheduler" --project "$project" --location "$region" --format='value(state)'; }
want=PAUSED
action=pause
if [ "$scheduler_state" = enabled ]; then
  want=ENABLED
  action=resume
fi
if [ "${APPLY:-0}" = 1 ]; then
  if [ "$(state)" != "$want" ]; then
    run gcloud scheduler jobs "$action" "$scheduler" --project "$project" --location "$region"
  fi
  got="$(state)"
  log "스케줄러 상태 $got"
  if [ "$got" != "$want" ]; then
    echo "스케줄러가 $want 가 아니다: $got" >&2
    exit 4
  fi
else
  run gcloud scheduler jobs "$action" "$scheduler" --project "$project" --location "$region"
fi

log "끝 (APPLY=${APPLY:-0})"

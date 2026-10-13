# create-huddle-minutes.sh 와 delete-huddle-minutes.sh 가 같이 쓰는 이름과 함수.
# 이 파일 한 곳에만 둔다. 둘이 어긋나면 지우기가 엉뚱한 것을 지우거나 남긴다.
# shellcheck shell=bash disable=SC2034 # 이 파일의 이름은 source 하는 스크립트가 쓴다

project=a2d2-lab
region=asia-northeast3

# Cloud Run 작업과 그것을 10분마다 부르는 Cloud Scheduler 작업
job=a2d2-huddle-minutes
scheduler=a2d2-huddle-minutes-every-10m
schedule='*/10 * * * *' # UTC 기준. 실행끼리 겹치는 것은 docs/huddle-minutes-worker.md "실행" 절
schedule_time_zone=Etc/UTC
# 스케줄러 상태. 기본은 enabled: 화자 분리·후보정이 붙은 회의록을 실제 허들로 확인한 뒤
# 켜기로 정했다(2026-10-13). 멈출 때만 SCHEDULER_STATE=paused.
# 기본값이 운영 상태와 다르면 다음 배포가 켜 둔 스케줄러를 말없이 멈춘다(5단계가 상태를 맞춘다).
scheduler_state=${SCHEDULER_STATE:-enabled}

# 작업기가 도는 계정, 스케줄러가 작업을 부를 때 쓰는 계정(작업 하나만 부를 수 있음)
sa_name=a2d2-huddle-minutes
sa="$sa_name@$project.iam.gserviceaccount.com"
invoker_name=a2d2-huddle-minutes-invoker
invoker="$invoker_name@$project.iam.gserviceaccount.com"

# 받아쓰기(Chirp 3, Speech-to-Text v2 recognize)와 Gemini(Vertex AI) 호출만 되는 맞춤 역할.
# Gemini 는 global 의 publishers/google/models/…:generateContent 를 부른다. 그 호출이
# 보는 권한이 aiplatform.endpoints.predict 다(배포 뒤 실제 호출로 확인; 안 되면
# roles/aiplatform.user 가 대안이지만 권한이 459개라 넓다).
role_id=a2d2HuddleMinutesWorker
role="projects/$project/roles/$role_id"
role_permissions=speech.recognizers.recognize,aiplatform.endpoints.predict

recordings_bucket=a2d2-huddle-recordings
minutes_bucket=a2d2-huddle-minutes
notion_secret=a2d2-buzz-notion-token

# 섞은 오디오는 {prefix}/{community}/{channel}/mixed/{첫 세션}.wav
# (crates/buzz-huddle-minutes/src/pipeline.rs mixed_audio_key). 녹음 객체는
# .bhr·.json 뿐이라 "이 prefix 아래 .wav 만 만들기" 로 mixed 만 열린다.
recordings_prefix=huddles
mixed_role=roles/storage.objectCreator
mixed_condition_title=huddle-minutes-mixed-audio-only
mixed_condition_expr="resource.name.startsWith(\"projects/_/buckets/$recordings_bucket/objects/$recordings_prefix/\") && resource.name.endsWith(\".wav\")"
mixed_condition="expression=$mixed_condition_expr,title=$mixed_condition_title"

# Cloud Run 작업 크기. 화자 나누기가 CPU 를 다 쓴다(1시간 회의실 녹음 bench: 2 CPU 에서
# 전체 28분, 그중 화자 나누기 20분 / 4 CPU·스레드 4 에서 화자 나누기 10.6분, 전체 약 18분).
job_cpu=4
job_memory=4Gi
job_task_timeout=55m # 작업기 lease(2시간)보다 짧게
job_max_retries=0
job_tasks=1
job_parallelism=1
labels=app=a2d2-huddle-minutes

# 이미지 안의 모델 폴더(Dockerfile)
image_cache_dir=/opt/huddle-minutes/cache

# 작업기 실행: 인자는 하위 명령 하나, 나머지는 환경 변수(BUZZ_MINUTES_*).
# 받아쓰기 인증(BUZZ_MINUTES_GCP_AUTH=metadata)과 시간 상한(BUZZ_MINUTES_TIME_LIMIT_MINUTES=50)은
# 작업기 기본값을 그대로 쓴다. PREFIX 는 기본값과 같지만 위 IAM 조건과 같은 변수에서
# 오게 일부러 적는다. 화자 분리는 켠다(모델 셋은 Dockerfile 이 이미지에 넣는다).
# 화자 나누기·목소리 특징 스레드는 CPU 수와 같게 둔다(작업기 기본값 2 는 CPU 를 따라가지 않는다).
# 새는 소리 지우기(BLEED)·목소리 프로필 배우기(VOICES_LEARN)·목소리 저장소
# (VOICES_BUCKET·VOICES_DIR)는 작업기 기본값(꺼짐)을 그대로 쓴다.
job_command=process
job_env=(
  "BUZZ_MINUTES_ALL=true"
  "BUZZ_MINUTES_RECORDINGS_BUCKET=$recordings_bucket"
  "BUZZ_MINUTES_PREFIX=$recordings_prefix"
  "BUZZ_MINUTES_BUCKET=$minutes_bucket"
  "BUZZ_MINUTES_CHIRP_PROJECT=$project"
  "BUZZ_MINUTES_CACHE=$image_cache_dir"
  "BUZZ_MINUTES_VAD_MODEL=$image_cache_dir/models/silero_vad.onnx"
  "BUZZ_MINUTES_SUMMARY=on" # 모델은 작업기 기본값(gemini-3.8-flash)
  "BUZZ_MINUTES_NOTION=on"  # 토큰은 NOTION_TOKEN 비밀
  "BUZZ_MINUTES_SPEAKERS=on"
  "BUZZ_MINUTES_SPEAKER_THREADS=$job_cpu"
  "BUZZ_MINUTES_ROOM_PIECES=cut" # 화자 토막마다 받아쓰기(작업기 기본값과 같지만 일부러 적는다)
  "BUZZ_MINUTES_VAD_LEVEL=on"    # 말소리 찾기에만 크기 맞춘 소리를 준다
  "BUZZ_MINUTES_CORRECT=on"      # 요약 전에 Gemini 로 잘못 들은 말 후보정
)
notion_env=NOTION_TOKEN

# ─── 같이 쓰는 함수 ─────────────────────────────────────────────────────────

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# 명령을 찍고, APPLY=1 일 때만 실행한다. 기본은 찍기만.
run() {
  printf '  +'
  printf ' %q' "$@"
  printf '\n'
  if [ "${APPLY:-0}" = 1 ]; then
    "$@"
  fi
}

# get-iam-policy JSON(표준 입력)에 member·role(·조건 제목) 바인딩이 있나.
has_binding() {
  python3 -I -c '
import json, sys
member, role, title = sys.argv[1], sys.argv[2], sys.argv[3]
for b in json.load(sys.stdin).get("bindings", []):
    if b.get("role") != role or member not in b.get("members", []):
        continue
    if (b.get("condition") or {}).get("title", "") == title:
        sys.exit(0)
sys.exit(1)
' "$1" "$2" "${3:-}"
}

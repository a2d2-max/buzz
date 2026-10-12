# create-huddle-minutes.sh 와 delete-huddle-minutes.sh 가 같이 쓰는 이름과 함수.
# 이 파일 한 곳에만 둔다. 둘이 어긋나면 지우기가 엉뚱한 것을 지우거나 남긴다.
# shellcheck shell=bash disable=SC2034 # 이 파일의 이름은 source 하는 스크립트가 쓴다

project=a2d2-lab
region=asia-northeast3

# Cloud Run 작업과 그것을 10분마다 부르는 Cloud Scheduler 작업
job=a2d2-huddle-minutes
scheduler=a2d2-huddle-minutes-every-10m
schedule='*/10 * * * *' # UTC 기준
schedule_time_zone=Etc/UTC

# 작업기가 도는 계정, 스케줄러가 작업을 부를 때 쓰는 계정(작업 하나만 부를 수 있음)
sa_name=a2d2-huddle-minutes
sa="$sa_name@$project.iam.gserviceaccount.com"
invoker_name=a2d2-huddle-minutes-invoker
invoker="$invoker_name@$project.iam.gserviceaccount.com"

# 받아쓰기(Chirp 3, Speech-to-Text v2 recognize)와 Gemini(Vertex AI) 호출만 되는 맞춤 역할
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

# Cloud Run 작업 크기
job_cpu=2
job_memory=4Gi
job_task_timeout=55m # 작업기 lease(2시간)보다 짧게
job_max_retries=0
job_tasks=1
job_parallelism=1
labels=app=a2d2-huddle-minutes

# 이미지 안의 모델 폴더(Dockerfile)
image_cache_dir=/opt/huddle-minutes/cache

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

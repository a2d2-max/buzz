#!/usr/bin/env bash
# 회의록 작업기를 Cloud Run 작업 + Cloud Scheduler(10분마다)로 만든다.
#   create-huddle-minutes.sh <이미지 repo@sha256:…>
# 기본은 할 일을 찍기만 한다. 정말 만들려면: APPLY=1 create-huddle-minutes.sh …
# 다시 돌려도 된다(있는 것은 그대로 두거나 같은 값으로 고친다).
# 되돌리기 짝: delete-huddle-minutes.sh (여기서 만든 것만 이름으로 지운다).
#
# 아직 정할 것(정하기 전에는 APPLY=1 이 멈춘다):
#   JOB_ARGS           작업기 인자. 지금 작업기의 process 는 --community·--channel
#                      하나씩만 받아서, 10분마다 "끝난 회의를 다 훑는" 명령이 없다.
#                      예) JOB_ARGS="process --recordings-bucket a2d2-huddle-recordings
#                          --minutes-bucket a2d2-huddle-minutes --chirp-project a2d2-lab
#                          --gcp-auth metadata --cache /opt/huddle-minutes/cache …"
#   NOTION_SECRET_ENV  Notion 토큰을 넣을 환경 변수 이름. 작업기에 아직 Notion 코드가
#                      없어서 비워 두면 비밀을 붙이지 않는다(권한은 미리 준다).
set -Eeuo pipefail
export LC_ALL=C

image=${1:?이미지 repo@sha256:…}
case "$image" in
  *@sha256:*) ;;
  *) echo "이미지는 digest 로 준다 (repo@sha256:…): $image" >&2; exit 2 ;;
esac
# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

job_args=${JOB_ARGS:-}
notion_env=${NOTION_SECRET_ENV:-}

# ─── 0. 점검(아무것도 바꾸지 않는다) ─────────────────────────────────────────
log "계정 $(gcloud config get-value account 2>/dev/null) / 프로젝트 $project / APPLY=${APPLY:-0}"
gcloud artifacts docker images describe "$image" --project "$project" --format='value(image_summary.digest)' >/dev/null
gcloud storage buckets describe "gs://$recordings_bucket" --format='value(name)' >/dev/null
gcloud storage buckets describe "gs://$minutes_bucket" --format='value(name)' >/dev/null
gcloud secrets describe "$notion_secret" --project "$project" --format='value(name)' >/dev/null
if [ -z "$job_args" ]; then
  log "JOB_ARGS 가 비었다: 작업기에 모든 채널을 훑는 명령이 아직 없다"
  if [ "${APPLY:-0}" = 1 ]; then exit 3; fi
  job_args="--help" # 찍기만 할 때의 자리 표시
fi
read -r -a args <<<"$job_args"

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

if gcloud secrets get-iam-policy "$notion_secret" --project "$project" --format=json | has_binding "$member" roles/secretmanager.secretAccessor; then
  log "비밀 $notion_secret 읽기 있음"
else
  run gcloud secrets add-iam-policy-binding "$notion_secret" --project "$project" --member "$member" --role roles/secretmanager.secretAccessor
fi

# ─── 4. Cloud Run 작업 ───────────────────────────────────────────────────────
secret_flags=()
if [ -n "$notion_env" ]; then
  secret_flags=(--set-secrets "$notion_env=$notion_secret:latest")
fi
run gcloud run jobs deploy "$job" --project "$project" --region "$region" \
  --image "$image" \
  --service-account "$sa" \
  --cpu "$job_cpu" --memory "$job_memory" \
  --task-timeout "$job_task_timeout" \
  --max-retries "$job_max_retries" \
  --tasks "$job_tasks" --parallelism "$job_parallelism" \
  --labels "$labels" \
  ${secret_flags[@]+"${secret_flags[@]}"} \
  --args "$(IFS=,; echo "${args[*]}")"

# 스케줄러 계정은 이 작업 하나만 부를 수 있다.
run gcloud run jobs add-iam-policy-binding "$job" --project "$project" --region "$region" \
  --member "serviceAccount:$invoker" --role roles/run.invoker

# ─── 5. Cloud Scheduler (10분마다, UTC) ─────────────────────────────────────
uri="https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$job:run"
verb=create
if gcloud scheduler jobs describe "$scheduler" --project "$project" --location "$region" >/dev/null 2>&1; then
  verb=update
fi
run gcloud scheduler jobs "$verb" http "$scheduler" --project "$project" --location "$region" \
  --schedule "$schedule" --time-zone "$schedule_time_zone" \
  --uri "$uri" --http-method POST \
  --oauth-service-account-email "$invoker" \
  --oauth-token-scope https://www.googleapis.com/auth/cloud-platform \
  --attempt-deadline 60s

log "끝 (APPLY=${APPLY:-0})"

#!/usr/bin/env bash
# create-huddle-minutes.sh 가 만든 것을 만든 순서의 반대로 되돌린다.
#   delete-huddle-minutes.sh
# 기본은 할 일을 찍기만 한다. 정말 지우려면: APPLY=1 delete-huddle-minutes.sh
# 지우는 대상은 common.sh 에 적힌 이름 하나하나뿐이다(패턴으로 고르지 않는다).
# 버킷·비밀 자체와 그 안의 객체(녹음·스크립트·lease)는 건드리지 않는다.
# 이 계정에 걸린 권한 바인딩만 뗀다.
set -Eeuo pipefail
export LC_ALL=C

# shellcheck source-path=SCRIPTDIR source=common.sh
. "$(cd "$(dirname "$0")" && pwd)/common.sh"
member="serviceAccount:$sa"
log "계정 $(gcloud config get-value account 2>/dev/null) / 프로젝트 $project / APPLY=${APPLY:-0}"

# ─── 1. 스케줄러(새 실행이 생기지 않게 먼저) ─────────────────────────────────
if gcloud scheduler jobs describe "$scheduler" --project "$project" --location "$region" >/dev/null 2>&1; then
  run gcloud scheduler jobs delete "$scheduler" --project "$project" --location "$region" --quiet
else
  log "스케줄러 $scheduler 없음"
fi

# ─── 2. Cloud Run 작업(작업에 걸린 run.invoker 도 같이 없어진다) ──────────────
# 도는 중인 실행이 있으면 지우기가 실패한다. 그때는 끝나기를 기다리거나 그 실행만
# 이름으로 취소한다: gcloud run jobs executions cancel <실행 이름> --region …
if gcloud run jobs describe "$job" --project "$project" --region "$region" >/dev/null 2>&1; then
  run gcloud run jobs delete "$job" --project "$project" --region "$region" --quiet
else
  log "작업 $job 없음"
fi

# ─── 3. 권한 바인딩 ──────────────────────────────────────────────────────────
if gcloud secrets get-iam-policy "$notion_secret" --project "$project" --format=json | has_binding "$member" roles/secretmanager.secretAccessor; then
  run gcloud secrets remove-iam-policy-binding "$notion_secret" --project "$project" --member "$member" --role roles/secretmanager.secretAccessor
else
  log "비밀 $notion_secret 읽기 바인딩 없음"
fi

bucket_unbind() { # 버킷 역할 [조건 제목 조건]
  local bucket=$1 role=$2 title=${3:-} condition=${4:-}
  if ! gcloud storage buckets get-iam-policy "gs://$bucket" --format=json | has_binding "$member" "$role" "$title"; then
    log "gs://$bucket $role${title:+ ($title)} 바인딩 없음"
  elif [ -n "$condition" ]; then
    run gcloud storage buckets remove-iam-policy-binding "gs://$bucket" --member "$member" --role "$role" --condition "$condition"
  else
    run gcloud storage buckets remove-iam-policy-binding "gs://$bucket" --member "$member" --role "$role"
  fi
}
bucket_unbind "$minutes_bucket" roles/storage.objectUser
bucket_unbind "$recordings_bucket" "$mixed_role" "$mixed_condition_title" "$mixed_condition"
bucket_unbind "$recordings_bucket" roles/storage.objectViewer

if gcloud projects get-iam-policy "$project" --format=json | has_binding "$member" "$role"; then
  run gcloud projects remove-iam-policy-binding "$project" --member "$member" --role "$role" --condition None
else
  log "프로젝트 $role 바인딩 없음"
fi

# ─── 4. 맞춤 역할 ────────────────────────────────────────────────────────────
# 지운 역할은 7일 안에 되살릴 수 있고(create 가 되살린다), 37일 동안 같은 이름으로
# 새로 만들 수 없다.
if [ "$(gcloud iam roles describe "$role_id" --project "$project" --format='value(deleted)' 2>/dev/null || echo absent)" = "" ]; then
  run gcloud iam roles delete "$role_id" --project "$project" --quiet
else
  log "역할 $role_id 없음(또는 이미 지움)"
fi

# ─── 5. 서비스 계정 ──────────────────────────────────────────────────────────
for account in "$invoker" "$sa"; do
  if gcloud iam service-accounts describe "$account" --project "$project" >/dev/null 2>&1; then
    run gcloud iam service-accounts delete "$account" --project "$project" --quiet
  else
    log "서비스 계정 $account 없음"
  fi
done

log "끝 (APPLY=${APPLY:-0})"

# syntax=docker/dockerfile:1.7
#
# 회의록 작업기(buzz-huddle-minutes) 이미지 — Cloud Run 작업용.
#
# 빌드 문맥은 build-image.sh 가 `git archive <커밋>` 으로 만든 깨끗한 소스다
# (Cargo.toml, Cargo.lock, rust-toolchain.toml, .cargo, crates, examples +
# 이 Dockerfile). 로컬 docker 로 빌드하지 않고 Cloud Build 로만 빌드한다.
#
# 들어가는 것:
#   /usr/local/bin/buzz-huddle-minutes          작업기 실행 파일
#   /opt/huddle-minutes/cache/models/            모델 (--cache /opt/huddle-minutes/cache)
#     silero_vad.onnx                            models.rs 의 주소·sha256 그대로
#     (화자 분리 모델은 아직 안 넣는다 — 아래 models 단계 참고)
# sherpa-onnx 는 sherpa-onnx-sys 기본값(static)으로 실행 파일 안에 정적
# 링크된다(onnxruntime 포함). 그래서 따로 넣을 공유 라이브러리가 없다.
# cloudbuild.yaml 이 ldd 로 이것을 확인한다.

ARG RUST_VERSION=1.95.0
ARG DEBIAN_VERSION=bookworm

# ─── 1. 실행 파일 ────────────────────────────────────────────────────────────
FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS builder
# libopus-dev: audiopus_sys 가 pkg-config 로 시스템 libopus 를 찾는다(못 찾으면
# cmake 로 직접 빌드). sherpa-onnx-sys 는 빌드 중에 GitHub 릴리스에서 정적
# 라이브러리 묶음을 받는다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        pkg-config \
        libopus-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
WORKDIR /build
COPY . .
RUN cargo build --release --locked -p buzz-huddle-minutes --bin buzz-huddle-minutes \
    && strip target/release/buzz-huddle-minutes

# ─── 2. 모델 ─────────────────────────────────────────────────────────────────
# 주소와 sha256 은 여기 따로 적지 않고 빌드하는 커밋의 models.rs 에서 읽는다.
# 같은 값을 두 곳에 두면 언젠가 어긋난다. 받은 파일이 그 sha256 과 다르면
# 빌드가 실패한다.
FROM debian:${DEBIAN_VERSION}-slim AS models
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY crates/buzz-huddle-minutes/src/models.rs /tmp/models.rs
RUN set -eu; \
    pinned() { awk -v name="$1" '$0 ~ "const " name ":" {found=1} found && match($0, /"[^"]+"/) {print substr($0, RSTART + 1, RLENGTH - 2); exit}' /tmp/models.rs; }; \
    url="$(pinned SILERO_VAD_URL)"; sha="$(pinned SILERO_VAD_SHA256)"; \
    test -n "$url" && test -n "$sha"; \
    mkdir -p /models; \
    curl -fsSL --retry 3 "$url" -o /models/silero_vad.onnx; \
    echo "$sha  /models/silero_vad.onnx" | sha256sum -c -; \
    chmod 0644 /models/silero_vad.onnx
# 화자 분리 모델은 넣지 않는다: 작업기에서 화자 분리가 꺼져 있어서(기본값)
# Silero 만 있으면 된다. models.rs 의 화자 모델(ModelFile, 주소가 concat! 로
# 여러 줄)은 위 awk 로 바르게 읽히지 않는다. 화자 분리를 켤 때는 이 단계를
# 1단계에서 만든 실행 파일의 `buzz-huddle-minutes fetch-models --cache /models/..`
# 로 바꿀 것(주소·sha256 확인을 코드가 한 곳에서 한다).

# ─── 3. 실행 환경 ────────────────────────────────────────────────────────────
FROM debian:${DEBIAN_VERSION}-slim
LABEL org.opencontainers.image.title="a2d2-huddle-minutes" \
      org.opencontainers.image.description="Huddle minutes worker (buzz-huddle-minutes) for Cloud Run jobs"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libopus0 \
        libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 minutes \
    && useradd --system --uid 10001 --gid minutes --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin minutes
COPY --from=builder /build/target/release/buzz-huddle-minutes /usr/local/bin/buzz-huddle-minutes
COPY --from=models /models/ /opt/huddle-minutes/cache/models/
ARG BUZZ_SOURCE_SHA=unknown
LABEL org.opencontainers.image.revision="${BUZZ_SOURCE_SHA}"
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/buzz-huddle-minutes"]
CMD ["--help"]

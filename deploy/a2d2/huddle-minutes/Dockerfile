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
#   /opt/huddle-minutes/cache/models/            모델 (BUZZ_MINUTES_CACHE=/opt/huddle-minutes/cache)
#     silero_vad.onnx                            말소리 찾기
#     pyannote-segmentation-3-0.onnx             화자 나누기
#     3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx  목소리 특징
#   셋 다 빌드 단계에서 `buzz-huddle-minutes fetch-models` 가 받는다(아래 1단계).
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
# 모델: 방금 만든 실행 파일이 받는다. 주소와 sha256 은 그 커밋의 models.rs 한
# 곳에만 있다(여기 다시 적으면 언젠가 어긋난다). 받은 파일이 sha256 과 다르면
# fetch-models 가 실패해서 빌드도 실패한다.
RUN target/release/buzz-huddle-minutes fetch-models --cache /models-cache \
    && chmod 0755 /models-cache/models \
    && chmod 0644 /models-cache/models/*

# ─── 2. 실행 환경 ────────────────────────────────────────────────────────────
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
COPY --from=builder /models-cache/models/ /opt/huddle-minutes/cache/models/
ARG BUZZ_SOURCE_SHA=unknown
LABEL org.opencontainers.image.revision="${BUZZ_SOURCE_SHA}"
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/buzz-huddle-minutes"]
CMD ["--help"]

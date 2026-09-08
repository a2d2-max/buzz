// TV 앱이 읽는 kind 만 추린 상수. 원본은 desktop/src/shared/constants/kinds.ts
// 와 crates/buzz-core/src/kind.rs — 값이 어긋나면 그쪽이 기준이다.
// (공유 패키지 추출은 다음 단계 제안으로 남긴다. 이번엔 tv/ 안에 둔다.)

export const KIND_PROFILE = 0;
export const KIND_STREAM_MESSAGE = 9;
export const KIND_STREAM_MESSAGE_V2 = 40002;
export const KIND_NIP29_GROUP_METADATA = 39000;

// Docs 페이지: 전용 kind 30623 우선, 이전 자리(공용 NIP-78 30078)도 같이 읽는다.
export const KIND_COMMUNITY_DOC = 30623;
export const KIND_COMMUNITY_DOC_LEGACY = 30078;
export const COMMUNITY_DOC_TAG = "community-doc";
export const COMMUNITY_DOC_D_PREFIX = "doc:";

/** 타임라인이 읽는 메시지 kind. 9 가 1세대, 40002 가 현행(v2)이다. */
export const TIMELINE_MESSAGE_KINDS: readonly number[] = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
];

/** Docs 조회는 전용 kind 와 레거시 창을 함께 요청한다. */
export const COMMUNITY_DOC_QUERY_KINDS: readonly number[] = [
  KIND_COMMUNITY_DOC,
  KIND_COMMUNITY_DOC_LEGACY,
];

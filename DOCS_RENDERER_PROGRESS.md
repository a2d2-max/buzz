# Docs 렌더러 후속 — 진행 기록

브리프: `/Users/sign-x/.buzz/PLANS/DOCS_RENDERER_BRIEF.md`
워크트리: `/Users/sign-x/orca/workspaces/buzz/community-docs` (브랜치 `a2d2-max/community-docs`)
시작점: Phase 3 마지막 커밋 `495173e85` 위에 이어서. 머지·푸시·게시 안 함.

## 단계별 상태

| # | 할 일 | 상태 | 커밋 | 근거 |
|---|---|---|---|---|
| 0 | 현재 코드 조사(렌더러·편집기·라우터·의존성) | 끝 | – | 아래 「조사 결과」 |
| 1 | Docs 링크 앱 내부 이동 + 없는 페이지 안내 | 끝(커밋 대기) | – | 파서 테스트 6, 화면 테스트 5 추가; Docs·렌더러 묶음 254/254 |
| 2 | 표(GFM) 렌더 + 편집기에서 안 깨지게 | 대기 | – | |
| 3 | 할 일 목록 체크박스 렌더 | 대기 | – | |
| 4 | 각주·HTML·CSV 여러 줄 셀: 원문 보존 | 대기 | – | |
| 5 | 실기: 로컬 릴레이에 샘플 넣고 화면 캡처 | 대기 | – | |
| 6 | 테스트·게이트·커밋 | 대기 | – | |

## 조사 결과

직접 잰 것만 적는다(2026-09-08 밤, 커밋 `495173e85` 기준).

**라우터.** `desktop/src/app/router.tsx`가 `createHashHistory()`를 쓴다. 그래서 `/#/docs/<pageId>`는 곧 앱 내부 URL이고, 링크를 앱 안에서 받으려면 `useAppNavigation().goDocs(pageId)`(내비게이션 가드 `allowNavigation`을 거침)로 가면 된다.

**오늘 Docs 링크가 떨어지는 곳.** 공용 렌더러 `desktop/src/shared/ui/markdown.tsx`의 `a` 컴포넌트는 채널 링크 → 메시지 링크 → `buzz://` 엔티티 링크 순서로 보고, 나머지는 전부 `markdown/ExternalLinkAnchor.tsx`로 보낸다. 그 앵커는 `target="_blank" rel="noreferrer"`라 웹뷰가 새 창/외부로 연다. 보고서 38줄("앱 안 Docs 이동: 못 함")이 맞다. Cmd+클릭도 같은 앵커의 기본 동작이다.

**렌더러가 이미 그리는 것.** `react-markdown@10 + remark-gfm@4`(`markdown/nodeCache.ts`). 직접 렌더해 본 DOM:
- 표: `<table><thead><th>…` — `markdown/MarkdownTable.tsx`(가로 스크롤 상자)와 `td/th` 매핑이 있다. 보기 모드는 이미 된다.
- 할 일 목록: `<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled>` — `markdown/MarkdownInput.tsx`가 체크박스로 그린다. 보기 모드는 이미 된다.
- 각주: `<sup><a href="#user-content-fn-1">` + 맨 아래 `<section data-footnotes>`. 본문은 나오지만 각주 링크가 `ExternalLinkAnchor`(새 창)로 가고, hash 라우터라 `#user-content-fn-1`로 기본 이동을 시키면 라우트 변경으로 오해된다 → 같은 문서 안 스크롤로 잡아야 한다.
- HTML(`<u>`, `<aside>`): `rehype-raw`가 없어서 태그가 **글자 그대로** 보인다(`&lt;aside&gt;…`). 내용은 안 잃는다.
- 표 셀 안 `<br>`: 글자 그대로 `x<br>y`. 내용은 안 잃는다.

**편집기.** `features/docs/ui/DocPageEditor.tsx`는 tiptap v3 + `tiptap-markdown@0.9`(`html: false`). Phase 3의 `markdownFidelity.ts`가 표·각주·할 일·HTML을 만나면 마크다운 소스(textarea) 모드로 열어 바이트를 지킨다. tiptap 쪽 표·할 일 확장은 설치돼 있지 않았다.

**파일 크기 래칫.** `markdown.tsx`는 1861줄로 상한을 넘은 파일이라 한 줄도 못 늘린다. 그래서 링크 처리는 그 파일 밖(`markdown/` 하위 새 파일)에서 하고, `markdown.tsx`는 임포트 이름만 바꾼다(줄 수 그대로).

## 결정

**D1. Docs 링크 인식 규칙** — `shared/lib/docsPageLink.ts`에 파서·빌더를 둔다. 받는 형태: `#/docs/<id>`, `/#/docs/<id>`, `./#/docs/<id>`, 그리고 앱 자기 origin의 절대 URL `<origin>/#/docs/<id>`. 다른 호스트의 `https://…/#/docs/<id>`는 외부 링크로 둔다(남의 사이트를 앱 페이지로 오해하면 안 된다). `<id>`는 코덱의 페이지 id 규칙(`[A-Za-z0-9][A-Za-z0-9_-]{0,127}`)과 같은 상수를 쓴다(한 곳에만 둠).

**D2. 링크 클릭** — `markdown/FallbackLinkAnchor.tsx`(새 파일)가 Docs 링크면 `DocsPageLinkAnchor`(`goDocs`로 이동), 같은 문서 안 조각(`#foo`)이면 스크롤, 나머지는 기존 `ExternalLinkAnchor`. 보조키(Cmd/Ctrl/Shift/Alt)나 가운데/오른쪽 버튼이면 가로채지 않아 기존 동작 그대로. `useAppNavigation`은 Docs 링크일 때만 호출한다(그 훅은 `useLocation` 구독이 있어 채팅의 모든 링크가 물면 비싸다).

**D3. 없는 페이지** — `goDocs`로 간 뒤 `DocsScreen`이 이미 하는 `#d` 단건 조회 → 없으면 안내 화면. 안내 문구에 페이지 id를 넣고, 이전 화면이 있으면 「Go back」(라우터 history.back), 없으면 「Back to Docs」. 조용히 무시하는 경로는 없다.

**D4. 표 편집(tiptap 표 확장 쓰기로 함)** — 근거: ① 보기 모드는 이미 그리므로 남은 건 편집기이고, 지금은 표가 있으면 통째로 textarea가 된다(509쪽이 전부 그 길). ② `tiptap-markdown`은 표 직렬화를 이미 갖고 있다(`nodes/table.js`: 머리행+본문, 셀 안 블록 하나, 병합 없음이면 GFM으로 씀). ③ 그 조건을 못 지키는 표(병합·여러 블록·셀 안 `|`)는 Phase 3의 `compareRenderedMarkdown`(원문 렌더 ↔ 편집기 되읽기 렌더 비교)이 잡아 소스 모드로 떨어뜨린다. 그래서 확장을 켜도 잃는 경로가 생기지 않는다. ④ `@tiptap/extension-table@3.22.5`는 설치돼 있던 tiptap 3.22.5와 같은 버전이 레지스트리에 있어 그대로 맞췄다. 비용: 의존성 1개 추가(`pnpm-lock.yaml` 변경). 표 셀 안 `<br>`는 tiptap-markdown이 HTML을 안 다루므로(`html: false`) 되읽기에서 사라진다 → 비교 검사가 잡아 소스 모드. 즉 「CSV 여러 줄 셀」 페이지는 소스 모드로 남는다(범위 밖으로 기록).

**D5. 할 일 목록 편집(부차)** — `@tiptap/extension-list`(스타터킷이 이미 끌어오는 패키지, 오프라인)에서 `TaskList`/`TaskItem`을 켠다. `tiptap-markdown`이 `markdown-it-task-lists`로 파싱·`- [x]`로 직렬화한다. 표와 같은 비교 검사로 보호.

**D6. 각주·HTML·CSV 여러 줄 셀** — 완전 지원 안 함. 보기: 글자 그대로 보존(위 조사대로). 편집: 소스 모드(기존). 각주 클릭만 문서 안 스크롤로 고친다(D2).


## 단계 1 — Docs 링크 (한 일)

- `desktop/src/shared/lib/docsPageLink.ts`: `DOC_PAGE_ID_PATTERN`, `buildDocsPageLink(pageId)` → `/#/docs/<id>`, `parseDocsPageLink(href, appOrigin)`. 코덱(`docPageCodec.ts`)이 같은 상수를 쓴다.
- `desktop/src/shared/ui/markdown/FallbackLinkAnchor.tsx`(새 파일): 렌더러가 채널·메시지·엔티티 링크가 아닌 것을 넘기는 자리. Docs 링크 → `goDocs`(보조키·비주 버튼이면 안 가로챔), `#조각` → 문서 안 스크롤(hash 라우터가 라우트 변경으로 오해하지 않게 기본 동작 막음), 그 외 → 기존 `ExternalLinkAnchor`.
- `markdown/ExternalLinkAnchor.tsx`: 오른쪽 클릭 메뉴 「Open link」를 앱 안 이동으로 바꿀 수 있는 `openLink` 추가.
- `markdown.tsx`: 임포트 이름 1줄, 태그 2줄, `li`가 `id`를 통과시키게 1줄(각주 대상 `li#user-content-fn-1`이 DOM에 남아야 스크롤이 됨). 1861줄 그대로.
- `DocsScreen.tsx`: 없는 페이지 안내에 페이지 id를 넣고, 이전 화면이 있으면 「Go back」(라우터 `history.back()`), 없으면 「Back to Docs」.
- 테스트: `docsPageLink.test.mjs`(형태 6가지 받음/15가지 거름), `DocsScreen.test.mjs`(링크 클릭 → 라우터 history가 `/docs/<id>`로 움직임, Cmd/Ctrl/가운데 버튼은 기본 동작 유지, 다른 호스트 같은 경로는 외부 링크, 각주 클릭은 스크롤만, 없는 페이지 안내 + Go back). 실제 메모리 history 라우터로 잰다(내비게이션 스텁 아님).

## 노션 보고서 문법 목록 처리 현황

(단계 5 뒤에 채움)

## 범위 밖으로 남긴 것

- 편집기(tiptap) 안에서 Docs 링크를 클릭했을 때의 이동: 편집 중 클릭은 링크 편집 팝오버 규칙(`linkInteractionExtension`)을 따른다. 보기 모드만 다룬다.
- HTML 블록(`<aside>` 같은 노션 콜아웃)을 예쁘게 그리기: 글자 그대로 보존까지만.
- 표 셀 안 줄바꿈(`<br>`)의 표시·편집: 보존만.
- 각주 편집: 소스 모드.


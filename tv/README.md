# a2d2 TV (webOS TV 웹앱)

LG 스마트TV 에서 쓰는 **읽기 전용** 클라이언트.
채널 목록 → 타임라인(kind 9·40002, 실시간 갱신) → Docs(kind 30623 + 레거시
30078) 뷰어를 리모컨 방향키로 본다. 쓰기 기능은 없다.

★**지원선: webOS TV 5.x (Chromium 68) 이상** — 실제 대상 TV 가
LG OLED77GXKNA(2020 GX, webOS 5.x = 크롬 68)라서다. 그래서:

- `vite.config.ts` 의 `build.target: "chrome68"` — ?.·??·클래스 필드 등
  크롬 80+ 문법을 의존성까지 트랜스파일 (문법 담당)
- `src/main.tsx` 첫 줄 `import "core-js/stable"` — globalThis·
  Object.fromEntries·Array.flat·Promise.allSettled 등 없는 API 채움 (API 담당)
- CSS 는 flex `gap`(84+)·`inset`(87+)·`:focus-visible`(86+)·`:has()` 금지 —
  간격은 `> * + *` 마진, 포커스 표시는 `.focused` 클래스
- Tailwind 미사용 (v4 는 크롬 111 미만 불가)
- React 19 는 **실제 Chromium 68(스냅샷 68.0.3440.0)에서 전체 흐름 동작 확인**
  (`scripts/verify-chrome68.mjs`) — 다운그레이드 불필요

- 설계 근거·조사: `~/.buzz/RESEARCH/LG_WEBOS_TV_APP.md`
- TV 설치 절차(개발자 모드·ares·hosted 껍데기): [scripts/README.md](scripts/README.md)

## 개발

```bash
pnpm install          # 레포 루트에서 (pnpm workspace: tv)
pnpm dev              # http://localhost:5183 (1920x1080 창 권장)
pnpm mock-relay       # ws://localhost:7447 모의 릴레이 (NIP-42 포함)
```

접속 설정은 화면에서 넣거나 URL 로 주입한다:
`http://localhost:5183/#relay=ws://localhost:7447&key=<64자리 hex 또는 nsec>`

PC 브라우저에는 리모컨 뒤로가기(키코드 461)가 없어 **Escape** 가 대신한다.

## 게이트

```bash
pnpm check            # biome + typecheck + node:test + build + chrome68 문법 검사
pnpm build            # dist/ (build.target: chrome68, 상대경로)
```

`scripts/check-chrome68.mjs` 가 dist 를 acorn 으로 파스해 크롬 68 에 없는
문법(?.·??·클래스 필드·논리 할당 등)을 전수 검사한다. 진짜 엔진 검증은
`scripts/verify-chrome68.mjs` (Chromium 68 스냅샷 + Rosetta, 절차는
scripts/README.md) — dev 서버는 트랜스파일 전 코드라 **TV 확인은 반드시
`pnpm build && pnpm preview` 산출물로** 한다.

## 구조

```
src/shared/lib/       # settings(캐시 취급 localStorage), relay(REQ·NIP-42·재연결), kinds
src/features/         # channels(39000) · timeline(9/40002 + 프로필 0) · docs(30623/30078) · settings
src/remote/           # norigin-spatial-navigation 배선, 키코드 461, cursorStateChange
webos/                # hosted 껍데기 (appinfo.json + 리다이렉트 index.html + 아이콘)
scripts/              # ares 패키징·설치·실행 + 모의 릴레이
```

릴레이 계층은 `web/src/shared/lib/nostr-client.ts` 를 씨앗으로 새로 조립했고,
Docs 해석은 `desktop/src/features/docs/lib/docPageCodec.ts` 의 읽기 규칙을
그대로 옮겼다(LWW 비교 규칙 동일). 공용화가 더 필요해지면 shared 패키지
추출을 검토한다 — 지금은 tv/ 안에 둔다.

# a2d2 TV (webOS TV 웹앱)

LG 스마트TV(webOS 25+, Chromium 120+)에서 쓰는 **읽기 전용** 클라이언트.
채널 목록 → 타임라인(kind 9·40002, 실시간 갱신) → Docs(kind 30623 + 레거시
30078) 뷰어를 리모컨 방향키로 본다. 쓰기 기능은 없다.

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
pnpm check            # biome + typecheck + node:test 단위 테스트
pnpm build            # dist/ (build.target: chrome120, 상대경로)
```

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

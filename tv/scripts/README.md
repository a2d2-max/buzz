# webOS TV 에 올리는 절차

**대상 TV: LG OLED77GXKNA (2020 GX, webOS TV 5.x = Chromium 68).**
빌드는 chrome68 타깃 + core-js 폴리필로 나온다 (tv/README.md 참조).

TV 웹앱은 **hosted 방식**이다: TV 에는 껍데기 `.ipk`(`tv/webos/`)만 설치하고,
실제 앱 번들(`tv/dist/`)은 서버가 서빙한다. 패키지 앱은 `file://` 로 떠서
ES 모듈이 CORS 로 막히기 때문이다(리서치 문서 1절, LG 포럼 직원 답변).
크롬 68 도 ES 모듈(61+)은 지원하므로 hosted 방식은 5.x 에서도 같은 이유로 유효하다.
(개발자 모드 앱·hosted 웹앱의 5.x 지원 여부를 공식 문서에서 버전 명시로
확인하려 했으나 **버전 언급 자체가 없다** — developer-mode-app 문서 기준.
webOS 4.x 대상 에뮬레이터·문서가 살아 있는 걸로 봐서 5.x 는 지원 범위로
보이지만, 최종 확인은 실기에서 해야 한다.)

## 0. 준비물

```bash
npm install -g @webos-tools/cli   # 이 워크트리에서 3.2.6 설치 확인됨 (2026-09-08)
ares -V
```

옛 webOS TV CLI 가 있으면 먼저 지우라는 게 공식 안내다.

## 1. 앱 번들을 서버에 올리기

```bash
cd tv && pnpm build          # dist/ 생성 (target: chrome68, 상대경로 산출물)
```

`dist/` 를 릴레이(또는 아무 정적 서버)가 서빙하게 하고, 그 주소를
`tv/webos/index.html` 의 `TV_APP_URL` 에 적는다.
★TV 에는 **반드시 빌드 산출물**(`pnpm build && pnpm preview`)을 물린다 —
dev 서버(`pnpm dev`)는 트랜스파일 전 최신 문법이라 크롬 68 에서 안 뜬다.
**릴레이가 tv 번들을 서빙하는 배선은 아직 없다 — 지금은 주소를 손으로 넣는 단계다.**

관전 키 주입: 주소 뒤에 `#relay=wss://…&key=nsec1…` 을 붙이면 설정 화면을
건너뛴다. 앱이 읽자마자 저장하고 주소창에서 지운다.

## 2. TV 개발자 모드 켜기

출처: https://webostv.developer.lge.com/develop/getting-started/developer-mode-app

1. LG Developer 계정 생성 → TV 의 LG Apps 에서 **Developer Mode** 앱 설치·로그인
2. **Dev Mode Status** 켜기 → TV 재부팅
3. PC: `ares-setup-device` → add → TV IP, 포트 **9922**, 사용자 **prisoner**, 비밀번호 없음
4. TV Developer Mode 앱에서 **Key Server** 켜기 → PC 에서
   `ares-novacom --device <이름> --getkey` → TV 화면 왼쪽 아래 6자리 passphrase 입력(대소문자 구분)
5. 연결 확인: `ares-device --system-info --device <이름>`

### ★ 세션 시간 주의

개발자 모드는 **시간 제한 세션**이다. Developer Mode 앱의 Remain Session 이
0 이 되면 **연장 불가 + 설치한 앱 전부 삭제**된다. 주기적으로 **EXTEND** 를
눌러 연장할 것. 네트워크 없이 10번 재부팅해도 꺼진다.
(몇 시간짜리인지 공식 수치는 문서에 없다 — 확인 못 함)

## 3. 패키징 → 설치 → 실행

```bash
./scripts/package.sh                 # dist-ipk/xyz.a2d2.tv_0.1.0_all.ipk
./scripts/install.sh <device>        # ares-install
./scripts/launch.sh <device>         # ares-launch xyz.a2d2.tv
```

디버깅: `ares-inspect --device <device> --app xyz.a2d2.tv --open`

## 4. TV 없이 확인 (webOS 5.x 기준)

- ★**실제 Chromium 68 로 검증** (권장 — 이 세션에서 통과 확인):

  ```bash
  # 1) 크롬 68 스냅샷 받기 (Mac x64 — Apple Silicon 은 Rosetta 로 돈다)
  curl -o /tmp/chrome68.zip \
    "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/561733/chrome-mac.zip"
  unzip -d /tmp/chrome68 /tmp/chrome68.zip
  xattr -dr com.apple.quarantine /tmp/chrome68/chrome-mac/Chromium.app
  # 2) 빌드 산출물 + 모의 릴레이 띄우기
  pnpm build && pnpm preview --port 4183 &   # dev 서버는 증거가 안 된다
  pnpm mock-relay &
  # 3) CDP 로 방향키 흐름을 밟고 스크린샷을 남긴다
  node scripts/verify-chrome68.mjs \
    /tmp/chrome68/chrome-mac/Chromium.app/Contents/MacOS/Chromium \
    "http://localhost:4183/#relay=ws://localhost:7447&key=<아무 64자리 hex>" \
    /tmp/c68-shots
  ```

- **webOS TV Emulator (5.0)**: 공식 배포는 있으나 macOS 는 **Intel 전용 —
  Apple Silicon 미지원**이라 이 맥에서는 못 쓴다
  (출처: emulator-installation 문서. webOS 22부터는 에뮬레이터 미제공).
  webOS TV **Simulator 는 최근 버전(25 등)용이라 5.x 검증엔 해당 없음**.
- **일반 브라우저**: `pnpm dev` + 1920x1080 창에서 방향키·Enter. 뒤로가기(461)는
  PC 에 없으니 **Escape** 가 같은 역할(`src/remote/keys.ts`). 단, 최신 크로미움
  통과는 크롬 68 증거가 아니다 — 위의 실엔진 검증이나 게이트로 재확인.
- **문법 게이트**: `pnpm check` 안의 `scripts/check-chrome68.mjs` 가 dist 를
  acorn 으로 파스해 크롬 68 금지 문법을 전수 검사한다.
- **모의 릴레이**: `pnpm mock-relay` 가 localhost:7447 에 NIP-42 AUTH 를 포함한
  가짜 릴레이를 띄운다. `#relay=ws://localhost:7447&key=<아무 hex 키>` 로 접속.

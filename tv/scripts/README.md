# webOS TV 에 올리는 절차

TV 웹앱은 **hosted 방식**이다: TV 에는 껍데기 `.ipk`(`tv/webos/`)만 설치하고,
실제 앱 번들(`tv/dist/`)은 서버가 서빙한다. 패키지 앱은 `file://` 로 떠서
ES 모듈이 CORS 로 막히기 때문이다(리서치 문서 1절, LG 포럼 직원 답변).

## 0. 준비물

```bash
npm install -g @webos-tools/cli   # 이 워크트리에서 3.2.6 설치 확인됨 (2026-09-08)
ares -V
```

옛 webOS TV CLI 가 있으면 먼저 지우라는 게 공식 안내다.

## 1. 앱 번들을 서버에 올리기

```bash
cd tv && pnpm build          # dist/ 생성 (target: chrome120, 상대경로 산출물)
```

`dist/` 를 릴레이(또는 아무 정적 서버)가 서빙하게 하고, 그 주소를
`tv/webos/index.html` 의 `TV_APP_URL` 에 적는다.
개발 중엔 PC 의 dev 서버(`pnpm dev`, 포트 5183) 주소를 넣어도 된다.
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

## 4. TV 없이 확인

- **webOS TV Simulator**: 사이트에서 버전별 배포(webOS 25 는 macOS ARM64 전용).
  설치 페이지에서 스크립트로 받을 수 있는 직접 링크를 못 찾아(페이지가 JS 렌더)
  **비대화식 설치는 확인 못 했다** — 사이트에서 수동으로 받아 압축 해제 후 실행,
  또는 webOS Studio(VS Code 확장)의 Package Manager 로 설치한다.
- **일반 브라우저(Chromium 계열)**: `pnpm dev` 로 띄우고 1920x1080 창에서
  방향키·Enter 로 조작한다. 뒤로가기(461)는 PC 에 없으니 **Escape** 가
  같은 역할을 한다(`src/remote/keys.ts`).
- **모의 릴레이**: `pnpm mock-relay` 가 localhost:7447 에 NIP-42 AUTH 를 포함한
  가짜 릴레이를 띄운다. `#relay=ws://localhost:7447&key=<아무 hex 키>` 로 접속.

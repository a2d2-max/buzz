# A2D2 클라우드 데스크톱 빌드

이 포크는 Buzz relay와 AFFiNE, Plane의 공개 주소를
[`config/a2d2-cloud.json`](config/a2d2-cloud.json)에 둔다. 이 설정에는
자격 정보가 없다. 백엔드 비밀값, 원본 앱 계정, A2D2 개인 키는 각 실행
환경에서 관리하며 이 파일에 추가하지 않는다.

빌드 없이 설정을 검사한다.

```sh
. ./bin/activate-hermit
just desktop-a2d2-release-config-check
```

일반 제품 앱 식별자를 유지한 로컬 배포 형태를 빌드한다.

```sh
just desktop-a2d2-release-build aarch64-apple-darwin
```

A2D2 전용 release runner는 Rust lockfile로 sidecar 6종을 release build한 뒤
bundle 안의 각 실행 파일이 새 결과와 byte-identical이고 비어 있지 않은지
검사한다. JavaScript 의존성도 frozen lockfile로 설치한 뒤 normal bundle ID와
`mesh-llm` feature를 유지한 Tauri app bundle을 만든다. 실행 스크립트는
`BUZZ_RELAY_URL`, `BUZZ_RELAY_HTTP`, `BUZZ_AFFINE_URL`,
`BUZZ_PLANE_URL`을 전달하고,
`desktop/src-tauri/build.rs`가 네이티브 호스트가 읽는 내부 컴파일 값으로 바꾼다.
내부 이름인 `BUZZ_DESKTOP_*`를 직접 설정하지 않는다.

실행 스크립트는 데모 이름과 상속된 QA 개인 키 입력을 거부한다.
`tauri.conf.json`은 바꾸지 않으므로 제품 식별자, 딥 링크 방식,
키체인 서비스, 데이터 디렉터리는 일반 A2D2 값을 유지한다.

Upstream OSS 태그 작업흐름은 그대로이며 이 포크 전용 설정을 읽지 않는다.
향후 A2D2 서명 작업흐름은 저장소 변수가 이미 있다고 가정하지 말고 같은
실행 스크립트로 Tauri build를 실행하거나 네 공개 입력 변수를 같은 방식으로
검사하고 주입해야 한다.

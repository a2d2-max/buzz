import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 실제 TV = LG OLED77GXKNA (2020 GX, webOS TV 5.x) = Chromium 68.
// target 을 chrome68 로 박아 ?.·??·클래스 필드 같은 크롬 80+ 문법을
// 의존성까지 포함해 전부 트랜스파일한다. 크롬 68 은 ES 모듈(61+)을
// 지원하므로 legacy 이중 빌드 없이 modern 빌드 하나로 간다.
// 없는 API(globalThis·Object.fromEntries 등)는 main.tsx 첫 줄의
// core-js 폴리필이 채운다 — 문법은 여기, API 는 core-js, 역할이 다르다.
export default defineConfig({
  plugins: [react()],
  build: {
    target: "chrome68",
  },
  // hosted 웹앱이 하위 경로에서 서빙될 수 있으니 상대 경로 산출물로 만든다.
  base: "./",
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    port: parseInt(process.env.VITE_PORT || "5183", 10),
    strictPort: true,
  },
});

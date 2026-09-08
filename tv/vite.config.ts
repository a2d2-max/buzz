import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// webOS TV 25 = Chromium 120 이 지원선이라 target 을 명시한다.
// (Vite 8 기본값 baseline-widely-available 은 Chrome 111 이지만,
//  지원선을 코드에 박아 두어야 나중에 기본값이 올라가도 안 깨진다)
export default defineConfig({
  plugins: [react()],
  build: {
    target: "chrome120",
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

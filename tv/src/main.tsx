// 폴리필이 무조건 첫 줄 — 크롬 68(webOS TV 5.x)에 없는 API 들
// (globalThis·Object.fromEntries·Array.flat·Promise.allSettled·
//  String.matchAll·queueMicrotask 등)을 다른 모듈이 평가되기 전에 채운다.
// 문법(?.·??·클래스 필드)은 vite build.target chrome68 이 트랜스파일한다.
import "core-js/stable";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { initSpatialNavigation } from "./remote/spatial.ts";
import "./styles.css";

// useFocusable 이 불리기 전에 spatial nav 를 먼저 세워야 한다.
initSpatialNavigation();

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

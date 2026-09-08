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

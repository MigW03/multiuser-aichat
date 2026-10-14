import { App, applyTheme } from "@mc/ui";
import "@mc/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

applyTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { createRoot } from "react-dom/client";
import App from "./App";
import "./fetchWithAuth";
import "./theme";

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/dist/sw.js", {
        updateViaCache: "none",
        scope: "/",
      })
      .catch(() => {});
  }
});

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

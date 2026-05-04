export type ThemePref = "system" | "dark" | "light";

const STORAGE_KEY = "fifos.theme";

let currentPref: ThemePref = "system";
let userTouched = false;
let mql: MediaQueryList | null = null;
let mqlListener: (() => void) | null = null;

function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "dark" || v === "light";
}

function readStoredPref(): ThemePref {
  if (typeof localStorage === "undefined") return "system";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemePref(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function writeStoredPref(pref: ThemePref): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {}
}

function resolveAndApply(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (mql && mqlListener) {
    mql.removeEventListener("change", mqlListener);
    mql = null;
    mqlListener = null;
  }
  if (pref === "system") {
    mql = window.matchMedia("(prefers-color-scheme: light)");
    mqlListener = () => {
      html.setAttribute("data-theme", mql?.matches ? "light" : "dark");
    };
    mqlListener();
    mql.addEventListener("change", mqlListener);
  } else {
    html.setAttribute("data-theme", pref);
  }
}

// Paint synchronously at module import — runs before React mounts, so
// the cached preference is applied before first render.
currentPref = readStoredPref();
resolveAndApply(currentPref);

export function reconcileTheme(serverPref: unknown): void {
  if (userTouched) return;
  const next = isThemePref(serverPref) ? serverPref : "system";
  if (next === currentPref) return;
  currentPref = next;
  writeStoredPref(next);
  resolveAndApply(next);
}

export function getThemePref(): ThemePref {
  return currentPref;
}

export function setThemePref(pref: ThemePref): void {
  userTouched = true;
  currentPref = pref;
  writeStoredPref(pref);
  resolveAndApply(pref);
  fetch("/f/settings/me", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: { theme: pref } }),
  }).catch(() => null);
}

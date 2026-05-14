export type ThemePref = "system" | "dark" | "light";

const STORAGE_KEY = "pues.theme";

let currentPref: ThemePref = "system";
let userTouched = false;
let mql: MediaQueryList | null = null;
let mqlListener: (() => void) | null = null;
let initialized = false;

function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "dark" || v === "light";
}

function readStored(): ThemePref {
  if (typeof localStorage === "undefined") return "system";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemePref(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function writeStored(pref: ThemePref): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {}
}

function apply(pref: ThemePref): void {
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

export function installTheme(): void {
  if (initialized) return;
  initialized = true;
  currentPref = readStored();
  apply(currentPref);
}

export function reconcileTheme(serverPref: unknown): void {
  if (userTouched) return;
  const next = isThemePref(serverPref) ? serverPref : "system";
  if (next === currentPref) return;
  currentPref = next;
  writeStored(next);
  apply(next);
}

export function getThemePref(): ThemePref {
  return currentPref;
}

export function setThemePref(pref: ThemePref): void {
  userTouched = true;
  currentPref = pref;
  writeStored(pref);
  apply(pref);
}

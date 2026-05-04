export type ThemePref = "system" | "dark" | "light";

let currentPref: ThemePref = "system";
let mql: MediaQueryList | null = null;
let mqlListener: (() => void) | null = null;

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

function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "dark" || v === "light";
}

export function initTheme(pref: unknown): void {
  currentPref = isThemePref(pref) ? pref : "system";
  resolveAndApply(currentPref);
}

export function getThemePref(): ThemePref {
  return currentPref;
}

export function setThemePref(pref: ThemePref): void {
  currentPref = pref;
  resolveAndApply(pref);
  fetch("/f/settings/me", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: { theme: pref } }),
  }).catch(() => null);
}

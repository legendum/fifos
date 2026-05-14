import { useState } from "react";
import { getThemePref, setThemePref, type ThemePref } from "./state";

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeChooser({ endpoint }: { endpoint?: string }) {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());

  function choose(next: ThemePref) {
    setPref(next);
    setThemePref(next);
    if (endpoint) {
      fetch(endpoint, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta: { theme: next } }),
      }).catch(() => null);
    }
  }

  return (
    <fieldset className="pues-theme-chooser">
      <legend className="pues-sr-only">Color theme</legend>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="pues-theme-chooser-option"
          aria-pressed={pref === opt.value}
          onClick={() => choose(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </fieldset>
  );
}

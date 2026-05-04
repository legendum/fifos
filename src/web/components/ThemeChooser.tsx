import { useState } from "react";
import { getThemePref, setThemePref, type ThemePref } from "../theme";

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function ThemeChooser() {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());
  return (
    <fieldset className="theme-chooser">
      <legend className="sr-only">Color theme</legend>
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="theme-chooser-option"
          aria-pressed={pref === opt.value}
          onClick={() => {
            setPref(opt.value);
            setThemePref(opt.value);
          }}
        >
          {opt.label}
        </button>
      ))}
    </fieldset>
  );
}

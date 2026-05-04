import { useEffect, useRef } from "react";

type Counter = {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

export default function EditTextDialog({
  title,
  text,
  placeholder,
  counter,
  onChange,
  onSave,
  onClose,
}: {
  title: string;
  text: string;
  placeholder?: string;
  counter?: Counter;
  onChange: (text: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button type="button" className="dialog-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="dialog-body">
          <input
            ref={inputRef}
            className="input"
            value={text}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
            }}
            style={{ width: "100%" }}
          />
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 12,
              justifyContent: counter ? "space-between" : "flex-end",
              alignItems: "center",
            }}
          >
            {counter ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#94a3b8", fontSize: 13 }}>
                  {counter.label}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    counter.onChange(Math.max(counter.min, counter.value - 1))
                  }
                  disabled={counter.value <= counter.min}
                  style={{ minWidth: 32, padding: "4px 10px" }}
                  aria-label={`Decrease ${counter.label}`}
                >
                  −
                </button>
                <span
                  style={{
                    minWidth: 24,
                    textAlign: "center",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {counter.value}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    counter.onChange(Math.min(counter.max, counter.value + 1))
                  }
                  disabled={counter.value >= counter.max}
                  style={{ minWidth: 32, padding: "4px 10px" }}
                  aria-label={`Increase ${counter.label}`}
                >
                  +
                </button>
              </div>
            ) : null}
            <button type="button" className="btn" onClick={onSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

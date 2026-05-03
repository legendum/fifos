import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CopyIcon from "./CopyIcon";

const INSTALL_CMD = "curl -fsSL https://fifos.in/install.sh | sh";
const COPY_ACK_MS = 850;

type Props = {
  onClose: () => void;
};

export default function InstallDialog({ onClose }: Props) {
  const [installCopiedFlash, setInstallCopiedFlash] = useState(false);
  const copyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (copyFlashTimer.current) clearTimeout(copyFlashTimer.current);
    };
  }, [onClose]);

  async function copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
      if (copyFlashTimer.current) clearTimeout(copyFlashTimer.current);
      setInstallCopiedFlash(true);
      copyFlashTimer.current = setTimeout(() => {
        setInstallCopiedFlash(false);
        copyFlashTimer.current = null;
      }, COPY_ACK_MS);
    } catch {
      /* clipboard unavailable */
    }
  }

  const overlay = (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 style={{ margin: 0, fontSize: 18 }}>Install the fifos CLI</h2>
          <button className="dialog-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="dialog-body">
          <section className="dialog-section">
            <div className="dialog-section-head">
              <h3>1. Install</h3>
              {installCopiedFlash ? (
                <span className="dialog-copy-hint" role="status">
                  Copied
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className={`dialog-code-install-wrap${installCopiedFlash ? " dialog-code--flash" : ""}`}
              onClick={copyInstallCommand}
              aria-label="Copy install command"
            >
              <span className="dialog-code-install-scroll">{INSTALL_CMD}</span>
              <span className="dialog-code-install-icon" aria-hidden="true">
                <CopyIcon />
              </span>
            </button>
          </section>

          <section className="dialog-section">
            <h3>2. Add your webhook to a project</h3>
            <p>
              Each fifo has a webhook URL (tap the URL under the fifo name to
              copy it). Add it to your project's <code>.env</code>:
            </p>
            <pre className="dialog-code">
              FIFOS_WEBHOOK=https://fifos.in/w/01ABC123DEF456GHI789
            </pre>
          </section>

          <section className="dialog-section">
            <h3>3. Use it</h3>
            <pre className="dialog-code">
              {`fifos push '{"build":42}'   # append work
fifos pop                    # consume oldest (fire-and-forget)
fifos pull                   # at-least-once (writes .fifos-lock)
fifos ack                    # mark current as done
fifos nack                   # mark current as fail
fifos info                   # show counts
fifos list open              # show open items
fifos open                   # open in browser`}
            </pre>
          </section>

          <section className="dialog-section">
            <h3>4. Teach your AI agent</h3>
            <p>
              Install the skill file so Claude Code and Cursor know how to use
              your fifos:
            </p>
            <pre className="dialog-code">fifos skill</pre>
          </section>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(overlay, document.body)
    : null;
}

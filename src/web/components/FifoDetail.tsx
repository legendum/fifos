import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ITEM_STATUSES } from "../../lib/web_constants.js";
import type { FifoEntry, Item, ItemStatus, StatusCounts } from "../types";
import CheckIcon from "./CheckIcon";
import CopyIcon from "./CopyIcon";
import EditTextDialog from "./EditTextDialog";
import { useKeyboardSafeBottom } from "./useKeyboardSafeBottom";
import { useOnlineStatus } from "./useOnlineStatus";
import { usePageTitle } from "./usePageTitle";

type Props = {
  fifo: FifoEntry;
  onBack: () => void;
  onRenamed: (updated: { name: string; slug: string }) => void;
  filterQuery: string;
};

const PUSH_TRUNCATE_LEN = 240;

/** Relative time since last item update (`updated_at`, unix seconds). */
function relativeUpdatedAgo(unixSec: number): string {
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (sec < 60) return "just now";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function truncate(s: string, n = PUSH_TRUNCATE_LEN): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n).trimEnd()}…`;
}

export default function FifoDetail({
  fifo,
  onBack,
  onRenamed,
  filterQuery,
}: Props) {
  const [status, setStatus] = useState<ItemStatus>("todo");
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<StatusCounts>(fifo.counts);
  const [pushing, setPushing] = useState(false);
  const [pushText, setPushText] = useState("");
  const [pushError, setPushError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Item | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState(fifo.name);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addBarRef = useRef<HTMLDivElement>(null);
  const online = useOnlineStatus();
  /** Bumps every minute so "Xm ago" / "Xh ago" labels stay current. */
  const [ageTick, setAgeTick] = useState(0);

  usePageTitle(`${fifo.name} — Fifos`);
  useKeyboardSafeBottom(addBarRef);

  const total = useMemo(
    () => counts.todo + counts.lock + counts.done + counts.fail + counts.skip,
    [counts],
  );

  const filtered = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.data.toLowerCase().includes(q));
  }, [items, filterQuery]);

  const fetchDetail = useCallback(
    async (s: ItemStatus) => {
      try {
        const r = await fetch(`/${fifo.slug}.json?status=${s}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!r.ok) return;
        const data = (await r.json()) as {
          counts: StatusCounts;
          items: Item[];
        };
        setCounts(data.counts);
        setItems(data.items);
      } catch {
        /* offline */
      }
    },
    [fifo.slug],
  );

  useEffect(() => {
    void fetchDetail(status);
  }, [fetchDetail, status]);

  useEffect(() => {
    const id = window.setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Live updates from the public per-fifo SSE stream.
  useEffect(() => {
    if (!online) return;
    const es = new EventSource(`/w/${fifo.ulid}/items`);
    const refetch = () => void fetchDetail(status);
    es.addEventListener("push", refetch);
    es.addEventListener("change", refetch);
    es.addEventListener("purge", refetch);
    es.addEventListener("resync", refetch);
    return () => es.close();
  }, [online, fifo.ulid, fetchDetail, status]);

  const copyWebhookUrl = () => {
    if (typeof navigator === "undefined") return;
    const url = `${window.location.origin}/w/${fifo.ulid}`;
    navigator.clipboard?.writeText(url);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(true);
    copyTimer.current = setTimeout(() => setCopied(false), 850);
  };

  const submitPush = async () => {
    const body = pushText;
    if (!body.trim()) return;
    setPushError(null);
    try {
      const r = await fetch(`/w/${fifo.ulid}/push`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setPushError(data.message || data.error || "Push failed");
        return;
      }
      setPushText("");
      setPushing(false);
      await fetchDetail(status);
      window.dispatchEvent(new Event("fifos-credits-refresh"));
    } catch {
      setPushError("Network error");
    }
  };

  const saveRename = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === fifo.name) {
      setEditingName(false);
      return;
    }
    const r = await fetch(`/${fifo.slug}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!r.ok) {
      setEditingName(false);
      return;
    }
    const data = (await r.json()) as { name: string; slug: string };
    onRenamed({ name: data.name, slug: data.slug });
    setEditingName(false);
  };

  return (
    <div className="screen">
      <div className="fifo-detail-header">
        <button className="back-btn" onClick={onBack}>
          ◀ Back
        </button>
        <div className="fifo-detail-titles">
          <button
            type="button"
            className="fifo-detail-name"
            onClick={() => {
              setEditName(fifo.name);
              setEditingName(true);
            }}
          >
            {fifo.name}
          </button>
          <button
            type="button"
            className="fifo-webhook-copy"
            onClick={copyWebhookUrl}
            title={copied ? "Copied" : "Copy webhook URL"}
          >
            <span className="fifo-webhook-text">/w/{fifo.ulid}</span>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      <div className="status-chips">
        {ITEM_STATUSES.map((s) => (
          <button
            type="button"
            key={s}
            className={`chip${status === s ? " chip--active" : ""}`}
            onClick={() => setStatus(s)}
          >
            {s} <span className="chip-count">{counts[s]}</span>
          </button>
        ))}
      </div>

      <ul className="list" data-age-tick={ageTick}>
        {filtered.map((it) => (
          <li key={it.id} className="item-row" onClick={() => setExpanded(it)}>
            <div className="item-row-main">
              <span className={`item-status item-status--${it.status}`}>
                {it.status}
              </span>
              <span className="item-pos">#{it.position}</span>
              <span
                className="item-age"
                title={`Updated ${new Date(it.updated_at * 1000).toLocaleString()}`}
              >
                {relativeUpdatedAgo(it.updated_at)}
              </span>
            </div>
            <div className="item-body">{truncate(it.data)}</div>
            {it.reason && (
              <div className="item-reason">{truncate(it.reason)}</div>
            )}
          </li>
        ))}
      </ul>

      {filtered.length === 0 && (
        <p style={{ padding: 16, color: "#64748b", textAlign: "center" }}>
          {total === 0
            ? "Empty fifo. Tap + to push an item."
            : items.length === 0
              ? `No ${status} items.`
              : "No items match the filter."}
        </p>
      )}

      {pushing ? (
        <div className="form" ref={addBarRef}>
          <textarea
            className="input"
            placeholder="Item body (text — JSON, Markdown, plain)"
            value={pushText}
            onChange={(e) => setPushText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitPush();
            }}
            rows={6}
            autoFocus
          />
          {pushError && (
            <p style={{ color: "#f87171", fontSize: 13, margin: 0 }}>
              {pushError}
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={submitPush}
              disabled={!pushText.trim()}
            >
              Push
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setPushing(false);
                setPushText("");
                setPushError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="fab" onClick={() => setPushing(true)}>
          +
        </button>
      )}

      {expanded && (
        <div className="dialog-overlay" onClick={() => setExpanded(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2 style={{ margin: 0, fontSize: 16 }}>
                #{expanded.position} · {expanded.status}
                <span
                  style={{
                    display: "block",
                    fontSize: 13,
                    fontWeight: 400,
                    color: "#94a3b8",
                    marginTop: 4,
                  }}
                  title={`Updated ${new Date(expanded.updated_at * 1000).toLocaleString()}`}
                >
                  {relativeUpdatedAgo(expanded.updated_at)}
                </span>
              </h2>
              <button
                className="dialog-close"
                onClick={() => setExpanded(null)}
              >
                &times;
              </button>
            </div>
            <div className="dialog-body">
              <pre className="dialog-code" style={{ whiteSpace: "pre-wrap" }}>
                {expanded.data}
              </pre>
              {expanded.reason && (
                <div className="dialog-reason">
                  <div className="dialog-reason-label">Reason</div>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                    {expanded.reason}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {editingName && (
        <EditTextDialog
          title="Rename fifo"
          placeholder="Fifo name"
          text={editName}
          onChange={setEditName}
          onSave={saveRename}
          onClose={() => setEditingName(false)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ITEM_STATUSES } from "../../lib/web_constants.js";
import type { FifoEntry, Item, ItemStatus, StatusCounts } from "../types";
import CopyIcon from "./CopyIcon";
import { useEscape } from "./useEscape";
import { useOnlineStatus } from "./useOnlineStatus";
import { usePageTitle } from "./usePageTitle";

type Props = {
  fifo: FifoEntry;
  onBack: () => void;
  onRenamed: (updated: { name: string; slug: string }) => void;
  filterQuery: string;
};

const PUSH_TRUNCATE_LEN = 240;
const COPY_FEEDBACK_MS = 850;

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

function formatLocalDateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}

function truncate(s: string, n = PUSH_TRUNCATE_LEN): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n).trimEnd()}…`;
}

function useClipboardFeedback() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setCopied(false);
  }, []);

  const copy = useCallback((text: string) => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard?.writeText(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }, []);

  return { copied, copy, reset };
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
  const webhookClipboard = useClipboardFeedback();
  const itemClipboard = useClipboardFeedback();
  const detailBodyRef = useRef<HTMLDivElement>(null);
  const bottomDockRef = useRef<HTMLDivElement>(null);
  const pushTextareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const online = useOnlineStatus();
  /** Bumps every minute so "Xm ago" / "Xh ago" labels stay current. */
  const [ageTick, setAgeTick] = useState(0);

  usePageTitle(`${fifo.name} — Fifos`);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const syncDetailBody = () => {
      const el = detailBodyRef.current;
      if (el) el.style.transform = `translateY(${vv.offsetTop}px)`;
    };
    const syncDockBottom = () => {
      const el = bottomDockRef.current;
      if (!el) return;
      el.style.bottom = `${Math.max(0, window.innerHeight - vv.offsetTop - vv.height)}px`;
    };
    const update = () => {
      syncDetailBody();
      syncDockBottom();
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      if (detailBodyRef.current) detailBodyRef.current.style.transform = "";
      if (bottomDockRef.current) bottomDockRef.current.style.bottom = "";
    };
  }, []);

  useEffect(() => {
    if (!pushing) return;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pushTextareaRef.current?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(id);
  }, [pushing]);

  const total = useMemo(
    () => counts.todo + counts.lock + counts.done + counts.fail + counts.skip,
    [counts],
  );

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState(filterQuery);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(filterQuery), 150);
    return () => window.clearTimeout(t);
  }, [filterQuery]);

  const fetchPage = useCallback(
    async (s: ItemStatus, q: string, cursor: number | null) => {
      const params = new URLSearchParams({ status: s, limit: "100" });
      if (q) params.set("q", q);
      if (cursor !== null) params.set("cursor", String(cursor));
      const r = await fetch(`/${fifo.slug}.json?${params.toString()}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!r.ok) return null;
      return (await r.json()) as {
        counts: StatusCounts;
        items: Item[];
        has_more: boolean;
      };
    },
    [fifo.slug],
  );

  const fetchFirstPage = useCallback(
    async (s: ItemStatus, q: string) => {
      try {
        const data = await fetchPage(s, q, null);
        if (!data) return;
        setCounts(data.counts);
        setItems(data.items);
        setHasMore(data.has_more);
      } catch {
        /* offline */
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void fetchFirstPage(status, debouncedQuery);
  }, [fetchFirstPage, status, debouncedQuery]);

  useEffect(() => {
    const rootEl = listScrollRef.current;
    const el = sentinelRef.current;
    if (!rootEl || !el || !hasMore || loadingMore) return;
    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setLoadingMore(true);
        try {
          const last = items[items.length - 1];
          if (!last) return;
          const data = await fetchPage(status, debouncedQuery, last.position);
          if (data) {
            setItems((prev) => [...prev, ...data.items]);
            setHasMore(data.has_more);
          }
        } finally {
          setLoadingMore(false);
        }
      },
      { root: rootEl, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, items, fetchPage, status, debouncedQuery]);

  useEffect(() => {
    const id = window.setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Live updates from the public per-fifo SSE stream.
  useEffect(() => {
    if (!online) return;
    const es = new EventSource(`/w/${fifo.ulid}/items`);
    const refetch = () => void fetchFirstPage(status, debouncedQuery);
    es.addEventListener("push", refetch);
    es.addEventListener("change", refetch);
    es.addEventListener("purge", refetch);
    es.addEventListener("resync", refetch);
    return () => es.close();
  }, [online, fifo.ulid, fetchFirstPage, status, debouncedQuery]);

  useEscape(!!expanded, () => setExpanded(null));

  useEffect(() => {
    itemClipboard.reset();
  }, [expanded?.id, itemClipboard.reset]);

  useEscape(pushing, () => {
    setPushing(false);
    setPushText("");
    setPushError(null);
  });

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
      await fetchFirstPage(status, debouncedQuery);
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

  const cancelEditName = () => {
    setEditName(fifo.name);
    setEditingName(false);
  };

  return (
    <div className="screen screen--detail">
      <div ref={detailBodyRef} className="fifo-detail-body">
        <div className="fifo-detail-fixed-top">
          <div className="fifo-detail-header">
            <button className="back-btn" onClick={onBack}>
              ◀ Back
            </button>
            <div className="fifo-detail-titles">
              {editingName ? (
                <input
                  ref={nameInputRef}
                  type="text"
                  className="fifo-detail-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={saveRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                      cancelEditName();
                      nameInputRef.current?.blur();
                    }
                  }}
                  autoFocus
                />
              ) : (
                <button
                  type="button"
                  className="fifo-detail-name"
                  title="Click to rename fifo"
                  onClick={() => {
                    setEditName(fifo.name);
                    setEditingName(true);
                  }}
                >
                  {fifo.name}
                </button>
              )}
              <button
                type="button"
                className="fifo-webhook-copy"
                onClick={() => webhookClipboard.copy(fifo.ulid)}
                title={
                  webhookClipboard.copied
                    ? "Copied to clipboard"
                    : "Click to copy fifo ULID"
                }
              >
                <span className="fifo-webhook-text">{fifo.ulid.slice(0, -6)}…</span>
                {webhookClipboard.copied ? (
                  <span className="copied-badge">Copied!</span>
                ) : (
                  <CopyIcon />
                )}
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
        </div>

        <div ref={listScrollRef} className="fifo-detail-scroll">
          <ul className="list" data-age-tick={ageTick}>
            {items.map((it) => (
              <li
                key={it.id}
                className="item-row"
                onClick={() => setExpanded(it)}
              >
                <div className="item-row-main">
                  <span className={`item-status item-status--${it.status}`}>
                    {it.status}
                  </span>
                  <span className="item-pos">#{it.position}</span>
                  <span
                    className="item-age"
                    title={`Updated ${formatLocalDateTime(it.updated_at)}`}
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

          {hasMore && (
            <div ref={sentinelRef} className="list-scroll-sentinel" />
          )}

          {items.length === 0 && (
            <p className="empty-state-hint">
              {total === 0
                ? "Empty fifo. Tap + to push an item."
                : debouncedQuery
                  ? "No items match the filter."
                  : `No ${status} items.`}
            </p>
          )}
        </div>
      </div>

      <div ref={bottomDockRef} className="fifo-add-dock">
        {pushing ? (
          <div className="fifo-add-dock-inner fifo-add-dock-inner--form">
            <div className="form">
              <textarea
                ref={pushTextareaRef}
                className="input"
                placeholder="Item body (text — JSON, Markdown, plain)"
                value={pushText}
                onChange={(e) => setPushText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                    submitPush();
                }}
                rows={6}
              />
              {pushError && <p className="form-error">{pushError}</p>}
              <div className="form-button-row">
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
          </div>
        ) : (
          <div className="fifo-add-dock-inner fifo-add-dock-inner--fab">
            <button
              type="button"
              className="fab"
              onClick={() => setPushing(true)}
            >
              +
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="dialog-overlay" onClick={() => setExpanded(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <div className="dialog-header-main">
                <h2 className="dialog-heading-title dialog-heading-title--compact">
                  #{expanded.position} · {expanded.status}
                </h2>
                <button
                  type="button"
                  className="fifo-webhook-copy"
                  onClick={() => itemClipboard.copy(expanded.id)}
                  title={
                    itemClipboard.copied
                      ? "Copied to clipboard"
                      : "Click to copy item ULID"
                  }
                >
                  <span className="fifo-webhook-text">{expanded.id.slice(0, -6)}…</span>
                  {itemClipboard.copied ? (
                    <span className="copied-badge">Copied!</span>
                  ) : (
                    <CopyIcon />
                  )}
                </button>
              </div>
              <button
                className="dialog-close"
                onClick={() => setExpanded(null)}
              >
                &times;
              </button>
            </div>
            <div className="dialog-body">
              <pre className="dialog-code dialog-code--pre-wrap">
                {expanded.data}
              </pre>
              {expanded.reason && (
                <div className="dialog-reason">
                  <div className="dialog-reason-label">Reason</div>
                  <pre className="dialog-pre-pre-wrap">{expanded.reason}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Fragment,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { FifoEntry } from "../types";
import DragHandle from "./DragHandle";
import EditTextDialog from "./EditTextDialog";
import ThemeChooser from "./ThemeChooser";
import { useEscape } from "./useEscape";
import { useOnlineStatus } from "./useOnlineStatus";
import { useSwipeToReveal } from "./useSwipeToReveal";

type Props = {
  onSelect: (entry: FifoEntry) => void;
  filterQuery: string;
  filterInputRef: RefObject<HTMLInputElement | null>;
  visible: boolean;
};

async function patchFifo(
  slug: string,
  body: { name?: string; max_retries?: number },
): Promise<boolean> {
  try {
    const res = await fetch(`/${slug}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function Fifos({
  onSelect,
  filterQuery,
  filterInputRef,
  visible,
}: Props) {
  const [fifos, setFifos] = useState<FifoEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [renameFifo, setRenameFifo] = useState<FifoEntry | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameMaxRetries, setRenameMaxRetries] = useState(1);
  const [deleteFifo, setDeleteFifo] = useState<FifoEntry | null>(null);

  const filterTrim = filterQuery.trim().toLowerCase();
  const filteredFifos = useMemo(() => {
    if (!filterTrim) return fifos;
    return fifos.filter(
      (f) =>
        f.name.toLowerCase().includes(filterTrim) ||
        f.slug.toLowerCase().includes(filterTrim) ||
        f.ulid.toLowerCase().includes(filterTrim),
    );
  }, [fifos, filterTrim]);

  const filterActive = filterTrim.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 6 } }),
  );

  const fetchFifos = useCallback(async () => {
    try {
      const res = await fetch("/", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { fifos: FifoEntry[] };
      setFifos(data.fifos);
    } catch {
      /* offline — keep current state */
    }
  }, []);

  useEffect(() => {
    if (visible) fetchFifos();
  }, [visible, fetchFifos]);

  // Move focus to filter when the home list is shown (including returning from a fifo).
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      filterInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [visible, filterInputRef]);

  const online = useOnlineStatus();

  // Live updates via the per-user SSE stream (push/pop/change/purge/rename
  // all coalesce into a single 'fifos' snapshot).
  useEffect(() => {
    if (!visible || !online) return;
    const es = new EventSource("/f/fifos/items");
    es.addEventListener("fifos", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as {
          fifos?: FifoEntry[];
        };
        if (Array.isArray(data.fifos)) setFifos(data.fifos);
      } catch {
        /* ignore malformed */
      }
    });
    return () => es.close();
  }, [visible, online]);

  useEscape(!!deleteFifo, () => setDeleteFifo(null));
  useEscape(creating, () => {
    setCreating(false);
    setNewName("");
    setError(null);
  });

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setError(null);
    const res = await fetch("/", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json()) as { message?: string };
      setError(data.message || "Failed to create fifo");
      return;
    }
    setNewName("");
    setCreating(false);
    await fetchFifos();
    window.dispatchEvent(new Event("fifos-credits-refresh"));
  };

  const confirmDelete = async () => {
    if (!deleteFifo) return;
    await fetch(`/${deleteFifo.slug}`, {
      method: "DELETE",
      credentials: "include",
    });
    setDeleteFifo(null);
    await fetchFifos();
  };

  const openRename = (entry: FifoEntry) => {
    setRenameFifo(entry);
    setRenameText(entry.name);
    setRenameMaxRetries(entry.max_retries);
  };

  const saveRename = async () => {
    if (!renameFifo) return;
    const trimmed = renameText.trim();
    const nameChanged = trimmed.length > 0 && trimmed !== renameFifo.name;
    const retriesChanged = renameMaxRetries !== renameFifo.max_retries;
    if (!nameChanged && !retriesChanged) {
      setRenameFifo(null);
      return;
    }
    const body: { name?: string; max_retries?: number } = {};
    if (nameChanged) body.name = trimmed;
    if (retriesChanged) body.max_retries = renameMaxRetries;
    const ok = await patchFifo(renameFifo.slug, body);
    if (ok) {
      setRenameFifo(null);
      await fetchFifos();
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const oldIndex = fifos.findIndex((f) => f.slug === activeId);
    const newIndex = fifos.findIndex((f) => f.slug === overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const next = arrayMove(fifos, oldIndex, newIndex);
    setFifos(next);

    fetch("/f/reorder", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: next.map((f) => f.slug) }),
    });
  };

  const draggedEntry = activeDragId
    ? fifos.find((f) => f.slug === activeDragId)
    : null;

  return (
    <div className="screen screen--home">
      {filterActive ? (
        <ul className="list">
          {filteredFifos.map((entry) => (
            <StaticFifoRow
              key={entry.slug}
              entry={entry}
              onSelect={() => onSelect(entry)}
              onEdit={() => openRename(entry)}
              onDelete={() => setDeleteFifo(entry)}
            />
          ))}
        </ul>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={fifos.map((f) => f.slug)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="list">
              {fifos.map((entry) => (
                <SortableFifoRow
                  key={entry.slug}
                  entry={entry}
                  onSelect={() => onSelect(entry)}
                  onEdit={() => openRename(entry)}
                  onDelete={() => setDeleteFifo(entry)}
                />
              ))}
            </ul>
          </SortableContext>

          <DragOverlay>
            {draggedEntry ? (
              <div className="drag-overlay">
                <div className="list-item list-item--no-border">
                  <DragHandle />
                  <div className="list-item-content list-item-content--indent">
                    <div className="list-item-title">{draggedEntry.name}</div>
                  </div>
                  <CountsPill counts={draggedEntry.counts} />
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {fifos.length === 0 && !creating && (
        <p className="empty-state-hint">No fifos yet. Tap + to create one.</p>
      )}

      {fifos.length > 0 && filterActive && filteredFifos.length === 0 && (
        <p className="empty-state-hint">No matches.</p>
      )}

      {creating && (
        <div className="form">
          <input
            className="input"
            placeholder="Fifo name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          {error && <p className="form-error">{error}</p>}
          <div className="form-button-row">
            <button
              type="button"
              className="btn"
              onClick={handleCreate}
              disabled={!newName.trim()}
            >
              Create
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setCreating(false);
                setNewName("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="links-list-theme links-list-theme--home">
        <p className="links-list-theme-label">Appearance</p>
        <ThemeChooser />
      </div>

      {!creating && (
        <button type="button" className="fab" onClick={() => setCreating(true)}>
          +
        </button>
      )}

      {renameFifo && (
        <EditTextDialog
          title="Edit fifo"
          placeholder="Fifo name"
          text={renameText}
          onChange={setRenameText}
          counter={{
            label: "Max retries",
            value: renameMaxRetries,
            min: 1,
            max: 10,
            onChange: setRenameMaxRetries,
          }}
          onSave={saveRename}
          onClose={() => setRenameFifo(null)}
        />
      )}

      {deleteFifo && (
        <div className="dialog-overlay" onClick={() => setDeleteFifo(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h2 className="dialog-heading-title">Delete fifo?</h2>
              <button
                type="button"
                className="dialog-close"
                onClick={() => setDeleteFifo(null)}
              >
                &times;
              </button>
            </div>
            <div className="dialog-body">
              <p className="dialog-lede">
                Permanently delete <strong>{deleteFifo.name}</strong> and all
                its items?
              </p>
              <div className="form-button-row form-button-row--end">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDeleteFifo(null)}
                >
                  No
                </button>
                <button type="button" className="btn" onClick={confirmDelete}>
                  Yes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CountsPill({
  counts,
}: {
  counts: {
    todo: number;
    lock: number;
    done: number;
    fail: number;
    skip: number;
  };
}) {
  const cells: Array<{ letter: string; label: string; value: number }> = [
    { letter: "T", label: "todo", value: counts.todo },
    { letter: "L", label: "lock", value: counts.lock },
    { letter: "D", label: "done", value: counts.done },
    { letter: "F", label: "fail", value: counts.fail },
    { letter: "S", label: "skip", value: counts.skip },
  ];
  return (
    <span
      className="cat-count"
      title={cells.map((c) => `${c.label} ${c.value}`).join(" · ")}
    >
      {cells.map((c, i) => (
        <Fragment key={`l-${c.letter}`}>
          {i > 0 && <span className="cat-count-between" aria-hidden />}
          <span className="cat-count-letter" title={c.label}>
            {c.letter}
          </span>
        </Fragment>
      ))}
      {cells.map((c, i) => (
        <Fragment key={`v-${c.letter}`}>
          {i > 0 && (
            <span className="cat-count-between" aria-hidden>
              {"\u2022"}
            </span>
          )}
          <span className="cat-count-value">{c.value}</span>
        </Fragment>
      ))}
    </span>
  );
}

function SortableFifoRow({
  entry,
  onSelect,
  onEdit,
  onDelete,
}: {
  entry: FifoEntry;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.slug });

  const { sliderStyle, slideHandlers, reset, handleClick } = useSwipeToReveal({
    actionCount: 2,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <li className="row-wrap" ref={setNodeRef} style={style} {...attributes}>
      <div className="row-slider" style={sliderStyle} {...slideHandlers}>
        <div className="row-main" onClick={() => handleClick(onSelect)}>
          <div className="list-item list-item--no-border">
            <DragHandle listeners={listeners} />
            <div className="list-item-content list-item-content--indent">
              <div className="list-item-title">{entry.name}</div>
            </div>
            <CountsPill counts={entry.counts} />
          </div>
        </div>
        <button
          type="button"
          className="row-edit"
          onClick={() => {
            reset();
            onEdit();
          }}
        >
          Edit
        </button>
        <button type="button" className="row-delete" onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

function StaticFifoRow({
  entry,
  onSelect,
  onEdit,
  onDelete,
}: {
  entry: FifoEntry;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { sliderStyle, slideHandlers, reset, handleClick } = useSwipeToReveal({
    actionCount: 2,
  });

  return (
    <li className="row-wrap">
      <div className="row-slider" style={sliderStyle} {...slideHandlers}>
        <div className="row-main" onClick={() => handleClick(onSelect)}>
          <div className="list-item list-item--no-border">
            <div className="drag-handle drag-handle--static" aria-hidden>
              <svg viewBox="0 0 16 16" fill="currentColor">
                <circle cx="5" cy="3" r="1.5" />
                <circle cx="11" cy="3" r="1.5" />
                <circle cx="5" cy="8" r="1.5" />
                <circle cx="11" cy="8" r="1.5" />
                <circle cx="5" cy="13" r="1.5" />
                <circle cx="11" cy="13" r="1.5" />
              </svg>
            </div>
            <div className="list-item-content list-item-content--indent">
              <div className="list-item-title">{entry.name}</div>
            </div>
            <CountsPill counts={entry.counts} />
          </div>
        </div>
        <button
          type="button"
          className="row-edit"
          onClick={() => {
            reset();
            onEdit();
          }}
        >
          Edit
        </button>
        <button type="button" className="row-delete" onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

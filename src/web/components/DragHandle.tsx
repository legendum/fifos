import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";

export default function DragHandle({
  listeners,
}: {
  listeners?: SyntheticListenerMap;
}) {
  return (
    <div className="drag-handle" {...listeners}>
      <svg viewBox="0 0 16 16" fill="currentColor">
        <circle cx="5" cy="3" r="1.5" />
        <circle cx="11" cy="3" r="1.5" />
        <circle cx="5" cy="8" r="1.5" />
        <circle cx="11" cy="8" r="1.5" />
        <circle cx="5" cy="13" r="1.5" />
        <circle cx="11" cy="13" r="1.5" />
      </svg>
    </div>
  );
}

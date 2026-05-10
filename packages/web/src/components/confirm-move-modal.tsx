'use client';

export type ConfirmMoveSource = { id: string; title: string };
export type ConfirmMoveTarget = { id: string | null; title: string };

export function ConfirmMoveModal({
  source,
  target,
  onCancel,
  onConfirm,
}: {
  source: ConfirmMoveSource;
  target: ConfirmMoveTarget;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter') onConfirm();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-(--color-border) bg-(--color-bg) shadow-2xl">
        <div className="px-4 py-3 border-b border-(--color-border)">
          <h2 className="text-sm font-medium">Move task</h2>
        </div>
        <div className="px-4 py-4 text-sm">
          Make <span className="font-medium">"{source.title}"</span> a subtask of{' '}
          <span className="font-medium">"{target.title}"</span>?
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-(--color-border)">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-(--color-border) hover:bg-(--color-surface) cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className="px-3 py-1.5 text-xs rounded bg-(--color-accent) text-(--color-bg) hover:opacity-90 cursor-pointer"
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
}

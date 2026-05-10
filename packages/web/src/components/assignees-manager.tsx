'use client';

import { useState, useTransition } from 'react';
import { Bot, Trash2, User as UserIcon, Plus } from 'lucide-react';
import type { Assignee, AssigneeKind } from '@getshit/core';
import {
  createAssigneeAction,
  deleteAssigneeAction,
  updateAssigneeAction,
} from '@/app/assignees-actions';

const COLORS = ['#fb923c', '#60a5fa', '#34d399', '#a78bfa', '#f472b6', '#facc15'];

export function AssigneesManager({ initial }: { initial: Assignee[] }) {
  const [items, setItems] = useState<Assignee[]>(initial);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AssigneeKind>('person');
  const [color, setColor] = useState<string | null>(COLORS[0] ?? null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    start(async () => {
      const result = await createAssigneeAction({ name: trimmed, kind, color });
      if (result.ok) {
        setItems((prev) => [...prev, result.value].sort((a, b) => a.name.localeCompare(b.name)));
        setName('');
        setError(null);
      } else {
        setError(result.error);
      }
    });
  };

  const remove = (id: string) => {
    if (!confirm('Delete this assignee? Tasks assigned to them will be unassigned.')) return;
    start(async () => {
      const result = await deleteAssigneeAction(id);
      if (result.ok) setItems((prev) => prev.filter((a) => a.id !== id));
      else setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-2 p-3 rounded-md border border-(--color-border) bg-(--color-surface)"
      >
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Alex, deploy-bot)"
            disabled={pending}
            className="flex-1 bg-(--color-bg) rounded px-2 py-1.5 text-sm outline-none border border-(--color-border) focus:border-(--color-accent)"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AssigneeKind)}
            disabled={pending}
            className="bg-(--color-bg) rounded px-2 py-1.5 text-sm outline-none border border-(--color-border) focus:border-(--color-accent) cursor-pointer"
          >
            <option value="person">Person</option>
            <option value="agent">Agent</option>
          </select>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-sm bg-(--color-accent) text-(--color-bg) hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            <Plus size={14} /> Add
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-(--color-muted)">Color:</span>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-5 w-5 rounded-full border-2 cursor-pointer ${color === c ? 'border-(--color-fg)' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-(--color-muted) px-2 py-6 text-center">
          No assignees yet. Add a person or agent above.
        </p>
      ) : (
        <ul className="flex flex-col">
          {items.map((a) => (
            <AssigneeRow
              key={a.id}
              assignee={a}
              onUpdate={(next) =>
                setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)))
              }
              onRemove={() => remove(a.id)}
              disabled={pending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AssigneeRow({
  assignee,
  onUpdate,
  onRemove,
  disabled,
}: {
  assignee: Assignee;
  onUpdate: (next: Assignee) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState(assignee.name);

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === assignee.name) {
      setName(assignee.name);
      return;
    }
    start(async () => {
      const result = await updateAssigneeAction(assignee.id, { name: trimmed });
      if (result.ok) onUpdate(result.value);
      else setName(assignee.name);
    });
  };

  const setKind = (kind: AssigneeKind) => {
    start(async () => {
      const result = await updateAssigneeAction(assignee.id, { kind });
      if (result.ok) onUpdate(result.value);
    });
  };

  const setColor = (color: string) => {
    start(async () => {
      const result = await updateAssigneeAction(assignee.id, { color });
      if (result.ok) onUpdate(result.value);
    });
  };

  const Icon = assignee.kind === 'agent' ? Bot : UserIcon;

  return (
    <li className="group flex items-center gap-2 px-2 py-2 border-b border-(--color-border) last:border-b-0">
      <span
        className="h-6 w-6 rounded-full flex items-center justify-center"
        style={{ backgroundColor: assignee.color ?? 'var(--color-surface-2)' }}
      >
        <Icon size={12} className="text-(--color-bg)" />
      </span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setName(assignee.name);
            (e.target as HTMLInputElement).blur();
          }
        }}
        disabled={pending || disabled}
        className="flex-1 bg-transparent text-sm outline-none focus:bg-(--color-surface) px-1 rounded"
      />
      <select
        value={assignee.kind}
        onChange={(e) => setKind(e.target.value as AssigneeKind)}
        disabled={pending || disabled}
        className="bg-transparent text-xs text-(--color-muted) outline-none cursor-pointer"
      >
        <option value="person">Person</option>
        <option value="agent">Agent</option>
      </select>
      <div className="flex items-center gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border-2 cursor-pointer ${assignee.color === c ? 'border-(--color-fg)' : 'border-transparent'}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={pending || disabled}
        className="p-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-red-400 cursor-pointer opacity-0 group-hover:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

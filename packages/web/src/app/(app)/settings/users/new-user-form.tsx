'use client';

import { useState, useTransition } from 'react';
import { Bot, UserCog, User as UserIcon } from 'lucide-react';
import { createUserAction } from './actions';

type Kind = 'human' | 'agent' | 'guest';

const KINDS: { value: Kind; label: string; icon: React.ComponentType<{ size?: number }>; hint: string }[] = [
  { value: 'human', label: 'Human', icon: UserIcon, hint: 'Logs in via Google or password.' },
  { value: 'agent', label: 'Agent', icon: Bot, hint: 'Automated user. Email or chat endpoint.' },
  { value: 'guest', label: 'Guest', icon: UserCog, hint: 'External user with limited access.' },
];

export function NewUserForm() {
  const [kind, setKind] = useState<Kind>('human');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onSubmit = (formData: FormData) => {
    formData.set('kind', kind);
    start(async () => {
      setError(null);
      const r = await createUserAction(formData);
      if (!r.ok) setError(r.error);
    });
  };

  return (
    <form
      action={onSubmit}
      className="border border-(--color-border) rounded-lg p-4 flex flex-col gap-3"
    >
      <div className="text-sm font-medium">Add user</div>

      <div className="flex gap-2">
        {KINDS.map((k) => {
          const Icon = k.icon;
          const active = kind === k.value;
          return (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              className={`flex-1 flex flex-col items-center gap-1 p-2 rounded border text-xs ${
                active
                  ? 'border-(--color-fg) bg-(--color-surface) text-(--color-fg)'
                  : 'border-(--color-border) text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)'
              }`}
            >
              <Icon size={14} />
              <span>{k.label}</span>
            </button>
          );
        })}
      </div>

      <div className="text-xs text-(--color-muted) -mt-1">{KINDS.find((k) => k.value === kind)?.hint}</div>

      <input
        type="text"
        name="name"
        placeholder="Name (optional)"
        className="bg-transparent border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-fg)"
      />

      <input
        type="email"
        name="email"
        placeholder={kind === 'agent' ? 'Email (optional if endpoint set)' : 'Email'}
        className="bg-transparent border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-fg)"
      />

      {kind === 'agent' && (
        <input
          type="url"
          name="endpoint"
          placeholder="Chat endpoint URL (e.g. https://…)"
          className="bg-transparent border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-fg)"
        />
      )}

      {error && <div className="text-xs text-red-500">{error}</div>}

      <button
        type="submit"
        disabled={pending}
        className="self-start bg-(--color-fg) text-(--color-bg) rounded px-3 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create user'}
      </button>
    </form>
  );
}

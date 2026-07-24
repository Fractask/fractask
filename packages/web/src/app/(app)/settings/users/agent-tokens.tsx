'use client';

import { useState, useTransition } from 'react';
import { KeyRound } from 'lucide-react';
import { generateAgentTokenAction, revokeAgentTokenAction } from './actions';

export type AgentTokenMeta = {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

function formatTimestamp(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function AgentTokens({
  agentId,
  agentName,
  tokens,
}: {
  agentId: string;
  agentName: string;
  tokens: AgentTokenMeta[];
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const generate = () => {
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set('agentId', agentId);
      fd.set('label', label);
      const r = await generateAgentTokenAction(fd);
      if (r.ok) {
        setFreshToken(r.token);
        setLabel('');
      } else {
        setError(r.error);
      }
    });
  };

  const revoke = (tokenId: string) => {
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set('agentId', agentId);
      fd.set('tokenId', tokenId);
      const r = await revokeAgentTokenAction(fd);
      if (!r.ok) setError(r.error);
    });
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-(--color-muted) hover:text-(--color-fg)"
      >
        <KeyRound size={12} />
        <span>
          MCP tokens{tokens.length > 0 ? ` (${tokens.length})` : ''}
        </span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-3 border border-(--color-border) rounded-lg p-3">
          {freshToken && (
            <div className="border border-(--color-fg) rounded p-3 flex flex-col gap-1.5 bg-(--color-bg)">
              <div className="text-xs font-medium">New token for {agentName} — copy it now</div>
              <pre className="text-xs bg-(--color-border)/30 px-2 py-1.5 rounded overflow-x-auto select-all">
                {freshToken}
              </pre>
              <div className="text-[11px] text-(--color-muted)">
                Shown once. Give it to this agent&rsquo;s MCP client via{' '}
                <code>GETSHIT_TOKEN</code> (stdio) or an{' '}
                <code>Authorization: Bearer</code> header (hosted). The agent is scoped to
                exactly the tasks it has been shared.
              </div>
            </div>
          )}

          <div className="flex gap-2 items-end">
            <label className="flex-1 flex flex-col gap-1 text-xs">
              <span className="text-(--color-muted)">Label (optional)</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. hetzner box"
                className="bg-transparent border border-(--color-border) rounded px-2 py-1.5 outline-none focus:border-(--color-fg)"
              />
            </label>
            <button
              type="button"
              onClick={generate}
              disabled={pending}
              className="bg-(--color-fg) text-(--color-bg) rounded px-3 py-1.5 text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              {pending ? '…' : 'Generate token'}
            </button>
          </div>

          {error && <div className="text-xs text-red-500">{error}</div>}

          {tokens.length > 0 && (
            <ul className="flex flex-col divide-y divide-(--color-border)">
              {tokens.map((t) => (
                <li key={t.id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <div className="text-xs">
                      {t.label || <span className="text-(--color-muted)">(no label)</span>}
                    </div>
                    <div className="text-[10px] text-(--color-muted)">
                      Created {formatTimestamp(t.createdAt)} · Last used{' '}
                      {formatTimestamp(t.lastUsedAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => revoke(t.id)}
                    disabled={pending}
                    className="text-[10px] px-2 py-1 rounded border border-(--color-border) text-(--color-muted) hover:text-red-500 hover:border-red-500 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

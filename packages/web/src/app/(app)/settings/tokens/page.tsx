import { listCliTokens } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { generateTokenAction, revokeTokenAction } from './actions';

type SearchParams = Promise<{ new?: string }>;

function formatTimestamp(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}

export default async function TokensPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await getRequestContext();
  const tokens = await listCliTokens(ctx.userId);
  const { new: newToken } = await searchParams;

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-medium tracking-tight">CLI tokens</h1>
        <p className="text-sm text-(--color-muted) mt-1">
          Long-lived bearer tokens for the <code className="text-xs">fractask</code> CLI and the
          MCP server. Each token authenticates as your account.
        </p>
      </header>

      {newToken && (
        <div className="border border-(--color-fg) rounded-lg p-4 bg-(--color-bg) flex flex-col gap-2">
          <div className="text-sm font-medium">New token — copy it now</div>
          <pre className="text-xs bg-(--color-border)/30 px-3 py-2 rounded overflow-x-auto select-all">
            {newToken}
          </pre>
          <div className="text-xs text-(--color-muted)">
            This is the only time the raw token is shown. Save it somewhere safe (e.g. your
            shell&rsquo;s rc file or <code>~/.getshit/config.json</code>). After you leave this
            page, only the hash is kept.
          </div>
        </div>
      )}

      <form action={generateTokenAction} className="flex gap-2 items-end">
        <label className="flex-1 flex flex-col gap-1.5 text-sm">
          <span className="text-(--color-muted)">Label (optional)</span>
          <input
            type="text"
            name="label"
            placeholder="e.g. local Mac, remote box"
            className="bg-transparent border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-fg)"
          />
        </label>
        <button
          type="submit"
          className="bg-(--color-fg) text-(--color-bg) rounded px-3 py-2 text-sm font-medium hover:opacity-90"
        >
          Generate token
        </button>
      </form>

      <section className="flex flex-col gap-2">
        <div className="text-xs text-(--color-muted) uppercase tracking-wider">Active tokens</div>
        {tokens.length === 0 ? (
          <div className="text-sm text-(--color-muted) py-4">No tokens yet.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-(--color-border)">
            {tokens.map((t) => (
              <li key={t.id} className="py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="text-sm">{t.label || <span className="text-(--color-muted)">(no label)</span>}</div>
                  <div className="text-xs text-(--color-muted)">
                    Created {formatTimestamp(t.createdAt)} · Last used {formatTimestamp(t.lastUsedAt)}
                  </div>
                </div>
                <form action={revokeTokenAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button
                    type="submit"
                    className="text-xs px-2 py-1 rounded border border-(--color-border) text-(--color-muted) hover:text-red-500 hover:border-red-500"
                  >
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="text-sm text-(--color-muted)">
        <summary className="cursor-pointer">How to use</summary>
        <div className="mt-2 flex flex-col gap-2 pl-4 text-xs">
          <div>
            <strong>CLI</strong> — write the token to <code>~/.getshit/config.json</code>:
            <pre className="bg-(--color-border)/30 px-3 py-2 rounded mt-1 select-all">{`{ "token": "gs_..." }`}</pre>
          </div>
          <div>
            <strong>MCP</strong> — re-register with the token in env:
            <pre className="bg-(--color-border)/30 px-3 py-2 rounded mt-1 select-all overflow-x-auto">
              claude mcp remove getshit --scope user{'\n'}
              claude mcp add --scope user getshit node /path/to/packages/mcp/dist/index.js -e GETSHIT_TOKEN=gs_...
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}

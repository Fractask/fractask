import { headers } from 'next/headers';
import Link from 'next/link';
import { listCliTokens } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { CodeBlock } from '@/components/copy-button';

export const dynamic = 'force-dynamic';

const TOKEN_PLACEHOLDER = '<YOUR_GETSHIT_TOKEN>';

async function resolveBaseUrl(): Promise<string> {
  const explicit = process.env.GETSHIT_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
  if (host) return `${proto}://${host}`;
  return 'https://YOUR-GETSHIT-URL';
}

export default async function SetupPage() {
  const ctx = await getRequestContext();
  const tokens = await listCliTokens(ctx.userId);
  const hasToken = tokens.length > 0;

  const baseUrl = await resolveBaseUrl();
  const mcpUrl = `${baseUrl}/api/mcp`;

  // The remote-bridge path (recommended): one env var only — the user's
  // personal token. Server holds the Turso credentials.
  const claudeCodeRemote = [
    'claude mcp add --scope user getshit \\',
    '  -- npx -y mcp-remote@latest \\',
    `  ${mcpUrl} \\`,
    `  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
  ].join('\n');

  const claudeDesktopRemote = JSON.stringify(
    {
      mcpServers: {
        getshit: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote@latest',
            mcpUrl,
            '--header',
            `Authorization: Bearer ${TOKEN_PLACEHOLDER}`,
          ],
        },
      },
    },
    null,
    2,
  );

  const cursorRemote = claudeDesktopRemote;

  const verifyPrompt = 'List all my projects in Fractask, grouped by entity.';

  // The local-stdio path (advanced): for hacking on the MCP server itself.
  // Requires Turso creds because the MCP talks to Turso directly.
  const stdioCmd = [
    'claude mcp add --scope user getshit \\',
    `  -e GETSHIT_DB_URL=libsql://YOUR-DB.turso.io \\`,
    `  -e GETSHIT_DB_AUTH_TOKEN=<TURSO_TOKEN> \\`,
    `  -e GETSHIT_TOKEN=${TOKEN_PLACEHOLDER} \\`,
    `  -- node /path/to/getshitdone/packages/mcp/dist/index.js`,
  ].join('\n');

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto flex flex-col gap-8">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Connect Fractask to your AI tools</h1>
        <p className="text-sm text-(--color-muted) mt-1">
          Fractask speaks <strong>MCP</strong> over HTTPS. Any client that can run{' '}
          <code className="font-mono-id">npx</code> (Claude Code, Claude Desktop, Cursor, Continue,
          Zed, etc.) can connect with one env var: your personal token. The server holds the
          database credentials &mdash; you don&rsquo;t.
        </p>
      </header>

      <Step n={1} title="Get a CLI token">
        <p className="text-sm text-(--color-muted)">
          The token is your identity. It authenticates as your account, scoped to the tasks you
          own or have been shared.
          {hasToken ? (
            <> You&rsquo;ve issued <strong>{tokens.length}</strong> token{tokens.length === 1 ? '' : 's'} already. </>
          ) : (
            <> You don&rsquo;t have one yet. </>
          )}
        </p>
        <Link
          href="/settings/tokens"
          className="inline-flex items-center gap-2 self-start mt-3 px-3 py-1.5 text-sm rounded border border-(--color-fg) text-(--color-fg) hover:bg-(--color-fg) hover:text-(--color-bg)"
        >
          {hasToken ? 'Manage tokens →' : 'Generate token →'}
        </Link>
      </Step>

      <Step n={2} title="Pick your client">
        <p className="text-sm text-(--color-muted) mb-4">
          The remote MCP URL is{' '}
          <code className="font-mono-id break-all">{mcpUrl}</code>. The bridge package{' '}
          <a
            href="https://www.npmjs.com/package/mcp-remote"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            mcp-remote
          </a>{' '}
          adapts it into a stdio server for any MCP client &mdash; no install needed,{' '}
          <code className="font-mono-id">npx</code> fetches it on demand.
        </p>

        <ClientSection title="Claude Code (terminal)" defaultOpen>
          <p className="text-xs text-(--color-muted) mb-2">
            Run once. <code className="font-mono-id">--scope user</code> registers globally so
            every project sees it.
          </p>
          <CodeBlock value={claudeCodeRemote} language="sh" />
          <p className="text-xs text-(--color-muted) mt-2">
            Verify with <code className="font-mono-id">claude mcp list</code>. Re-running with the
            same name overwrites; remove with{' '}
            <code className="font-mono-id">claude mcp remove getshit --scope user</code>.
          </p>
        </ClientSection>

        <ClientSection title="Claude Desktop (Mac / Windows)">
          <p className="text-xs text-(--color-muted) mb-2">
            Edit{' '}
            <code className="font-mono-id">~/Library/Application Support/Claude/claude_desktop_config.json</code>{' '}
            (Mac) or <code className="font-mono-id">%APPDATA%\Claude\claude_desktop_config.json</code>{' '}
            (Windows). Merge into <code className="font-mono-id">mcpServers</code>; restart the
            app.
          </p>
          <CodeBlock value={claudeDesktopRemote} language="json" />
        </ClientSection>

        <ClientSection title="Cursor">
          <p className="text-xs text-(--color-muted) mb-2">
            Cursor speaks MCP. Edit <code className="font-mono-id">~/.cursor/mcp.json</code> (or
            Settings → MCP → Add). Same JSON shape as Claude Desktop:
          </p>
          <CodeBlock value={cursorRemote} language="json" />
        </ClientSection>

        <ClientSection title="Any other MCP-aware client">
          <p className="text-xs text-(--color-muted) mb-2">
            <strong>Direct HTTP:</strong> POST JSON-RPC 2.0 to{' '}
            <code className="font-mono-id break-all">{mcpUrl}</code> with{' '}
            <code className="font-mono-id">Authorization: Bearer &lt;token&gt;</code>. Stateless
            (no <code className="font-mono-id">Mcp-Session-Id</code> needed). Methods supported:{' '}
            <code className="font-mono-id">initialize</code>,{' '}
            <code className="font-mono-id">tools/list</code>,{' '}
            <code className="font-mono-id">tools/call</code>.
          </p>
          <p className="text-xs text-(--color-muted) mb-2">
            <strong>Stdio bridge:</strong> any client that takes a command can wrap with{' '}
            <code className="font-mono-id">npx -y mcp-remote@latest {mcpUrl} --header &ldquo;Authorization: Bearer &lt;token&gt;&rdquo;</code>.
          </p>
          <p className="text-xs text-(--color-muted)">
            Six tools are exposed: <code className="font-mono-id">list_tasks</code>,{' '}
            <code className="font-mono-id">get_task</code>,{' '}
            <code className="font-mono-id">create_task</code>,{' '}
            <code className="font-mono-id">update_task</code>,{' '}
            <code className="font-mono-id">delete_task</code>,{' '}
            <code className="font-mono-id">move_task</code>.
          </p>
        </ClientSection>
      </Step>

      <Step n={3} title="Verify it works">
        <p className="text-sm text-(--color-muted)">
          Open a fresh chat in your client and try:
        </p>
        <CodeBlock value={verifyPrompt} />
        <p className="text-xs text-(--color-muted) mt-2">
          The agent should call <code className="font-mono-id">list_tasks</code> and return your
          tree. If you see <code className="font-mono-id">401</code> or{' '}
          <code className="font-mono-id">403</code>, double-check{' '}
          <code className="font-mono-id">GETSHIT_TOKEN</code> matches a token at{' '}
          <Link href="/settings/tokens" className="underline">/app/settings/tokens</Link>.
        </p>
      </Step>

      <Step n={4} title="Tune what the agent does">
        <p className="text-sm text-(--color-muted)">
          The MCP server injects your task guidelines into{' '}
          <code className="font-mono-id">create_task</code>&rsquo;s tool description so every
          client picks them up automatically. Customize at{' '}
          <Link href="/settings/guidelines" className="underline">/app/settings/guidelines</Link>.
        </p>
        <p className="text-xs text-(--color-muted) mt-2">
          Want to bring in tasks from another platform?{' '}
          <Link href="/import" className="underline">See the import guide →</Link>
        </p>
      </Step>

      <details className="text-xs text-(--color-muted) border-t border-(--color-border) pt-4">
        <summary className="cursor-pointer">Advanced: local stdio for hacking on the MCP server</summary>
        <div className="mt-3 flex flex-col gap-2 pl-2">
          <p>
            If you&rsquo;re developing on this codebase and want the MCP to run from your local
            checkout (so edits take effect without a deploy), use the stdio path. This requires
            Turso credentials because the local MCP talks to the database directly &mdash; only
            useful for trusted developers.
          </p>
          <CodeBlock value={stdioCmd} language="sh" />
          <p>
            Build first with <code className="font-mono-id">pnpm --filter @getshit/mcp build</code>.
          </p>
        </div>
      </details>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium flex items-center gap-2">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-(--color-fg) text-(--color-bg) text-[11px] font-mono-id">
          {n}
        </span>
        {title}
      </h2>
      <div className="pl-7 flex flex-col">{children}</div>
    </section>
  );
}

function ClientSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group border border-(--color-border) rounded-md mb-2 open:bg-(--color-surface)/40"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium list-none flex items-center justify-between">
        <span>{title}</span>
        <span className="text-(--color-muted) text-xs group-open:hidden">show</span>
        <span className="text-(--color-muted) text-xs hidden group-open:inline">hide</span>
      </summary>
      <div className="px-3 pb-3 pt-1 flex flex-col gap-2">{children}</div>
    </details>
  );
}

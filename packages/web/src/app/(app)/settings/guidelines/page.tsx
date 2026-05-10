import {
  DEFAULT_TASK_GUIDELINES,
  getGlobalTaskGuidelines,
  getUserTaskGuidelines,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { saveGlobalGuidelinesAction, saveUserGuidelinesAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function GuidelinesPage() {
  const ctx = await getRequestContext();
  const [globalValue, userValue] = await Promise.all([
    getGlobalTaskGuidelines(),
    getUserTaskGuidelines(ctx),
  ]);
  const globalIsCustom = globalValue !== DEFAULT_TASK_GUIDELINES;
  const userIsSet = userValue !== null;
  const effective = userValue ?? globalValue;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 flex flex-col gap-8">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Task guidelines</h1>
        <p className="text-sm text-(--color-muted) mt-1">
          Markdown the MCP server injects into <code className="font-mono-id">create_task</code>&rsquo;s
          tool description. Every Claude Code, Cursor, or other MCP client sees these as
          additional instructions whenever it&rsquo;s about to make a task. Restart your MCP
          server after editing for changes to take effect.
        </p>
      </header>

      <section className="border border-(--color-border) rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Effective guidelines (what your MCP currently sends)</h2>
          <span className="text-[10px] uppercase tracking-wider text-(--color-muted)">
            {userIsSet ? 'your override' : globalIsCustom ? 'global custom' : 'global default'}
          </span>
        </div>
        <pre className="text-xs bg-(--color-border)/30 px-3 py-3 rounded-md overflow-x-auto whitespace-pre-wrap font-mono-id leading-relaxed">
          {effective}
        </pre>
      </section>

      <form action={saveGlobalGuidelinesAction} className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Global default</h2>
          <span className="text-[10px] uppercase tracking-wider text-(--color-muted)">
            visible to every user
          </span>
        </div>
        <p className="text-xs text-(--color-muted)">
          The instance-wide baseline. Used for any user who hasn&rsquo;t set a personal override.
          Leave blank and save to fall back to the built-in default.
        </p>
        <textarea
          name="value"
          rows={14}
          defaultValue={globalIsCustom ? globalValue : ''}
          placeholder={DEFAULT_TASK_GUIDELINES}
          className="text-xs bg-(--color-surface) border border-(--color-border) rounded-md px-3 py-3 font-mono-id leading-relaxed outline-none focus:border-(--color-fg) resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="bg-(--color-fg) text-(--color-bg) rounded px-3 py-1.5 text-sm font-medium hover:opacity-90"
          >
            Save global default
          </button>
          {globalIsCustom && (
            <span className="text-xs text-(--color-muted)">
              Submitting blank resets to the built-in default.
            </span>
          )}
        </div>
      </form>

      <form action={saveUserGuidelinesAction} className="flex flex-col gap-3 border-t border-(--color-border) pt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Your personal override</h2>
          <span className="text-[10px] uppercase tracking-wider text-(--color-muted)">
            only your MCP sessions
          </span>
        </div>
        <p className="text-xs text-(--color-muted)">
          Wins over the global default for your own MCP sessions. Useful for personal style
          preferences (e.g. &ldquo;always include a 1-sentence rationale&rdquo;). Leave blank and save to
          drop back to the global default.
        </p>
        <textarea
          name="value"
          rows={10}
          defaultValue={userValue ?? ''}
          placeholder="(using global default — type to override)"
          className="text-xs bg-(--color-surface) border border-(--color-border) rounded-md px-3 py-3 font-mono-id leading-relaxed outline-none focus:border-(--color-fg) resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="bg-(--color-fg) text-(--color-bg) rounded px-3 py-1.5 text-sm font-medium hover:opacity-90"
          >
            {userIsSet ? 'Update my override' : 'Save my override'}
          </button>
          {userIsSet && (
            <span className="text-xs text-(--color-muted)">
              Submitting blank clears your override.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

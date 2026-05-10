import Link from 'next/link';
import { CodeBlock } from '@/components/copy-button';

export const dynamic = 'force-dynamic';

const ASANA_PROMPT = `I want to mirror my Asana workspace into Fractask.

1. Use the Asana MCP to list my workspaces, then projects in the active workspace.
2. For each Asana project, call mcp__getshit__create_task with kind="project" and parentId=<entity-id>.
   - Ask me which Fractask entity each Asana project should live under.
   - If a Fractask project with the same title already exists under that entity, skip it.
3. For each Asana project, list its tasks (incomplete only).
4. For each Asana task, call mcp__getshit__create_task with kind="task" and parentId set to the
   Fractask project you just created (or matched).
   - Title = Asana task name.
   - Description = Asana task notes (markdown if present).
   - If the Asana task is assigned to me, set assigneeId = "me:<my-Fractask-user-id>".
5. Print a summary: N projects created, M tasks created, K skipped (with reason).

Do a DRY RUN first — show me what you'd create, don't write yet. Wait for my confirmation.`;

  const MONDAY_PROMPT = `Import my Monday.com boards into Fractask.

1. Via the Monday MCP, list my boards. Show me names + ids; I'll pick which to import.
2. For each chosen board:
   a. Call mcp__getshit__create_task kind="project" with the board name. parentId = the entity I name.
   b. List the board's groups; each group becomes a child task with kind="task" titled after the group.
   c. List items in each group; each item becomes a grandchild task.
3. Map Monday status columns to Fractask:
   - "Done" / "Complete" → status="done"
   - "Working on it" / "In progress" → status="doing"
   - everything else → status="open"
4. Map Monday people column → assigneeId. If the assignee email exists in /assignees, link;
   otherwise create the assignee row first.
5. Skip items already imported (match on title + parent).

DRY RUN first. Print: boards visited, tasks planned, conflicts. Wait for go-ahead before writes.`;

  const CSV_PROMPT = `I'll paste a CSV export below. Parse it and create Fractask tasks.

Columns are: title, description, parent_path, status, due_date, assignee_email, kind.

For each row:
- Resolve parent_path (e.g. "Sunbek/Marketing/Q2") by walking from root, calling mcp__getshit__list_tasks
  at each level. Create missing intermediates as kind="entity" or "project" using your judgment.
- Call mcp__getshit__create_task with the resolved parentId.
- Convert due_date to a UNIX ms timestamp for dueAt.
- If assignee_email matches an /assignees row by email, set assigneeId; otherwise leave unassigned
  and tell me at the end which emails were unmatched.

Do 5 rows as a sample first, show me the result, then continue if I say "go".

\`\`\`csv
<paste your CSV here>
\`\`\``;

  const NOTION_PROMPT = `Import a Notion database into Fractask.

Use the Notion MCP to query database <database-id>. Map:
- Notion "Name" → task title
- Notion "Status" select → Fractask status (open/doing/review/done)
- Notion sub-pages → child tasks (recurse one level)
- Notion "Owner" person → assigneeId via email lookup in /assignees
- Notion page body → description (markdown)

Create everything under the Fractask project named "<project name>". Dry-run first, then execute.`;

  const LINEAR_PROMPT = `Mirror my Linear team's open issues into Fractask.

Via the Linear MCP:
1. List my teams; I'll pick one.
2. List open issues in that team (state != "Completed", != "Canceled").
3. For each issue, mcp__getshit__create_task with:
   - title = Linear issue title (no LIN-123 prefix)
   - description = Linear description + a final line "Linear: <issue url>"
   - parentId = the Fractask project I designate
   - assigneeId = match on email to /assignees, else null
   - status: Linear "In Progress" → "doing", "In Review" → "review", else "open"

If a Fractask task already has the Linear url in its description, skip (idempotent re-runs).`;

export default function ImportPage() {
  return (
    <div className="px-6 py-8 max-w-3xl mx-auto flex flex-col gap-8">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Import tasks from another platform</h1>
        <p className="text-sm text-(--color-muted) mt-1">
          The agent-native way: connect both <strong>Fractask</strong> and the source platform&rsquo;s MCP
          server to the same Claude/Cursor session, then ask the agent to mirror tasks across.
          No custom scripts, no CSV exports unless you want one.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">The pattern</h2>
        <ol className="text-sm text-(--color-muted) list-decimal pl-5 flex flex-col gap-1.5">
          <li>
            Set up the Fractask MCP — see <Link href="/setup" className="underline">/app/setup</Link>.
          </li>
          <li>
            Set up the source platform&rsquo;s MCP server (Asana, Monday, Notion, Linear, GitHub
            Issues, etc.) in the same client.
          </li>
          <li>
            Open a fresh chat. Paste one of the prompts below, edit the entity / project mappings,
            and let the agent run a dry-run first.
          </li>
          <li>Review the dry-run output. If it looks right, say <em>go</em> and the agent executes.</li>
        </ol>
        <p className="text-xs text-(--color-muted) mt-2">
          <strong>Why dry-run first.</strong> MCP write tools are real. A bad prompt can spawn 200
          duplicate tasks. The prompts below all start with a dry-run step — keep that.
        </p>
      </section>

      <PromptCard
        title="Asana → Fractask"
        platform="Asana"
        helper={
          <>
            Requires an Asana MCP server. The community{' '}
            <code className="font-mono-id">@modelcontextprotocol/server-asana</code> works (run via
            npx, env <code className="font-mono-id">ASANA_TOKEN</code>).
          </>
        }
        prompt={ASANA_PROMPT}
      />

      <PromptCard
        title="Monday.com → Fractask"
        platform="Monday"
        helper={
          <>
            Requires a Monday MCP. Search the public registries — most expose{' '}
            <code className="font-mono-id">list_boards</code>, <code className="font-mono-id">list_items</code>,
            etc.
          </>
        }
        prompt={MONDAY_PROMPT}
      />

      <PromptCard
        title="Notion database → Fractask"
        platform="Notion"
        helper={
          <>
            Use the official Notion MCP server. Pre-populate <em>&lt;database-id&gt;</em> and{' '}
            <em>&lt;project name&gt;</em> in the prompt.
          </>
        }
        prompt={NOTION_PROMPT}
      />

      <PromptCard
        title="Linear → Fractask"
        platform="Linear"
        helper={<>Use the Linear MCP. Works for re-runs because it keys on the issue URL.</>}
        prompt={LINEAR_PROMPT}
      />

      <PromptCard
        title="CSV paste → Fractask"
        platform="CSV / generic"
        helper={
          <>
            No MCP for the source? Export to CSV, paste into the chat, ask Claude to do the rest.
            Works for Trello, Jira, Smartsheet, anything you can export.
          </>
        }
        prompt={CSV_PROMPT}
      />

      <section className="flex flex-col gap-3 border-t border-(--color-border) pt-6">
        <h2 className="text-sm font-medium">Best practices</h2>
        <ul className="text-sm text-(--color-muted) list-disc pl-5 flex flex-col gap-1.5">
          <li>
            <strong>Dry-run first, write second.</strong> Always have the agent print its plan
            before calling <code className="font-mono-id">create_task</code>. Mistakes are easy to
            spot and impossible to undo cleanly.
          </li>
          <li>
            <strong>Mirror hierarchy, don&rsquo;t flatten.</strong> A platform&rsquo;s board ≈
            Fractask project; a section/group ≈ a child task; an item ≈ a leaf. Use
            <code className="font-mono-id"> parentId</code> to preserve structure.
          </li>
          <li>
            <strong>Make it idempotent.</strong> Have the agent dedupe on title + parent (or a URL
            line in the description) so re-running an import is safe.
          </li>
          <li>
            <strong>Map status, not state names.</strong> Source platforms have dozens of custom
            states. Collapse to Fractask&rsquo;s five: <code className="font-mono-id">open</code>,{' '}
            <code className="font-mono-id">doing</code>, <code className="font-mono-id">review</code>,{' '}
            <code className="font-mono-id">done</code>, <code className="font-mono-id">archived</code>.
          </li>
          <li>
            <strong>Resolve assignees first.</strong> Pre-create <Link href="/assignees" className="underline">/app/assignees</Link>{' '}
            for the people you&rsquo;ll match on, so the agent can link by email instead of leaving
            tasks unassigned.
          </li>
          <li>
            <strong>Batch in slices.</strong> For &gt;100 tasks, do 20 at a time and confirm. Long
            uninterrupted tool loops are where hallucinated parents sneak in.
          </li>
          <li>
            <strong>Tag the source.</strong> Add a tag like <code className="font-mono-id">imported:asana</code>{' '}
            so a one-line query later shows what came from where.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 border-t border-(--color-border) pt-6">
        <h2 className="text-sm font-medium">Going the other way</h2>
        <p className="text-sm text-(--color-muted)">
          The same pattern works in reverse: connect both MCPs and ask Claude to push Fractask tasks
          out to Asana / Linear / wherever. Useful for handing finished work back to the team
          tracker.
        </p>
      </section>
    </div>
  );
}

function PromptCard({
  title,
  platform,
  helper,
  prompt,
}: {
  title: string;
  platform: string;
  helper: React.ReactNode;
  prompt: string;
}) {
  return (
    <section className="flex flex-col gap-2 border border-(--color-border) rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-[10px] uppercase tracking-wider text-(--color-muted)">{platform}</span>
      </div>
      <p className="text-xs text-(--color-muted)">{helper}</p>
      <CodeBlock value={prompt} />
    </section>
  );
}

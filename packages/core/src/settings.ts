import { and, eq } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { settings } from './schema.js';

const KEY_TASK_GUIDELINES = 'task_guidelines';
const SCOPE_GLOBAL = 'global';

export const DEFAULT_TASK_GUIDELINES = `# Task guidelines

When you create or break down a task, follow these conventions so the tree stays useful for both humans and agents:

- **Concrete & actionable.** A title is something a person or agent can pick up today. Prefer "Rewrite onboarding email subject line" over "Improve onboarding."
- **Imperative single-verb titles.** Start with a verb (Add, Fix, Write, Decide, Investigate). One short line, no period.
- **Atomic.** Each task is one shippable unit. If the title contains "and" or the body has a TODO list, split it into children.
- **Decompose ambitious work.** A \`project\` holds children. Don't park implementation details on the project — call \`create_task\` once per concrete subtask, with \`parentId\` set.
- **Use \`kind\` correctly.** \`entity\` = company/area, \`project\` = a project under an entity, \`task\` = a to-do, \`goal\` = a qualitative outcome, \`kpi\` = a measurable check-in (combine with \`recurrence\`).
- **Don't duplicate existing children.** Before decomposing, list the parent's children and skip what's already there.
- **Note context, not narration.** The description should help a future reader pick up the task — links, decisions, gotchas — not "as we discussed."

## Asking the human (ask_human)

When you need a decision, approval, or open-ended input, call \`ask_human\` and **end your turn**. Don't poll. The next time you call \`get_task\` on that task, the answered prompt will be in \`prompts[].answer\`.

- \`approval\` for go/no-go decisions ("Approve deleting these 142 archived tasks?").
- \`choice\` when there's a finite set ("Which framework? Next.js / Remix / SvelteKit"). Set \`multiple: true\` for multi-select.
- \`text\` for open-ended answers ("What should I name the new dataset?").
- \`pick_image\` when the decision is visual. Reference attached images via \`option.attachmentId\` or external URLs via \`option.imageUrl\`.

Side effect: the task moves to \`status="review"\` automatically so the human sees it in the Reviews queue. Don't try to set status yourself for an in-flight question.

## Attaching files (attach_file_from_url)

When you generate or fetch an artifact (screenshot, PDF, diagram, image), call \`attach_file_from_url\` with a public URL. The server stores it and returns metadata; the file shows up in \`get_task(taskId).attachments\` and at \`/api/files/<id>\`. Combine with \`pick_image\` to ask the human to choose between two options.
`;

/**
 * Lookup helper. Returns null if no row exists for that scope+key.
 */
async function getSetting(scope: string, key: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.scope, scope), eq(settings.key, key)));
  return rows[0]?.value ?? null;
}

async function upsertSetting(scope: string, key: string, value: string): Promise<void> {
  const db = getDb();
  const ts = Date.now();
  await db
    .insert(settings)
    .values({ scope, key, value, updatedAt: ts })
    .onConflictDoUpdate({
      target: [settings.scope, settings.key],
      set: { value, updatedAt: ts },
    });
}

async function deleteSetting(scope: string, key: string): Promise<void> {
  const db = getDb();
  await db.delete(settings).where(and(eq(settings.scope, scope), eq(settings.key, key)));
}

export async function getGlobalTaskGuidelines(): Promise<string> {
  return (await getSetting(SCOPE_GLOBAL, KEY_TASK_GUIDELINES)) ?? DEFAULT_TASK_GUIDELINES;
}

export async function setGlobalTaskGuidelines(value: string): Promise<void> {
  await upsertSetting(SCOPE_GLOBAL, KEY_TASK_GUIDELINES, value);
}

export async function resetGlobalTaskGuidelines(): Promise<void> {
  await deleteSetting(SCOPE_GLOBAL, KEY_TASK_GUIDELINES);
}

/**
 * The user's personal override, if any. Returns null when the user is using
 * the global default.
 */
export async function getUserTaskGuidelines(ctx: Context): Promise<string | null> {
  return getSetting(ctx.userId, KEY_TASK_GUIDELINES);
}

export async function setUserTaskGuidelines(ctx: Context, value: string): Promise<void> {
  await upsertSetting(ctx.userId, KEY_TASK_GUIDELINES, value);
}

export async function clearUserTaskGuidelines(ctx: Context): Promise<void> {
  await deleteSetting(ctx.userId, KEY_TASK_GUIDELINES);
}

/**
 * What the MCP server should actually inject into tool descriptions: the
 * user's override if set, otherwise the global default.
 */
export async function getEffectiveTaskGuidelines(ctx: Context): Promise<string> {
  const personal = await getUserTaskGuidelines(ctx);
  if (personal !== null) return personal;
  return getGlobalTaskGuidelines();
}

/**
 * Top-level operating instructions returned in the MCP `initialize` response.
 * MCP clients surface this to the agent as system-level guidance — it's the
 * one place to tell the agent, before any tool is even called, what this
 * server is for and where to put things.
 *
 * Composed from a fixed preamble (what Fractask is, when to reach for
 * `ask_human` / `attach_file_from_url`) plus the user-configurable task
 * guidelines so the same overrides flow everywhere.
 */
export async function getServerInstructions(ctx: Context): Promise<string> {
  const guidelines = await getEffectiveTaskGuidelines(ctx);
  return `# Fractask

You are connected to the user's Fractask task tree — a shared, durable workspace where every meaningful unit of work lives as a task. Read it, write to it, and don't keep important state only in chat.

## When to use this server

- **A question or approval needed from the human** (decision, yes/no, choice between options, pick an image): call \`ask_human\` against the relevant task and **end your turn**. Do NOT ask the question only in chat — Fractask is the durable channel; chat is ephemeral. The task auto-moves to \`status="review"\` (the unified "needs your input" bucket; both approvals and questions live here). On your next \`get_task\` the answer is in \`prompts[].answer\`. The human will then either mark the task \`done\` or send it back to \`doing\` — when you see it back at \`doing\`, continue the work.
- **A file, image, PDF, screenshot, or any artifact** worth keeping: call \`attach_file_from_url\` (or accept an upload through the web UI). The file is then visible to the human on the task and to future agent sessions via \`get_task(taskId).attachments\`.
- **A short status update, observation, or non-blocking reply to human feedback**: call \`post_comment(taskId, body)\`. Comments are the persistent conversation per task — a linear thread, humans and agents in the same stream. Use this when you'd otherwise dump a paragraph in chat the human will never see again. \`post_comment\` does NOT move the task to review; for a blocking decision still use \`ask_human\`.
- **Progress, decisions, or notes** that future-you or another agent will need: write them to the task's \`description\` (\`update_task\`) or as a child task. Cold-start sessions read from here, not from chat history.

## Status lifecycle

Active path: \`open\` → \`doing\` → \`review\` → \`done\`. Use \`review\` whenever the human needs to act (either via \`ask_human\` or because work is ready for approval). The human moves it forward; you don't have to flip status to \`done\` yourself unless the human delegated that explicitly.

Parked states (not in the active queue):
- \`backlog\` — "noted, not now, no schedule". Use when the user says "we'll do this later", "park this", "add to backlog", or when you're decomposing and a sub-task is real but clearly post-MVP. Backlog tasks don't show up in Today/Inbox/default subtask lists — they live in each parent's collapsible Backlog section.
- \`snoozed\` — hidden until a wake date/condition. Different from backlog: snooze has a *when*, backlog has no schedule.
- \`archived\` — dead, kept for reference.

If the user mentions "backlog" or "ideas pile" or "not now", create or move the task with \`status: "backlog"\` — don't park it as \`open\` (which would pollute their active queue).
- **A breakdown / plan**: create child tasks (\`create_task\` with \`parentId\`). Don't park a TODO list inside one task's description — split it.

## Read the task before you act

When the user mentions a task by name or id, call \`get_task(id)\` first. It returns the task, its direct children, its \`attachments\`, its \`prompts\`, and its \`comments\` — that's your full context. If \`prompts[]\` contains a pending entry where you are the asker, **don't repeat the question** — the human will answer it in the web UI.

## Check comments on review and resumed tasks

\`comments[]\` is the persistent conversation per task — short notes from humans and agents, oldest first. **Before you act on any task in \`status="review"\` or a task that was just bounced from \`review\` back to \`doing\`, scan the tail of \`comments[]\` first.** If the latest comments mean the work needs to change, reply with \`post_comment\` summarizing what you're doing about it before continuing. Don't silently override human feedback.

---

${guidelines}`;
}

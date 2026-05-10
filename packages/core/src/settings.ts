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

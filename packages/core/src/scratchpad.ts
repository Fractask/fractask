/**
 * Scratchpad — quick capture for a human, triage queue for agents.
 *
 * The human types raw ideas into one page; each entry autosaves. Agents sweep
 * `status='new'` entries, decide what each one is (a task, a subtask of
 * existing work, a note, noise), act with the ordinary primitives
 * (`create_task`, `move_task`, `create_note`, …) and then call {@link
 * fileScratchEntry} so the entry points at the task it became and disappears
 * from the queue. Nothing here creates tasks itself — filing is a pointer, not
 * a side effect, so an agent stays free to do the right thing with each idea.
 *
 * Access: owner or workspace admin (the same coordinator scope tasks use).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { scratchEntries, tasks, users, type ScratchEntry, type ScratchStatus } from './schema.js';
import {
  assertAccessibleExists,
  ForbiddenError,
  NotFoundError,
  NotSharedScratchError,
} from './access.js';
import { isAdmin } from './auth.js';

export const MAX_SCRATCH_BODY = 8000;

export const scratchStatusSchema = z.enum(['new', 'filed', 'dismissed']);

export const createScratchEntryInputSchema = z.object({
  body: z.string().trim().min(1).max(MAX_SCRATCH_BODY),
});
export type CreateScratchEntryInput = z.infer<typeof createScratchEntryInputSchema>;

export const listScratchEntriesFilterSchema = z.object({
  /** Which owners: my own entries (default in the UI) or everyone's I can reach (admins). */
  scope: z.enum(['mine', 'all']).optional(),
  status: z.union([scratchStatusSchema, z.literal('all')]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ListScratchEntriesFilter = z.infer<typeof listScratchEntriesFilterSchema>;

/**
 * No such row. A *subclass of NotFoundError* so the scratchpad speaks the same
 * error vocabulary as tasks and notes: before this it extended plain `Error`,
 * which both MCP transports mapped to the catch-all `error:` prefix — so a
 * missing entry and a database outage were indistinguishable to a caller, and
 * the `not_found:` / `not_shared:` contrast this module now draws was
 * unreadable on the wire.
 */
export class ScratchNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(id);
    this.name = 'ScratchNotFoundError';
    this.message = `Scratch entry ${id} not found`;
  }
}

/** An entry plus the display fields the UI and agents want next to it. */
export type ScratchEntryView = ScratchEntry & {
  ownerName: string | null;
  filedTaskTitle: string | null;
  filedByName: string | null;
};

function now(): number {
  return Date.now();
}

/**
 * Load one entry the caller may touch: their own, or anyone's when they are an
 * admin.
 *
 * The two failures are DIFFERENT answers and the callers need them apart:
 *   - no such row                   -> ScratchNotFoundError  ("not_found:")
 *   - row exists, someone else owns -> NotSharedScratchError ("not_shared:")
 *
 * This used to be one answer for both, and the docblock justified it with
 * "as with tasks". That justification was retired by the very card that fixed
 * tasks: `assertAccessibleExists` has distinguished the two since 2026-09-03.
 * A stale reason reads exactly like a live decision, which is why the
 * scratchpad survived three passes of that card — see the note on
 * `Tx5g85uLq96D`. A scratchpad ENTRY id is the fourth object type in this
 * codebase to hit it, after tasks, brain notes and comment ids.
 */
async function loadAccessible(ctx: Context, id: string): Promise<ScratchEntry> {
  const db = getDb();
  const rows = await db.select().from(scratchEntries).where(eq(scratchEntries.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new ScratchNotFoundError(id);
  if (row.userId === ctx.userId) return row;
  if (await isAdmin(ctx.userId)) return row;
  throw new NotSharedScratchError(id);
}

export async function createScratchEntry(
  ctx: Context,
  input: CreateScratchEntryInput,
  opts: { source?: 'human' | 'agent' } = {},
): Promise<ScratchEntry> {
  const parsed = createScratchEntryInputSchema.parse(input);
  const db = getDb();
  const ts = now();
  const row: ScratchEntry = {
    id: nanoid(12),
    userId: ctx.userId,
    body: parsed.body,
    status: 'new',
    filedTaskId: null,
    filedBy: null,
    filedNote: null,
    filedAt: null,
    source: opts.source ?? 'human',
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(scratchEntries).values(row);
  return row;
}

export async function getScratchEntry(ctx: Context, id: string): Promise<ScratchEntryView | null> {
  try {
    const row = await loadAccessible(ctx, id);
    const [view] = await enrich([row]);
    return view ?? null;
  } catch (err) {
    // Both unreachable cases stay `null` here. This is a READ used by the web
    // page, which renders "nothing to show" either way; splitting the error is
    // for the MCP surface, where an agent acts on the difference. Listed
    // explicitly rather than caught as NotFoundError so that widening the
    // hierarchy again cannot silently swallow a third thing.
    if (err instanceof ScratchNotFoundError || err instanceof NotSharedScratchError) return null;
    throw err;
  }
}

/**
 * Newest first. `scope: 'all'` only widens beyond the caller's own rows when
 * they are an admin — for everyone else it is identical to 'mine'.
 */
export async function listScratchEntries(
  ctx: Context,
  filter: ListScratchEntriesFilter = {},
): Promise<ScratchEntryView[]> {
  const f = listScratchEntriesFilterSchema.parse(filter);
  const db = getDb();
  const status = f.status ?? 'new';
  const wide = f.scope === 'all' && (await isAdmin(ctx.userId));
  const conds = [];
  if (!wide) conds.push(eq(scratchEntries.userId, ctx.userId));
  if (status !== 'all') conds.push(eq(scratchEntries.status, status));
  const rows = await db
    .select()
    .from(scratchEntries)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(scratchEntries.createdAt))
    .limit(f.limit ?? 200);
  return enrich(rows);
}

/** Count of the caller's own unfiled ideas — the sidebar badge. */
export async function countNewScratchEntries(ctx: Context): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(scratchEntries)
    .where(and(eq(scratchEntries.userId, ctx.userId), eq(scratchEntries.status, 'new')));
  return Number(rows[0]?.n ?? 0);
}

/** Edit the text. Re-opens a filed/dismissed entry only if the caller asks via `status`. */
export async function updateScratchEntry(
  ctx: Context,
  id: string,
  patch: { body?: string; status?: ScratchStatus },
): Promise<ScratchEntry> {
  const row = await loadAccessible(ctx, id);
  const set: Partial<ScratchEntry> = { updatedAt: now() };
  if (patch.body !== undefined) {
    const body = patch.body.trim();
    if (body.length > MAX_SCRATCH_BODY) throw new Error(`body exceeds ${MAX_SCRATCH_BODY} chars`);
    set.body = body;
  }
  if (patch.status !== undefined) {
    set.status = patch.status;
    if (patch.status === 'new') {
      set.filedTaskId = null;
      set.filedBy = null;
      set.filedNote = null;
      set.filedAt = null;
    } else if (patch.status === 'dismissed' && row.status !== 'dismissed') {
      set.filedBy = ctx.userId;
      set.filedAt = now();
    }
  }
  const db = getDb();
  await db.update(scratchEntries).set(set).where(eq(scratchEntries.id, id));
  return { ...row, ...set };
}

/**
 * Mark an idea as handled: it became `taskId`, or was placed under it. The
 * task must be one the filer can reach (it usually is — they just created it).
 */
export async function fileScratchEntry(
  ctx: Context,
  id: string,
  input: { taskId: string; note?: string | null },
): Promise<ScratchEntry> {
  const row = await loadAccessible(ctx, id);
  await assertAccessibleExists(ctx, input.taskId);
  const set: Partial<ScratchEntry> = {
    status: 'filed',
    filedTaskId: input.taskId,
    filedBy: ctx.userId,
    filedNote: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
    filedAt: now(),
    updatedAt: now(),
  };
  const db = getDb();
  await db.update(scratchEntries).set(set).where(eq(scratchEntries.id, id));
  return { ...row, ...set };
}

/** Looked at it, nothing to file. Keeps the text for the record. */
export async function dismissScratchEntry(
  ctx: Context,
  id: string,
  input: { note?: string | null } = {},
): Promise<ScratchEntry> {
  const row = await loadAccessible(ctx, id);
  const set: Partial<ScratchEntry> = {
    status: 'dismissed',
    filedTaskId: null,
    filedBy: ctx.userId,
    filedNote: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
    filedAt: now(),
    updatedAt: now(),
  };
  const db = getDb();
  await db.update(scratchEntries).set(set).where(eq(scratchEntries.id, id));
  return { ...row, ...set };
}

/**
 * Owner only — an agent tidies by filing or dismissing, never by deleting.
 * (Not an MCP tool; reached from the web page.)
 *
 * This used to filter on ownership INSIDE the WHERE clause, so "no such entry"
 * and "not your entry" both came back as zero rows — structurally incapable of
 * telling them apart, which is the exact pre-fix shape of the note guard.
 * Fixed here as well as on the MCP path, because leaving the blind version one
 * function below the fixed one is how this defect has kept reappearing.
 *
 * Three outcomes now, and the set of successful deletes is unchanged — an
 * admin still may not delete somebody else's entry, they just get told why:
 */
export async function deleteScratchEntry(ctx: Context, id: string): Promise<void> {
  const row = await loadAccessible(ctx, id); // missing -> not_found, others' -> not_shared
  if (row.userId !== ctx.userId) {
    // Reachable only for an admin: they can READ the entry (loadAccessible let
    // them through) and still may not delete it. "Not shared" would be a lie.
    throw new ForbiddenError(id, 'Scratch entry');
  }
  await getDb().delete(scratchEntries).where(eq(scratchEntries.id, id));
}

async function enrich(rows: ScratchEntry[]): Promise<ScratchEntryView[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const userIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const r of rows) {
    userIds.add(r.userId);
    if (r.filedBy) userIds.add(r.filedBy);
    if (r.filedTaskId) taskIds.add(r.filedTaskId);
  }
  const [userRows, taskRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...userIds])),
    taskIds.size
      ? db
          .select({ id: tasks.id, title: tasks.title })
          .from(tasks)
          .where(inArray(tasks.id, [...taskIds]))
      : Promise.resolve([] as { id: string; title: string }[]),
  ]);
  const names = new Map(userRows.map((u) => [u.id, u.name]));
  const titles = new Map(taskRows.map((t) => [t.id, t.title]));
  return rows.map((r) => ({
    ...r,
    ownerName: names.get(r.userId) ?? null,
    filedTaskTitle: r.filedTaskId ? (titles.get(r.filedTaskId) ?? null) : null,
    filedByName: r.filedBy ? (names.get(r.filedBy) ?? null) : null,
  }));
}

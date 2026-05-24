import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import {
  brainNotes,
  tasks,
  taskAttachments,
  type BrainNote,
  type TaskAttachment,
} from './schema.js';
import {
  assertAccessibleNoteExists,
  assertAccessibleExists,
  getAccessibleNoteIds,
  getAccessibleTaskIds,
  NotFoundError,
} from './access.js';
import { getStorage } from './storage/index.js';
import {
  createBrainNoteInputSchema,
  listBrainNotesFilterSchema,
  updateBrainNoteInputSchema,
  type CreateBrainNoteInput,
  type ListBrainNotesFilter,
  type UpdateBrainNoteInput,
} from './types.js';
import { tiptapJsonToText, textToTiptapDoc } from './brain-text.js';
import { searchTasks } from './tasks.js';

export type BrainNoteWithChildren = BrainNote & {
  children: BrainNote[];
  attachments: TaskAttachment[];
};

const EMPTY_DOC = '{"type":"doc","content":[]}';

function now(): number {
  return Date.now();
}

/**
 * Validates that scopeTaskId (when set) points at a task the caller can access
 * AND that kind is 'entity' or 'project' — the only two workstream containers
 * brain notes attach to. Other kinds (task, goal, kpi) aren't appropriate
 * scopes for a knowledge base.
 */
async function ensureScopeTaskValid(
  ctx: Context,
  scopeTaskId: string | null | undefined,
): Promise<void> {
  if (scopeTaskId === null || scopeTaskId === undefined) return;
  const scope = await assertAccessibleExists(ctx, scopeTaskId);
  if (scope.kind !== 'entity' && scope.kind !== 'project') {
    throw new Error(
      `Task ${scopeTaskId} is kind=${scope.kind}; brain notes only attach to entities or projects`,
    );
  }
}

/**
 * Renders contentJson + contentText from whatever the caller provided. Centralized
 * so callers can pass either the JSON (UI) or text (MCP) and both fields end up
 * coherent in the row. Returns `{ contentJson, contentText }` strings ready to
 * write.
 *
 * Sanitizes the input via JSON round-trip — Tiptap v3's `getJSON()` can include
 * function references on attrs (a serialization quirk that survives the React
 * Server Actions encoder). JSON.parse(JSON.stringify(...)) strips functions,
 * undefined values, and getter accessors so the stored doc is plain.
 *
 * Also accepts `contentJson` as a *pre-serialized JSON string*: some MCP
 * transports (and ad-hoc JSON-RPC clients) serialize nested objects to strings
 * on the wire. Without this, the doubly-stringified payload gets stored
 * literally and renders as raw JSON text in the editor.
 */
function deriveContent(
  input: { contentJson?: unknown; contentText?: string } | undefined,
): { contentJson: string; contentText: string } {
  if (input?.contentJson !== undefined) {
    const unwrapped = unwrapJsonInput(input.contentJson);
    const serialized = JSON.stringify(unwrapped);
    const sanitized = JSON.parse(serialized);
    const text =
      input.contentText !== undefined ? input.contentText : tiptapJsonToText(sanitized);
    return { contentJson: serialized, contentText: text };
  }
  if (input?.contentText !== undefined) {
    const json = textToTiptapDoc(input.contentText);
    return { contentJson: JSON.stringify(json), contentText: input.contentText };
  }
  return { contentJson: EMPTY_DOC, contentText: '' };
}

/**
 * If `value` is a JSON-encoded string of an object/array, parse it once and
 * return the result. Anything else (including a string that doesn't parse to
 * an object) is returned as-is. We only unwrap one level because the legitimate
 * Tiptap doc input is always an object — a second decode could turn a literal
 * string field into something else.
 */
function unwrapJsonInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
    return value;
  } catch {
    return value;
  }
}

async function nextPosition(ctx: Context, parentNoteId: string | null): Promise<number> {
  const db = getDb();
  const accessibleIds = await getAccessibleNoteIds(ctx);
  if (accessibleIds.length === 0) return 0;
  const cond =
    parentNoteId === null
      ? and(inArray(brainNotes.id, accessibleIds), isNull(brainNotes.parentNoteId))
      : and(inArray(brainNotes.id, accessibleIds), eq(brainNotes.parentNoteId, parentNoteId));
  const rows = await db
    .select({ pos: brainNotes.position })
    .from(brainNotes)
    .where(cond)
    .orderBy(desc(brainNotes.position))
    .limit(1);
  return (rows[0]?.pos ?? -1) + 1;
}

export async function createBrainNote(
  ctx: Context,
  input: CreateBrainNoteInput,
): Promise<BrainNote> {
  const parsed = createBrainNoteInputSchema.parse(input);
  await ensureScopeTaskValid(ctx, parsed.scopeTaskId ?? null);

  let ownerId = ctx.userId;
  if (parsed.parentNoteId) {
    const parent = await assertAccessibleNoteExists(ctx, parsed.parentNoteId);
    ownerId = parent.userId;
  } else if (parsed.scopeTaskId) {
    // For scope-task roots, inherit owner from the scope task so collaborators
    // see each other's notes under the shared workstream.
    const scope = await assertAccessibleExists(ctx, parsed.scopeTaskId);
    ownerId = scope.userId;
  }

  const { contentJson, contentText } = deriveContent({
    ...(parsed.contentJson !== undefined ? { contentJson: parsed.contentJson } : {}),
    ...(parsed.contentText !== undefined ? { contentText: parsed.contentText } : {}),
  });

  const ts = now();
  const row: BrainNote = {
    id: nanoid(12),
    userId: ownerId,
    scopeTaskId: parsed.scopeTaskId ?? null,
    parentNoteId: parsed.parentNoteId ?? null,
    title: parsed.title,
    icon: parsed.icon ?? null,
    contentJson,
    contentText,
    position: await nextPosition(ctx, parsed.parentNoteId ?? null),
    source: parsed.source ?? 'human',
    createdAt: ts,
    updatedAt: ts,
  };
  await getDb().insert(brainNotes).values(row);
  return row;
}

export async function getBrainNote(ctx: Context, id: string): Promise<BrainNoteWithChildren | null> {
  const db = getDb();
  const note = await assertAccessibleNoteExists(ctx, id).catch((e: unknown) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!note) return null;
  const accessibleIds = await getAccessibleNoteIds(ctx);
  const [children, attachments] = await Promise.all([
    accessibleIds.length === 0
      ? Promise.resolve([] as BrainNote[])
      : db
          .select()
          .from(brainNotes)
          .where(and(inArray(brainNotes.id, accessibleIds), eq(brainNotes.parentNoteId, id)))
          .orderBy(asc(brainNotes.position), asc(brainNotes.createdAt)),
    db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.brainNoteId, id))
      .orderBy(asc(taskAttachments.createdAt)),
  ]);
  return { ...note, children, attachments };
}

export async function listBrainNotes(
  ctx: Context,
  filter: ListBrainNotesFilter = {},
): Promise<BrainNote[]> {
  const f = listBrainNotesFilterSchema.parse(filter);
  const db = getDb();
  const accessibleIds = await getAccessibleNoteIds(ctx);
  if (accessibleIds.length === 0) return [];
  const conditions = [inArray(brainNotes.id, accessibleIds)];
  if (f.scopeTaskId !== undefined) {
    conditions.push(
      f.scopeTaskId === null
        ? isNull(brainNotes.scopeTaskId)
        : eq(brainNotes.scopeTaskId, f.scopeTaskId),
    );
  }
  if (f.parentNoteId !== undefined) {
    conditions.push(
      f.parentNoteId === null
        ? isNull(brainNotes.parentNoteId)
        : eq(brainNotes.parentNoteId, f.parentNoteId),
    );
  }
  const query = db
    .select()
    .from(brainNotes)
    .where(and(...conditions))
    .orderBy(asc(brainNotes.position), asc(brainNotes.createdAt));
  if (f.limit !== undefined) return query.limit(f.limit);
  return query;
}

/**
 * Return every note the user can read, in one shot. Used by the sidebar to
 * render the full tree without an N+1 of `listBrainNotes` per parent.
 */
export async function listAllAccessibleBrainNotes(ctx: Context): Promise<BrainNote[]> {
  const db = getDb();
  const accessibleIds = await getAccessibleNoteIds(ctx);
  if (accessibleIds.length === 0) return [];
  return db
    .select()
    .from(brainNotes)
    .where(inArray(brainNotes.id, accessibleIds))
    .orderBy(asc(brainNotes.position), asc(brainNotes.createdAt));
}

export async function updateBrainNote(
  ctx: Context,
  id: string,
  patch: UpdateBrainNoteInput,
): Promise<BrainNote> {
  const parsed = updateBrainNoteInputSchema.parse(patch);
  await assertAccessibleNoteExists(ctx, id);
  if (parsed.scopeTaskId !== undefined) {
    await ensureScopeTaskValid(ctx, parsed.scopeTaskId);
  }
  if (parsed.parentNoteId !== undefined && parsed.parentNoteId !== null) {
    if (parsed.parentNoteId === id) throw new Error('A note cannot be its own parent');
    await assertAccessibleNoteExists(ctx, parsed.parentNoteId);
  }

  const ts = now();
  const update: Partial<BrainNote> = { updatedAt: ts };
  if (parsed.title !== undefined) update.title = parsed.title;
  if (parsed.icon !== undefined) update.icon = parsed.icon;
  if (parsed.scopeTaskId !== undefined) update.scopeTaskId = parsed.scopeTaskId;
  if (parsed.parentNoteId !== undefined) update.parentNoteId = parsed.parentNoteId;

  if (parsed.contentJson !== undefined || parsed.contentText !== undefined) {
    const derived = deriveContent({
      ...(parsed.contentJson !== undefined ? { contentJson: parsed.contentJson } : {}),
      ...(parsed.contentText !== undefined ? { contentText: parsed.contentText } : {}),
    });
    update.contentJson = derived.contentJson;
    update.contentText = derived.contentText;
  }

  await getDb().update(brainNotes).set(update).where(eq(brainNotes.id, id));
  const rows = await getDb().select().from(brainNotes).where(eq(brainNotes.id, id));
  return rows[0]!;
}

async function collectNoteDescendantIds(ctx: Context, rootId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE roots(id) AS (
      SELECT id FROM tasks WHERE user_id = ${ctx.userId}
      UNION
      SELECT task_id FROM task_shares WHERE user_id = ${ctx.userId}
    ),
    accessible_tasks(id) AS (
      SELECT id FROM roots
      UNION
      SELECT t.id FROM tasks t JOIN accessible_tasks a ON t.parent_id = a.id
    ),
    accessible_notes(id) AS (
      SELECT id FROM brain_notes
       WHERE (scope_task_id IS NULL AND user_id = ${ctx.userId})
          OR scope_task_id IN (SELECT id FROM accessible_tasks)
    ),
    subtree(id) AS (
      SELECT id FROM brain_notes
       WHERE id = ${rootId}
         AND id IN (SELECT id FROM accessible_notes)
      UNION ALL
      SELECT n.id FROM brain_notes n
        JOIN subtree s ON n.parent_note_id = s.id
       WHERE n.id IN (SELECT id FROM accessible_notes)
    )
    SELECT id FROM subtree
  `);
  return rows.map((r) => r.id);
}

export async function deleteBrainNote(
  ctx: Context,
  id: string,
): Promise<{ deletedIds: string[] }> {
  await assertAccessibleNoteExists(ctx, id);
  const ids = await collectNoteDescendantIds(ctx, id);
  if (ids.length === 0) return { deletedIds: [] };

  const db = getDb();
  // Delete attachment blobs first so the storage adapter can clean up before
  // the rows disappear. Best-effort — orphan blobs are recoverable via storage_key.
  const atts = await db
    .select()
    .from(taskAttachments)
    .where(inArray(taskAttachments.brainNoteId, ids));
  if (atts.length > 0) {
    const adapter = await getStorage();
    await Promise.allSettled(atts.map((a) => adapter.delete(a.storageKey)));
    await db.delete(taskAttachments).where(inArray(taskAttachments.brainNoteId, ids));
  }
  await db.delete(brainNotes).where(inArray(brainNotes.id, ids));
  return { deletedIds: ids };
}

export async function moveBrainNote(
  ctx: Context,
  id: string,
  newParentNoteId: string | null,
  position?: number,
): Promise<BrainNote> {
  await assertAccessibleNoteExists(ctx, id);
  if (newParentNoteId !== null) {
    if (newParentNoteId === id) throw new Error('A note cannot be its own parent');
    await assertAccessibleNoteExists(ctx, newParentNoteId);
    const subtreeIds = await collectNoteDescendantIds(ctx, id);
    if (subtreeIds.includes(newParentNoteId)) {
      throw new Error('Cannot move a note under one of its own descendants');
    }
  }

  const ts = now();
  const targetPos = position ?? (await nextPosition(ctx, newParentNoteId));
  await getDb()
    .update(brainNotes)
    .set({ parentNoteId: newParentNoteId, position: targetPos, updatedAt: ts })
    .where(eq(brainNotes.id, id));
  const rows = await getDb().select().from(brainNotes).where(eq(brainNotes.id, id));
  return rows[0]!;
}

export type SearchBrainNotesOptions = {
  scopeTaskId?: string | null;
  limit?: number;
};

export type BrainNoteSearchHit = {
  id: string;
  title: string;
  icon: string | null;
  scopeTaskId: string | null;
  parentNoteId: string | null;
  snippet: string;
  updatedAt: number;
};

export async function searchBrainNotes(
  ctx: Context,
  query: string,
  options: SearchBrainNotesOptions = {},
): Promise<BrainNoteSearchHit[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const accessibleIds = await getAccessibleNoteIds(ctx);
  if (accessibleIds.length === 0) return [];

  const escaped = q.replace(/[!%_]/g, '!$&');
  const pattern = `%${escaped}%`;
  const limit = options.limit ?? 50;

  const db = getDb();
  const conditions = [
    inArray(brainNotes.id, accessibleIds),
    or(
      sql`LOWER(${brainNotes.title}) LIKE LOWER(${pattern}) ESCAPE '!'`,
      sql`LOWER(${brainNotes.contentText}) LIKE LOWER(${pattern}) ESCAPE '!'`,
    ),
  ];
  if (options.scopeTaskId !== undefined) {
    conditions.push(
      options.scopeTaskId === null
        ? isNull(brainNotes.scopeTaskId)
        : eq(brainNotes.scopeTaskId, options.scopeTaskId),
    );
  }
  const rows = await db
    .select()
    .from(brainNotes)
    .where(and(...conditions))
    .orderBy(desc(brainNotes.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    scopeTaskId: r.scopeTaskId,
    parentNoteId: r.parentNoteId,
    updatedAt: r.updatedAt,
    snippet: makeSnippet(r.contentText, q),
  }));
}

function makeSnippet(text: string, q: string): string {
  if (text.length === 0) return '';
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 160);
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + q.length + 110);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

/**
 * Mixed search across tasks and brain notes for the editor's "/" link picker.
 * Returns at most `limit` items total, biased to notes (which are usually the
 * most relevant link target inside a brain note) then tasks. Ordered by recency
 * inside each bucket.
 */
export type LinkableHit =
  | {
      kind: 'task';
      id: string;
      title: string;
      icon: string | null;
      subtitle: string | null;
    }
  | {
      kind: 'note';
      id: string;
      title: string;
      icon: string | null;
      subtitle: string | null;
    };

export async function searchLinkables(
  ctx: Context,
  query: string,
  limit = 10,
): Promise<LinkableHit[]> {
  const q = query.trim();
  const half = Math.max(2, Math.floor(limit / 2));
  let tasks: LinkableHit[] = [];
  let notes: LinkableHit[];
  if (q.length === 0) {
    // Empty query: show recent notes only so the picker isn't blank.
    const recent = await listAllAccessibleBrainNotes(ctx);
    notes = recent
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((n) => ({
        kind: 'note' as const,
        id: n.id,
        title: n.title,
        icon: n.icon,
        subtitle: n.scopeTaskId ? 'scoped' : 'personal',
      }));
  } else {
    const [taskRows, noteHits] = await Promise.all([
      searchTasks(ctx, q, { limit: half }),
      searchBrainNotes(ctx, q, { limit: half }),
    ]);
    tasks = taskRows.map((t) => ({
      kind: 'task' as const,
      id: t.id,
      title: t.title,
      icon: null,
      subtitle: t.kind,
    }));
    notes = noteHits.map((h) => ({
      kind: 'note' as const,
      id: h.id,
      title: h.title,
      icon: h.icon,
      subtitle: h.scopeTaskId ? 'scoped' : 'personal',
    }));
  }
  return [...notes, ...tasks].slice(0, limit);
}

/**
 * Resolve a list of `{kind, id}` references (used by the editor's internal
 * link mark) to a map of `{ id -> { title, icon, kind } }`. Reads are
 * access-gated; references the caller can't see are simply omitted.
 */
export type InternalLinkRef = { kind: 'task' | 'note'; id: string };
export type InternalLinkInfo = {
  id: string;
  kind: 'task' | 'note';
  title: string;
  icon: string | null;
};
export async function resolveInternalLinks(
  ctx: Context,
  refs: InternalLinkRef[],
): Promise<Map<string, InternalLinkInfo>> {
  const out = new Map<string, InternalLinkInfo>();
  if (refs.length === 0) return out;
  const taskIds = refs.filter((r) => r.kind === 'task').map((r) => r.id);
  const noteIds = refs.filter((r) => r.kind === 'note').map((r) => r.id);
  const db = getDb();
  if (taskIds.length > 0) {
    const accessibleTaskIds = await getAccessibleTaskIds(ctx);
    const visible = taskIds.filter((id) => accessibleTaskIds.includes(id));
    if (visible.length > 0) {
      const rows = await db
        .select({ id: tasks.id, title: tasks.title, kind: tasks.kind })
        .from(tasks)
        .where(inArray(tasks.id, visible));
      for (const r of rows) {
        out.set(`task:${r.id}`, { id: r.id, kind: 'task', title: r.title, icon: null });
      }
    }
  }
  if (noteIds.length > 0) {
    const accessibleNoteIds = await getAccessibleNoteIds(ctx);
    const visible = noteIds.filter((id) => accessibleNoteIds.includes(id));
    if (visible.length > 0) {
      const rows = await db
        .select({ id: brainNotes.id, title: brainNotes.title, icon: brainNotes.icon })
        .from(brainNotes)
        .where(inArray(brainNotes.id, visible));
      for (const r of rows) {
        out.set(`note:${r.id}`, { id: r.id, kind: 'note', title: r.title, icon: r.icon });
      }
    }
  }
  return out;
}

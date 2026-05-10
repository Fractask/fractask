import { and, asc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { tags, taskTags, type Tag } from './schema.js';
import {
  createTagInputSchema,
  updateTagInputSchema,
  type CreateTagInput,
  type UpdateTagInput,
} from './types.js';

export class TagNotFoundError extends Error {
  constructor(id: string) {
    super(`Tag ${id} not found`);
    this.name = 'TagNotFoundError';
  }
}

function now(): number {
  return Date.now();
}

export async function listTags(ctx: Context): Promise<Tag[]> {
  const db = getDb();
  return db.select().from(tags).where(eq(tags.userId, ctx.userId)).orderBy(asc(tags.name));
}

export async function getTag(ctx: Context, id: string): Promise<Tag | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, ctx.userId)));
  return rows[0] ?? null;
}

export async function createTag(ctx: Context, input: CreateTagInput): Promise<Tag> {
  const parsed = createTagInputSchema.parse(input);
  const db = getDb();
  const row: Tag = {
    id: nanoid(10),
    userId: ctx.userId,
    name: parsed.name,
    color: parsed.color ?? null,
    createdAt: now(),
  };
  await db.insert(tags).values(row);
  return row;
}

export async function updateTag(
  ctx: Context,
  id: string,
  patch: UpdateTagInput,
): Promise<Tag> {
  const parsed = updateTagInputSchema.parse(patch);
  const existing = await getTag(ctx, id);
  if (!existing) throw new TagNotFoundError(id);

  const db = getDb();
  const update: Partial<Tag> = {};
  if (parsed.name !== undefined) update.name = parsed.name;
  if (parsed.color !== undefined) update.color = parsed.color;

  if (Object.keys(update).length > 0) {
    await db
      .update(tags)
      .set(update)
      .where(and(eq(tags.id, id), eq(tags.userId, ctx.userId)));
  }
  const row = await getTag(ctx, id);
  return row!;
}

export async function deleteTag(ctx: Context, id: string): Promise<void> {
  const existing = await getTag(ctx, id);
  if (!existing) throw new TagNotFoundError(id);
  const db = getDb();
  await db.delete(taskTags).where(and(eq(taskTags.userId, ctx.userId), eq(taskTags.tagId, id)));
  await db.delete(tags).where(and(eq(tags.id, id), eq(tags.userId, ctx.userId)));
}

export async function getTagsForTask(ctx: Context, taskId: string): Promise<Tag[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: tags.id,
      userId: tags.userId,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
    })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(and(eq(taskTags.userId, ctx.userId), eq(taskTags.taskId, taskId)))
    .orderBy(asc(tags.name));
  return rows;
}

/**
 * Returns a map of taskId -> tags for the given task ids. One round trip.
 */
export async function getTagsForTasks(
  ctx: Context,
  taskIds: string[],
): Promise<Record<string, Tag[]>> {
  if (taskIds.length === 0) return {};
  const db = getDb();
  const rows = await db
    .select({
      taskId: taskTags.taskId,
      id: tags.id,
      userId: tags.userId,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
    })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(and(eq(taskTags.userId, ctx.userId), inArray(taskTags.taskId, taskIds)))
    .orderBy(asc(tags.name));

  const result: Record<string, Tag[]> = {};
  for (const id of taskIds) result[id] = [];
  for (const r of rows) {
    const { taskId, ...tag } = r;
    result[taskId]!.push(tag);
  }
  return result;
}

/**
 * Replace the full set of tags on a task with the given tag ids.
 */
export async function setTaskTags(
  ctx: Context,
  taskId: string,
  tagIds: string[],
): Promise<void> {
  const db = getDb();
  const ts = now();
  await db
    .delete(taskTags)
    .where(and(eq(taskTags.userId, ctx.userId), eq(taskTags.taskId, taskId)));
  if (tagIds.length === 0) return;
  await db.insert(taskTags).values(
    tagIds.map((tagId) => ({
      userId: ctx.userId,
      taskId,
      tagId,
      createdAt: ts,
    })),
  );
}

export async function addTagToTask(
  ctx: Context,
  taskId: string,
  tagId: string,
): Promise<void> {
  const db = getDb();
  await db
    .insert(taskTags)
    .values({ userId: ctx.userId, taskId, tagId, createdAt: now() })
    .onConflictDoNothing();
}

export async function removeTagFromTask(
  ctx: Context,
  taskId: string,
  tagId: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(taskTags)
    .where(
      and(
        eq(taskTags.userId, ctx.userId),
        eq(taskTags.taskId, taskId),
        eq(taskTags.tagId, tagId),
      ),
    );
}

'use server';

import {
  TagNotFoundError,
  addTagToTask as coreAddTagToTask,
  createTag as coreCreateTag,
  deleteTag as coreDeleteTag,
  listTags as coreListTags,
  removeTagFromTask as coreRemoveTagFromTask,
  setTaskTags as coreSetTaskTags,
  updateTag as coreUpdateTag,
  type Tag,
} from '@getshit/core';
import { revalidatePath } from 'next/cache';
import { getRequestContext } from '@/lib/auth';
import type { ActionResult } from './actions';

function toError(err: unknown): string {
  if (err instanceof TagNotFoundError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

export async function listTagsAction(): Promise<ActionResult<Tag[]>> {
  try {
    const ctx = await getRequestContext();
    return { ok: true, value: await coreListTags(ctx) };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function createTagAction(input: {
  name: string;
  color?: string | null;
}): Promise<ActionResult<Tag>> {
  try {
    const ctx = await getRequestContext();
    const t = await coreCreateTag(ctx, input);
    revalidatePath('/tags');
    return { ok: true, value: t };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function updateTagAction(
  id: string,
  patch: { name?: string; color?: string | null },
): Promise<ActionResult<Tag>> {
  try {
    const ctx = await getRequestContext();
    const t = await coreUpdateTag(ctx, id, patch);
    revalidatePath('/tags');
    return { ok: true, value: t };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function deleteTagAction(id: string): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreDeleteTag(ctx, id);
    revalidatePath('/tags');
    revalidatePath('/');
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function setTaskTagsAction(
  taskId: string,
  tagIds: string[],
): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreSetTaskTags(ctx, taskId, tagIds);
    revalidatePath(`/${taskId}`);
    revalidatePath('/');
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function addTagToTaskAction(
  taskId: string,
  tagId: string,
): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreAddTagToTask(ctx, taskId, tagId);
    revalidatePath(`/${taskId}`);
    revalidatePath('/');
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function removeTagFromTaskAction(
  taskId: string,
  tagId: string,
): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreRemoveTagFromTask(ctx, taskId, tagId);
    revalidatePath(`/${taskId}`);
    revalidatePath('/');
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

'use server';

import {
  AssigneeNotFoundError,
  createAssignee as coreCreateAssignee,
  deleteAssignee as coreDeleteAssignee,
  listAssignees as coreListAssignees,
  updateAssignee as coreUpdateAssignee,
  type Assignee,
  type AssigneeKind,
} from '@getshit/core';
import { revalidatePath } from 'next/cache';
import { getRequestContext } from '@/lib/auth';
import type { ActionResult } from './actions';

function toError(err: unknown): string {
  if (err instanceof AssigneeNotFoundError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

export async function listAssigneesAction(): Promise<ActionResult<Assignee[]>> {
  try {
    const ctx = await getRequestContext();
    return { ok: true, value: await coreListAssignees(ctx) };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function createAssigneeAction(input: {
  name: string;
  kind: AssigneeKind;
  color?: string | null;
}): Promise<ActionResult<Assignee>> {
  try {
    const ctx = await getRequestContext();
    const a = await coreCreateAssignee(ctx, input);
    revalidatePath('/assignees');
    return { ok: true, value: a };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function updateAssigneeAction(
  id: string,
  patch: { name?: string; kind?: AssigneeKind; color?: string | null },
): Promise<ActionResult<Assignee>> {
  try {
    const ctx = await getRequestContext();
    const a = await coreUpdateAssignee(ctx, id, patch);
    revalidatePath('/assignees');
    return { ok: true, value: a };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function deleteAssigneeAction(id: string): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreDeleteAssignee(ctx, id);
    revalidatePath('/assignees');
    revalidatePath('/');
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

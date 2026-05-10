'use server';

import { revalidatePath } from 'next/cache';
import {
  listShareableUsers,
  listTaskShares,
  shareTaskWithUserId,
  unshareTask,
  type ShareEntry,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

export type ShareEntryDTO = {
  user: { id: string; email: string | null; name: string | null };
  createdAt: number;
  via?: { id: string; title: string };
};

type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

function toError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

function toDTO(e: ShareEntry): ShareEntryDTO {
  return {
    user: { id: e.user.id, email: e.user.email, name: e.user.name },
    createdAt: e.createdAt,
    ...(e.via ? { via: e.via } : {}),
  };
}

export async function shareTaskAction(
  taskId: string,
  recipientUserId: string,
): Promise<ActionResult<ShareEntryDTO>> {
  try {
    const ctx = await getRequestContext();
    const entry = await shareTaskWithUserId(ctx, taskId, recipientUserId);
    revalidatePath(`/${taskId}`);
    return { ok: true, value: toDTO(entry) };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function listShareableUsersAction(): Promise<
  ActionResult<{ id: string; email: string | null; name: string | null }[]>
> {
  try {
    const ctx = await getRequestContext();
    const rows = await listShareableUsers(ctx);
    return {
      ok: true,
      value: rows.map((u) => ({ id: u.id, email: u.email, name: u.name })),
    };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function unshareTaskAction(
  taskId: string,
  userId: string,
): Promise<ActionResult<true>> {
  try {
    const ctx = await getRequestContext();
    await unshareTask(ctx, taskId, userId);
    revalidatePath(`/${taskId}`);
    return { ok: true, value: true };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function listSharesAction(
  taskId: string,
): Promise<ActionResult<{ direct: ShareEntryDTO[]; inherited: ShareEntryDTO[] }>> {
  try {
    const ctx = await getRequestContext();
    const { direct, inherited } = await listTaskShares(ctx, taskId);
    return {
      ok: true,
      value: {
        direct: direct.map(toDTO),
        inherited: inherited.map(toDTO),
      },
    };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

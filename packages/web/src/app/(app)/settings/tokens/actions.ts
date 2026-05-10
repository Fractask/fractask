'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createCliToken, revokeCliToken } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

export async function generateTokenAction(formData: FormData): Promise<void> {
  const ctx = await getRequestContext();
  const labelRaw = String(formData.get('label') ?? '').trim();
  const label = labelRaw.length > 0 ? labelRaw : null;
  const { token } = await createCliToken(ctx.userId, label);
  // Stash on the URL so the page can show the raw token exactly once. The
  // hash is what's stored — the URL parameter is only round-tripped to this
  // user's own browser, never persisted.
  redirect(`/settings/tokens?new=${encodeURIComponent(token)}`);
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const ctx = await getRequestContext();
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  await revokeCliToken(ctx.userId, id);
  revalidatePath('/settings/tokens');
}

'use server';

import { revalidatePath } from 'next/cache';
import { createUser } from '@getshit/core';

export async function createUserAction(formData: FormData): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const kindRaw = String(formData.get('kind') ?? 'human');
    if (kindRaw !== 'human' && kindRaw !== 'agent' && kindRaw !== 'guest') {
      return { ok: false, error: 'invalid kind' };
    }
    const name = String(formData.get('name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();
    const endpoint = String(formData.get('endpoint') ?? '').trim();
    await createUser({
      kind: kindRaw,
      name: name || null,
      email: email || null,
      endpoint: endpoint || null,
    });
    revalidatePath('/settings/users');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

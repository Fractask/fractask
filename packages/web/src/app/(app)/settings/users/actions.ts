'use server';

import { revalidatePath } from 'next/cache';
import { createUser, createAgentCliToken, revokeCliToken } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

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

/**
 * Mint a CLI/MCP bearer token for an agent user. The raw token is returned
 * once so the caller's browser can display it; only the hash is stored.
 */
export async function generateAgentTokenAction(
  formData: FormData,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    // Auth gate — only a signed-in workspace member may mint agent tokens.
    await getRequestContext();
    const agentId = String(formData.get('agentId') ?? '').trim();
    if (!agentId) return { ok: false, error: 'missing agent' };
    const labelRaw = String(formData.get('label') ?? '').trim();
    const { token } = await createAgentCliToken(agentId, labelRaw || null);
    revalidatePath('/settings/users');
    return { ok: true, token };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export async function revokeAgentTokenAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getRequestContext();
    const agentId = String(formData.get('agentId') ?? '').trim();
    const tokenId = String(formData.get('tokenId') ?? '').trim();
    if (!agentId || !tokenId) return { ok: false, error: 'missing id' };
    await revokeCliToken(agentId, tokenId);
    revalidatePath('/settings/users');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

'use server';

import { revalidatePath } from 'next/cache';
import {
  clearUserTaskGuidelines,
  resetGlobalTaskGuidelines,
  setGlobalTaskGuidelines,
  setUserTaskGuidelines,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

export async function saveGlobalGuidelinesAction(formData: FormData): Promise<void> {
  const value = String(formData.get('value') ?? '').trim();
  if (value.length === 0) {
    await resetGlobalTaskGuidelines();
  } else {
    await setGlobalTaskGuidelines(value);
  }
  revalidatePath('/settings/guidelines');
}

export async function saveUserGuidelinesAction(formData: FormData): Promise<void> {
  const ctx = await getRequestContext();
  const value = String(formData.get('value') ?? '').trim();
  if (value.length === 0) {
    await clearUserTaskGuidelines(ctx);
  } else {
    await setUserTaskGuidelines(ctx, value);
  }
  revalidatePath('/settings/guidelines');
}

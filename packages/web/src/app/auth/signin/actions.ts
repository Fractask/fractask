'use server';

import { redirect } from 'next/navigation';
import { signIn, signOut } from '@/auth';

export async function googleSignInAction(formData: FormData): Promise<void> {
  const callbackUrl = String(formData.get('callbackUrl') ?? '/') || '/';
  await signIn('google', { redirectTo: callbackUrl });
}

export async function credentialsSignInAction(formData: FormData): Promise<void> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const callbackUrl = String(formData.get('callbackUrl') ?? '/') || '/';

  try {
    await signIn('credentials', {
      username,
      password,
      redirect: false,
    });
  } catch {
    redirect('/auth/signin?error=invalid&callbackUrl=' + encodeURIComponent(callbackUrl));
  }
  redirect(callbackUrl.startsWith('/') ? callbackUrl : '/');
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/auth/signin' });
}

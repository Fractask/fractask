import { NextResponse } from 'next/server';
import { VIEW_AS_COOKIE } from '@/lib/view-as';

export const dynamic = 'force-dynamic';

/** Exit "View as agent" preview: clear the cookie and return to the users page. */
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/settings/users', req.url));
  res.cookies.delete(VIEW_AS_COOKIE);
  return res;
}

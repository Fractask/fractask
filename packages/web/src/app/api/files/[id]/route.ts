import { NextResponse } from 'next/server';
import { getAttachment, getStorage, NotFoundError } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/[id]
 *
 * Auth-gated download. For the `local` adapter, streams the file body. For
 * `s3` (or any adapter that can presign), 302-redirects to a short-lived
 * signed URL so the browser pulls bytes straight from object storage.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await getRequestContext();
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  let row;
  try {
    row = await getAttachment(auth, id);
  } catch (err) {
    const status = err instanceof NotFoundError ? 404 : 400;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status },
    );
  }

  const adapter = await getStorage();
  const signed = await adapter.getSignedUrl(row.storageKey);
  if (signed) {
    return NextResponse.redirect(signed, 302);
  }

  const { body, mimeType } = await adapter.getStream(row.storageKey);
  return new Response(body, {
    headers: {
      'content-type': mimeType ?? row.mimeType,
      'content-disposition': `inline; filename="${row.filename}"`,
      'cache-control': 'private, max-age=60',
    },
  });
}

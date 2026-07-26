import { NextResponse } from 'next/server';
import { getAttachment, getStorage, NotFoundError, resolveTokenToUser } from '@getshit/core';
import type { Context } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve the caller to a Context from either an `Authorization: Bearer <gs_…>`
 * (or `x-getshit-token`) header — the same `cli_tokens` bearer that `/api/mcp`
 * uses — or, failing that, the Auth.js session cookie. Agents authenticate with
 * a bearer token and have no browser session, so without the bearer path they
 * could read that an attachment exists (via MCP) but never pull its bytes.
 * Returns null when neither credential is present/valid.
 */
async function resolveDownloadContext(req: Request): Promise<Context | null> {
  const header = req.headers.get('authorization') ?? req.headers.get('x-getshit-token');
  if (header) {
    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : header.trim();
    if (token.length > 0) {
      const user = await resolveTokenToUser(token);
      return user ? { userId: user.id } : null;
    }
  }
  try {
    return await getRequestContext();
  } catch {
    return null;
  }
}

/**
 * GET /api/files/[id]
 *
 * Auth-gated download. For the `local` adapter, streams the file body. For
 * `s3` (or any adapter that can presign), 302-redirects to a short-lived
 * signed URL so the browser pulls bytes straight from object storage.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await resolveDownloadContext(req);
  if (!auth) {
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

  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const driver = process.env['GETSHIT_STORAGE'] ?? 'local';
    const hasBucket = Boolean(process.env['GETSHIT_S3_BUCKET']);
    const hasKey = Boolean(process.env['GETSHIT_S3_ACCESS_KEY_ID']);
    return NextResponse.json(
      {
        error: 'storage_failed',
        message: msg,
        diag: { driver, hasBucket, hasKey, storageKey: row.storageKey },
      },
      { status: 500 },
    );
  }
}

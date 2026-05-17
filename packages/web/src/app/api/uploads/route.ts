import { NextResponse } from 'next/server';
import { createAttachment, maxUploadBytes } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/uploads
 *
 * Multipart upload. Expects:
 *   - taskId: text field
 *   - file:   one or more File parts
 *
 * Returns the created attachment rows. Bound by GETSHIT_MAX_UPLOAD_MB
 * per-file; Next 15 route handlers stream FormData with no built-in body
 * cap, so the cap lives in core (createAttachment) and here.
 */
export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await getRequestContext();
  } catch {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid multipart body' }, { status: 400 });
  }

  const taskId = form.get('taskId');
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return NextResponse.json({ error: 'taskId required' }, { status: 400 });
  }

  const files: File[] = [];
  for (const entry of form.getAll('file')) {
    if (entry instanceof File && entry.size > 0) files.push(entry);
  }
  if (files.length === 0) {
    return NextResponse.json({ error: 'no files' }, { status: 400 });
  }

  const limit = maxUploadBytes();
  for (const f of files) {
    if (f.size > limit) {
      return NextResponse.json(
        { error: `file ${f.name} exceeds ${limit} bytes` },
        { status: 413 },
      );
    }
  }

  try {
    const created = await Promise.all(
      files.map(async (f) => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        return createAttachment(ctx, {
          taskId,
          filename: f.name,
          mimeType: f.type || 'application/octet-stream',
          body: bytes,
          source: 'human',
        });
      }),
    );
    return NextResponse.json({ ok: true, attachments: created });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'upload failed' },
      { status: 400 },
    );
  }
}

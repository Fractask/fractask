import {
  getSubtree,
  listAttachmentsForTasks,
  listTasks,
  type Task,
  type TaskTree,
} from '@getshit/core';
import Link from 'next/link';
import { getRequestContext } from '@/lib/auth';
import { GalleryGrid, type GalleryMedia } from '@/components/gallery-grid';
import { ViewToggle } from '@/components/view-toggle';

export const dynamic = 'force-dynamic';

function flatten(node: TaskTree): Task[] {
  const { children, ...task } = node;
  return [task as Task, ...children.flatMap(flatten)];
}

export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope } = await searchParams;
  const ctx = await getRequestContext();

  // Every image/video attached to this task's whole subtree (?scope=), or to
  // everything you can see (no scope). No new schema — this is a lens over the
  // attachments that already exist.
  let tasks: Task[];
  let scopeTitle: string | null = null;
  if (scope) {
    const tree = await getSubtree(ctx, scope);
    if (tree) {
      scopeTitle = tree.title;
      tasks = flatten(tree);
    } else {
      tasks = [];
    }
  } else {
    tasks = await listTasks(ctx, {});
  }

  const titleById = new Map(tasks.map((t) => [t.id, t.title]));
  const attByTask = await listAttachmentsForTasks(ctx, tasks.map((t) => t.id));

  const media: (GalleryMedia & { createdAt: number })[] = [];
  for (const [taskId, list] of attByTask) {
    for (const a of list) {
      const isImage = a.mimeType.startsWith('image/');
      const isVideo = a.mimeType.startsWith('video/');
      if (!isImage && !isVideo) continue;
      media.push({
        id: a.id,
        kind: isImage ? 'image' : 'video',
        url: `/api/files/${a.id}`,
        filename: a.filename,
        taskId,
        taskTitle: titleById.get(taskId) ?? '',
        createdAt: a.createdAt,
      });
    }
  }
  media.sort((a, b) => b.createdAt - a.createdAt); // newest first

  return (
    <div className="px-6 py-4 max-w-6xl mx-auto">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-sm font-medium whitespace-nowrap">Gallery</h1>
          <span className="text-xs text-(--color-muted) tabular-nums">{media.length}</span>
          {scope && scopeTitle && (
            <span className="flex items-baseline gap-1.5 min-w-0 text-xs text-(--color-muted)">
              ·
              <Link
                href={`/${scope}`}
                className="truncate hover:text-(--color-fg)"
                title={scopeTitle}
              >
                {scopeTitle}
              </Link>
              <Link href="/gallery" className="whitespace-nowrap hover:text-(--color-fg)">
                (show all)
              </Link>
            </span>
          )}
        </div>
        <ViewToggle />
      </div>

      <GalleryGrid media={media} />
    </div>
  );
}

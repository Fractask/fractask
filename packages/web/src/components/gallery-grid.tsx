import Link from 'next/link';
import { Play } from 'lucide-react';
import { textDirection } from '@/lib/text-direction';

export type GalleryMedia = {
  id: string;
  kind: 'image' | 'video';
  url: string;
  filename: string;
  taskId: string;
  taskTitle: string;
};

/**
 * One continuous masonry grid of every image/video in a task subtree. CSS
 * columns give the "endless grid" feel; images lazy-load and videos only fetch
 * their first frame until played, so a large board stays cheap.
 */
export function GalleryGrid({ media }: { media: GalleryMedia[] }) {
  if (media.length === 0) {
    return (
      <p className="px-2 py-12 text-center text-sm text-(--color-muted)">
        No images or videos here yet — attach some to this task or its subtasks.
      </p>
    );
  }

  return (
    <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 [column-fill:balance]">
      {media.map((m) => (
        <figure
          key={m.id}
          className="mb-3 break-inside-avoid overflow-hidden rounded-md border border-(--color-border) bg-(--color-surface)"
        >
          {m.kind === 'image' ? (
            <a href={m.url} target="_blank" rel="noreferrer" title={m.filename}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url} alt={m.filename} loading="lazy" className="w-full" />
            </a>
          ) : (
            <span className="relative block">
              <video
                src={m.url}
                controls
                preload="metadata"
                playsInline
                className="w-full bg-black"
              />
              <Play
                size={16}
                className="pointer-events-none absolute left-2 top-2 text-white/80 drop-shadow"
              />
            </span>
          )}
          <figcaption className="px-2 py-1.5">
            <Link
              href={`/${m.taskId}`}
              dir={textDirection(m.taskTitle)}
              className="line-clamp-1 text-xs text-(--color-muted) hover:text-(--color-accent)"
              title={m.taskTitle}
            >
              {m.taskTitle}
            </Link>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

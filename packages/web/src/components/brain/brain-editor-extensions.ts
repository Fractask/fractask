import { Mark, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';

/**
 * Internal-link mark. Decorates a text run that points at a sibling resource
 * inside Fractask — another brain note (kind="note") or a task (kind="task").
 * The mark stores only `{ kind, id }`; the renderer resolves `title + icon`
 * at read time so renames in the target don't leave stale labels behind.
 *
 * Render shape: a styled `<a>` with `data-internal-link` and `data-id` so the
 * read-side React render can swap in a chip with icon + current title.
 */
export const InternalLink = Mark.create<{ HTMLAttributes: Record<string, unknown> }>({
  name: 'internalLink',

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id'),
        renderHTML: (attrs: { id?: string | null }) =>
          attrs.id ? { 'data-id': attrs.id } : {},
      },
      kind: {
        default: 'note',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') ?? 'note',
        renderHTML: (attrs: { kind?: string }) => ({ 'data-kind': attrs.kind ?? 'note' }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'a[data-internal-link]',
        getAttrs: (el: HTMLElement | string) => {
          if (typeof el === 'string') return false;
          return {
            id: el.getAttribute('data-id'),
            kind: el.getAttribute('data-kind') ?? 'note',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    const href =
      HTMLAttributes['data-kind'] === 'task'
        ? `/${HTMLAttributes['data-id']}`
        : `/brain/${HTMLAttributes['data-id']}`;
    return [
      'a',
      mergeAttributes(
        { 'data-internal-link': 'true', href, class: 'brain-internal-link' },
        HTMLAttributes,
      ),
      0,
    ];
  },
});

/**
 * Image node extended with an `attachmentId` attribute so we can correlate
 * inline images back to attachment rows (and clean up blobs on note delete).
 */
export const BrainImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-attachment-id'),
        renderHTML: (attrs: { attachmentId?: string | null }) =>
          attrs.attachmentId ? { 'data-attachment-id': attrs.attachmentId } : {},
      },
    };
  },
});

/**
 * Heuristic — does this href look like an internal link we should auto-promote
 * to the InternalLink mark on paste? Match the same shapes the app exposes:
 * `/brain/<id>` and `/<taskId>` (12-char nanoid).
 */
export function detectInternalLink(href: string): { kind: 'task' | 'note'; id: string } | null {
  try {
    const url = new URL(href, 'http://x');
    const pathname = url.pathname;
    const brain = pathname.match(/^\/brain\/([A-Za-z0-9_-]{6,32})$/);
    if (brain) return { kind: 'note', id: brain[1]! };
    const task = pathname.match(/^\/([A-Za-z0-9_-]{12})$/);
    if (task) return { kind: 'task', id: task[1]! };
    return null;
  } catch {
    return null;
  }
}

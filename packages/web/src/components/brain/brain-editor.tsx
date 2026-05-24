'use client';

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { createRoot, type Root } from 'react-dom/client';
import { createRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
  Quote as QuoteIcon,
  Code as CodeIcon,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Link2,
  Loader2,
} from 'lucide-react';
import { BrainImage, InternalLink, detectInternalLink } from './brain-editor-extensions';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { LinkSuggestion, type LinkSuggestionItem } from './link-suggestion';
import {
  LinkSuggestionPopover,
  type LinkSuggestionPopoverHandle,
} from './link-suggestion-popover';
import {
  resolveInternalLinksAction,
  searchLinkablesAction,
  updateBrainNoteAction,
} from '@/app/brain-actions';
import type { InternalLinkInfo, InternalLinkRef } from '@getshit/core';

type Props = {
  noteId: string;
  initialJson: unknown;
  placeholder?: string;
};

/**
 * Tiptap WYSIWYG editor for a brain note. Stores Tiptap JSON via a debounced
 * server action; pasting an image uploads it through /api/uploads and embeds
 * an `<img data-attachment-id="...">`.
 */
export function BrainEditor({ noteId, initialJson, placeholder }: Props) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedJson = useRef<string>(JSON.stringify(initialJson));
  const editorRef = useRef<Editor | null>(null);
  const [linkMap, setLinkMap] = useState<Map<string, InternalLinkInfo>>(new Map());

  const insertImageFromUpload = async (file: File) => {
    const form = new FormData();
    form.append('brainNoteId', noteId);
    form.append('file', file);
    try {
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(j.error ?? `Upload failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as {
        attachments?: { id: string; filename: string }[];
      };
      const att = json.attachments?.[0];
      if (!att || !editorRef.current) return;
      editorRef.current
        .chain()
        .focus()
        .insertContent({
          type: 'image',
          attrs: {
            src: `/api/files/${att.id}`,
            attachmentId: att.id,
            alt: att.filename,
          },
        })
        .run();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'upload failed');
    }
  };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({
        placeholder: placeholder ?? 'Start writing your note. Paste images, links, anything…',
      }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: 'brain-link' } }),
      InternalLink,
      BrainImage.configure({ inline: false, allowBase64: false }),
      LinkSuggestion.configure({
        suggestion: buildLinkSuggestion(),
      }),
    ],
    content: initialJson ?? { type: 'doc', content: [] },
    editorProps: {
      attributes: {
        class:
          'brain-prose focus:outline-none min-h-[300px] py-2 text-(--color-fg) leading-relaxed',
      },
      handlePaste: (view, event) => {
        const dt = event.clipboardData;
        if (!dt) return false;
        // Image paste → upload as attachment, insert img node.
        const file = Array.from(dt.files).find((f) => f.type.startsWith('image/'));
        if (file) {
          event.preventDefault();
          void insertImageFromUpload(file);
          return true;
        }
        // Plain-text internal URL paste → promote to InternalLink mark.
        const text = dt.getData('text/plain').trim();
        if (text && /^https?:\/\//.test(text)) {
          const internal = detectInternalLink(text);
          if (internal) {
            event.preventDefault();
            const { state } = view;
            const { from, to } = state.selection;
            const label = internal.kind === 'note' ? 'note' : 'task';
            const tr = state.tr;
            if (from === to) {
              tr.insertText(label, from, to);
              tr.addMark(
                from,
                from + label.length,
                state.schema.marks['internalLink']!.create(internal),
              );
            } else {
              tr.addMark(from, to, state.schema.marks['internalLink']!.create(internal));
            }
            view.dispatch(tr);
            return true;
          }
        }
        return false;
      },
    },
    onUpdate({ editor: ed }) {
      scheduleSave(ed);
    },
    onCreate({ editor: ed }) {
      editorRef.current = ed;
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Resolve internal-link references so the editor can render chips with
  // current titles + icons. Refresh whenever the doc changes.
  useEffect(() => {
    if (!editor) return;
    const refs = collectInternalLinkRefs(editor.getJSON());
    if (refs.length === 0) {
      setLinkMap(new Map());
      return;
    }
    let cancelled = false;
    resolveInternalLinksAction(refs).then((r) => {
      if (cancelled || !r.ok) return;
      const m = new Map<string, InternalLinkInfo>();
      for (const info of r.value) m.set(`${info.kind}:${info.id}`, info);
      setLinkMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, [editor]);

  // Cheap DOM swap: rewrite the textContent of `<a data-internal-link>` to
  // show the current title + icon. ProseMirror re-renders on every change
  // so we re-apply on every state update.
  useEffect(() => {
    if (!editor) return;
    const apply = () => {
      const root = editor.view.dom as HTMLElement;
      const links = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('a[data-internal-link]'),
      );
      for (const a of links) {
        const id = a.getAttribute('data-id');
        const kind = a.getAttribute('data-kind') ?? 'note';
        if (!id) continue;
        const info = linkMap.get(`${kind}:${id}`);
        if (info) {
          const label = info.icon ? `${info.icon} ${info.title}` : info.title;
          if (a.textContent !== label) a.textContent = label;
        }
      }
    };
    apply();
    const off = editor.on('update', apply);
    return () => {
      // Tiptap's `off` is via editor.off, but `on` returns the editor instance.
      editor.off('update', apply);
      void off;
    };
  }, [editor, linkMap]);

  const scheduleSave = (ed: Editor) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      flushNow(ed);
    }, 600);
  };

  const flushNow = (ed: Editor) => {
    const raw = ed.getJSON();
    // Tiptap/ProseMirror's attrs are null-prototype objects which the React
    // Server Actions flight serializer encodes oddly (the server side ends up
    // seeing `attrs` as a function reference). A JSON round-trip on the client
    // converts everything to plain Object-prototype objects, which encodes
    // correctly across the action boundary.
    const serialized = JSON.stringify(raw);
    const json = JSON.parse(serialized) as unknown;
    if (serialized === lastSavedJson.current) return;
    lastSavedJson.current = serialized;
    setSaving(true);
    setSaveError(null);
    updateBrainNoteAction(noteId, { contentJson: json }).then((r) => {
      setSaving(false);
      if (!r.ok) setSaveError(r.error);
    });
  };

  const flushOnBlur = () => {
    if (!editor) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    flushNow(editor);
  };

  const triggerImageFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void insertImageFromUpload(f);
    };
    input.click();
  };

  const promptForLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes('link')['href'] as string | undefined;
    const url = window.prompt('URL', previous ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const internal = detectInternalLink(url);
    if (internal) {
      const { from, to } = editor.state.selection;
      if (from === to) {
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: internal.kind === 'note' ? 'note' : 'task',
            marks: [{ type: 'internalLink', attrs: internal }],
          })
          .run();
      } else {
        editor.chain().focus().extendMarkRange('link').setMark('internalLink', internal).run();
      }
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const toolbar = useMemo(() => {
    if (!editor) return null;
    const cls = (active: boolean) =>
      `inline-flex items-center justify-center rounded p-1.5 text-(--color-muted) hover:text-(--color-fg) hover:bg-(--color-surface) cursor-pointer ${
        active ? 'text-(--color-fg) bg-(--color-surface)' : ''
      }`;
    return (
      <div className="flex flex-wrap items-center gap-0.5 border-b border-(--color-border) px-1 py-1">
        <button
          type="button"
          className={cls(editor.isActive('heading', { level: 1 }))}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1"
        >
          <Heading1 size={14} />
        </button>
        <button
          type="button"
          className={cls(editor.isActive('heading', { level: 2 }))}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2"
        >
          <Heading2 size={14} />
        </button>
        <button
          type="button"
          className={cls(editor.isActive('heading', { level: 3 }))}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Heading 3"
        >
          <Heading3 size={14} />
        </button>
        <span className="mx-1 h-4 w-px bg-(--color-border)" />
        <button
          type="button"
          className={cls(editor.isActive('bold'))}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <BoldIcon size={14} />
        </button>
        <button
          type="button"
          className={cls(editor.isActive('italic'))}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <ItalicIcon size={14} />
        </button>
        <button
          type="button"
          className={cls(editor.isActive('code'))}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        >
          <CodeIcon size={14} />
        </button>
        <span className="mx-1 h-4 w-px bg-(--color-border)" />
        <button
          type="button"
          className={cls(editor.isActive('bulletList'))}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bulleted list"
        >
          <ListIcon size={14} />
        </button>
        <button
          type="button"
          className={cls(editor.isActive('orderedList'))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          <ListOrderedIcon size={14} />
        </button>
        <button
          type="button"
          className={cls(editor.isActive('blockquote'))}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Quote"
        >
          <QuoteIcon size={14} />
        </button>
        <span className="mx-1 h-4 w-px bg-(--color-border)" />
        <button type="button" className={cls(false)} onClick={promptForLink} title="Link / Internal link">
          <Link2 size={14} />
        </button>
        <button type="button" className={cls(false)} onClick={triggerImageFile} title="Insert image">
          <ImageIcon size={14} />
        </button>
        <div className="ml-auto flex items-center gap-2 px-2 text-[10px] uppercase tracking-wider">
          {saving ? (
            <span className="flex items-center gap-1 text-(--color-muted)">
              <Loader2 size={10} className="animate-spin" /> Saving
            </span>
          ) : saveError ? (
            <span className="text-red-400">{saveError}</span>
          ) : (
            <span className="text-(--color-muted)">Saved</span>
          )}
        </div>
      </div>
    );
  }, [editor, saving, saveError]);

  return (
    <div
      className="rounded-md border border-(--color-border) bg-(--color-surface)/30"
      onBlur={flushOnBlur}
    >
      {toolbar}
      <div className="px-4 py-2">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/**
 * Builds the Suggestion config the LinkSuggestion extension consumes. The
 * lifecycle hooks here own a single mounted React popover that follows the
 * cursor; the suggestion plugin pushes items + clientRect into it via the
 * exposed mutable state.
 */
function buildLinkSuggestion() {
  type State = {
    container: HTMLDivElement | null;
    root: Root | null;
    handleRef: React.RefObject<LinkSuggestionPopoverHandle | null>;
    items: LinkSuggestionItem[];
    loading: boolean;
    query: string;
    command: ((item: LinkSuggestionItem) => void) | null;
    seq: number;
  };

  return {
    char: '/',
    startOfLine: false,
    items: async ({ query }: { query: string }) => {
      const r = await searchLinkablesAction(query, 10);
      return r.ok ? (r.value as LinkSuggestionItem[]) : [];
    },
    render: () => {
      const state: State = {
        container: null,
        root: null,
        handleRef: createRef<LinkSuggestionPopoverHandle>(),
        items: [],
        loading: false,
        query: '',
        command: null,
        seq: 0,
      };

      const render = () => {
        if (!state.root) return;
        state.root.render(
          <LinkSuggestionPopover
            ref={state.handleRef}
            items={state.items}
            loading={state.loading}
            query={state.query}
            command={(item) => state.command?.(item)}
          />,
        );
      };

      const position = (rect?: DOMRect | null) => {
        if (!state.container) return;
        if (!rect) {
          state.container.style.display = 'none';
          return;
        }
        state.container.style.display = '';
        state.container.style.position = 'absolute';
        state.container.style.top = `${rect.bottom + 6}px`;
        state.container.style.left = `${rect.left}px`;
        state.container.style.zIndex = '50';
      };

      return {
        onStart: (props: SuggestionProps<LinkSuggestionItem>) => {
          state.container = document.createElement('div');
          document.body.appendChild(state.container);
          state.root = createRoot(state.container);
          state.items = props.items;
          state.query = props.query;
          state.command = props.command;
          state.loading = false;
          render();
          position(props.clientRect?.() ?? null);
        },
        onUpdate: (props: SuggestionProps<LinkSuggestionItem>) => {
          state.items = props.items;
          state.query = props.query;
          state.command = props.command;
          render();
          position(props.clientRect?.() ?? null);
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === 'Escape') {
            position(null);
            return true;
          }
          return state.handleRef.current?.onKeyDown(props.event) ?? false;
        },
        onExit: () => {
          if (state.root) {
            // Defer unmount to next tick so React doesn't complain about
            // unmounting during a parent commit.
            const root = state.root;
            const container = state.container;
            state.root = null;
            state.container = null;
            setTimeout(() => {
              root.unmount();
              container?.remove();
            }, 0);
          }
        },
      };
    },
  };
}

function collectInternalLinkRefs(doc: unknown): InternalLinkRef[] {
  const refs = new Map<string, InternalLinkRef>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      marks?: { type?: string; attrs?: Record<string, unknown> }[];
      content?: unknown[];
    };
    if (Array.isArray(n.marks)) {
      for (const m of n.marks) {
        if (m.type === 'internalLink' && m.attrs) {
          const id = m.attrs['id'];
          const kind = m.attrs['kind'];
          if (typeof id === 'string' && (kind === 'task' || kind === 'note')) {
            refs.set(`${kind}:${id}`, { kind, id });
          }
        }
      }
    }
    if (Array.isArray(n.content)) {
      for (const c of n.content) visit(c);
    }
  };
  visit(doc);
  return Array.from(refs.values());
}

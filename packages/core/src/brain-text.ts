/**
 * Walk a Tiptap JSON doc and return the concatenated plain text. Used to keep
 * `brain_notes.content_text` in sync with `content_json` on every write so that
 * MCP read tools and `LIKE` search don't need a JSON parser at query time.
 *
 * Hard block boundaries (paragraph, heading, list_item, blockquote, code_block)
 * insert a newline; soft inline runs are joined with no separator. Unknown
 * node types are walked into without error so future custom nodes don't break.
 */
type TiptapNode = {
  type?: string;
  text?: string;
  content?: TiptapNode[];
};

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'list_item',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'code_block',
  'horizontalRule',
  'hardBreak',
]);

export function tiptapJsonToText(json: unknown): string {
  const parts: string[] = [];
  walk(json, parts);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const n = node as TiptapNode;
  if (typeof n.text === 'string') {
    out.push(n.text);
  }
  if (n.content) walk(n.content, out);
  if (n.type && BLOCK_TYPES.has(n.type)) {
    out.push('\n');
  }
}

/**
 * Wrap a plain-text string as a minimal Tiptap doc so MCP agents can write
 * notes with plain `contentText` without knowing the editor schema. Each blank
 * line becomes a paragraph break; runs of non-empty lines become a paragraph
 * with hardBreak nodes between them.
 */
export function textToTiptapDoc(text: string): unknown {
  const paragraphs = text.split(/\n{2,}/);
  return {
    type: 'doc',
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.length === 0 ? [] : interleaveBreaks(p.split('\n')),
    })),
  };
}

function interleaveBreaks(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 0) out.push({ type: 'text', text: lines[i] });
    if (i < lines.length - 1) out.push({ type: 'hardBreak' });
  }
  return out;
}

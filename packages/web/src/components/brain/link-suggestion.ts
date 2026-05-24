import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';

/**
 * Tiptap extension that wires the `/` slash command to a suggestion picker.
 * The actual `items` fetcher and `render` lifecycle (which draws the popover)
 * are provided by the editor mount via `configure(...)` — this extension only
 * declares the plugin shape and the `command` that inserts the chosen target
 * as an InternalLink-marked text run.
 *
 * Why a custom extension rather than `@tiptap/extension-mention`: Mention
 * inserts an atomic Node, but our chip is a Mark on a text run (so the link's
 * label is real text the user can edit and search hits). We just want the
 * Suggestion plugin plumbing, not the Node.
 */
export type LinkSuggestionItem = {
  kind: 'task' | 'note';
  id: string;
  title: string;
  icon: string | null;
  subtitle: string | null;
};

export const linkSuggestionPluginKey = new PluginKey('linkSuggestion');

export const LinkSuggestion = Extension.create<{
  suggestion: Omit<SuggestionOptions<LinkSuggestionItem>, 'editor'>;
}>({
  name: 'linkSuggestion',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        pluginKey: linkSuggestionPluginKey,
        // Defaults; the mount overrides items/render with the React-side ones.
        items: () => [],
        render: () => ({}),
        command: ({ editor, range, props }) => {
          const item = props as LinkSuggestionItem;
          const label = item.icon ? `${item.icon} ${item.title}` : item.title;
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'text',
              text: label,
              marks: [
                {
                  type: 'internalLink',
                  attrs: { id: item.id, kind: item.kind },
                },
              ],
            })
            .insertContent(' ')
            .run();
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<LinkSuggestionItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bot, RefreshCcw, Send } from 'lucide-react';
import { ModelPicker, useStoredModelId } from './model-picker';

type Message = { role: 'user' | 'assistant'; content: string };

function focusedIdFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  // Expect: ["app", "<id>"]. Anything else (longer or shorter) is not a focus page.
  if (segments.length !== 2 || segments[0] !== 'app') return null;
  const id = segments[1]!;
  if (
    ['inbox', 'today', 'reviews', 'assignees', 'tags', 'settings', 'archived', 'snoozed', 'goals', 'search', 'setup', 'import', 'install'].includes(id)
  ) {
    return null;
  }
  return id;
}

export function RightRail() {
  const pathname = usePathname();
  const focusedId = focusedIdFromPath(pathname);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelId = useStoredModelId();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    const next: Message[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(next);
    setInput('');
    setBusy(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: next,
          modelId,
          ...(focusedId ? { taskId: focusedId } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        setMessages((m) => [...m, { role: 'assistant', content: `error: ${response.statusText}` }]);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      setMessages((m) => [...m, { role: 'assistant', content: '' }]);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: 'assistant', content: assistantText };
          return copy;
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex flex-col h-screen border-l border-(--color-border) bg-(--color-bg)">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-(--color-border)">
        <div className="flex items-center gap-2 min-w-0">
          <Bot size={14} className="text-(--color-accent)" />
          <span className="text-sm font-medium">Agent</span>
          <span className="text-xs text-(--color-muted) truncate">
            {focusedId ? focusedId.slice(0, 8) : 'All tasks'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ModelPicker />
          <button
            type="button"
            title="New chat"
            onClick={() => setMessages([])}
            className="p-1 rounded hover:bg-(--color-surface) text-(--color-muted) hover:text-(--color-fg) cursor-pointer"
          >
            <RefreshCcw size={14} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.length === 0 && (
          <p className="text-xs text-(--color-muted) text-center py-8">
            Ask about {focusedId ? 'this task' : 'your tasks'}.
            <br />
            Currently selected task is sent as context.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`text-sm whitespace-pre-wrap ${
              m.role === 'user' ? 'text-(--color-fg)' : 'text-(--color-muted)'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide text-(--color-muted) mb-0.5">
              {m.role}
            </div>
            {m.content || (busy && i === messages.length - 1 ? '…' : '')}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex items-center gap-2 px-3 py-2 border-t border-(--color-border)"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent…"
          disabled={busy}
          className="flex-1 bg-(--color-surface) rounded px-2 py-1.5 text-sm outline-none border border-(--color-border) focus:border-(--color-accent)"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="p-1.5 rounded bg-(--color-surface) hover:bg-(--color-surface-2) disabled:opacity-50 cursor-pointer"
        >
          <Send size={14} />
        </button>
      </form>
    </aside>
  );
}

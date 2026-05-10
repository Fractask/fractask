'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently no-op */
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-(--color-border) bg-(--color-bg)/90 text-(--color-muted) hover:text-(--color-fg) hover:border-(--color-fg)"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({
  value,
  language,
}: {
  value: string;
  language?: string;
}) {
  return (
    <div className="relative group">
      <pre
        className="text-xs bg-(--color-border)/30 px-3 py-3 pr-20 rounded-md overflow-x-auto font-mono-id leading-relaxed"
        data-language={language}
      >
        {value}
      </pre>
      <CopyButton value={value} />
    </div>
  );
}

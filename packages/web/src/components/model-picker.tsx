'use client';

import { useEffect, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import { listModelsAction } from '@/app/actions';
import type { ModelOption, Provider } from '@/lib/llm';

const STORAGE_KEY = 'getshit:modelId';
const DEFAULT_ID = 'anthropic:claude-sonnet-4-6';

export function getStoredModelId(): string {
  if (typeof window === 'undefined') return DEFAULT_ID;
  return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ID;
}

export function setStoredModelId(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(new CustomEvent('getshit:model-changed', { detail: id }));
}

export function useStoredModelId(): string {
  const [id, setId] = useState<string>(DEFAULT_ID);
  useEffect(() => {
    setId(getStoredModelId());
    const onChange = (e: Event) => {
      if (e instanceof CustomEvent && typeof e.detail === 'string') setId(e.detail);
    };
    window.addEventListener('getshit:model-changed', onChange as EventListener);
    return () =>
      window.removeEventListener('getshit:model-changed', onChange as EventListener);
  }, []);
  return id;
}

export function ModelPicker() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<Record<Provider, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [selected, setSelected] = useState<string>(DEFAULT_ID);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    listModelsAction().then((r) => {
      setModels(r.models);
      setProviders(r.providers);
    });
    setSelected(getStoredModelId());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('[data-model-picker]')) setOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [open]);

  const current = models.find((m) => m.id === selected);
  const choose = (id: string) => {
    setSelected(id);
    setStoredModelId(id);
    setOpen(false);
  };

  return (
    <div data-model-picker className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-(--color-border) bg-(--color-surface) hover:bg-(--color-surface-2) cursor-pointer"
      >
        <Bot size={14} className="text-(--color-muted)" />
        <span className="truncate max-w-[140px]">{current?.label ?? 'Pick a model'}</span>
        <ChevronDown size={12} className="text-(--color-muted)" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-60 rounded-md border border-(--color-border) bg-(--color-bg) shadow-lg overflow-hidden">
          {(['anthropic', 'openai'] as Provider[]).map((prov) => {
            const provModels = models.filter((m) => m.provider === prov);
            if (provModels.length === 0) return null;
            const enabled = providers[prov];
            return (
              <div key={prov} className="py-1">
                <div className="px-3 py-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-(--color-muted)">
                  <span>{prov}</span>
                  {!enabled && <span className="text-red-400">no API key</span>}
                </div>
                {provModels.map((m) => {
                  const sel = m.id === selected;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!enabled}
                      onClick={() => choose(m.id)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between cursor-pointer ${
                        sel ? 'bg-(--color-surface-2) text-(--color-fg)' : 'hover:bg-(--color-surface)'
                      } ${!enabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <span>{m.label}</span>
                      {sel && <span className="font-mono-id text-(--color-accent)">●</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

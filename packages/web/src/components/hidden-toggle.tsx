'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';

export function HiddenToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const showHidden = params.get('hidden') === '1';

  const toggle = () => {
    const sp = new URLSearchParams(params.toString());
    if (showHidden) sp.delete('hidden');
    else sp.set('hidden', '1');
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const Icon = showHidden ? Eye : EyeOff;
  return (
    <button
      type="button"
      onClick={toggle}
      title={showHidden ? 'Hide archived & snoozed' : 'Show archived & snoozed'}
      aria-pressed={showHidden}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-(--color-border) cursor-pointer ${
        showHidden
          ? 'bg-(--color-surface-2) text-(--color-fg)'
          : 'text-(--color-muted) hover:text-(--color-fg)'
      }`}
    >
      <Icon size={14} />
      Hidden
    </button>
  );
}

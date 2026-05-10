'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

export function MobileShell({
  sidebar,
  rightRail,
  children,
}: {
  sidebar: React.ReactNode;
  rightRail: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  return (
    <div className="flex flex-col h-[100dvh] md:h-screen overflow-hidden md:grid md:grid-cols-[240px_1fr] lg:grid-cols-[240px_1fr_360px]">
      {/* Mobile top bar */}
      <header className="md:hidden shrink-0 flex items-center gap-3 px-3 h-12 border-b border-(--color-border) bg-(--color-bg) text-(--color-fg) z-30">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="p-2 -ml-2 rounded hover:bg-(--color-border)/40"
        >
          <Menu className="size-5" />
        </button>
        <span className="text-sm font-medium tracking-tight">Fractask</span>
      </header>

      {/* Sidebar — drawer on mobile, static on md+ */}
      <div
        className={[
          'md:static md:translate-x-0 md:transition-none md:w-auto md:z-auto md:shadow-none',
          'fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] transform transition-transform duration-200 shadow-xl md:shadow-none',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        {/* Mobile-only close button overlaying the sidebar header */}
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="md:hidden absolute top-2 right-2 z-10 p-2 rounded hover:bg-(--color-border)/40 text-(--color-fg)"
        >
          <X className="size-5" />
        </button>
        {sidebar}
      </div>

      {/* Backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Main */}
      <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>

      {/* Right rail — desktop only */}
      <div className="hidden lg:block">{rightRail}</div>
    </div>
  );
}

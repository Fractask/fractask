'use client';

import { useEffect, useState } from 'react';
import { Apple, Chrome, Laptop, Share, Smartphone, SquarePlus } from 'lucide-react';

type Platform = 'ios' | 'android' | 'desktop' | 'unknown';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  // iPadOS 13+ reports as Mac; disambiguate with touch.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export function InstallGuide() {
  const [detected, setDetected] = useState<Platform>('unknown');
  const [active, setActive] = useState<Platform>('unknown');
  const [installed, setInstalled] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BIPEvent | null>(null);

  useEffect(() => {
    const p = detectPlatform();
    setDetected(p);
    setActive(p === 'unknown' ? 'ios' : p);

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari quirk
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(standalone);

    const onBIP = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BIPEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const triggerInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  };

  if (installed) {
    return (
      <div className="rounded-md border border-(--color-border) bg-(--color-surface) px-4 py-3 text-sm">
        <span className="text-(--color-fg)">You&rsquo;re running Fractask as an installed app.</span>{' '}
        <span className="text-(--color-muted)">Nothing more to do here.</span>
      </div>
    );
  }

  const tabs: { id: Platform; label: string; icon: typeof Apple }[] = [
    { id: 'ios', label: 'iPhone / iPad', icon: Apple },
    { id: 'android', label: 'Android', icon: Smartphone },
    { id: 'desktop', label: 'Desktop', icon: Laptop },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1 border-b border-(--color-border)">
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.id;
          const isDetected = detected === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${
                isActive
                  ? 'border-(--color-accent) text-(--color-fg)'
                  : 'border-transparent text-(--color-muted) hover:text-(--color-fg)'
              }`}
            >
              <Icon size={14} />
              {t.label}
              {isDetected && (
                <span className="text-[10px] uppercase tracking-wider text-(--color-accent)">
                  · you
                </span>
              )}
            </button>
          );
        })}
      </div>

      {active === 'ios' && <IosSteps />}
      {active === 'android' && (
        <AndroidSteps canPrompt={!!deferredPrompt} onInstall={triggerInstall} />
      )}
      {active === 'desktop' && (
        <DesktopSteps canPrompt={!!deferredPrompt} onInstall={triggerInstall} />
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="font-mono-id text-xs text-(--color-muted) w-5 pt-0.5 shrink-0">
        {n.toString().padStart(2, '0')}
      </span>
      <div className="text-sm text-(--color-fg) flex-1">{children}</div>
    </li>
  );
}

function IosSteps() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-(--color-muted)">
        iOS only allows installing from <strong>Safari</strong>. If you&rsquo;re in Chrome or
        another browser, copy the URL and paste it into Safari first.
      </p>
      <ol className="flex flex-col gap-2.5">
        <Step n={1}>Open this page in Safari.</Step>
        <Step n={2}>
          Tap the <Share size={14} className="inline align-text-bottom" /> <strong>Share</strong>{' '}
          button at the bottom of the screen (or top, on iPad).
        </Step>
        <Step n={3}>
          Scroll down and tap <strong>Add to Home Screen</strong>.
        </Step>
        <Step n={4}>
          Confirm the name (&ldquo;Fractask&rdquo;) and tap <strong>Add</strong> in the top-right.
        </Step>
        <Step n={5}>
          Launch from the home screen icon. The app opens full-screen with no Safari chrome.
        </Step>
      </ol>
    </div>
  );
}

function AndroidSteps({ canPrompt, onInstall }: { canPrompt: boolean; onInstall: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-(--color-muted)">
        Works in Chrome, Edge, Brave, Samsung Internet, and most other Chromium browsers.
      </p>
      {canPrompt && (
        <button
          type="button"
          onClick={onInstall}
          className="self-start inline-flex items-center gap-2 px-3 py-2 rounded-md bg-(--color-accent) text-(--color-bg) text-sm font-medium hover:opacity-90"
        >
          <SquarePlus size={14} />
          Install Fractask
        </button>
      )}
      <ol className="flex flex-col gap-2.5">
        <Step n={1}>
          Look for an <strong>Install</strong> banner at the bottom of the page, or an install icon
          in the address bar.
        </Step>
        <Step n={2}>
          If you don&rsquo;t see it, open the browser menu (
          <Chrome size={14} className="inline align-text-bottom" /> three dots, top-right) and tap{' '}
          <strong>Install app</strong> or <strong>Add to Home screen</strong>.
        </Step>
        <Step n={3}>
          Confirm <strong>Install</strong>.
        </Step>
        <Step n={4}>
          Launch from the home screen or app drawer. It runs as a standalone app.
        </Step>
      </ol>
    </div>
  );
}

function DesktopSteps({ canPrompt, onInstall }: { canPrompt: boolean; onInstall: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-(--color-muted)">
        Chrome, Edge, Brave, and Arc support installing web apps to your dock or start menu.
      </p>
      {canPrompt && (
        <button
          type="button"
          onClick={onInstall}
          className="self-start inline-flex items-center gap-2 px-3 py-2 rounded-md bg-(--color-accent) text-(--color-bg) text-sm font-medium hover:opacity-90"
        >
          <SquarePlus size={14} />
          Install Fractask
        </button>
      )}
      <ol className="flex flex-col gap-2.5">
        <Step n={1}>
          Look at the right side of the address bar for an <strong>install</strong> icon (a monitor
          with a down-arrow, or a small &ldquo;+&rdquo;).
        </Step>
        <Step n={2}>
          Click it and confirm <strong>Install</strong>. The app appears in your dock (macOS),
          taskbar (Windows), or app launcher (Linux).
        </Step>
        <Step n={3}>
          On Safari (macOS 14+): <strong>File &rarr; Add to Dock</strong>.
        </Step>
        <Step n={4}>
          Firefox doesn&rsquo;t install PWAs natively &mdash; create a bookmark or use Site
          Specific Browser tools instead.
        </Step>
      </ol>
    </div>
  );
}

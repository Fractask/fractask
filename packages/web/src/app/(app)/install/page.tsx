import { InstallGuide } from './install-guide';

export const metadata = { title: 'Install · Fractask' };

export default function InstallPage() {
  return (
    <div className="px-6 py-8 max-w-3xl mx-auto flex flex-col gap-8">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Install Fractask on your phone</h1>
        <p className="text-sm text-(--color-muted) mt-1">
          Fractask is a Progressive Web App &mdash; install it from your browser and it lives on
          your home screen like a native app, full screen, no address bar.
        </p>
      </header>

      <InstallGuide />

      <section className="text-xs text-(--color-muted) border-t border-(--color-border) pt-4">
        <p>
          After install, the app launches in standalone mode. Sign in once and the session sticks.
          To uninstall, long-press the icon (mobile) or use the browser&rsquo;s app management
          (desktop).
        </p>
      </section>
    </div>
  );
}

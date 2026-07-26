import { Sidebar } from '@/components/sidebar';
import { RightRail } from '@/components/right-rail';
import { MobileShell } from '@/components/mobile-shell';
import { ViewAsBanner } from '@/components/view-as-banner';
import { ReadOnlyProvider } from '@/components/read-only-context';
import { getViewState } from '@/lib/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { viewingAs } = await getViewState();
  return (
    <ReadOnlyProvider value={!!viewingAs}>
      {viewingAs && <ViewAsBanner agentName={viewingAs.agentName} />}
      <MobileShell sidebar={<Sidebar />} rightRail={<RightRail />}>
        {children}
      </MobileShell>
    </ReadOnlyProvider>
  );
}

import { Sidebar } from '@/components/sidebar';
import { RightRail } from '@/components/right-rail';
import { MobileShell } from '@/components/mobile-shell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <MobileShell sidebar={<Sidebar />} rightRail={<RightRail />}>
      {children}
    </MobileShell>
  );
}

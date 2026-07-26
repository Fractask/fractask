import { Eye, X } from 'lucide-react';

/**
 * Sticky top banner shown while an admin previews Fractask as an agent. Uses a
 * plain <a> (not next/link) so navigating to the /api/view-as/exit route is a
 * full request the server can answer with a Set-Cookie + redirect.
 */
export function ViewAsBanner({ agentName }: { agentName: string }) {
  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-2.5 bg-violet-600 px-4 py-1.5 text-center text-xs font-medium text-white">
      <Eye size={13} className="shrink-0" />
      <span className="truncate">
        Viewing Fractask as <strong>{agentName}</strong>
        <span className="hidden sm:inline"> · read-only preview</span>
      </span>
      <a
        href="/api/view-as/exit"
        className="inline-flex shrink-0 items-center gap-1 rounded bg-white/20 px-2 py-0.5 hover:bg-white/30"
      >
        <X size={12} /> Exit
      </a>
    </div>
  );
}

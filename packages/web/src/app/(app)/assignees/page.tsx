import { listAssignees } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { AssigneesManager } from '@/components/assignees-manager';

export const dynamic = 'force-dynamic';

export default async function AssigneesPage() {
  const ctx = await getRequestContext();
  const assignees = await listAssignees(ctx);

  return (
    <div className="px-6 py-4 max-w-3xl mx-auto">
      <header className="mb-4">
        <h1 className="text-sm font-medium">Assignees</h1>
        <p className="text-xs text-(--color-muted) mt-0.5">
          People and agents you can assign tasks to.
        </p>
      </header>
      <AssigneesManager initial={assignees} />
    </div>
  );
}

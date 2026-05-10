import { listTags } from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { TagsManager } from '@/components/tags-manager';

export const dynamic = 'force-dynamic';

export default async function TagsPage() {
  const ctx = await getRequestContext();
  const tags = await listTags(ctx);

  return (
    <div className="px-6 py-4 max-w-3xl mx-auto">
      <header className="mb-4">
        <h1 className="text-sm font-medium">Tags</h1>
        <p className="text-xs text-(--color-muted) mt-0.5">
          Free-form labels you can apply to any task.
        </p>
      </header>
      <TagsManager initial={tags} />
    </div>
  );
}

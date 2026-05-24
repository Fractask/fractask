import Link from 'next/link';
import { Brain } from 'lucide-react';
import {
  getTask,
  listAllAccessibleBrainNotes,
  listTasks,
  type BrainNote,
  type Task,
} from '@getshit/core';
import { getRequestContext } from '@/lib/auth';
import { NoteChildren } from '@/components/brain/note-children';

export const dynamic = 'force-dynamic';

/**
 * Brain index: lists personal root notes, plus one section per entity and one
 * per project (the only two task kinds that can scope a brain note). Each
 * section shows its existing notes and an inline "+ new" form so seeding the
 * first note for a fresh scope is a one-click action.
 *
 * `?scope=<taskId>` focuses a single scope. The old `?entity=<id>` shape is
 * accepted for backward-compat with deep links.
 */
export default async function BrainIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; entity?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await getRequestContext();

  const hidden: ('archived' | 'snoozed' | 'backlog')[] = ['archived', 'snoozed', 'backlog'];
  const [all, allEntities, allProjects] = await Promise.all([
    listAllAccessibleBrainNotes(ctx),
    listTasks(ctx, { kind: 'entity', excludeStatuses: hidden }),
    listTasks(ctx, { kind: 'project', excludeStatuses: hidden }),
  ]);

  // Bucket notes by scope.
  const personal: BrainNote[] = [];
  const byScope = new Map<string, BrainNote[]>();
  for (const n of all) {
    if (n.scopeTaskId === null) {
      personal.push(n);
    } else {
      const arr = byScope.get(n.scopeTaskId) ?? [];
      arr.push(n);
      byScope.set(n.scopeTaskId, arr);
    }
  }

  // Roots inside each scope (notes whose parent is null OR whose parent isn't
  // in the accessible set — those surface as roots here too).
  const accessibleIds = new Set(all.map((n) => n.id));
  const rootsOf = (notes: BrainNote[]) =>
    notes.filter((n) => n.parentNoteId === null || !accessibleIds.has(n.parentNoteId));

  const sortByNotesThenTitle = (a: Task, b: Task) => {
    const aHas = (byScope.get(a.id)?.length ?? 0) > 0;
    const bHas = (byScope.get(b.id)?.length ?? 0) > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return a.title.localeCompare(b.title);
  };

  const liveEntities = allEntities
    .filter((e) => e.status !== 'done')
    .sort(sortByNotesThenTitle);
  const liveProjects = allProjects
    .filter((p) => p.status !== 'done')
    .sort(sortByNotesThenTitle);

  const focusedScopeId = sp.scope ?? sp.entity ?? null;
  const focusedScope = focusedScopeId ? await getTask(ctx, focusedScopeId) : null;

  return (
    <div className="px-6 py-6 max-w-4xl mx-auto">
      <header className="mb-6 flex items-center gap-3">
        <Brain size={20} className="text-(--color-accent)" />
        <h1 className="text-2xl font-semibold tracking-tight">Brain</h1>
        <p className="text-sm text-(--color-muted)">
          The persistent knowledge base. Notes the user and agents share across
          sessions.
        </p>
      </header>

      {focusedScope ? (
        <ScopeSection
          scopeId={focusedScope.id}
          title={focusedScope.title}
          kind={focusedScope.kind}
          notes={byScope.get(focusedScope.id) ?? []}
          roots={rootsOf(byScope.get(focusedScope.id) ?? [])}
        />
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-2 px-2 text-xs uppercase tracking-wider text-(--color-muted)">
              Personal
            </h2>
            <NoteChildren
              parentNoteId={null}
              scopeTaskId={null}
              children={rootsOf(personal)}
              emptyLabel="No personal notes yet. Add one to get started."
            />
          </section>

          {liveEntities.length > 0 && (
            <div className="mb-2 px-2 text-[10px] uppercase tracking-wider text-(--color-muted)">
              Entities
            </div>
          )}
          {liveEntities.map((e) => (
            <ScopeRowSection
              key={e.id}
              scope={e}
              notes={byScope.get(e.id) ?? []}
              roots={rootsOf(byScope.get(e.id) ?? [])}
            />
          ))}

          {liveProjects.length > 0 && (
            <div className="mb-2 mt-6 px-2 text-[10px] uppercase tracking-wider text-(--color-muted)">
              Projects
            </div>
          )}
          {liveProjects.map((p) => (
            <ScopeRowSection
              key={p.id}
              scope={p}
              notes={byScope.get(p.id) ?? []}
              roots={rootsOf(byScope.get(p.id) ?? [])}
            />
          ))}

          {liveEntities.length === 0 &&
            liveProjects.length === 0 &&
            personal.length === 0 && (
              <p className="px-2 text-sm text-(--color-muted) italic">
                No brain notes yet. Personal notes show up here, and any entity
                or project you tag a note to will get its own section.
              </p>
            )}
        </>
      )}
    </div>
  );
}

function ScopeRowSection({
  scope,
  notes,
  roots,
}: {
  scope: Task;
  notes: BrainNote[];
  roots: BrainNote[];
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 px-2 flex items-center justify-between text-xs uppercase tracking-wider text-(--color-muted)">
        <Link href={`/${scope.id}`} className="hover:text-(--color-fg)">
          {scope.title}{' '}
          <span className="text-(--color-muted)/60 normal-case tracking-normal">
            · {notes.length} note{notes.length === 1 ? '' : 's'}
          </span>
        </Link>
        <Link
          href={`/brain?scope=${scope.id}`}
          className="text-(--color-muted) hover:text-(--color-fg) normal-case tracking-normal"
        >
          View all →
        </Link>
      </h2>
      <NoteChildren
        parentNoteId={null}
        scopeTaskId={scope.id}
        children={roots}
        emptyLabel={`No notes for this ${scope.kind} yet — type a title below to add one.`}
      />
    </section>
  );
}

function ScopeSection({
  scopeId,
  title,
  kind,
  notes,
  roots,
}: {
  scopeId: string;
  title: string;
  kind: Task['kind'];
  notes: BrainNote[];
  roots: BrainNote[];
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-medium">
          <Link href={`/${scopeId}`} className="hover:text-(--color-accent)">
            {title}
          </Link>{' '}
          <span className="text-xs text-(--color-muted)">· {kind}</span>
        </h2>
        <Link href="/brain" className="text-xs text-(--color-muted) hover:text-(--color-fg)">
          ← all brain
        </Link>
      </div>
      <p className="mb-4 px-2 text-xs text-(--color-muted)">
        {notes.length} note{notes.length === 1 ? '' : 's'} under this {kind}.
      </p>
      <NoteChildren
        parentNoteId={null}
        scopeTaskId={scopeId}
        children={roots}
        emptyLabel={`No notes for this ${kind} yet.`}
      />
    </section>
  );
}

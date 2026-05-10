import { Option, Command } from 'clipanion';
import {
  getSubtree,
  listTasks,
  resolveTaskId,
  taskKindSchema,
  taskStatusSchema,
  type TaskKind,
  type TaskStatus,
} from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { renderFlat, renderForest } from '../render.js';
import { BaseCommand } from './base.js';

export class LsCommand extends BaseCommand {
  static override paths = [['ls'], ['list']];
  static override usage = Command.Usage({
    description: 'List tasks',
    examples: [
      ['Top-level tasks', '$0 ls'],
      ['Children of a task', '$0 ls --parent abc123'],
      ['Tree view', '$0 ls --tree'],
      ['Filter by status', '$0 ls --status doing'],
      ['Only entities', '$0 ls --kind entity'],
    ],
  });

  parent = Option.String('-p,--parent', {
    description: 'Parent ID (or prefix); omit for roots, "root" for explicit roots',
  });
  tree = Option.Boolean('-t,--tree', false, { description: 'Render as a tree' });
  status = Option.String('-s,--status', { description: 'Filter by open|doing|done' });
  kind = Option.String('-k,--kind', { description: 'Filter by entity|project|task' });

  protected override async run() {
    const ctx = await bootstrap();
    const status: TaskStatus | undefined =
      this.status !== undefined ? taskStatusSchema.parse(this.status) : undefined;
    const kind: TaskKind | undefined =
      this.kind !== undefined ? taskKindSchema.parse(this.kind) : undefined;
    const parentId =
      this.parent === undefined || this.parent === 'root'
        ? null
        : await resolveTaskId(ctx, this.parent);

    if (this.tree) {
      if (parentId) {
        const subtree = await getSubtree(ctx, parentId);
        if (!subtree) {
          this.context.stderr.write(`No task ${parentId}\n`);
          return 1;
        }
        this.context.stdout.write(`${renderForest([subtree])}\n`);
        return 0;
      }
      const roots = await listTasks(ctx, {
        parentId: null,
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
      });
      const trees = (await Promise.all(roots.map((r) => getSubtree(ctx, r.id)))).filter(
        (t): t is NonNullable<typeof t> => t !== null,
      );
      this.context.stdout.write(`${renderForest(trees)}\n`);
      return 0;
    }

    const rows = await listTasks(ctx, {
      parentId,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
    });
    this.context.stdout.write(`${renderFlat(rows)}\n`);
    return 0;
  }
}

import { Option, Command } from 'clipanion';
import { getTask, resolveTaskId } from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { formatLine, renderFlat } from '../render.js';
import { BaseCommand } from './base.js';

export class ShowCommand extends BaseCommand {
  static override paths = [['show']];
  static override usage = Command.Usage({
    description: 'Show a task and its direct children',
  });

  id = Option.String();

  protected override async run() {
    const ctx = await bootstrap();
    const id = await resolveTaskId(ctx, this.id);
    const task = await getTask(ctx, id);
    if (!task) {
      this.context.stderr.write(`No task ${id}\n`);
      return 1;
    }
    const out = this.context.stdout;
    out.write(`${formatLine(task)}\n`);
    out.write(`id:        ${task.id}\n`);
    out.write(`status:    ${task.status}\n`);
    out.write(`source:    ${task.source}\n`);
    if (task.parentId) out.write(`parent:    ${task.parentId}\n`);
    out.write(`created:   ${new Date(task.createdAt).toISOString()}\n`);
    out.write(`updated:   ${new Date(task.updatedAt).toISOString()}\n`);
    if (task.completedAt) out.write(`completed: ${new Date(task.completedAt).toISOString()}\n`);
    if (task.description) {
      out.write('\n');
      out.write(`${task.description}\n`);
    }
    if (task.children.length > 0) {
      out.write('\nchildren:\n');
      out.write(`${renderFlat(task.children)}\n`);
    }
    return 0;
  }
}

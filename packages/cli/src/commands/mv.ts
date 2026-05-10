import { Option, Command } from 'clipanion';
import { moveTask, resolveTaskId } from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { formatLine } from '../render.js';
import { BaseCommand } from './base.js';

export class MvCommand extends BaseCommand {
  static override paths = [['mv'], ['move']];
  static override usage = Command.Usage({
    description: 'Move a task under a new parent (or "root")',
    examples: [
      ['Reparent', '$0 mv abc123 def456'],
      ['Promote to root', '$0 mv abc123 root'],
    ],
  });

  id = Option.String();
  newParent = Option.String();

  protected override async run() {
    const ctx = await bootstrap();
    const id = await resolveTaskId(ctx, this.id);
    const target = this.newParent === 'root' ? null : await resolveTaskId(ctx, this.newParent);
    const moved = await moveTask(ctx, id, target);
    this.context.stdout.write(`${formatLine(moved)}\n`);
  }
}

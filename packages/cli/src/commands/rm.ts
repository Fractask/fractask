import { Option, Command } from 'clipanion';
import { deleteTask, resolveTaskId } from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { BaseCommand } from './base.js';

export class RmCommand extends BaseCommand {
  static override paths = [['rm'], ['delete']];
  static override usage = Command.Usage({
    description: 'Delete a task and all of its descendants',
  });

  id = Option.String();
  yes = Option.Boolean('-y,--yes', false, { description: 'Skip confirmation' });

  protected override async run() {
    const ctx = await bootstrap();
    const id = await resolveTaskId(ctx, this.id);
    const result = await deleteTask(ctx, id);
    this.context.stdout.write(`Deleted ${result.deletedIds.length} task(s).\n`);
  }
}

import { Option, Command } from 'clipanion';
import { resolveTaskId, updateTask, type TaskStatus } from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { formatLine } from '../render.js';
import { BaseCommand } from './base.js';

abstract class StatusBase extends BaseCommand {
  abstract id: string;
  protected abstract targetStatus: TaskStatus;

  protected override async run() {
    const ctx = await bootstrap();
    const id = await resolveTaskId(ctx, this.id);
    const updated = await updateTask(ctx, id, { status: this.targetStatus });
    this.context.stdout.write(`${formatLine(updated)}\n`);
  }
}

export class DoneCommand extends StatusBase {
  static override paths = [['done']];
  static override usage = Command.Usage({ description: 'Mark a task as done' });
  override id = Option.String();
  protected override targetStatus: TaskStatus = 'done';
}

export class DoingCommand extends StatusBase {
  static override paths = [['doing']];
  static override usage = Command.Usage({ description: 'Mark a task as in progress' });
  override id = Option.String();
  protected override targetStatus: TaskStatus = 'doing';
}

export class ReopenCommand extends StatusBase {
  static override paths = [['reopen']];
  static override usage = Command.Usage({ description: 'Reopen a done task' });
  override id = Option.String();
  protected override targetStatus: TaskStatus = 'open';
}

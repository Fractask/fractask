import { Option, Command } from 'clipanion';
import { createTask, resolveTaskId, taskKindSchema } from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { formatLine } from '../render.js';
import { BaseCommand } from './base.js';

export class AddCommand extends BaseCommand {
  static override paths = [['add']];
  static override usage = Command.Usage({
    description: 'Add a task',
    examples: [
      ['Add a top-level task', '$0 add "Ship v1"'],
      ['Add a subtask', '$0 add "Wire MCP" --parent abc123'],
      ['Add an entity (company/area)', '$0 add "Sunbek" --kind entity'],
      ['Add a project under an entity', '$0 add "Q2 launch" --parent abc123 --kind project'],
    ],
  });

  title = Option.String();
  parent = Option.String('-p,--parent', { description: 'Parent task ID (or prefix)' });
  description = Option.String('-d,--desc', { description: 'Description (markdown)' });
  kind = Option.String('-k,--kind', { description: 'entity | project | task (default task)' });

  protected override async run() {
    const ctx = await bootstrap();
    const parentId = this.parent !== undefined ? await resolveTaskId(ctx, this.parent) : undefined;
    const kind = this.kind !== undefined ? taskKindSchema.parse(this.kind) : undefined;
    const task = await createTask(ctx, {
      title: this.title,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(this.description !== undefined ? { description: this.description } : {}),
      ...(kind !== undefined ? { kind } : {}),
    });
    this.context.stdout.write(`${formatLine(task)}\n`);
  }
}

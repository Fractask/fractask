import { Option, Command } from 'clipanion';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTask, resolveTaskId, updateTask } from '@getshit/core';
import { bootstrap } from '../runtime.js';
import { formatLine } from '../render.js';
import { BaseCommand } from './base.js';

export class EditCommand extends BaseCommand {
  static override paths = [['edit']];
  static override usage = Command.Usage({
    description: 'Edit a task description in $EDITOR',
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

    const tmpFile = path.join(os.tmpdir(), `getshit-${task.id}.md`);
    const initial =
      task.description ?? `# ${task.title}\n\n<!-- Write the description below this line. -->\n`;
    fs.writeFileSync(tmpFile, initial, 'utf8');

    const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
    const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
    if (result.status !== 0) {
      this.context.stderr.write(`Editor exited with status ${result.status}\n`);
      fs.rmSync(tmpFile, { force: true });
      return result.status ?? 1;
    }

    const next = fs.readFileSync(tmpFile, 'utf8').trim();
    fs.rmSync(tmpFile, { force: true });

    const description = next.length === 0 ? null : next;
    if (description === (task.description ?? null)) {
      this.context.stdout.write('(no changes)\n');
      return 0;
    }
    const updated = await updateTask(ctx, task.id, { description });
    this.context.stdout.write(`${formatLine(updated)}\n`);
    return 0;
  }
}

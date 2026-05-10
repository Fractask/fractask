import { Option, Command } from 'clipanion';
import { getTask, resolveTaskId, updateTask } from '@getshit/core';
import { DEFAULT_MODEL_ID, findModel, generate } from '@getshit/core/llm';
import { bootstrap } from '../runtime.js';
import { formatLine } from '../render.js';
import { BaseCommand } from './base.js';

export class NoteCommand extends BaseCommand {
  static override paths = [['note']];
  static override usage = Command.Usage({
    description: 'AI-generate a note for a task and append (or replace) the description',
    examples: [
      ['Auto-generate context note', '$0 note abc123'],
      ['Guide the model', '$0 note abc123 --prompt "include open questions"'],
      ['Replace existing description', '$0 note abc123 --replace'],
      ['Use a specific model', '$0 note abc123 --model openai:gpt-4o'],
    ],
  });

  id = Option.String();
  prompt = Option.String('-p,--prompt', { description: 'Extra guidance for the model' });
  replace = Option.Boolean('-r,--replace', false, {
    description: 'Replace the description instead of appending',
  });
  model = Option.String('-m,--model', { description: 'Model id (provider:model)' });
  yes = Option.Boolean('-y,--yes', false, { description: 'Skip the preview/confirm step' });

  protected override async run() {
    const ctx = await bootstrap();
    const id = await resolveTaskId(ctx, this.id);
    const task = await getTask(ctx, id);
    if (!task) {
      this.context.stderr.write(`No task ${id}\n`);
      return 1;
    }

    const modelId = this.model ?? process.env['GETSHIT_DEFAULT_MODEL'] ?? DEFAULT_MODEL_ID;
    const model = findModel(modelId);

    const childList =
      task.children.length === 0
        ? '(none)'
        : task.children.map((c) => `- [${c.status}] ${c.title}`).join('\n');

    const userPrompt = `Write a concise note for this task. The note should be short markdown — bullets or a short paragraph, no headers.

Task: ${task.title}
Existing description: ${task.description ?? '(none yet)'}
Subtasks:
${childList}

${this.prompt ? `Extra guidance: ${this.prompt}\n\n` : ''}Output the note text only — no preface, no quotes, no JSON.`;

    this.context.stdout.write(`Asking ${model.label}…\n`);
    const note = (await generate({ modelId, user: userPrompt, maxTokens: 800 })).trim();
    if (!note) {
      this.context.stderr.write('(model returned empty output)\n');
      return 1;
    }

    const next =
      this.replace || !task.description
        ? note
        : `${task.description}\n\n---\n${note}`;

    this.context.stdout.write(`\n--- proposed note ---\n${note}\n---------------------\n`);

    if (!this.yes) {
      const accepted = await prompt(`Save? [Y/n] `);
      if (accepted.toLowerCase() === 'n' || accepted.toLowerCase() === 'no') {
        this.context.stdout.write('(discarded)\n');
        return 0;
      }
    }

    const updated = await updateTask(ctx, id, { description: next });
    this.context.stdout.write(`${formatLine(updated)}  (note ${this.replace ? 'replaced' : 'appended'})\n`);
    return 0;
  }
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(String(data).trim());
    });
  });
}

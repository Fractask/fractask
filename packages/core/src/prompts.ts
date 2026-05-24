/**
 * Structured human-in-the-loop prompts. An agent posts a prompt against a
 * task and ends its turn; the human answers via the web UI; the agent picks
 * up the answer on its next `get_task` call.
 *
 * The body is strictly structured JSON — no HTML, no markdown — so the web
 * layer can render each `kind` to a polished component without sanitizing
 * arbitrary content and so the payload stays small for MCP round-trips.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import {
  agentPrompts,
  tasks,
  type AgentPromptKind,
  type AgentPromptRow,
  type AgentPromptStatus,
} from './schema.js';
import { assertAccessibleExists, assertOwnedExists, NotFoundError } from './access.js';
import { idSchema } from './types.js';

export const promptKindSchema = z.enum(['text', 'choice', 'approval', 'pick_image']);

export const promptOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().optional(),
  attachmentId: idSchema.optional(),
});
export type PromptOption = z.infer<typeof promptOptionSchema>;

export const createPromptInputSchema = z
  .object({
    taskId: idSchema,
    kind: promptKindSchema,
    prompt: z.string().min(1).max(2000),
    options: z.array(promptOptionSchema).max(50).optional(),
    multiple: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.kind === 'choice' || v.kind === 'pick_image') && (!v.options || v.options.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `Kind '${v.kind}' requires at least one option`,
      });
    }
    if (v.kind === 'pick_image' && v.options) {
      for (let i = 0; i < v.options.length; i++) {
        const o = v.options[i]!;
        if (!o.imageUrl && !o.attachmentId) {
          ctx.addIssue({
            code: 'custom',
            path: ['options', i],
            message: "pick_image options need imageUrl or attachmentId",
          });
        }
      }
    }
    if (v.kind === 'approval' && v.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: "approval prompts don't take options",
      });
    }
    if (v.kind === 'text' && v.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: "text prompts don't take options",
      });
    }
    const ids = (v.options ?? []).map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'option ids must be unique' });
    }
  });
export type CreatePromptInput = z.infer<typeof createPromptInputSchema>;

export const promptAnswerSchema = z.object({
  text: z.string().max(20_000).optional(),
  selectedIds: z.array(z.string().max(64)).max(50).optional(),
  approved: z.boolean().optional(),
  comment: z.string().max(2000).optional(),
});
export type PromptAnswer = z.infer<typeof promptAnswerSchema>;

export type AgentPrompt = Omit<AgentPromptRow, 'options' | 'answer' | 'multiple'> & {
  options: PromptOption[] | null;
  answer: PromptAnswer | null;
  multiple: boolean;
};

function deserialize(row: AgentPromptRow): AgentPrompt {
  return {
    ...row,
    multiple: row.multiple === 1,
    options: row.options ? (JSON.parse(row.options) as PromptOption[]) : null,
    answer: row.answer ? (JSON.parse(row.answer) as PromptAnswer) : null,
  };
}

export async function listPromptsForTask(ctx: Context, taskId: string): Promise<AgentPrompt[]> {
  await assertAccessibleExists(ctx, taskId);
  const db = getDb();
  const rows = await db
    .select()
    .from(agentPrompts)
    .where(eq(agentPrompts.taskId, taskId))
    .orderBy(asc(agentPrompts.createdAt));
  return rows.map(deserialize);
}

export async function listPromptsForTasks(
  ctx: Context,
  taskIds: string[],
): Promise<Map<string, AgentPrompt[]>> {
  const out = new Map<string, AgentPrompt[]>();
  if (taskIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select()
    .from(agentPrompts)
    .where(and(eq(agentPrompts.userId, ctx.userId), inArray(agentPrompts.taskId, taskIds)))
    .orderBy(asc(agentPrompts.createdAt));
  for (const row of rows) {
    const list = out.get(row.taskId) ?? [];
    list.push(deserialize(row));
    out.set(row.taskId, list);
  }
  return out;
}

export async function listPendingPromptsForUser(ctx: Context): Promise<AgentPrompt[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentPrompts)
    .where(and(eq(agentPrompts.userId, ctx.userId), eq(agentPrompts.status, 'pending')))
    .orderBy(desc(agentPrompts.createdAt));
  return rows.map(deserialize);
}

export async function createPrompt(
  ctx: Context,
  input: CreatePromptInput,
): Promise<AgentPrompt> {
  const parsed = createPromptInputSchema.parse(input);
  const task = await assertAccessibleExists(ctx, parsed.taskId);
  const ts = Date.now();
  const row: AgentPromptRow = {
    id: nanoid(12),
    taskId: parsed.taskId,
    userId: task.userId,
    askedByUserId: ctx.userId,
    kind: parsed.kind as AgentPromptKind,
    prompt: parsed.prompt,
    options: parsed.options ? JSON.stringify(parsed.options) : null,
    multiple: parsed.multiple ? 1 : 0,
    status: 'pending' as AgentPromptStatus,
    answer: null,
    answeredByUserId: null,
    createdAt: ts,
    answeredAt: null,
    cancelledAt: null,
  };
  const db = getDb();
  await db.insert(agentPrompts).values(row);

  // A pending prompt is a review request. Bump the task to status='review'
  // with the owner as reviewer so it surfaces in /reviews next to other
  // approvals waiting on the human. Skipped if the task is already in
  // review or in a terminal state (done/archived/snoozed).
  if (task.status === 'open' || task.status === 'doing') {
    await db
      .update(tasks)
      .set({ status: 'review', reviewerId: task.userId, updatedAt: ts })
      .where(eq(tasks.id, task.id));
  }

  return deserialize(row);
}

export async function answerPrompt(
  ctx: Context,
  id: string,
  rawAnswer: PromptAnswer,
): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.status !== 'pending') throw new Error(`Prompt is already ${row.status}`);

  await assertAccessibleExists(ctx, row.taskId);

  const parsedAnswer = promptAnswerSchema.parse(rawAnswer);
  validateAnswerShape(row, parsedAnswer);

  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({
      status: 'answered',
      answer: JSON.stringify(parsedAnswer),
      answeredAt: ts,
      answeredByUserId: ctx.userId,
    })
    .where(eq(agentPrompts.id, id));

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

export async function cancelPrompt(ctx: Context, id: string): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.status !== 'pending') return deserialize(row);
  // Either the asker or the task owner can cancel.
  if (row.askedByUserId !== ctx.userId) {
    await assertOwnedExists(ctx, row.taskId);
  } else {
    await assertAccessibleExists(ctx, row.taskId);
  }
  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({ status: 'cancelled', cancelledAt: ts })
    .where(eq(agentPrompts.id, id));
  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

function validateAnswerShape(row: AgentPromptRow, answer: PromptAnswer): void {
  switch (row.kind) {
    case 'text': {
      if (!answer.text || answer.text.length === 0) throw new Error('text answer required');
      return;
    }
    case 'approval': {
      if (typeof answer.approved !== 'boolean') {
        throw new Error('approval answer requires `approved` boolean');
      }
      return;
    }
    case 'choice':
    case 'pick_image': {
      const opts = row.options ? (JSON.parse(row.options) as PromptOption[]) : [];
      const validIds = new Set(opts.map((o) => o.id));
      const picked = answer.selectedIds ?? [];
      if (picked.length === 0) throw new Error('`selectedIds` required');
      if (!row.multiple && picked.length > 1) throw new Error('single-select prompt');
      for (const id of picked) {
        if (!validIds.has(id)) throw new Error(`Unknown option id: ${id}`);
      }
      return;
    }
  }
}

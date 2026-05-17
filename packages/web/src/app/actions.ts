'use server';

import {
  AmbiguousIdError,
  CycleError,
  NotFoundError,
  addAttachmentFromUrl as coreAddAttachmentFromUrl,
  answerPrompt as coreAnswerPrompt,
  cancelPrompt as coreCancelPrompt,
  createTask as coreCreateTask,
  deleteAttachment as coreDeleteAttachment,
  deleteTask as coreDeleteTask,
  getTask as coreGetTask,
  moveTask as coreMoveTask,
  reorderSiblings as coreReorderSiblings,
  searchTasks as coreSearchTasks,
  setPriority as coreSetPriority,
  updateTask as coreUpdateTask,
  type AgentPrompt,
  type PromptAnswer,
  type Task,
  type TaskAttachment,
  type TaskKind,
  type TaskStatus,
} from '@getshit/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRequestContext } from '@/lib/auth';
import { availableProviders, findModel, generate, MODELS, type ModelOption } from '@/lib/llm';
import type { DecomposeDraft } from '@/lib/anthropic';

type NoteResult = { note: string };

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

function toError(err: unknown): string {
  if (err instanceof NotFoundError) return err.message;
  if (err instanceof AmbiguousIdError) return err.message;
  if (err instanceof CycleError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

function paths(taskParentId: string | null | undefined) {
  revalidatePath('/');
  if (taskParentId) revalidatePath(`/${taskParentId}`);
}

export async function createTaskAction(input: {
  title: string;
  description?: string;
  parentId?: string | null;
  kind?: TaskKind;
  dueAt?: number | null;
}): Promise<ActionResult<Task>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreCreateTask(ctx, {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    });
    paths(task.parentId);
    if (task.parentId) revalidatePath(`/${task.parentId}`);
    if (task.dueAt !== null) revalidatePath('/today');
    return { ok: true, value: task };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function setStatusAction(id: string, status: TaskStatus): Promise<ActionResult<Task>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreUpdateTask(ctx, id, { status });
    paths(task.parentId);
    revalidatePath(`/${id}`);
    return { ok: true, value: task };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function updateTaskAction(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    rules?: string | null;
    kind?: TaskKind;
    status?: TaskStatus;
    dueAt?: number | null;
    assigneeId?: string | null;
    reviewerId?: string | null;
    recurrence?: string | null;
  },
): Promise<ActionResult<Task>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreUpdateTask(ctx, id, patch);
    paths(task.parentId);
    revalidatePath(`/${id}`);
    revalidatePath('/today');
    return { ok: true, value: task };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function deleteAttachmentAction(id: string): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreDeleteAttachment(ctx, id);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function addAttachmentByUrlAction(
  taskId: string,
  url: string,
): Promise<ActionResult<TaskAttachment>> {
  try {
    const ctx = await getRequestContext();
    const att = await coreAddAttachmentFromUrl(ctx, taskId, url, 'human');
    revalidatePath(`/${taskId}`);
    return { ok: true, value: att };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function answerPromptAction(
  promptId: string,
  answer: PromptAnswer,
): Promise<ActionResult<AgentPrompt>> {
  try {
    const ctx = await getRequestContext();
    const updated = await coreAnswerPrompt(ctx, promptId, answer);
    revalidatePath(`/${updated.taskId}`);
    revalidatePath('/awaiting');
    return { ok: true, value: updated };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function cancelPromptAction(promptId: string): Promise<ActionResult<AgentPrompt>> {
  try {
    const ctx = await getRequestContext();
    const updated = await coreCancelPrompt(ctx, promptId);
    revalidatePath(`/${updated.taskId}`);
    revalidatePath('/awaiting');
    return { ok: true, value: updated };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function revalidateTaskAction(taskId: string): Promise<ActionResult<void>> {
  revalidatePath(`/${taskId}`);
  return { ok: true, value: undefined };
}

export async function deleteTaskAction(id: string): Promise<ActionResult<{ deletedIds: string[] }>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreGetTask(ctx, id);
    const result = await coreDeleteTask(ctx, id);
    paths(task?.parentId ?? null);
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function moveTaskAction(
  id: string,
  newParentId: string | null,
  position?: number,
): Promise<ActionResult<Task>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreMoveTask(ctx, id, newParentId, position);
    paths(task.parentId);
    revalidatePath(`/${id}`);
    if (newParentId) revalidatePath(`/${newParentId}`);
    return { ok: true, value: task };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function reorderSiblingsAction(
  parentId: string | null,
  orderedIds: string[],
): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreReorderSiblings(ctx, parentId, orderedIds);
    revalidatePath('/');
    if (parentId) revalidatePath(`/${parentId}`);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function reorderPriorityAction(
  orderedIds: string[],
): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    await coreSetPriority(ctx, orderedIds);
    revalidatePath('/today');
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function focusTaskAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id === 'string' && id.length > 0) redirect(`/${id}`);
  redirect('/');
}

export async function searchTasksAction(
  query: string,
  kinds?: TaskKind[],
  limit?: number,
): Promise<ActionResult<Task[]>> {
  try {
    const ctx = await getRequestContext();
    const tasks = await coreSearchTasks(ctx, query, {
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      limit: limit ?? 50,
    });
    return { ok: true, value: tasks };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function listModelsAction(): Promise<{
  models: ModelOption[];
  providers: ReturnType<typeof availableProviders>;
}> {
  return { models: MODELS, providers: availableProviders() };
}

export async function decomposeAction(
  taskId: string,
  modelId: string,
  count = 5,
): Promise<ActionResult<DecomposeDraft[]>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreGetTask(ctx, taskId);
    if (!task) return { ok: false, error: `task ${taskId} not found` };

    const ancestors: { title: string; description: string | null }[] = [];
    let cursor: string | null = task.parentId;
    while (cursor) {
      const parent = await coreGetTask(ctx, cursor);
      if (!parent) break;
      ancestors.unshift({ title: parent.title, description: parent.description });
      cursor = parent.parentId;
    }

    const ancestorBlock =
      ancestors.length === 0
        ? '(none — this task is a top-level root)'
        : ancestors
            .map((a, i) => `${i + 1}. ${a.title}${a.description ? `\n   ${a.description}` : ''}`)
            .join('\n');

    const existingChildren =
      task.children.length === 0
        ? '(none yet)'
        : task.children.map((c) => `- ${c.title} [${c.status}]`).join('\n');

    const prompt = `You are decomposing a task into ${count} concrete subtasks.

Ancestor chain (parent first):
${ancestorBlock}

Task to decompose:
Title: ${task.title}
Description: ${task.description ?? '(no description)'}

Existing children (don't duplicate these):
${existingChildren}

Return STRICT JSON only — no prose, no markdown fences. Shape:
{ "subtasks": [{ "title": "...", "description": "..." }, ...] }
- "title" must be a single short imperative line.
- "description" is optional, one or two sentences max, omit if redundant.
- Aim for ${count} subtasks unless the parent obviously needs fewer.`;

    findModel(modelId); // throws-via-fallback if missing — we use it for label/log only
    const text = await generate({ modelId, user: prompt, maxTokens: 2000 });
    const parsed = parseSubtaskJson(text);
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

export async function generateNoteAction(
  taskId: string,
  modelId: string,
  guidance?: string,
): Promise<ActionResult<NoteResult>> {
  try {
    const ctx = await getRequestContext();
    const task = await coreGetTask(ctx, taskId);
    if (!task) return { ok: false, error: `task ${taskId} not found` };

    const childList =
      task.children.length === 0
        ? '(none)'
        : task.children.map((c) => `- [${c.status}] ${c.title}`).join('\n');

    const userPrompt = `Write a concise note for this task. The note should be short markdown — bullets or a short paragraph, no headers.

Task: ${task.title}
Existing description: ${task.description ?? '(none yet)'}
Subtasks:
${childList}

${guidance ? `Extra guidance: ${guidance}\n\n` : ''}Output the note text only — no preface, no quotes, no JSON.`;

    findModel(modelId);
    const note = (await generate({ modelId, user: userPrompt, maxTokens: 800 })).trim();
    if (!note) return { ok: false, error: 'model returned empty output' };
    return { ok: true, value: { note } };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

function parseSubtaskJson(text: string): DecomposeDraft[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;

  const parsed = JSON.parse(body) as { subtasks?: unknown };
  if (!Array.isArray(parsed.subtasks)) throw new Error('AI did not return a subtasks array');
  return parsed.subtasks
    .filter((s): s is { title: string; description?: string } => {
      return (
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { title: unknown }).title === 'string'
      );
    })
    .map((s) => ({
      title: s.title,
      ...(typeof s.description === 'string' && s.description.length > 0
        ? { description: s.description }
        : {}),
    }));
}

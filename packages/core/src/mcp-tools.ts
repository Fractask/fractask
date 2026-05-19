import { z } from 'zod';
import type { Context } from './context.js';
import {
  createTask,
  deleteTask,
  getSubtree,
  listTasks,
  moveTask,
  updateTask,
} from './tasks.js';
import type { TaskTree } from './tasks.js';
import type { Task } from './schema.js';
import {
  addAttachmentFromUrl,
  deleteAttachment,
  listAttachments,
} from './attachments.js';
import {
  cancelPrompt,
  createPrompt,
  listPromptsForTask,
  promptKindSchema,
  promptOptionSchema,
} from './prompts.js';
import {
  createComment,
  deleteComment,
  listCommentsForTask,
} from './comments.js';

/**
 * One tool, defined once and consumed by both transports:
 *   - the stdio MCP server (`packages/mcp`)
 *   - the HTTP MCP route (`packages/web/.../api/mcp`)
 *
 * `inputSchemaZod` validates at runtime; `inputSchemaJson` is what gets
 * advertised to clients via `tools/list`. They must describe the same shape —
 * the JSON Schema is hand-written so both transports see identical text
 * without introducing a converter dep.
 *
 * Handlers throw on error; transports catch and translate to their respective
 * error envelopes (stdio's content-block flag vs HTTP's JSON-RPC error).
 */
export type ToolJsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchemaZod: z.ZodTypeAny;
  inputSchemaJson: ToolJsonSchema;
  handler: (ctx: Context, args: unknown) => Promise<unknown>;
};

const taskStatusEnum = [
  'open',
  'doing',
  'review',
  'done',
  'backlog',
  'snoozed',
  'archived',
] as const;
const taskKindEnum = ['entity', 'project', 'task', 'goal', 'kpi'] as const;

/**
 * Whitelistable Task fields for MCP read tools. `id` is always returned;
 * everything else is opt-in to keep default payloads small enough for agents
 * to skim. Mirrors the `Task` shape minus `id` and `userId` (which agents
 * shouldn't generally see — it leaks ownership across shared trees).
 */
const taskFieldEnum = [
  'title',
  'description',
  'status',
  'kind',
  'rules',
  'parentId',
  'position',
  'source',
  'dueAt',
  'assigneeId',
  'reviewerId',
  'recurrence',
  'priority',
  'createdAt',
  'updatedAt',
  'completedAt',
] as const;
type TaskField = (typeof taskFieldEnum)[number];

const DEFAULT_TASK_FIELDS: readonly TaskField[] = ['title', 'dueAt'];

function projectTask(t: Task, fields: readonly TaskField[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: t.id };
  for (const f of fields) out[f] = (t as unknown as Record<string, unknown>)[f];
  return out;
}

function projectTree(node: TaskTree, fields: readonly TaskField[]): Record<string, unknown> {
  return {
    ...projectTask(node, fields),
    children: node.children.map((c) => projectTree(c, fields)),
  };
}

const listTasksZod = z.object({
  parentId: z.union([z.string(), z.null()]).optional(),
  status: z.enum(taskStatusEnum).optional(),
  kind: z.enum(taskKindEnum).optional(),
  assigneeId: z.union([z.string(), z.null()]).optional(),
  reviewerId: z.union([z.string(), z.null()]).optional(),
  fields: z.array(z.enum(taskFieldEnum)).optional(),
});

const getTaskZod = z.object({
  id: z.string(),
  fields: z.array(z.enum(taskFieldEnum)).optional(),
});

const createTaskZod = z.object({
  title: z.string().min(1),
  parentId: z.union([z.string(), z.null()]).optional(),
  description: z.string().optional(),
  rules: z.string().optional(),
  status: z.enum(taskStatusEnum).optional(),
  kind: z.enum(taskKindEnum).optional(),
  assigneeId: z.union([z.string(), z.null()]).optional(),
  reviewerId: z.union([z.string(), z.null()]).optional(),
});

const updateTaskZod = z.object({
  id: z.string(),
  title: z.string().min(1).optional(),
  description: z.union([z.string(), z.null()]).optional(),
  rules: z.union([z.string(), z.null()]).optional(),
  status: z.enum(taskStatusEnum).optional(),
  kind: z.enum(taskKindEnum).optional(),
  assigneeId: z.union([z.string(), z.null()]).optional(),
  reviewerId: z.union([z.string(), z.null()]).optional(),
});

const deleteTaskZod = z.object({ id: z.string() });

const moveTaskZod = z.object({
  id: z.string(),
  newParentId: z.union([z.string(), z.null()]),
  position: z.number().int().nonnegative().optional(),
});

const attachFromUrlZod = z.object({
  taskId: z.string(),
  url: z.string().url(),
});

const listAttachmentsZod = z.object({ taskId: z.string() });
const deleteAttachmentZod = z.object({ id: z.string() });

const askHumanZod = z.object({
  taskId: z.string(),
  kind: promptKindSchema,
  prompt: z.string().min(1).max(2000),
  options: z.array(promptOptionSchema).max(50).optional(),
  multiple: z.boolean().optional(),
});

const cancelPromptZod = z.object({ id: z.string() });
const listPromptsZod = z.object({ taskId: z.string() });

const postCommentZod = z.object({
  taskId: z.string(),
  body: z.string().min(1).max(20000),
});
const listCommentsZod = z.object({ taskId: z.string() });
const deleteCommentZod = z.object({ id: z.string() });

const STATUS_PROP = { type: 'string' as const, enum: [...taskStatusEnum] };
const KIND_PROP = { type: 'string' as const, enum: [...taskKindEnum] };
const STR_OR_NULL = { type: ['string', 'null'] as const };
const FIELDS_PROP = {
  type: 'array' as const,
  items: { type: 'string' as const, enum: [...taskFieldEnum] },
  description: `Task fields to include on each row. Defaults to ["title","dueAt"]. \`id\` is always included. Pass an explicit list to opt into more (e.g. ["title","status","dueAt","assigneeId"]).`,
};

export const TOOLS: ToolDef[] = [
  {
    name: 'list_tasks',
    description: [
      'List tasks for the current user.',
      'Use parentId="root" or null/omit to list top-level tasks. Pass an id to list direct children of that task.',
      'Status: "open" (queued / next-up) | "doing" (active) | "review" (needs the human) | "done" (shipped) | "backlog" (noted, not now, no schedule — pulled when ready) | "snoozed" (hidden until a wake date) | "archived" (dead, kept for reference). The default views (Inbox, Today, project subtasks) exclude backlog/snoozed/archived; pass status explicitly to see them.',
      'Optional kind filter: "entity" (top-level company/area), "project" (a project under an entity), "task" (a to-do).',
      'Optional assigneeId / reviewerId filters: assignee is the doer; reviewer is who must approve when status="review".',
      'Default response keeps payloads small: each row is `{ id, title, dueAt }`. Use `fields` to opt into more (e.g. `["title","status","dueAt","assigneeId"]`); `id` is always present.',
      'Returns rows ordered by sibling position.',
    ].join(' '),
    inputSchemaZod: listTasksZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        parentId: { ...STR_OR_NULL, description: 'Parent task id, null for roots, or "root"' },
        status: STATUS_PROP,
        kind: KIND_PROP,
        assigneeId: { ...STR_OR_NULL, description: 'Filter by assignee. null matches unassigned.' },
        reviewerId: { ...STR_OR_NULL, description: 'Filter by reviewer. null matches no reviewer.' },
        fields: FIELDS_PROP,
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listTasksZod.parse(raw);
      const resolvedParent = a.parentId === undefined || a.parentId === 'root' ? null : a.parentId;
      const fields = a.fields ?? DEFAULT_TASK_FIELDS;
      const rows = await listTasks(ctx, {
        parentId: resolvedParent,
        ...(a.status ? { status: a.status } : {}),
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
        ...(a.reviewerId !== undefined ? { reviewerId: a.reviewerId } : {}),
      });
      return rows.map((t) => projectTask(t, fields));
    },
  },
  {
    name: 'get_task',
    description: [
      'Fetch a single task by id with its full descendant tree (matches the web tree view), plus the task\'s attachments, prompts, and comments.',
      'Returns null if not found.',
      'Tree shape: each node is `{ id, ...selected fields, children: [...] }`. The whole subtree is included so one call is enough to orient on a project.',
      'Default per-node payload is minimal: `{ id, title, dueAt, children }`. Use `fields` to opt into more (e.g. `["title","status","dueAt","assigneeId"]`); `id` and `children` are always present.',
      'attachments[] — files attached to the root task (filename, mimeType, sizeBytes, storage). Download URL: /api/files/<id>.',
      'prompts[] — structured questions on the root task. Read these on every turn: an answered prompt (status="answered") delivers the human\'s response in `answer`. Pending prompts mean you are still waiting.',
      'comments[] — root task\'s free-form thread (oldest first). Always scan the tail before acting, especially on review/doing tasks — the human may have left feedback there since your last turn.',
    ].join(' '),
    inputSchemaZod: getTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id' },
        fields: FIELDS_PROP,
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = getTaskZod.parse(raw);
      const fields = a.fields ?? DEFAULT_TASK_FIELDS;
      const tree = await getSubtree(ctx, a.id);
      if (!tree) return null;
      const [attachments, prompts, comments] = await Promise.all([
        listAttachments(ctx, a.id),
        listPromptsForTask(ctx, a.id),
        listCommentsForTask(ctx, a.id),
      ]);
      return {
        ...projectTree(tree, fields),
        attachments,
        prompts,
        comments,
      };
    },
  },
  {
    name: 'create_task',
    description: [
      'Create a task. Use this repeatedly to decompose a parent into subtasks:',
      'first call get_task(parentId), reason about the breakdown,',
      'then call create_task once per subtask with parentId set.',
      'Source is automatically tagged "agent" for tool-driven creates.',
      'kind: "entity" = a top-level company/area (no parent); "project" = a project, usually under an entity; "task" (default) = an actual to-do; "goal" = a qualitative outcome attached to a project/entity; "kpi" = a measurable check-in (combine with recurrence for repeating reviews).',
      'rules: persistent guidance for this entity/project that future agent sessions should respect.',
      'assigneeId is who does the work; reviewerId is who must approve when the task moves to status="review". Set both equal for self-review, different for peer review.',
    ].join(' '),
    inputSchemaZod: createTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title (one line)' },
        parentId: { ...STR_OR_NULL, description: 'Parent task id, omit/null for top-level' },
        description: { type: 'string', description: 'Long-form description (markdown)' },
        rules: { type: 'string', description: 'Persistent rules/guidance (entity or project only)' },
        status: STATUS_PROP,
        kind: KIND_PROP,
        assigneeId: { ...STR_OR_NULL, description: 'Assignee id (the doer)' },
        reviewerId: { ...STR_OR_NULL, description: 'Reviewer id (approver when status="review")' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = createTaskZod.parse(raw);
      return createTask(ctx, {
        title: a.title,
        ...(a.parentId !== undefined && a.parentId !== null ? { parentId: a.parentId } : {}),
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.rules !== undefined ? { rules: a.rules } : {}),
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.kind !== undefined ? { kind: a.kind } : {}),
        ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
        ...(a.reviewerId !== undefined ? { reviewerId: a.reviewerId } : {}),
        source: 'agent',
      });
    },
  },
  {
    name: 'update_task',
    description: [
      'Update fields on an existing task. Only the provided fields are changed.',
      'status="review" means waiting for approval; reviewers approve by setting status="done", or send back with status="doing".',
      'Setting status to "done" stamps completedAt.',
    ].join(' '),
    inputSchemaZod: updateTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: STR_OR_NULL,
        rules: STR_OR_NULL,
        status: STATUS_PROP,
        kind: KIND_PROP,
        assigneeId: STR_OR_NULL,
        reviewerId: STR_OR_NULL,
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = updateTaskZod.parse(raw);
      return updateTask(ctx, a.id, {
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.rules !== undefined ? { rules: a.rules } : {}),
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.kind !== undefined ? { kind: a.kind } : {}),
        ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
        ...(a.reviewerId !== undefined ? { reviewerId: a.reviewerId } : {}),
      });
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task and all of its descendants. Returns the list of deleted ids.',
    inputSchemaZod: deleteTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = deleteTaskZod.parse(raw);
      return deleteTask(ctx, a.id);
    },
  },
  {
    name: 'attach_file_from_url',
    description: [
      'Attach a file (image, PDF, document) to a task by fetching a public http(s) URL server-side.',
      'The server stores the bytes, computes a sha256, and returns attachment metadata.',
      'Use for screenshots, generated images, reference PDFs, or any artifact you want the human (and later agent turns) to see on the task.',
      'Source is auto-tagged "agent". Capped by GETSHIT_MAX_UPLOAD_MB (default 25). After upload, the file is available at /api/files/<id> and appears in get_task(taskId).attachments.',
      'Prefer this over base64-in-args for any file beyond a few KB.',
      'Tip: attachments can be referenced from ask_human(kind="pick_image") via option.attachmentId — useful when asking the human to pick between two images you generated.',
    ].join(' '),
    inputSchemaZod: attachFromUrlZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to attach to' },
        url: { type: 'string', description: 'http(s) URL to fetch' },
      },
      required: ['taskId', 'url'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = attachFromUrlZod.parse(raw);
      return addAttachmentFromUrl(ctx, a.taskId, a.url, 'agent');
    },
  },
  {
    name: 'list_attachments',
    description: 'List attachments for a task.',
    inputSchemaZod: listAttachmentsZod,
    inputSchemaJson: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listAttachmentsZod.parse(raw);
      return listAttachments(ctx, a.taskId);
    },
  },
  {
    name: 'delete_attachment',
    description: 'Delete an attachment. Owner-only.',
    inputSchemaZod: deleteAttachmentZod,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = deleteAttachmentZod.parse(raw);
      await deleteAttachment(ctx, a.id);
      return { ok: true };
    },
  },
  {
    name: 'ask_human',
    description: [
      'Ask the task owner a structured question and end your turn.',
      'kind: "text" (open answer) | "choice" (pick from options, set multiple=true to allow many) | "approval" (yes/no) | "pick_image" (option must have imageUrl or attachmentId).',
      'Side effect: the task is automatically moved to status="review" with the owner as reviewer, so it appears in the human\'s unified "Needs your input" queue (the same bucket as work waiting for approval — one inbox for everything that needs the human).',
      'Returns { id } immediately; the answer surfaces on a later get_task call as prompts[].answer once the human responds.',
      'Do NOT poll. Exit your turn and continue work next time you are invoked — the human reading get_task again will show the answer in prompts[].',
      'If you no longer need the answer, call cancel_prompt.',
    ].join(' '),
    inputSchemaZod: askHumanZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'choice', 'approval', 'pick_image'] },
        prompt: { type: 'string', description: 'Plain-text question shown to the human' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
              imageUrl: { type: 'string' },
              attachmentId: { type: 'string' },
            },
            required: ['id', 'label'],
            additionalProperties: false,
          },
        },
        multiple: { type: 'boolean', description: 'Only meaningful for kind="choice"' },
      },
      required: ['taskId', 'kind', 'prompt'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = askHumanZod.parse(raw);
      const prompt = await createPrompt(ctx, {
        taskId: a.taskId,
        kind: a.kind,
        prompt: a.prompt,
        ...(a.options ? { options: a.options } : {}),
        ...(a.multiple !== undefined ? { multiple: a.multiple } : {}),
      });
      return { id: prompt.id };
    },
  },
  {
    name: 'list_prompts',
    description: 'List all prompts (pending, answered, cancelled) for a task.',
    inputSchemaZod: listPromptsZod,
    inputSchemaJson: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listPromptsZod.parse(raw);
      return listPromptsForTask(ctx, a.taskId);
    },
  },
  {
    name: 'cancel_prompt',
    description: 'Cancel a pending prompt. The asker or the task owner can cancel.',
    inputSchemaZod: cancelPromptZod,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = cancelPromptZod.parse(raw);
      return cancelPrompt(ctx, a.id);
    },
  },
  {
    name: 'post_comment',
    description: [
      'Post a comment on a task. Use this for short status notes, observations, results you want the human to see, or non-blocking replies to feedback in the existing thread.',
      'For blocking decisions (approval, choice, open question), use ask_human instead — that moves the task to "review" and surfaces it in the human\'s queue. post_comment does NOT change task status.',
      'Body is markdown; renders the same as task descriptions.',
      'Source is auto-tagged "agent". The comment shows up in get_task(taskId).comments[] (oldest first) and in the web UI thread.',
    ].join(' '),
    inputSchemaZod: postCommentZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        body: { type: 'string', description: 'Comment body (markdown)' },
      },
      required: ['taskId', 'body'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = postCommentZod.parse(raw);
      return createComment(ctx, { taskId: a.taskId, body: a.body, source: 'agent' });
    },
  },
  {
    name: 'list_comments',
    description: 'List all comments on a task, oldest first. get_task already includes this — call list_comments only when you need the thread without the rest of the task payload.',
    inputSchemaZod: listCommentsZod,
    inputSchemaJson: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listCommentsZod.parse(raw);
      return listCommentsForTask(ctx, a.taskId);
    },
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment. Only the author or the task owner can delete.',
    inputSchemaZod: deleteCommentZod,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = deleteCommentZod.parse(raw);
      await deleteComment(ctx, a.id);
      return { ok: true };
    },
  },
  {
    name: 'move_task',
    description: [
      'Reparent a task. newParentId="root" or null promotes the task to a top-level root.',
      'Optional position inserts at that sibling index (siblings shift down).',
      'Cycles (moving a task into its own subtree) are rejected.',
    ].join(' '),
    inputSchemaZod: moveTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        newParentId: { ...STR_OR_NULL, description: 'New parent id, null/"root" to promote' },
        position: { type: 'integer', minimum: 0 },
      },
      required: ['id', 'newParentId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = moveTaskZod.parse(raw);
      const target = a.newParentId === 'root' ? null : a.newParentId;
      return moveTask(ctx, a.id, target, a.position);
    },
  },
];

/**
 * Look up a tool by name. Returns null if unknown.
 */
export function findTool(name: string): ToolDef | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

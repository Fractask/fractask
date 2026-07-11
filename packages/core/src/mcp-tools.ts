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
  createAttachment,
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
import {
  createBrainNote,
  deleteBrainNote,
  getBrainNote,
  listBrainNotes,
  moveBrainNote,
  searchBrainNotes,
  updateBrainNote,
} from './brain.js';
import { getUserById, getUserByName, searchUsers } from './users.js';

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

// Due date can arrive as epoch ms (number) or an ISO date string like
// "2026-07-15" — bots naturally produce the latter. Coerce to epoch ms; null
// clears the date.
const dueAtZod = z.union([z.number().int(), z.string().min(1), z.null()]).optional();

function coerceDueAt(v: number | string | null | undefined): number | null | undefined {
  if (v === undefined || v === null || typeof v === 'number') return v;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid dueAt "${v}" — pass epoch milliseconds or an ISO date like "2026-07-15"`);
  }
  return ms;
}

const DUE_AT_PROP = {
  description:
    'Due / scheduled date — epoch milliseconds or an ISO date string like "2026-07-15" (null clears it). This is the day the task lands on the calendar view.',
  anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }],
} as const;

const createTaskZod = z.object({
  title: z.string().min(1),
  parentId: z.union([z.string(), z.null()]).optional(),
  description: z.string().optional(),
  rules: z.string().optional(),
  status: z.enum(taskStatusEnum).optional(),
  kind: z.enum(taskKindEnum).optional(),
  assigneeId: z.union([z.string(), z.null()]).optional(),
  reviewerId: z.union([z.string(), z.null()]).optional(),
  dueAt: dueAtZod,
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
  dueAt: dueAtZod,
});

const deleteTaskZod = z.object({ id: z.string() });

const moveTaskZod = z.object({
  id: z.string(),
  newParentId: z.union([z.string(), z.null()]),
  position: z.number().int().nonnegative().optional(),
});

const attachFromUrlZod = z
  .object({
    taskId: z.string().optional(),
    noteId: z.string().optional(),
    url: z.string().url(),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.noteId ? 1 : 0) === 1,
    'Exactly one of taskId or noteId is required',
  );

const attachFileZod = z
  .object({
    taskId: z.string().optional(),
    noteId: z.string().optional(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    dataBase64: z.string().min(1),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.noteId ? 1 : 0) === 1,
    'Exactly one of taskId or noteId is required',
  );

// Accept a bare base64 string or a full data: URL ("data:image/png;base64,…").
function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma !== -1 ? input.slice(comma + 1) : input;
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength === 0) {
    throw new Error('dataBase64 decoded to zero bytes — expected base64-encoded file contents');
  }
  // Copy into a fresh ArrayBuffer-backed view (Buffer is typed ArrayBufferLike).
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

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

// Brain-note tool argument schemas. Like other tools, "root" is accepted as an
// alias for null on scope-shaped args so cli/MCP callers don't have to pass
// JSON null.
const listNotesZod = z.object({
  scopeTaskId: z.union([z.string(), z.null()]).optional(),
  parentNoteId: z.union([z.string(), z.null()]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
const getNoteZod = z.object({
  id: z.string(),
  includeChildren: z.boolean().optional(),
  format: z.enum(['text', 'json']).optional(),
});
const createNoteZod = z.object({
  title: z.string().min(1),
  icon: z.union([z.string(), z.null()]).optional(),
  scopeTaskId: z.union([z.string(), z.null()]).optional(),
  parentNoteId: z.union([z.string(), z.null()]).optional(),
  contentText: z.string().optional(),
  contentJson: z.unknown().optional(),
});
const updateNoteZod = z.object({
  id: z.string(),
  title: z.string().min(1).optional(),
  icon: z.union([z.string(), z.null()]).optional(),
  scopeTaskId: z.union([z.string(), z.null()]).optional(),
  parentNoteId: z.union([z.string(), z.null()]).optional(),
  contentText: z.string().optional(),
  contentJson: z.unknown().optional(),
});
const deleteNoteZod = z.object({ id: z.string() });
const moveNoteZod = z.object({
  id: z.string(),
  newParentNoteId: z.union([z.string(), z.null()]),
  position: z.number().int().nonnegative().optional(),
});
const searchNotesZod = z.object({
  query: z.string().min(1),
  scopeTaskId: z.union([z.string(), z.null()]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const getUserZod = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .refine(
    (v) => (v.id ? 1 : 0) + (v.name ? 1 : 0) === 1,
    'Exactly one of id or name is required',
  );
const searchUsersZod = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

function STR_OR_NULL_DESCRIBED(description: string) {
  return { type: ['string', 'null'] as const, description };
}

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
        dueAt: DUE_AT_PROP,
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
        ...(a.dueAt !== undefined ? { dueAt: coerceDueAt(a.dueAt) } : {}),
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
        dueAt: DUE_AT_PROP,
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
        ...(a.dueAt !== undefined ? { dueAt: coerceDueAt(a.dueAt) } : {}),
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
      'Attach a file (image, PDF, document) to a task or brain note by fetching a public http(s) URL server-side.',
      'Pass exactly one of taskId or noteId.',
      'The server stores the bytes, computes a sha256, and returns attachment metadata.',
      'Use for screenshots, generated images, reference PDFs, or any artifact you want the human (and later agent turns) to see.',
      'Source is auto-tagged "agent". Capped by GETSHIT_MAX_UPLOAD_MB (default 25). After upload, the file is available at /api/files/<id> and appears in get_task(taskId).attachments or get_note(noteId).attachments.',
      'Prefer this over base64-in-args for any file beyond a few KB.',
      'Tip: attachments can be referenced from ask_human(kind="pick_image") via option.attachmentId — useful when asking the human to pick between two images you generated.',
    ].join(' '),
    inputSchemaZod: attachFromUrlZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to attach to (exactly one of taskId/noteId)' },
        noteId: { type: 'string', description: 'Brain note to attach to (exactly one of taskId/noteId)' },
        url: { type: 'string', description: 'http(s) URL to fetch' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = attachFromUrlZod.parse(raw);
      return addAttachmentFromUrl(
        ctx,
        {
          ...(a.taskId ? { taskId: a.taskId } : {}),
          ...(a.noteId ? { brainNoteId: a.noteId } : {}),
        },
        a.url,
        'agent',
      );
    },
  },
  {
    name: 'attach_file',
    description: [
      'Attach a file (image, video, PDF, document) to a task or brain note by uploading its bytes directly as base64 — no public URL needed.',
      'Pass exactly one of taskId or noteId, plus filename, mimeType (e.g. "image/png", "video/mp4"), and dataBase64 (base64 of the raw bytes; a full "data:...;base64,..." URL is also accepted).',
      'Prefer attach_file_from_url for large files (esp. video): on a hosted/serverless MCP endpoint the request body is capped by the platform (~4.5MB on Vercel), while URL-fetch is bounded only by GETSHIT_MAX_UPLOAD_MB.',
      'Source is auto-tagged "agent". After upload the file is at /api/files/<id> and appears in get_task(taskId).attachments or get_note(noteId).attachments; the first image (else video) becomes the calendar thumbnail.',
    ].join(' '),
    inputSchemaZod: attachFileZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to attach to (exactly one of taskId/noteId)' },
        noteId: { type: 'string', description: 'Brain note to attach to (exactly one of taskId/noteId)' },
        filename: { type: 'string', description: 'File name, e.g. "reel.mp4"' },
        mimeType: { type: 'string', description: 'MIME type, e.g. "image/png" or "video/mp4"' },
        dataBase64: {
          type: 'string',
          description: 'Base64-encoded file bytes (a full "data:...;base64,..." URL is also accepted)',
        },
      },
      required: ['filename', 'mimeType', 'dataBase64'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = attachFileZod.parse(raw);
      return createAttachment(ctx, {
        ...(a.taskId ? { taskId: a.taskId } : {}),
        ...(a.noteId ? { brainNoteId: a.noteId } : {}),
        filename: a.filename,
        mimeType: a.mimeType,
        body: decodeBase64(a.dataBase64),
        source: 'agent',
      });
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
    name: 'list_notes',
    description: [
      'List brain notes the current user can read.',
      'scopeTaskId="root" or null lists personal (scope-less) notes; pass an entity or project task id to list notes scoped to it.',
      'parentNoteId=null lists top-level notes (under the chosen scope); pass a note id for direct children of that note.',
      'Brain notes are the persistent knowledge base — company voice, brand, project background, references. Read before acting on scoped work.',
      'Default response is `{ id, title, icon, parentNoteId, scopeTaskId }` per row, ordered by sibling position.',
    ].join(' '),
    inputSchemaZod: listNotesZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        scopeTaskId: {
          ...STR_OR_NULL,
          description: 'Entity or project task id, null/"root" for personal notes',
        },
        parentNoteId: { ...STR_OR_NULL, description: 'Parent note id, null for top of the scope' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listNotesZod.parse(raw);
      const scopeTaskId = a.scopeTaskId === 'root' ? null : a.scopeTaskId;
      const parentNoteId = a.parentNoteId === 'root' ? null : a.parentNoteId;
      const rows = await listBrainNotes(ctx, {
        ...(scopeTaskId !== undefined ? { scopeTaskId } : {}),
        ...(parentNoteId !== undefined ? { parentNoteId } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        parentNoteId: r.parentNoteId,
        scopeTaskId: r.scopeTaskId,
      }));
    },
  },
  {
    name: 'get_note',
    description: [
      'Fetch a single brain note by id. Default payload is text-focused for LLM use:',
      '`{ id, title, icon, scopeTaskId, parentNoteId, contentText, attachments, children? }`.',
      'Pass `format="json"` to also get the canonical `contentJson` (Tiptap doc) — only needed when round-tripping content back into update_note.',
      'Pass `includeChildren=true` to include direct child notes.',
      'Returns null if not found / not accessible.',
    ].join(' '),
    inputSchemaZod: getNoteZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        includeChildren: { type: 'boolean' },
        format: { type: 'string', enum: ['text', 'json'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = getNoteZod.parse(raw);
      const note = await getBrainNote(ctx, a.id);
      if (!note) return null;
      const out: Record<string, unknown> = {
        id: note.id,
        title: note.title,
        icon: note.icon,
        scopeTaskId: note.scopeTaskId,
        parentNoteId: note.parentNoteId,
        contentText: note.contentText,
        attachments: note.attachments,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
      if (a.format === 'json') {
        try {
          out['contentJson'] = JSON.parse(note.contentJson);
        } catch {
          out['contentJson'] = null;
        }
      }
      if (a.includeChildren) {
        out['children'] = note.children.map((c) => ({
          id: c.id,
          title: c.title,
          icon: c.icon,
        }));
      }
      return out;
    },
  },
  {
    name: 'create_note',
    description: [
      'Create a brain note (a persistent knowledge-base page) the user and other agents can read in future sessions.',
      'Use this for durable context: company voice, brand, decisions, references, prompt templates, anything that should outlive a chat thread.',
      'scopeTaskId scopes the note to an entity OR project task; omit/null for a personal/global note.',
      'parentNoteId nests this note under another note for hierarchy.',
      'BODY: pass EITHER `contentJson` (preferred — Tiptap doc with real headings/bold/italic/lists/links) OR `contentText` (plain text only — blank lines split paragraphs, single newlines become line breaks).',
      'IMPORTANT: `contentText` is NOT parsed as markdown. `##`, `**`, `-`, table pipes, etc. render as literal characters. For any formatting use `contentJson` — see the Brain notes section of the server instructions for the node schema.',
      'Source is auto-tagged "agent". Returns `{ id }`. Read the new note back with get_note.',
    ].join(' '),
    inputSchemaZod: createNoteZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title (one line)' },
        icon: STR_OR_NULL_DESCRIBED('Single emoji icon (e.g. 📒)'),
        scopeTaskId: {
          ...STR_OR_NULL,
          description: 'Entity or project task id; null for personal',
        },
        parentNoteId: { ...STR_OR_NULL, description: 'Parent note id; null for top-level' },
        contentText: {
          type: 'string',
          description:
            'Plain-text body. NOT parsed as markdown — `##`, `**`, table pipes etc. render literally. Use contentJson for any formatting.',
        },
        contentJson: {
          type: 'object',
          description:
            'Tiptap doc (preferred for formatted notes). Shape: `{type:"doc",content:[…]}`. Block nodes: paragraph, heading (attrs.level 1-3), bulletList/orderedList+listItem, blockquote, codeBlock, horizontalRule, hardBreak. Inline marks: bold, italic, strike, code, link (attrs.href). See the Brain notes section of the server instructions for examples.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = createNoteZod.parse(raw);
      const created = await createBrainNote(ctx, {
        title: a.title,
        ...(a.icon !== undefined ? { icon: a.icon } : {}),
        ...(a.scopeTaskId !== undefined ? { scopeTaskId: a.scopeTaskId } : {}),
        ...(a.parentNoteId !== undefined ? { parentNoteId: a.parentNoteId } : {}),
        ...(a.contentText !== undefined ? { contentText: a.contentText } : {}),
        ...(a.contentJson !== undefined ? { contentJson: a.contentJson } : {}),
        source: 'agent',
      });
      return { id: created.id };
    },
  },
  {
    name: 'update_note',
    description: [
      'Update fields on a brain note. Only provided fields change.',
      'BODY: pass EITHER `contentJson` (preferred for any formatted note — headings, bold, italic, lists, links) OR `contentText` (plain text only — blank lines split paragraphs, single newlines become line breaks).',
      'IMPORTANT: `contentText` is NOT parsed as markdown. `##`, `**`, `-`, table pipes, etc. render as literal characters. If you want headings/bold/italic/lists, you MUST pass `contentJson` as a Tiptap doc. See the Brain notes section of the server instructions for the node schema and examples.',
      'Round-trip safe: `get_note(id, format="json")` returns the canonical `contentJson` you can mutate and pass back.',
      'Pass `scopeTaskId` (null to detach) or `parentNoteId` to re-scope / re-parent.',
    ].join(' '),
    inputSchemaZod: updateNoteZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        icon: STR_OR_NULL,
        scopeTaskId: STR_OR_NULL,
        parentNoteId: STR_OR_NULL,
        contentText: {
          type: 'string',
          description:
            'Plain-text body. NOT parsed as markdown — `##`, `**`, table pipes etc. render literally. Use contentJson for any formatting.',
        },
        contentJson: {
          type: 'object',
          description:
            'Tiptap doc (preferred for formatted notes). Shape: `{type:"doc",content:[…]}`. Block nodes: paragraph, heading (attrs.level 1-3), bulletList/orderedList+listItem, blockquote, codeBlock, horizontalRule, hardBreak. Inline marks: bold, italic, strike, code, link (attrs.href). See the Brain notes section of the server instructions for examples.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = updateNoteZod.parse(raw);
      const updated = await updateBrainNote(ctx, a.id, {
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.icon !== undefined ? { icon: a.icon } : {}),
        ...(a.scopeTaskId !== undefined ? { scopeTaskId: a.scopeTaskId } : {}),
        ...(a.parentNoteId !== undefined ? { parentNoteId: a.parentNoteId } : {}),
        ...(a.contentText !== undefined ? { contentText: a.contentText } : {}),
        ...(a.contentJson !== undefined ? { contentJson: a.contentJson } : {}),
      });
      return { id: updated.id };
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a brain note and all of its descendants. Owner-only. Returns the deleted ids.',
    inputSchemaZod: deleteNoteZod,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = deleteNoteZod.parse(raw);
      return deleteBrainNote(ctx, a.id);
    },
  },
  {
    name: 'move_note',
    description: [
      'Re-parent a brain note. newParentNoteId="root" or null promotes the note to a top-level note within its current scope.',
      'Optional position inserts at that sibling index.',
      'Cycles (moving a note under one of its own descendants) are rejected.',
    ].join(' '),
    inputSchemaZod: moveNoteZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        newParentNoteId: { ...STR_OR_NULL, description: 'New parent note id, null/"root" to promote' },
        position: { type: 'integer', minimum: 0 },
      },
      required: ['id', 'newParentNoteId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = moveNoteZod.parse(raw);
      const target = a.newParentNoteId === 'root' ? null : a.newParentNoteId;
      return moveBrainNote(ctx, a.id, target, a.position);
    },
  },
  {
    name: 'search_notes',
    description: [
      'Substring search across brain note titles and body text (the plain-text mirror of the editor content).',
      'Scoped to notes the user can read. Pass scopeTaskId to restrict to one entity or project, null/"root" to restrict to personal notes.',
      'Returns `[{ id, title, icon, snippet, updatedAt }]` ordered by recency.',
    ].join(' '),
    inputSchemaZod: searchNotesZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        scopeTaskId: {
          ...STR_OR_NULL,
          description: 'Restrict to entity/project (null for personal-only)',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = searchNotesZod.parse(raw);
      const scopeTaskId = a.scopeTaskId === 'root' ? null : a.scopeTaskId;
      return searchBrainNotes(ctx, a.query, {
        ...(scopeTaskId !== undefined ? { scopeTaskId } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      });
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
  {
    name: 'get_user',
    description: [
      'Fetch a single user (a person or agent) by `id` OR by `name` — pass exactly one.',
      'Name match is case-insensitive and exact; if several users share a name the oldest is returned, so prefer `search_users` to disambiguate.',
      'Use this to resolve who an assigneeId/reviewerId refers to, or to turn a human-supplied name into an id for create_task/update_task.',
      'Returns `{ id, name, email, kind, image, createdAt }` where kind is "human" (signed in) | "agent" | "guest". Returns null if not found.',
    ].join(' '),
    inputSchemaZod: getUserZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User id (exact)' },
        name: { type: 'string', description: 'Exact name, case-insensitive' },
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = getUserZod.parse(raw);
      return a.id !== undefined
        ? getUserById(ctx, a.id)
        : getUserByName(ctx, a.name as string);
    },
  },
  {
    name: 'search_users',
    description: [
      'Search users (people and agents) by a substring of their name or email (case-insensitive).',
      'Omit `query` to list everyone. Everyone in the shared workspace is visible.',
      'Use this to find the id for an assigneeId/reviewerId — e.g. search "alex", then pass the matching id to create_task/update_task.',
      'Returns `[{ id, name, email, kind, image, createdAt }]` ordered by name; kind is "human" | "agent" | "guest".',
    ].join(' '),
    inputSchemaZod: searchUsersZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring of name or email; omit to list all' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = searchUsersZod.parse(raw);
      return searchUsers(ctx, {
        ...(a.query !== undefined ? { query: a.query } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      });
    },
  },
];

/**
 * Look up a tool by name. Returns null if unknown.
 */
export function findTool(name: string): ToolDef | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

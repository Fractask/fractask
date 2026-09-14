import { createHash } from 'node:crypto';
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
import { recurrenceSchema } from './types.js';
import {
  addAttachmentFromUrl,
  createAttachment,
  createUploadTicket,
  deleteAttachment,
  finalizeUpload,
  listAttachments,
  withDownloadUrls,
} from './attachments.js';
import {
  cancelPrompt,
  createPrompt,
  deckSchema,
  getPendingPromptSummaries,
  listPromptsForTask,
  MAX_AGENT_EST_SECONDS,
  MIN_AGENT_EST_SECONDS,
  promptKindSchema,
  promptOptionSchema,
  promptTemplateSchema,
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
import {
  createScratchEntry,
  dismissScratchEntry,
  fileScratchEntry,
  listScratchEntries,
} from './scratchpad.js';
import { reportShipped } from './focus.js';
import { assertAdmin, createUser, createAgentCliToken } from './auth.js';
import { shareTaskWithUserId, shareTaskWithEmail } from './shares.js';
import { getAgentActivity } from './activity-stats.js';
import {
  NOT_SHARED_MESSAGE,
  NOT_SHARED_NOTE_MESSAGE,
  noteVisibility,
  taskVisibility,
} from './access.js';
import { getVenturePulse, getVentureRoom, getReviewQueueLoad } from './ventures.js';

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
  /**
   * Admin-only tools (agent provisioning) are hidden from `tools/list` for
   * non-admin callers and rejected at call time. The handler also calls
   * `assertAdmin` as the authoritative guard — the transport filtering is
   * defense-in-depth / UX, not the security boundary.
   */
  adminOnly?: boolean;
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
  'goalId',
  'milestoneId',
  'progressPct',
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
  deep: z.boolean().optional(),
  pendingPrompt: z.boolean().optional(),
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

const RECURRENCE_PROP = {
  description:
    'Repeat rule. Interval: "1d" (daily), "1w" (weekly), "4h", "1mo". Weekdays: "weekdays" (Mon–Fri) or a list like "mon,wed,fri". null = one-off. Needs a dueAt to anchor the schedule.',
  type: ['string', 'null'] as const,
} as const;

const RECURRENCE_MODE_PROP = {
  description:
    'Only with `recurrence`. "checkbox" (default) = one rolling task; ticking it rolls to the next occurrence and logs a completion (heartbeats, KPI checks). "deliverable" = a template; a daily cron spawns one child task per due day that runs its own open→review→done flow (e.g. a daily social post needing approval, SDR outreach).',
  type: 'string' as const,
  enum: ['checkbox', 'deliverable'],
} as const;

const GOAL_ID_PROP = {
  type: ['string', 'null'] as const,
  description:
    'Focus goal link: id of a task with kind="goal" that this task advances (null clears it). Tasks nested inside a goal\'s subtree inherit the link implicitly — set this only for cross-tree work. No goal at all = a "specific" self-contained task, which is valid.',
} as const;

const MILESTONE_ID_PROP = {
  type: ['string', 'null'] as const,
  description:
    'Optional refinement of goalId: which path node this task advances. Must be a DIRECT child of the goal task (a goal\'s path nodes are its direct children, in sibling order). null clears.',
} as const;

const PROGRESS_PCT_PROP = {
  type: ['number', 'null'] as const,
  description:
    'Completion estimate, 0-100. Only meaningful on kind="goal" tasks that have no milestones (direct children) to derive progress from — when a goal DOES have direct children, the Office/venture views compute done/total automatically and this value is ignored for display. null clears it.',
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
  recurrence: z.union([recurrenceSchema, z.null()]).optional(),
  recurrenceMode: z.enum(['checkbox', 'deliverable']).optional(),
  goalId: z.union([z.string(), z.null()]).optional(),
  milestoneId: z.union([z.string(), z.null()]).optional(),
  progressPct: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
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
  recurrence: z.union([recurrenceSchema, z.null()]).optional(),
  recurrenceMode: z.enum(['checkbox', 'deliverable']).optional(),
  goalId: z.union([z.string(), z.null()]).optional(),
  milestoneId: z.union([z.string(), z.null()]).optional(),
  progressPct: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
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
    sizeBytes: z.number().int().positive(),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be 64 hex characters')
      .optional(),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.noteId ? 1 : 0) === 1,
    'Exactly one of taskId or noteId is required',
  );

const createUploadZod = z
  .object({
    taskId: z.string().optional(),
    noteId: z.string().optional(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    sizeBytes: z.number().int().positive(),
  })
  .refine(
    (v) => (v.taskId ? 1 : 0) + (v.noteId ? 1 : 0) === 1,
    'Exactly one of taskId or noteId is required',
  );

const finalizeUploadZod = z
  .object({
    attachmentId: z.string(),
    taskId: z.string().optional(),
    noteId: z.string().optional(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    sizeBytes: z.number().int().positive(),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be 64 hex characters')
      .optional(),
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

// Node's base64 decoder is lenient by design: it drops characters outside the
// alphabet and decodes a string cut mid-way into a SHORTER, perfectly valid
// byte array. It never throws. So an `attach_file` tool-call argument truncated
// in transit used to be stored as a real, small attachment and reported as
// success — a corrupt PDF that looks like a delivered artifact.
//
// The server cannot detect this on its own: it only ever sees the bytes that
// arrived, and a truncated big file is indistinguishable from a small file.
// Only the caller knows the true length, so the caller must declare it.
function decodeVerified(
  dataBase64: string,
  declaredSize: number,
  declaredSha?: string,
): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(dataBase64);
  if (bytes.byteLength !== declaredSize) {
    const verb = bytes.byteLength < declaredSize ? 'TRUNCATED' : 'altered';
    throw new Error(
      `attach_file payload ${verb} in transit: you declared sizeBytes=${declaredSize} but the base64 that reached the server decodes to ${bytes.byteLength} bytes. ` +
        `Nothing was stored. Base64 of a large file usually does not survive being passed as a tool-call argument — ` +
        `do not retry the same call. Use attach_file_from_url with a publicly fetchable https URL instead ` +
        `(the server fetches it directly, so neither the agent's context nor the argument size is a limit).`,
    );
  }
  if (declaredSha) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== declaredSha.toLowerCase()) {
      throw new Error(
        `attach_file payload CORRUPTED in transit: the byte count matched (${declaredSize}) but the content hash did not. ` +
          `Declared sha256=${declaredSha.toLowerCase()}, received sha256=${actual}. Nothing was stored.`,
      );
    }
  }
  return bytes;
}

const listAttachmentsZod = z.object({ taskId: z.string() });
const deleteAttachmentZod = z.object({ id: z.string() });

const askHumanZod = z.object({
  taskId: z.string(),
  kind: promptKindSchema,
  prompt: z.string().min(1).max(2000),
  options: z.array(promptOptionSchema).max(50).optional(),
  multiple: z.boolean().optional(),
  template: promptTemplateSchema.optional(),
  deck: deckSchema.optional(),
  recommendation: z.string().min(1).max(2000).optional(),
  estSeconds: z.number().int().min(1).max(86_400).optional(),
  goalTaskId: z.string().optional(),
  keepPrevious: z.boolean().optional(),
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

const reportShippedZod = z.object({
  taskId: z.string(),
  title: z.string().min(1).max(300),
  url: z.string().url().optional(),
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

// --- Admin-only agent provisioning ---
const createAgentZod = z.object({
  name: z.string().min(1).max(120),
  endpoint: z.string().url().optional(),
});
const shareTaskZod = z
  .object({
    taskId: z.string(),
    userId: z.string().optional(),
    email: z.string().email().optional(),
  })
  .refine(
    (v) => (v.userId ? 1 : 0) + (v.email ? 1 : 0) === 1,
    'Exactly one of userId or email is required',
  );
const mintAgentTokenZod = z.object({
  agentId: z.string(),
  label: z.string().max(120).optional(),
});
const provisionAgentZod = z.object({
  name: z.string().min(1).max(120),
  shareTaskId: z.string(),
  endpoint: z.string().url().optional(),
  label: z.string().max(120).optional(),
});
const officeVentureZod = z.object({ entityId: z.string() });

function STR_OR_NULL_DESCRIBED(description: string) {
  return { type: ['string', 'null'] as const, description };
}

const STATUS_PROP = { type: 'string' as const, enum: [...taskStatusEnum] };
const KIND_PROP = { type: 'string' as const, enum: [...taskKindEnum] };
const scratchListZod = z.object({
  status: z.enum(['new', 'filed', 'dismissed', 'all']).optional(),
  scope: z.enum(['mine', 'all']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
const scratchAddZod = z.object({ body: z.string().trim().min(1).max(8000) });
const scratchFileZod = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  note: z.string().max(500).nullable().optional(),
});
const scratchDismissZod = z.object({ id: z.string().min(1), note: z.string().trim().min(1).max(500) });

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
      'deep: search the WHOLE accessible tree at any depth instead of one level. Without it, an omitted parentId means "roots of my view" only — so a nested task you own is invisible. Pass deep=true with status/assigneeId/reviewerId to answer questions like "every task in review across all ventures" or "everything assigned to me" in ONE call instead of walking the tree. Ignored when parentId names a specific parent (that stays a direct-children query).',
      'NOTE: when you pass assigneeId or reviewerId and omit parentId, the query is deep automatically — "tasks assigned to X" is never meaningfully a roots-only question, and the old roots-only default made agents believe they had no work. Pass deep=false to opt out.',
      'Default response keeps payloads small: each row is `{ id, title, dueAt }`. Use `fields` to opt into more (e.g. `["title","status","dueAt","assigneeId"]`); `id` is always present.',
      'Returns rows ordered by sibling position.',
      'An empty result is a real answer, not an error — but if parentId names a task that EXISTS and is not shared with you, this returns `not_shared` instead of `[]`, because "here are the children: none" is a worse lie than "not found". Treat that as "ask for access", never as "the subtree is empty, recreate it".',
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
        deep: {
          type: 'boolean' as const,
          description:
            'Search the whole accessible tree at any depth rather than just the top level. Defaults to true when assigneeId/reviewerId is set and parentId is omitted; false otherwise. Ignored when parentId names a specific parent.',
        },
        pendingPrompt: {
          type: 'boolean' as const,
          description:
            'Attach each task\'s newest pending ask_human as `pendingPrompt` ({ id, kind, prompt, estSeconds, askedByUserId, userId, createdAt }), or null. Combine with status="review" + deep=true to get the whole review queue and its total answer time in one call.',
        },
        fields: FIELDS_PROP,
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listTasksZod.parse(raw);
      const resolvedParent = a.parentId === undefined || a.parentId === 'root' ? null : a.parentId;
      // An assignee/reviewer question is never a roots-only question: asking
      // "what is assigned to me" and getting back only the handful of matches
      // whose parent happens to be invisible is how an agent concludes it is
      // idle while holding six tasks. Default those deep; let callers opt out.
      const byPerson = a.assigneeId !== undefined || a.reviewerId !== undefined;
      const deep = a.deep ?? (byPerson && a.parentId === undefined);
      const fields = a.fields ?? DEFAULT_TASK_FIELDS;
      const rows = await listTasks(ctx, {
        parentId: resolvedParent,
        ...(deep ? { deep: true } : {}),
        ...(a.status ? { status: a.status } : {}),
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
        ...(a.reviewerId !== undefined ? { reviewerId: a.reviewerId } : {}),
      });
      const projected = rows.map((t) => projectTask(t, fields));
      if (!a.pendingPrompt) return projected;
      const pending = await getPendingPromptSummaries(rows.map((t) => t.id));
      return projected.map((row) => ({
        ...row,
        pendingPrompt: pending.get(row['id'] as string) ?? null,
      }));
    },
  },
  {
    name: 'get_task',
    description: [
      'Fetch a single task by id with its full descendant tree (matches the web tree view), plus the task\'s attachments, prompts, and comments.',
      'Returns null if no such task exists. If the task EXISTS but is not shared with you, returns `{ id, error: "not_shared", message }` instead — treat that as "ask for access", never as "it was deleted, recreate it".',
      'Tree shape: each node is `{ id, ...selected fields, children: [...] }`. The whole subtree is included so one call is enough to orient on a project.',
      'Default per-node payload is minimal: `{ id, title, dueAt, children }`. Use `fields` to opt into more (e.g. `["title","status","dueAt","assigneeId"]`); `id` and `children` are always present.',
      'attachments[] — files attached to the root task (filename, mimeType, sizeBytes, storage, downloadUrl). `downloadUrl` is ready to GET as-is, no auth header needed — it\'s either a presigned URL (S3 storage, expires in 1h — re-fetch get_task if it\'s gone stale) or, on local storage, /api/files/<id> which DOES need `Authorization: Bearer <GETSHIT_TOKEN>` since that path can\'t be presigned.',
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
      if (!tree) {
        // A bare null here reads as "deleted", and agents act on that: one
        // coordinator sweep concluded ~20 ventures had no goals and was one
        // call away from creating duplicates on top of goals that existed.
        // Say which it is, but only for an id the caller already holds — a
        // guessed id still comes back as a plain null.
        if ((await taskVisibility(ctx, a.id)) === 'hidden') {
          return {
            id: a.id,
            error: 'not_shared',
            message: NOT_SHARED_MESSAGE,
          };
        }
        return null;
      }
      const [attachmentRows, prompts, comments] = await Promise.all([
        listAttachments(ctx, a.id),
        listPromptsForTask(ctx, a.id),
        listCommentsForTask(ctx, a.id),
      ]);
      const attachments = await withDownloadUrls(attachmentRows);
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
      'For repeating work set `recurrence` (e.g. "weekdays", "mon,wed,fri", "1d") + a dueAt. Use recurrenceMode="deliverable" when each occurrence is a real deliverable needing its own approval (daily post, outreach) — a cron then spawns one task per day; "checkbox" (default) is a rolling heartbeat.',
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
        recurrence: RECURRENCE_PROP,
        recurrenceMode: RECURRENCE_MODE_PROP,
        goalId: GOAL_ID_PROP,
        milestoneId: MILESTONE_ID_PROP,
        progressPct: PROGRESS_PCT_PROP,
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
        ...(a.recurrence !== undefined ? { recurrence: a.recurrence } : {}),
        ...(a.recurrenceMode !== undefined ? { recurrenceMode: a.recurrenceMode } : {}),
        ...(a.goalId !== undefined ? { goalId: a.goalId } : {}),
        ...(a.milestoneId !== undefined ? { milestoneId: a.milestoneId } : {}),
        ...(a.progressPct !== undefined ? { progressPct: a.progressPct } : {}),
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
      'You cannot move a task INTO status="review" yourself: review is the human\'s "needs your input" queue, so it requires a pending question. Call ask_human(...) instead — it posts the question and moves the task to review for you. To report progress or hand off finished work with nothing to decide, use post_comment(...) and leave the task at "doing" (or set "done" if it is complete). This is a workspace rule ("Review needs a question"), which the human can turn off at /settings/rules.',
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
        recurrence: RECURRENCE_PROP,
        recurrenceMode: RECURRENCE_MODE_PROP,
        goalId: GOAL_ID_PROP,
        milestoneId: MILESTONE_ID_PROP,
        progressPct: PROGRESS_PCT_PROP,
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
        ...(a.recurrence !== undefined ? { recurrence: a.recurrence } : {}),
        ...(a.recurrenceMode !== undefined ? { recurrenceMode: a.recurrenceMode } : {}),
        ...(a.goalId !== undefined ? { goalId: a.goalId } : {}),
        ...(a.milestoneId !== undefined ? { milestoneId: a.milestoneId } : {}),
        ...(a.progressPct !== undefined ? { progressPct: a.progressPct } : {}),
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
      'Source is auto-tagged "agent". Capped by GETSHIT_MAX_UPLOAD_MB (default 25). The result includes `downloadUrl`, ready to GET as-is (presigned on S3 storage, expires in 1h; on local storage it\'s /api/files/<id>, needing `Authorization: Bearer <GETSHIT_TOKEN>`) and it also appears in get_task(taskId).attachments or get_note(noteId).attachments.',
      'Prefer this over base64-in-args for any file beyond a few KB — including local files, esp. video.',
      'The fetch happens on the SERVER, not on your machine. So the URL must be reachable from the server — a URL that works in your own shell proves nothing.',
      'LOCAL FILE (no public URL, e.g. a video on disk): do NOT base64 it. If — and only if — this MCP runs as a LOCAL STDIO server (same machine as you), serve the folder over http (`python3 -m http.server 8000`) and pass `http://localhost:8000/<file>`; the server is your box, so it can fetch your loopback.',
      'Against a HOSTED endpoint (an https:// MCP url, e.g. the Vercel deployment) that localhost recipe CANNOT work — `localhost` resolves to the server, not to you — and neither can `http://<your-public-ip>:<port>` unless inbound to that port is actually open from the public internet, which on a firewalled cloud box it usually is not. From a headless/hosted setup the only reliable paths are: (a) a genuinely public https URL (object store, CDN, a site you deploy), or (b) attach_file with sizeBytes+sha256 for small files.',
      '⚠️ PERSONAL DATA NEVER GOES VIA A PUBLIC URL. The public-object-store route (fal storage and anything like it) mints a URL that is unauthenticated, immutable and cached for 60 days with NO delete path — measured, not assumed. It is the right path for screenshots, renders, probes, decks and marketing PDFs. It is NOT acceptable for an artifact containing a named person\'s details (CVs, contracts, ID documents, customer conversations). For those use create_upload + finalize_upload, which hands you a private presigned URL straight into this store — no public copy is ever made, and it works from a headless box with no size ceiling. Fleet standard set by the workspace owner, 2026-09-04.',
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
      const row = await addAttachmentFromUrl(
        ctx,
        {
          ...(a.taskId ? { taskId: a.taskId } : {}),
          ...(a.noteId ? { brainNoteId: a.noteId } : {}),
        },
        a.url,
        'agent',
      );
      return (await withDownloadUrls([row]))[0];
    },
  },
  {
    name: 'attach_file',
    description: [
      'Attach a file (image, video, PDF, document) to a task or brain note by uploading its bytes directly as base64 — no public URL needed.',
      'Pass exactly one of taskId or noteId, plus filename, mimeType (e.g. "image/png", "video/mp4"), and dataBase64 (base64 of the raw bytes; a full "data:...;base64,..." URL is also accepted).',
      'You MUST pass sizeBytes — the real byte count of the file on disk (`stat -c%s <file>`), not the base64 length — and should pass sha256 (`sha256sum <file>`). The server verifies both and stores nothing on a mismatch. This exists because base64 passed as a tool-call argument can be silently cut in transit, and a truncated base64 string still decodes to a valid, shorter file: without the declared size the server would store that as a real attachment and report success, handing the human a corrupt artifact that looks delivered.',
      'For a LARGE LOCAL file, prefer create_upload + finalize_upload — a private presigned PUT with no size ceiling and no public copy. Use attach_file_from_url when the source genuinely is a public URL. Two independent limits bite here: (1) on a hosted/serverless endpoint the request body is capped by the platform (~4.5MB on Vercel), and (2) regardless of server, the base64 string is passed as a tool argument through the agent, so anything more than a few hundred KB blows the model output/context limit before the server ever sees it — this is the practical ceiling, and it is the agent\'s output budget, not a server setting. For a LOCAL file with no public URL, see attach_file_from_url: the `http://localhost:PORT` recipe works ONLY when this MCP runs as a local stdio server on your own machine.',
      'Source is auto-tagged "agent". The result includes `downloadUrl`, ready to GET as-is (presigned on S3 storage, expires in 1h; on local storage it\'s /api/files/<id>, needing `Authorization: Bearer <GETSHIT_TOKEN>`) and it also appears in get_task(taskId).attachments or get_note(noteId).attachments; the first image (else video) becomes the calendar thumbnail.',
      '⚠️ One case where you must NOT reroute to attach_file_from_url: an artifact containing a named person\'s details (CV, contract, ID document, customer conversation). The public-object-store route that makes attach_file_from_url work from a headless box mints a permanent, unauthenticated URL that cannot be deleted. Use create_upload + finalize_upload for those — a private presigned upload into this same store, no public copy at any point, and no size ceiling. Fleet standard set by the workspace owner, 2026-09-04.',
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
        sizeBytes: {
          type: 'integer',
          description:
            'REQUIRED. Exact size of the file in bytes on your disk (`stat -c%s <file>` / `wc -c`), NOT the length of the base64 string. The server compares this against what actually arrived and hard-errors on a mismatch, so a truncated upload fails loudly instead of storing a corrupt file.',
        },
        sha256: {
          type: 'string',
          description:
            'Optional but recommended: hex sha256 of the file (`sha256sum <file>`). Catches corruption that preserves the byte count, which sizeBytes alone cannot see.',
        },
      },
      required: ['filename', 'mimeType', 'dataBase64', 'sizeBytes'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = attachFileZod.parse(raw);
      const row = await createAttachment(ctx, {
        ...(a.taskId ? { taskId: a.taskId } : {}),
        ...(a.noteId ? { brainNoteId: a.noteId } : {}),
        filename: a.filename,
        mimeType: a.mimeType,
        body: decodeVerified(a.dataBase64, a.sizeBytes, a.sha256),
        source: 'agent',
      });
      return (await withDownloadUrls([row]))[0];
    },
  },
  {
    name: 'create_upload',
    description: [
      'Get a private, short-lived upload URL for a file you hold on YOUR OWN disk. This is the path to use when the file is too big for attach_file and you have no public URL — and it is the REQUIRED path for anything containing a named person\'s details (CV, contract, ID document, customer conversation), because it never publishes the file anywhere.',
      'How it works: you call this, you PUT the bytes straight into the private object store with the command it hands back, then you call finalize_upload. The bytes never pass through this MCP connection (so no context/output limit), never pass through the web server (so no ~4.5MB platform body cap), and never become publicly readable at any point.',
      'Pass exactly one of taskId or noteId, plus filename, mimeType and sizeBytes (`stat -f%z <file>` on macOS, `stat -c%s <file>` on Linux). Both mimeType and sizeBytes are cryptographically bound into the URL: the upload is rejected unless it is exactly that file, so get them right.',
      'Returns {attachmentId, uploadUrl, headers, expiresAt, curl}. `curl` is a ready-to-run command — substitute <path> and run it. The URL expires in 15 minutes and is single-purpose; if it lapses, call this again for a fresh one.',
      'NOTHING IS ATTACHED until you call finalize_upload with the same attachmentId, taskId/noteId, filename, mimeType and sizeBytes. Until then the task shows no attachment.',
      'Not available when the server stores attachments on local disk (a self-hosted default) — it will tell you to use attach_file instead.',
    ].join(' '),
    inputSchemaZod: createUploadZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to attach to (exactly one of taskId/noteId)' },
        noteId: { type: 'string', description: 'Brain note to attach to (exactly one of taskId/noteId)' },
        filename: { type: 'string', description: 'File name, e.g. "candidate-cv.pdf"' },
        mimeType: {
          type: 'string',
          description:
            'MIME type, e.g. "application/pdf". Signed into the upload URL — the PUT must send this exact Content-Type.',
        },
        sizeBytes: {
          type: 'integer',
          description:
            'REQUIRED. Exact size in bytes (`stat -f%z <file>` macOS / `stat -c%s <file>` Linux). Signed into the upload URL, so an upload of any other size is refused by the object store itself.',
        },
      },
      required: ['filename', 'mimeType', 'sizeBytes'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = createUploadZod.parse(raw);
      return createUploadTicket(ctx, {
        ...(a.taskId ? { taskId: a.taskId } : {}),
        ...(a.noteId ? { brainNoteId: a.noteId } : {}),
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      });
    },
  },
  {
    name: 'finalize_upload',
    description: [
      'Second half of create_upload: confirms the bytes landed and creates the attachment. Call it right after your PUT returns success.',
      'Pass the attachmentId from create_upload plus the SAME taskId/noteId, filename, mimeType and sizeBytes you used there — they identify the object, so a mismatch means it cannot be found.',
      'The server checks the stored object against your declared sizeBytes and refuses (and deletes) a truncated or unexpected upload rather than attaching a corrupt file. Pass sha256 (`sha256sum <file>`) if you have it; it is recorded as provenance but not verified, since verifying would mean downloading the file back.',
      'On success the result includes `downloadUrl`, ready to GET as-is (presigned on S3 storage, expires in 1h; on local storage it\'s /api/files/<attachmentId>, needing `Authorization: Bearer <GETSHIT_TOKEN>`) and it also appears in get_task(taskId).attachments. Source is auto-tagged "agent".',
    ].join(' '),
    inputSchemaZod: finalizeUploadZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', description: 'The attachmentId returned by create_upload' },
        taskId: { type: 'string', description: 'Same taskId you passed to create_upload' },
        noteId: { type: 'string', description: 'Same noteId you passed to create_upload' },
        filename: { type: 'string', description: 'Same filename you passed to create_upload' },
        mimeType: { type: 'string', description: 'Same mimeType you passed to create_upload' },
        sizeBytes: {
          type: 'integer',
          description:
            'Same sizeBytes you passed to create_upload. Compared against the object actually stored; a mismatch deletes the upload and errors.',
        },
        sha256: {
          type: 'string',
          description:
            'Optional hex sha256 (`sha256sum <file>`). Recorded as provenance, not verified server-side.',
        },
      },
      required: ['attachmentId', 'filename', 'mimeType', 'sizeBytes'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = finalizeUploadZod.parse(raw);
      const row = await finalizeUpload(ctx, {
        attachmentId: a.attachmentId,
        ...(a.taskId ? { taskId: a.taskId } : {}),
        ...(a.noteId ? { brainNoteId: a.noteId } : {}),
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        ...(a.sha256 ? { sha256: a.sha256 } : {}),
        source: 'agent',
      });
      return (await withDownloadUrls([row]))[0];
    },
  },
  {
    name: 'list_attachments',
    description:
      'List attachments for a task. Each row includes `downloadUrl`, ready to GET as-is — no auth header needed on S3 storage (presigned, expires in 1h); on local storage it\'s /api/files/<id>, which needs `Authorization: Bearer <GETSHIT_TOKEN>`.',
    inputSchemaZod: listAttachmentsZod,
    inputSchemaJson: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listAttachmentsZod.parse(raw);
      return withDownloadUrls(await listAttachments(ctx, a.taskId));
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
      `REQUIRED for agent callers — package the question so it is answerable in ≤2 minutes: \`deck\` (1–12 evidence blocks rendered above the question: text/image/video/pdf/chart), \`recommendation\` (your recommended answer, 1–2 sentences), and \`estSeconds\` (honest estimate, ${MIN_AGENT_EST_SECONDS}–${MAX_AGENT_EST_SECONDS}). An ask that genuinely needs more than ${MAX_AGENT_EST_SECONDS}s must be split into a QUEST: one master task, one child task per sub-decision, one ask_human (with deck) per child — the cards then flow consecutively for the human under the master's banner. Unpackaged or oversized agent asks are rejected with a self-teaching error.`,
      `ADDRESSING: the question goes to the task's OWNER, and a task you created at the top level is owned by YOU — an agent asking on its own root card asks itself, and no human is ever shown it. \`reviewerId\` does not change this. Parent new cards under a task the human owns (\`create_task(..., parentId)\`); the server reroutes to the nearest human owner where it can and refuses the ask outright where it cannot. The result carries \`addressedToUserId\` — check it rather than assuming a returned id means delivered.`,
      'Optionally pass goalTaskId (a task with kind="goal") to link this work to a big goal — the Focus card then shows the goal path. Omit it for small self-contained asks; both are valid.',
      'When asking the human to approve an outgoing message, you MUST also pass `template` so the review renders as a realistic preview: type="email" (Gmail-style draft — to/subject/body required), type="whatsapp" (WhatsApp conversation — contactName/draft required, history optional), type="chat" (live-chat widget — customerName/draft required, history optional), type="tweet" (X/Twitter post card — text required, handle/displayName optional), type="instagram" (Instagram post/reel/story card — media required, caption/handle/format optional). The human approves exactly what is shown, so template content must match what will actually be sent, verbatim.',
      'Side effect: the task is automatically moved to status="review" with the owner as reviewer, so it appears in the human\'s unified "Needs your input" queue (the same bucket as work waiting for approval — one inbox for everything that needs the human).',
      'Returns { id, addressedToUserId } immediately; the answer surfaces on a later get_task call as prompts[].answer once the human responds.',
      'Do NOT poll. Exit your turn and continue work next time you are invoked — the human reading get_task again will show the answer in prompts[].',
      'Asking again on the same task supersedes your own earlier pending questions there — they are cancelled automatically and their ids come back as supersededPromptIds, so a revised question replaces the one it revises instead of stacking up in the human\'s queue. Other askers\' prompts are never touched. Pass keepPrevious=true only when your questions are genuinely parallel and you want them all answered.',
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
        deck: {
          type: 'array',
          description:
            'Evidence blocks rendered above the question, in order — everything the human needs to answer without opening the task. 1–12 blocks. Shapes: {kind:"text", body:"<markdown, RTL ok>"} | {kind:"image", attachmentId? | url?, caption?} | {kind:"video", attachmentId? | url?, poster?} | {kind:"pdf", attachmentId, page?} | {kind:"chart", spec:{type:"bar"|"line", series:[{label,value}], title?, unit?}}. Attach files first (attach_file / attach_file_from_url) and reference them by attachmentId. REQUIRED for agent callers.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['text', 'image', 'video', 'pdf', 'chart'] },
              body: { type: 'string', description: 'text: markdown body (RTL supported)' },
              attachmentId: { type: 'string', description: 'image/video/pdf: attachment id' },
              url: { type: 'string', description: 'image/video: external https URL' },
              caption: { type: 'string', description: 'image: optional caption' },
              poster: { type: 'string', description: 'video: optional poster frame URL' },
              page: { type: 'integer', description: 'pdf: 1-based page to show' },
              spec: {
                type: 'object',
                description: 'chart: small inline spec, rendered without a chart library',
                properties: {
                  type: { type: 'string', enum: ['bar', 'line'] },
                  title: { type: 'string' },
                  unit: { type: 'string' },
                  series: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        value: { type: 'number' },
                      },
                      required: ['label', 'value'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['type', 'series'],
                additionalProperties: false,
              },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        recommendation: {
          type: 'string',
          description:
            'Your recommended answer in one or two sentences, e.g. "Approve — matches the brief; price confirmed on the parent task." Shown as the highlighted default. REQUIRED for agent callers.',
        },
        estSeconds: {
          type: 'integer',
          description: `Honest answer-time estimate in seconds. Agent callers: ${MIN_AGENT_EST_SECONDS}–${MAX_AGENT_EST_SECONDS}; anything bigger must be split into a quest (several small asks on child tasks under one master task). Estimates are calibrated against actual answer times per agent.`,
        },
        goalTaskId: {
          type: 'string',
          description:
            'Optional: id of a task with kind="goal" this work advances. Links the task to the goal so the Focus card shows the goal path. Omit for small self-contained asks.',
        },
        keepPrevious: {
          type: 'boolean',
          description:
            'Keep your earlier pending prompts on this task instead of superseding them. Only for genuinely parallel questions you want answered separately.',
        },
        template: {
          type: 'object',
          description:
            'Realistic review preview. type="email": {to: string[], subject, body, cc?, bcc?, from?} rendered as a Gmail-style draft. type="whatsapp": {contactName, draft, contactPhone?, history?} rendered as a WhatsApp conversation with the draft as the pending outgoing bubble. type="chat": {customerName, draft, channel?, history?} rendered as a live-chat widget with the prior transcript. type="tweet": {text, handle?, displayName?} rendered as an X/Twitter post card. type="instagram": {media: [{attachmentId|url, kind?}], caption?, handle?, format?, location?, firstComment?, altText?} rendered as an Instagram post card (carousel if several media, swipe order = array order) with the caption and a live 2200-char / 30-hashtag count. history items are {from: "us"|"them", text, author?, time?}, oldest first. Use with kind="approval" for send/no-send reviews.',
          properties: {
            type: { type: 'string', enum: ['email', 'whatsapp', 'chat', 'tweet', 'instagram'] },
            from: { type: 'string', description: 'email: sender address/name' },
            to: { type: 'array', items: { type: 'string' }, description: 'email: recipients' },
            cc: { type: 'array', items: { type: 'string' } },
            bcc: { type: 'array', items: { type: 'string' } },
            subject: { type: 'string', description: 'email: subject line' },
            body: { type: 'string', description: 'email: full body, verbatim' },
            contactName: { type: 'string', description: 'whatsapp: contact display name' },
            contactPhone: { type: 'string', description: 'whatsapp: contact phone' },
            customerName: { type: 'string', description: 'chat: customer display name' },
            channel: { type: 'string', description: 'chat: e.g. "Website live chat"' },
            handle: { type: 'string', description: 'tweet/instagram: posting account, e.g. "@verikal"' },
            displayName: { type: 'string', description: 'tweet: account display name' },
            text: { type: 'string', description: 'tweet: the post text awaiting approval, verbatim' },
            format: {
              type: 'string',
              enum: ['post', 'reel', 'story'],
              description: 'instagram: frame ratio of the preview (default "post")',
            },
            media: {
              type: 'array',
              description:
                'instagram: the image(s)/video being posted, in swipe order. REQUIRED for type="instagram" — the visual is the post.',
              items: {
                type: 'object',
                properties: {
                  attachmentId: { type: 'string', description: 'an attachment on this task (preferred)' },
                  url: { type: 'string', description: 'public URL, if not attached to the task' },
                  kind: { type: 'string', enum: ['image', 'video'] },
                },
                additionalProperties: false,
              },
            },
            caption: { type: 'string', description: 'instagram: the caption awaiting approval, verbatim' },
            firstComment: { type: 'string', description: 'instagram: hashtags/mentions posted as the first comment' },
            location: { type: 'string', description: 'instagram: location tag' },
            altText: { type: 'string', description: 'instagram: accessibility alt text for the first slide' },
            history: {
              type: 'array',
              description: 'Prior conversation for context, oldest first',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string', enum: ['us', 'them'] },
                  text: { type: 'string' },
                  author: { type: 'string' },
                  time: { type: 'string' },
                },
                required: ['from', 'text'],
                additionalProperties: false,
              },
            },
            draft: { type: 'string', description: 'whatsapp/chat: the outgoing message awaiting approval, verbatim' },
          },
          required: ['type'],
          additionalProperties: false,
        },
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
        ...(a.template ? { template: a.template } : {}),
        ...(a.deck ? { deck: a.deck } : {}),
        ...(a.recommendation !== undefined ? { recommendation: a.recommendation } : {}),
        ...(a.estSeconds !== undefined ? { estSeconds: a.estSeconds } : {}),
        ...(a.goalTaskId !== undefined ? { goalTaskId: a.goalTaskId } : {}),
        ...(a.keepPrevious !== undefined ? { keepPrevious: a.keepPrevious } : {}),
      });
      return {
        id: prompt.id,
        // Always returned, never inferred. The whole ask_human addressing bug
        // survived for weeks because `{id}` looked identical whether the
        // question reached a human or was filed against an agent — so the
        // recipient is part of the result, and an agent can assert on it
        // instead of calling list_prompts to find out what it just did.
        addressedToUserId: prompt.userId,
        ...(prompt.reroutedFromUserId
          ? {
              reroutedFromUserId: prompt.reroutedFromUserId,
              note:
                'This task is owned by an agent, so the question was addressed to the nearest ' +
                'human owner above it in the tree instead. Nothing is wrong with this ask — but ' +
                'tasks you create at the top level are owned by YOU, and asking on one with no ' +
                'human above it is refused. Parent new cards under a task the human owns.',
            }
          : {}),
        ...(prompt.supersededPromptIds.length > 0
          ? { supersededPromptIds: prompt.supersededPromptIds }
          : {}),
      };
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
      'If scopeTaskId or parentNoteId names a row that EXISTS and is not shared with you, this returns `not_shared` rather than an empty list — an empty list would read as "this scope holds no notes".',
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
      'Returns null if no such note exists. If the note EXISTS but is not shared with you, returns `{ id, error: "not_shared", message }` instead — treat that as "ask for access", never as "it was deleted, recreate it".',
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
      if (!note) {
        // Same reasoning as get_task above: a bare null reads as "deleted", and
        // an agent that believes a note was deleted writes a new one. Only ever
        // computed for an id the caller already holds.
        if ((await noteVisibility(ctx, a.id)) === 'hidden') {
          return {
            id: a.id,
            error: 'not_shared',
            message: NOT_SHARED_NOTE_MESSAGE,
          };
        }
        return null;
      }
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
      'If scopeTaskId names a task that EXISTS and is not shared with you, this returns `not_shared` rather than an empty list — an empty list would read as "nothing in that scope matches".',
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
    name: 'scratchpad_list',
    description: [
      'The human\'s Scratchpad: raw ideas, goals and half-thoughts they typed in one place without deciding where they go. Sweep it and turn each into real work.',
      'Default returns status="new" entries (unfiled), newest first, for every owner you can read — your own, and everyone\'s if you are an admin/coordinator. Pass status="filed"|"dismissed"|"all" to see history.',
      'For each new entry decide what it is, act with the normal tools, then call scratchpad_file(id, taskId): (a) a new piece of work → create_task under the right entity/project (search the tree first — list_tasks/get_task — so it lands in the correct place, never at root unless nothing fits); (b) detail for existing work → post_comment or update_task on that task; (c) a goal/KPI → create_task with kind="goal"/"kpi"; (d) knowledge, not work → create_note in the right scope, then file it under that scope task. If it is noise or already done, scratchpad_dismiss(id, note). If it genuinely needs the human to clarify, leave it new and mention it in your digest — do not guess a project.',
      'Returns { id, body, status, ownerId, ownerName, source, createdAt, filedTaskId, filedTaskTitle, filedByName, filedNote }.',
    ].join(' '),
    inputSchemaZod: scratchListZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['new', 'filed', 'dismissed', 'all'],
          description: 'Default "new" — the unfiled queue',
        },
        scope: {
          type: 'string',
          enum: ['mine', 'all'],
          description: 'Default "all": every owner you can read (admins see everyone). "mine" = only entries you wrote.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = scratchListZod.parse(raw);
      const rows = await listScratchEntries(ctx, {
        scope: a.scope ?? 'all',
        status: a.status ?? 'new',
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      });
      return rows.map((r) => ({
        id: r.id,
        body: r.body,
        status: r.status,
        ownerId: r.userId,
        ownerName: r.ownerName,
        source: r.source,
        createdAt: r.createdAt,
        filedTaskId: r.filedTaskId,
        filedTaskTitle: r.filedTaskTitle,
        filedByName: r.filedByName,
        filedNote: r.filedNote,
      }));
    },
  },
  {
    name: 'scratchpad_add',
    description: [
      'Drop a raw idea into the caller\'s own Scratchpad without deciding where it goes — e.g. the human said something in chat worth keeping but not yet a task. Plain text, one idea per entry.',
      'Do NOT use this for work you already know how to place: create_task under the right parent instead. The scratchpad is for capture, not a second inbox.',
    ].join(' '),
    inputSchemaZod: scratchAddZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 8000, description: 'The idea, as typed' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = scratchAddZod.parse(raw);
      const row = await createScratchEntry(ctx, { body: a.body }, { source: 'agent' });
      return { id: row.id, body: row.body, status: row.status, createdAt: row.createdAt };
    },
  },
  {
    name: 'scratchpad_file',
    description: [
      'Mark a Scratchpad entry as handled: it became `taskId`, or was placed under it (the project/entity/task you filed it into). Call this AFTER create_task / move_task / post_comment / create_note — filing is a pointer, it creates nothing.',
      '`note` is one line the human will read next to the idea, e.g. "Created as a task under Verikal › Website" or "Added as a comment on the pricing task". The entry leaves the new queue and shows in the human\'s Filed list with a link to the task.',
    ].join(' '),
    inputSchemaZod: scratchFileZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Scratchpad entry id from scratchpad_list' },
        taskId: { type: 'string', description: 'The task it became, or the task/project it now lives under' },
        note: { ...STR_OR_NULL, maxLength: 500, description: 'One line: what you did with it' },
      },
      required: ['id', 'taskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = scratchFileZod.parse(raw);
      const row = await fileScratchEntry(ctx, a.id, { taskId: a.taskId, note: a.note ?? null });
      return { id: row.id, status: row.status, filedTaskId: row.filedTaskId, filedNote: row.filedNote };
    },
  },
  {
    name: 'scratchpad_dismiss',
    description: [
      'Mark a Scratchpad entry as looked-at with nothing to file: a duplicate of existing work, already done, or noise. Always pass `note` saying why — the human sees it. Never delete entries; dismissing keeps the record.',
    ].join(' '),
    inputSchemaZod: scratchDismissZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Scratchpad entry id' },
        note: { type: 'string', minLength: 1, maxLength: 500, description: 'Why nothing was filed' },
      },
      required: ['id', 'note'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = scratchDismissZod.parse(raw);
      const row = await dismissScratchEntry(ctx, a.id, { note: a.note });
      return { id: row.id, status: row.status, filedNote: row.filedNote };
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
    name: 'report_shipped',
    description: [
      'Report that something went PUBLIC because of work on this task — a page published, a post live, a campaign launched, an email sent.',
      'Call it at the moment of shipping, with a short human-readable title ("Wholesale shop — product pages published") and the public URL when there is one.',
      'This feeds the human\'s "shipped because of past answers" feed, which is how they see that answering your questions leads somewhere. Cheap to call, high leverage — do not skip it.',
      'Not for internal progress (use post_comment) — only for things that actually shipped.',
    ].join(' '),
    inputSchemaZod: reportShippedZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task the shipped thing belongs to' },
        title: { type: 'string', description: 'Short feed line, e.g. "Verikal — digital-twin thread posted"' },
        url: { type: 'string', description: 'Public URL of the shipped thing, if any' },
      },
      required: ['taskId', 'title'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = reportShippedZod.parse(raw);
      const event = await reportShipped(ctx, {
        taskId: a.taskId,
        title: a.title,
        ...(a.url ? { url: a.url } : {}),
      });
      return { id: event.id };
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
  {
    name: 'create_agent',
    adminOnly: true,
    description: [
      'ADMIN ONLY. Create a new agent user (kind="agent") — an automated identity an MCP/CLI client authenticates as.',
      'The agent starts with access to nothing; share entities/tasks to it (share_task) and mint it a token (mint_agent_token), or use provision_agent to do all three at once.',
      'Returns { id, name, kind, endpoint }.',
    ].join(' '),
    inputSchemaZod: createAgentZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name, e.g. "kitkoo-outreach"' },
        endpoint: { type: 'string', description: 'Optional chat webhook URL for the agent' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      await assertAdmin(ctx);
      const a = createAgentZod.parse(raw);
      const u = await createUser({
        kind: 'agent',
        name: a.name,
        ...(a.endpoint ? { endpoint: a.endpoint } : {}),
      });
      return { id: u.id, name: u.name, kind: u.kind, endpoint: u.endpoint };
    },
  },
  {
    name: 'share_task',
    adminOnly: true,
    description: [
      'ADMIN ONLY. Share a task (or entity/project) with a user by `userId` or `email` — pass exactly one.',
      'Sharing cascades to the whole subtree; the recipient can read and edit everything under it. Idempotent. You must own the task.',
      'Returns { taskId, userId, createdAt }.',
    ].join(' '),
    inputSchemaZod: shareTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task/entity id to share' },
        userId: { type: 'string', description: 'Recipient user id (exactly one of userId/email)' },
        email: { type: 'string', description: 'Recipient email (exactly one of userId/email)' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      await assertAdmin(ctx);
      const a = shareTaskZod.parse(raw);
      const entry = a.userId
        ? await shareTaskWithUserId(ctx, a.taskId, a.userId)
        : await shareTaskWithEmail(ctx, a.taskId, a.email as string);
      return { taskId: entry.taskId, userId: entry.user.id, createdAt: entry.createdAt };
    },
  },
  {
    name: 'mint_agent_token',
    adminOnly: true,
    description: [
      'ADMIN ONLY. Mint a gs_ bearer token for an agent user. The raw token is shown ONCE and is not recoverable — hand it to the agent\'s MCP/CLI config as GETSHIT_TOKEN or an Authorization: Bearer header.',
      'Only agent users can hold tokens. Returns { agentId, token }.',
    ].join(' '),
    inputSchemaZod: mintAgentTokenZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent user id' },
        label: { type: 'string', description: 'Optional label to identify this token later' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      await assertAdmin(ctx);
      const a = mintAgentTokenZod.parse(raw);
      const { token } = await createAgentCliToken(a.agentId, a.label ?? null);
      return { agentId: a.agentId, token };
    },
  },
  {
    name: 'provision_agent',
    adminOnly: true,
    description: [
      'ADMIN ONLY. One-shot agent provisioning: create an agent user, share a task/entity to it, and mint its gs_ token — the whole "new brand agent" flow in one call.',
      'The token is shown ONCE. Returns { agentId, name, sharedTaskId, token }.',
    ].join(' '),
    inputSchemaZod: provisionAgentZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent display name, e.g. "kitkoo-outreach"' },
        shareTaskId: { type: 'string', description: 'Entity/task id to share with the new agent' },
        endpoint: { type: 'string', description: 'Optional chat webhook URL' },
        label: { type: 'string', description: 'Optional token label' },
      },
      required: ['name', 'shareTaskId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      await assertAdmin(ctx);
      const a = provisionAgentZod.parse(raw);
      const agent = await createUser({
        kind: 'agent',
        name: a.name,
        ...(a.endpoint ? { endpoint: a.endpoint } : {}),
      });
      await shareTaskWithUserId(ctx, a.shareTaskId, agent.id);
      const { token } = await createAgentCliToken(agent.id, a.label ?? `${a.name} token`);
      return { agentId: agent.id, name: agent.name, sharedTaskId: a.shareTaskId, token };
    },
  },
  {
    name: 'agent_activity',
    adminOnly: true,
    description: [
      'ADMIN ONLY. Operator dashboard for agent productivity, scoped to the tasks you can see. Mirrors the web Activity → Agents view.',
      'Returns { overall, agents[], generatedAt }. `overall` = counts of visible non-archived tasks by status. Each agents[] row = { id, name, today, yesterday, last7d, open, doing, review, waiting }.',
      'today/yesterday/last7d = actions (agent comments + tasks the agent completed) in that window, in Israel time. open/doing/review = tasks currently assigned to the agent. waiting = pending prompts the agent raised (blocked on a human answer).',
    ].join(' '),
    inputSchemaZod: z.object({}),
    inputSchemaJson: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (ctx) => {
      await assertAdmin(ctx);
      return getAgentActivity(ctx);
    },
  },
  {
    name: 'office_pulse',
    adminOnly: true,
    description: [
      'ADMIN ONLY. The ventures floor in one call — health ladder (live/warn/crit/parked) per venture, motion sparkline, staffed-vs-gap lane counts, plus the Saturation Law gauge. Mirrors GET /api/office/pulse.',
      'Replaces walking every venture with list_tasks by hand. Returns { ventures[], reviewQueueHours, reviewQueue, generatedAt }.',
      'Read reviewQueue, not reviewQueueHours alone: hours is answer TIME and says nothing about wait time, so it can read ~0.1h (idle) while reviewQueue.oldestAgeHours shows a decision that has blocked a lane for a day. reviewQueue.imputed is how many of reviewQueue.items had no estimate and were defaulted — when it approaches items, hours is a guess. reviewQueue.seen is how many pending asks the human has actually been shown (items - seen is the unseen backlog), and oldestSeenAgeHours ages from that first render rather than from creation: an unseen ask is waiting on delivery and a nudge may help, while a seen one was read and put down, so re-raising it changes nothing and the CARD is what needs fixing.',
    ].join(' '),
    inputSchemaZod: z.object({}),
    inputSchemaJson: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (ctx) => {
      await assertAdmin(ctx);
      const [ventures, reviewQueue] = await Promise.all([getVenturePulse(ctx), getReviewQueueLoad()]);
      return { ventures, reviewQueueHours: reviewQueue.hours, reviewQueue, generatedAt: Date.now() };
    },
  },
  {
    name: 'office_venture',
    adminOnly: true,
    description: [
      'ADMIN ONLY. Drill-down for one venture flagged warn/crit by office_pulse: KPIs/goal progress, lane-by-lane status (run/idle/stuck/off with why), pending-decision gate count. Mirrors GET /api/office/venture/:entityId.',
      'Pass the entityId from an office_pulse row. Returns null if the id is not a chartered venture.',
    ].join(' '),
    inputSchemaZod: officeVentureZod,
    inputSchemaJson: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Venture entity task id, from office_pulse' },
      },
      required: ['entityId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      await assertAdmin(ctx);
      const a = officeVentureZod.parse(raw);
      const room = await getVentureRoom(ctx, a.entityId);
      return room;
    },
  },
];

/**
 * Look up a tool by name. Returns null if unknown.
 */
export function findTool(name: string): ToolDef | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/**
 * Reduce a tool's input Zod schema to its object *shape* (the map of field name
 * → Zod type) for transports that advertise a raw shape (the stdio MCP SDK).
 *
 * `.refine()` wraps a ZodObject in a ZodEffects — and `.default()`/`.optional()`
 * wrap it too — so a naive `.shape` access returns undefined and the tool ends
 * up advertising an EMPTY schema, which makes clients silently drop every
 * argument (the bug that broke attach_file / attach_file_from_url / get_user).
 * Peel the known wrappers until we reach the ZodObject; return {} if there is
 * none. Cross-field refinements are preserved regardless because handlers
 * re-parse with the full schema at call time.
 */
export function zodInputShape(schema: unknown): Record<string, unknown> {
  let cur = schema as {
    _def?: { typeName?: string; schema?: unknown; innerType?: unknown };
    shape?: Record<string, unknown>;
  };
  for (let i = 0; i < 10 && cur?._def; i++) {
    const tn = cur._def.typeName;
    if (tn === 'ZodObject') return cur.shape ?? {};
    if (tn === 'ZodEffects') {
      cur = cur._def.schema as typeof cur;
    } else if (tn === 'ZodDefault' || tn === 'ZodOptional' || tn === 'ZodNullable') {
      cur = cur._def.innerType as typeof cur;
    } else {
      break;
    }
  }
  return {};
}

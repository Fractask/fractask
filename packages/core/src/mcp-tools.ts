import { z } from 'zod';
import type { Context } from './context.js';
import { createTask, deleteTask, getTask, listTasks, moveTask, updateTask } from './tasks.js';

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

const taskStatusEnum = ['open', 'doing', 'review', 'done', 'archived', 'snoozed'] as const;
const taskKindEnum = ['entity', 'project', 'task', 'goal', 'kpi'] as const;

const listTasksZod = z.object({
  parentId: z.union([z.string(), z.null()]).optional(),
  status: z.enum(taskStatusEnum).optional(),
  kind: z.enum(taskKindEnum).optional(),
  assigneeId: z.union([z.string(), z.null()]).optional(),
  reviewerId: z.union([z.string(), z.null()]).optional(),
});

const getTaskZod = z.object({ id: z.string() });

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

const STATUS_PROP = { type: 'string' as const, enum: [...taskStatusEnum] };
const KIND_PROP = { type: 'string' as const, enum: [...taskKindEnum] };
const STR_OR_NULL = { type: ['string', 'null'] as const };

export const TOOLS: ToolDef[] = [
  {
    name: 'list_tasks',
    description: [
      'List tasks for the current user.',
      'Use parentId="root" or null/omit to list top-level tasks. Pass an id to list direct children of that task.',
      'Status: "open" | "doing" | "review" (waiting for approval) | "done" | "archived" | "snoozed".',
      'Optional kind filter: "entity" (top-level company/area), "project" (a project under an entity), "task" (a to-do).',
      'Optional assigneeId / reviewerId filters: assignee is the doer; reviewer is who must approve when status="review".',
      'Returns an array of Task rows ordered by sibling position.',
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
      },
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = listTasksZod.parse(raw);
      const resolvedParent = a.parentId === undefined || a.parentId === 'root' ? null : a.parentId;
      return listTasks(ctx, {
        parentId: resolvedParent,
        ...(a.status ? { status: a.status } : {}),
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.assigneeId !== undefined ? { assigneeId: a.assigneeId } : {}),
        ...(a.reviewerId !== undefined ? { reviewerId: a.reviewerId } : {}),
      });
    },
  },
  {
    name: 'get_task',
    description: 'Fetch a single task by id, including its direct children. Returns null if not found.',
    inputSchemaZod: getTaskZod,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const a = getTaskZod.parse(raw);
      return getTask(ctx, a.id);
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

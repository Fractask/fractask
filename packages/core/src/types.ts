import { z } from 'zod';
import { isValidRecurrence } from './recurrence.js';

export const taskStatusSchema = z.enum([
  'open',
  'doing',
  'review',
  'done',
  'backlog',
  'snoozed',
  'archived',
]);
export const userKindSchema = z.enum(['human', 'agent', 'guest']);
export const taskSourceSchema = z.enum(['human', 'agent']);
export const taskKindSchema = z.enum(['entity', 'project', 'task', 'goal', 'kpi']);
export const assigneeKindSchema = z.enum(['person', 'agent']);

export const idSchema = z.string().min(1).max(64);

/**
 * Recurrence rule. Accepts intervals (`<n>m|h|d|w|mo`, e.g. `4h`, `1d`, `1w`,
 * `1mo`) and weekday rules (`weekdays`, or a list like `mon,wed,fri`). `null`
 * means non-recurring. See recurrence.ts for parsing / next-occurrence logic.
 */
export const recurrenceSchema = z
  .string()
  .max(30)
  .refine(isValidRecurrence, 'Invalid recurrence (e.g. 1d, 1w, weekdays, mon,wed,fri)');

export const createTaskInputSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  rules: z.string().max(50_000).optional(),
  parentId: idSchema.nullable().optional(),
  status: taskStatusSchema.optional(),
  kind: taskKindSchema.optional(),
  source: taskSourceSchema.optional(),
  position: z.number().int().nonnegative().optional(),
  dueAt: z.number().int().nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
  reviewerId: idSchema.nullable().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  recurrenceMode: z.enum(['checkbox', 'deliverable']).optional(),
  goalId: idSchema.nullable().optional(),
  milestoneId: idSchema.nullable().optional(),
  progressPct: z.number().int().min(0).max(100).nullable().optional(),
  tagIds: z.array(idSchema).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(50_000).nullable(),
    rules: z.string().max(50_000).nullable(),
    status: taskStatusSchema,
    kind: taskKindSchema,
    dueAt: z.number().int().nullable(),
    assigneeId: idSchema.nullable(),
    reviewerId: idSchema.nullable(),
    recurrence: recurrenceSchema.nullable(),
    recurrenceMode: z.enum(['checkbox', 'deliverable']),
    goalId: idSchema.nullable(),
    milestoneId: idSchema.nullable(),
    progressPct: z.number().int().min(0).max(100).nullable(),
  })
  .partial();
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const listTasksFilterSchema = z
  .object({
    parentId: idSchema.nullable().optional(),
    status: taskStatusSchema.optional(),
    excludeStatuses: z.array(taskStatusSchema).optional(),
    kind: taskKindSchema.optional(),
    dueBefore: z.number().int().optional(),
    assigneeId: idSchema.nullable().optional(),
    reviewerId: idSchema.nullable().optional(),
    tagId: idSchema.optional(),
    /**
     * Search the whole accessible tree instead of one level. Ignored when
     * `parentId` names a specific parent — that stays an explicit
     * direct-children query. Use with `parentId: null` (or omitted) to turn
     * "roots of my view" into "every task I can reach, at any depth".
     */
    deep: z.boolean().optional(),
  })
  .default({});
export type ListTasksFilter = z.infer<typeof listTasksFilterSchema>;

export const createAssigneeInputSchema = z.object({
  name: z.string().min(1).max(100),
  kind: assigneeKindSchema,
  color: z.string().max(20).nullable().optional(),
});
export type CreateAssigneeInput = z.infer<typeof createAssigneeInputSchema>;

export const updateAssigneeInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    kind: assigneeKindSchema,
    color: z.string().max(20).nullable(),
  })
  .partial();
export type UpdateAssigneeInput = z.infer<typeof updateAssigneeInputSchema>;

export const createTagInputSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(20).nullable().optional(),
});
export type CreateTagInput = z.infer<typeof createTagInputSchema>;

export const updateTagInputSchema = z
  .object({
    name: z.string().min(1).max(60),
    color: z.string().max(20).nullable(),
  })
  .partial();
export type UpdateTagInput = z.infer<typeof updateTagInputSchema>;

// Tiptap content is stored opaquely (JSON.stringified on write, parsed by the
// editor on read), so we accept any value here. Concrete shape validation
// would conflict with Tiptap v3's getJSON, which can include function getters
// on attrs in some serialization paths. The server-side `deriveContent` runs
// a JSON round-trip to strip any non-plain values before persistence.
export const tiptapDocSchema: z.ZodTypeAny = z.unknown();

export const createBrainNoteInputSchema = z.object({
  title: z.string().min(1).max(500),
  icon: z.string().max(16).nullable().optional(),
  scopeTaskId: idSchema.nullable().optional(),
  parentNoteId: idSchema.nullable().optional(),
  contentJson: tiptapDocSchema.optional(),
  contentText: z.string().max(200_000).optional(),
  source: z.enum(['human', 'agent']).optional(),
});
export type CreateBrainNoteInput = z.infer<typeof createBrainNoteInputSchema>;

export const updateBrainNoteInputSchema = z
  .object({
    title: z.string().min(1).max(500),
    icon: z.string().max(16).nullable(),
    scopeTaskId: idSchema.nullable(),
    parentNoteId: idSchema.nullable(),
    contentJson: tiptapDocSchema,
    contentText: z.string().max(200_000),
  })
  .partial();
export type UpdateBrainNoteInput = z.infer<typeof updateBrainNoteInputSchema>;

export const listBrainNotesFilterSchema = z
  .object({
    scopeTaskId: idSchema.nullable().optional(),
    parentNoteId: idSchema.nullable().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .default({});
export type ListBrainNotesFilter = z.infer<typeof listBrainNotesFilterSchema>;

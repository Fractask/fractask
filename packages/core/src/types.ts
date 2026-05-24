import { z } from 'zod';

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
 * Recurrence rule. Accepts: `<n>m`, `<n>h`, `<n>d`, `<n>w`, `<n>mo`.
 * Examples: `4h` (every 4 hours), `1d` (daily), `1w` (weekly), `1mo` (monthly).
 * `null` means non-recurring.
 */
export const recurrenceSchema = z
  .string()
  .regex(/^[1-9][0-9]*(m|h|d|w|mo)$/, 'Invalid recurrence (e.g. 4h, 1d, 1w, 1mo)')
  .max(20);

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

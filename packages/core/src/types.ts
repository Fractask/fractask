import { z } from 'zod';

export const taskStatusSchema = z.enum(['open', 'doing', 'review', 'done', 'archived', 'snoozed']);
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

export const createContextDocInputSchema = z.object({
  taskId: idSchema,
  title: z.string().min(1).max(200),
  content: z.string().max(200_000),
});
export type CreateContextDocInput = z.infer<typeof createContextDocInputSchema>;

export const updateContextDocInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    content: z.string().max(200_000),
  })
  .partial();
export type UpdateContextDocInput = z.infer<typeof updateContextDocInputSchema>;

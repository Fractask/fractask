import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  name: text('name'),
  googleId: text('google_id').unique(),
  image: text('image'),
  kind: text('kind', { enum: ['human', 'agent', 'guest'] })
    .notNull()
    .default('human'),
  /** Webhook URL for agent chat — only meaningful when kind='agent'. */
  endpoint: text('endpoint'),
  createdAt: integer('created_at').notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: ['open', 'doing', 'review', 'done', 'archived', 'snoozed'] })
      .notNull()
      .default('open'),
    kind: text('kind', { enum: ['entity', 'project', 'task', 'goal', 'kpi'] })
      .notNull()
      .default('task'),
    rules: text('rules'),
    parentId: text('parent_id'),
    position: integer('position').notNull().default(0),
    source: text('source', { enum: ['human', 'agent'] })
      .notNull()
      .default('human'),
    dueAt: integer('due_at'),
    assigneeId: text('assignee_id'),
    reviewerId: text('reviewer_id'),
    recurrence: text('recurrence'),
    priority: integer('priority'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => ({
    userParent: index('idx_tasks_user_parent').on(t.userId, t.parentId),
    userStatus: index('idx_tasks_user_status').on(t.userId, t.status),
    userKind: index('idx_tasks_user_kind').on(t.userId, t.kind),
    userDue: index('idx_tasks_user_due').on(t.userId, t.dueAt),
    userAssignee: index('idx_tasks_user_assignee').on(t.userId, t.assigneeId),
    userReviewer: index('idx_tasks_user_reviewer').on(t.userId, t.reviewerId),
  }),
);

export const contextDocs = sqliteTable(
  'context_docs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    taskId: text('task_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    userTask: index('idx_context_docs_user_task').on(t.userId, t.taskId),
  }),
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userName: index('idx_tags_user_name').on(t.userId, t.name),
  }),
);

export const taskTags = sqliteTable(
  'task_tags',
  {
    userId: text('user_id').notNull(),
    taskId: text('task_id').notNull(),
    tagId: text('tag_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.tagId] }),
    userTask: index('idx_task_tags_user_task').on(t.userId, t.taskId),
    userTag: index('idx_task_tags_user_tag').on(t.userId, t.tagId),
  }),
);

export const taskShares = sqliteTable(
  'task_shares',
  {
    taskId: text('task_id').notNull(),
    userId: text('user_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.userId] }),
    userTask: index('idx_task_shares_user_task').on(t.userId, t.taskId),
  }),
);

/**
 * Generic key/value bag scoped either to a user (`scope = userId`) or to the
 * whole instance (`scope = 'global'`). First use: `task_guidelines` — markdown
 * shown to MCP clients as additional instructions when creating tasks.
 */
export const settings = sqliteTable(
  'settings',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.key] }),
    scopeIdx: index('idx_settings_scope').on(t.scope),
  }),
);

export const cliTokens = sqliteTable(
  'cli_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label'),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userIdx: index('idx_cli_tokens_user').on(t.userId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type ContextDoc = typeof contextDocs.$inferSelect;
export type NewContextDoc = typeof contextDocs.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type TaskTag = typeof taskTags.$inferSelect;
export type TaskStatus = Task['status'];
export type TaskSource = Task['source'];
export type TaskKind = Task['kind'];
export type TaskShare = typeof taskShares.$inferSelect;
export type NewTaskShare = typeof taskShares.$inferInsert;
export type CliToken = typeof cliTokens.$inferSelect;
export type NewCliToken = typeof cliTokens.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

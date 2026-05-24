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
    status: text('status', {
      enum: ['open', 'doing', 'review', 'done', 'backlog', 'snoozed', 'archived'],
    })
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

/**
 * Brain notes — the persistent, Notion-like knowledge base.
 * A note is owned by a user, optionally scoped to a parent task (entity or
 * project — null = personal/global), and hierarchical via parentNoteId.
 * Content is stored as Tiptap JSON (canonical) plus a derived plain-text
 * mirror for search and MCP payloads.
 *
 * ACL: notes with a scopeTaskId inherit access from that task's task_shares
 * subtree closure; personal notes (scopeTaskId null) are owner-only.
 */
export const brainNotes = sqliteTable(
  'brain_notes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    scopeTaskId: text('scope_task_id'),
    parentNoteId: text('parent_note_id'),
    title: text('title').notNull(),
    icon: text('icon'),
    contentJson: text('content_json').notNull().default('{"type":"doc","content":[]}'),
    contentText: text('content_text').notNull().default(''),
    position: integer('position').notNull().default(0),
    source: text('source', { enum: ['human', 'agent'] })
      .notNull()
      .default('human'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    userParent: index('idx_brain_notes_user_parent').on(t.userId, t.parentNoteId),
    userScope: index('idx_brain_notes_user_scope').on(t.userId, t.scopeTaskId),
    scopeParent: index('idx_brain_notes_scope_parent').on(t.scopeTaskId, t.parentNoteId),
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

/**
 * Binary/file artifacts attached to a task. Storage is pluggable: rows hold
 * adapter id (`local` | `s3`) + opaque `storageKey`, so we can move adapters
 * without rewriting metadata. Phase 2 reserves `extracted_text` /
 * `extracted_at` columns for LLM-ready text extraction.
 */
export const taskAttachments = sqliteTable(
  'task_attachments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    // Exactly one of taskId / brainNoteId is set. Polymorphic owner so the same
    // storage/listing/download path serves both tasks and brain notes without
    // duplicating the adapter abstraction. App-level invariant — no DB CHECK.
    taskId: text('task_id'),
    brainNoteId: text('brain_note_id'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storage: text('storage', { enum: ['local', 's3'] }).notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256'),
    source: text('source', { enum: ['human', 'agent'] })
      .notNull()
      .default('human'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userTask: index('idx_task_attachments_user_task').on(t.userId, t.taskId),
    userNote: index('idx_task_attachments_user_note').on(t.userId, t.brainNoteId),
  }),
);

/**
 * Structured human-in-the-loop prompt posted by an agent (or human) against
 * a task. Lives in its own table because the lifecycle (pending → answered)
 * differs from a task's, and so a task can have multiple concurrent prompts.
 *
 * `options` and `answer` are JSON text — schemas live in `prompts.ts`.
 * `kind` decides which shape both fields must obey.
 */
export const agentPrompts = sqliteTable(
  'agent_prompts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    userId: text('user_id').notNull(),
    askedByUserId: text('asked_by_user_id').notNull(),
    kind: text('kind', { enum: ['text', 'choice', 'approval', 'pick_image'] }).notNull(),
    prompt: text('prompt').notNull(),
    options: text('options'),
    multiple: integer('multiple').notNull().default(0),
    status: text('status', { enum: ['pending', 'answered', 'cancelled'] })
      .notNull()
      .default('pending'),
    answer: text('answer'),
    answeredByUserId: text('answered_by_user_id'),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (t) => ({
    userStatus: index('idx_agent_prompts_user_status').on(t.userId, t.status),
    taskStatus: index('idx_agent_prompts_task_status').on(t.taskId, t.status),
  }),
);

/**
 * Free-form ordered conversation thread on a task. Humans and agents post into
 * the same linear stream, displayed chronologically. Used for status notes,
 * non-blocking questions, and review feedback. Blocking decisions still go
 * through `agentPrompts` (ask_human) so they show up in the review queue.
 */
export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    taskId: text('task_id').notNull(),
    authorUserId: text('author_user_id').notNull(),
    body: text('body').notNull(),
    source: text('source', { enum: ['human', 'agent'] })
      .notNull()
      .default('human'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    taskCreated: index('idx_task_comments_task_created').on(t.taskId, t.createdAt),
    userTask: index('idx_task_comments_user_task').on(t.userId, t.taskId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type BrainNote = typeof brainNotes.$inferSelect;
export type NewBrainNote = typeof brainNotes.$inferInsert;
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
export type TaskAttachment = typeof taskAttachments.$inferSelect;
export type NewTaskAttachment = typeof taskAttachments.$inferInsert;
export type AgentPromptRow = typeof agentPrompts.$inferSelect;
export type NewAgentPromptRow = typeof agentPrompts.$inferInsert;
export type AgentPromptKind = AgentPromptRow['kind'];
export type AgentPromptStatus = AgentPromptRow['status'];
export type AttachmentStorage = TaskAttachment['storage'];
export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
export type TaskCommentSource = TaskComment['source'];

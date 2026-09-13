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
  /**
   * Workspace admin. Admins see the Users settings view (the roster of every
   * user, agent, and agent token) and can provision agents over MCP. Everyone
   * else — including agents and guest collaborators — is scoped to their own
   * shared trees and never sees the roster.
   */
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
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
    /**
     * Focus Mode goal link. Points at a task with kind='goal' whose direct
     * children are the goal's path nodes. A task nested inside a goal's
     * subtree inherits the link implicitly — goalId is for cross-tree work.
     * Null outside any goal subtree = a "specific" (self-contained) task,
     * which is a valid state, not an error.
     */
    goalId: text('goal_id'),
    /** Optional refinement of goalId: which direct child (path node) of the goal this task advances. */
    milestoneId: text('milestone_id'),
    /**
     * Manual completion estimate, 0-100. Only meaningful on kind='goal' tasks
     * without milestones to derive progress from — when a goal HAS direct
     * children, computed done/total progress always wins over this. Agents
     * update it over MCP the same way they update any other task field.
     */
    progressPct: integer('progress_pct'),
    /**
     * How a recurring task behaves. `checkbox` (default) rolls dueAt forward on
     * completion and logs to task_completions. `deliverable` is a template: a
     * cron spawns one child instance per due day, each with its own
     * open→review→done lifecycle. Only meaningful when `recurrence` is set.
     */
    recurrenceMode: text('recurrence_mode', { enum: ['checkbox', 'deliverable'] })
      .notNull()
      .default('checkbox'),
    /**
     * On a spawned deliverable instance: the day (start-of-day ms) it is for.
     * Null on non-instances. Used to dedupe cron spawns and drive archival.
     */
    occurrenceDate: integer('occurrence_date'),
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
    // Bare-column indexes: the access CTE roots on `assignee_id = ?` /
    // `reviewer_id = ?` with no user_id predicate, so the composites above
    // (which lead with user_id) can't serve it.
    assignee: index('idx_tasks_assignee').on(t.assigneeId),
    reviewer: index('idx_tasks_reviewer').on(t.reviewerId),
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

/**
 * Completion log for `checkbox`-mode recurring tasks. Each time such a task is
 * ticked done it rolls forward (clearing completedAt), so the task row keeps no
 * history — this table is that history. One row per occurrence completed.
 */
export const taskCompletions = sqliteTable(
  'task_completions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    userId: text('user_id').notNull(),
    completedByUserId: text('completed_by_user_id').notNull(),
    /** The dueAt/occurrence that was satisfied (may differ from completedAt). */
    occurrenceAt: integer('occurrence_at'),
    completedAt: integer('completed_at').notNull(),
    source: text('source', { enum: ['human', 'agent'] }).notNull().default('human'),
  },
  (t) => ({
    taskCompleted: index('idx_task_completions_task_completed').on(t.taskId, t.completedAt),
    byCompleted: index('idx_task_completions_by_completed').on(t.completedByUserId, t.completedAt),
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
 * `options`, `answer` and `template` are JSON text — schemas live in
 * `prompts.ts`. `kind` decides which shape `options`/`answer` must obey;
 * `template` is an optional realistic preview (email draft, WhatsApp
 * conversation, live-chat transcript) rendered to the human in review.
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
    template: text('template'),
    /**
     * Focus Mode deck — JSON array of evidence blocks (text / image / video /
     * pdf / chart) rendered above the question so the human can answer without
     * reconstructing context. Schema in `prompts.ts` (deckBlockSchema).
     * Required for agent askers when the `prompt_requires_deck` rule is on;
     * legacy/human prompts leave it null and render as plain cards.
     */
    deck: text('deck'),
    /** The asker's recommended answer, one or two sentences. Paired with deck. */
    recommendation: text('recommendation'),
    /** Honest answer-time estimate in seconds. Agents are capped at 120 (§ quests). */
    estSeconds: integer('est_seconds'),
    /** First render in Focus Mode — start of the answer timer. */
    openedAt: integer('opened_at'),
    /** How the prompt left the queue: a real answer, a send-back, or "not relevant". */
    answerKind: text('answer_kind', { enum: ['answered', 'sent_back', 'not_relevant'] }),
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
 * Office org-chart profile — one row per agent user. The 3D Office renders
 * entirely from these rows joined onto live task/prompt/comment data; adding
 * an agent to the floor = adding a profiles row, nothing else. `reportsTo`
 * NULL means the agent reports straight to the human (that row is the
 * chief-of-staff / manager card on the floor); everyone else defaults to the
 * manager.
 */
export const agentProfiles = sqliteTable(
  'agent_profiles',
  {
    userId: text('user_id').primaryKey(),
    /** Department plate the agent's card hangs under, e.g. "VERIKAL". */
    groupName: text('group_name').notNull(),
    /** Short role line shown under the name, e.g. "Paid acquisition". */
    roleLine: text('role_line').notNull(),
    /** Manager user id; NULL = reports directly to the human (the manager row itself). */
    reportsTo: text('reports_to'),
    /** The agent's charter task — standups are comments on it; presence keys off this. */
    charterTaskId: text('charter_task_id'),
    /** Sub-agents living in the same box (×N badge). 0 = solo. */
    subAgents: integer('sub_agents').notNull().default(0),
    /** Hostname of the agent's box (phase D console streaming). */
    box: text('box'),
    /** JSON array of task ids whose brain-note scopes hold this agent's knowledge. */
    brainScopeTaskIds: text('brain_scope_task_ids'),
    /** Global ordering: groups sort by their minimum, agents within a group by value. */
    sort: integer('sort').notNull().default(0),
  },
  (t) => ({
    groupSort: index('idx_agent_profiles_group_sort').on(t.groupName, t.sort),
  }),
);

/**
 * Focus Mode event log — the single source for quota, streaks, pace, drift
 * stats, estimate calibration, and the ship feed. One row per thing that
 * happened in (or because of) a Focus session: a card opened/answered/skipped,
 * a do-card started/checked-in/drifted/ended, an agent reporting something
 * shipped. `userId` is the human whose session it was (quota is personal);
 * `seconds` is actual time on the card/task where that makes sense.
 */
export const focusEvents = sqliteTable(
  'focus_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    taskId: text('task_id'),
    promptId: text('prompt_id'),
    type: text('type', {
      enum: [
        'opened',
        'answered',
        'sent_back',
        'not_relevant',
        'skipped',
        'snoozed',
        'do_started',
        'checkin_ok',
        'drift',
        'do_ended',
        'shipped',
      ],
    }).notNull(),
    /** Actual time on the card / task, in seconds. Null when not applicable. */
    seconds: integer('seconds'),
    /** JSON side-channel: {url,title} for shipped, {estSeconds} snapshots, etc. */
    meta: text('meta'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userCreated: index('idx_focus_events_user_created').on(t.userId, t.createdAt),
    taskCreated: index('idx_focus_events_task_created').on(t.taskId, t.createdAt),
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

/**
 * Scratchpad — the one place a human dumps raw ideas, goals, and half-thoughts
 * without deciding where they go. Each entry is a short free-text blob that
 * autosaves from the web UI. Agents (the coordinator, Jibin, or any admin)
 * sweep `status='new'` entries over MCP and either turn them into tasks under
 * the right project / entity or park them, then mark the entry `filed` with a
 * pointer to the task they created or placed it under. `dismissed` = looked at,
 * nothing to do.
 *
 * ACL: an entry is readable/writable by its owner; workspace admins (the
 * coordinator scope, same as tasks) read and file everyone's. There is no
 * sharing table — the scratchpad is deliberately personal.
 */
export const scratchEntries = sqliteTable(
  'scratch_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    body: text('body').notNull().default(''),
    status: text('status', { enum: ['new', 'filed', 'dismissed'] })
      .notNull()
      .default('new'),
    /** Task this idea became, or was placed under. Set when status='filed'. */
    filedTaskId: text('filed_task_id'),
    /** Who filed/dismissed it (usually an agent). */
    filedBy: text('filed_by'),
    /** One line from the filer: what they did with it. */
    filedNote: text('filed_note'),
    filedAt: integer('filed_at'),
    source: text('source', { enum: ['human', 'agent'] })
      .notNull()
      .default('human'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    userStatus: index('idx_scratch_user_status').on(t.userId, t.status),
    statusCreated: index('idx_scratch_status_created').on(t.status, t.createdAt),
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
export type ScratchEntry = typeof scratchEntries.$inferSelect;
export type NewScratchEntry = typeof scratchEntries.$inferInsert;
export type ScratchStatus = ScratchEntry['status'];
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
export type PromptAnswerKind = NonNullable<AgentPromptRow['answerKind']>;
export type FocusEventRow = typeof focusEvents.$inferSelect;
export type NewFocusEventRow = typeof focusEvents.$inferInsert;
export type FocusEventType = FocusEventRow['type'];
export type AgentProfile = typeof agentProfiles.$inferSelect;
export type NewAgentProfile = typeof agentProfiles.$inferInsert;
export type AttachmentStorage = TaskAttachment['storage'];
export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
export type TaskCommentSource = TaskComment['source'];
export type TaskCompletion = typeof taskCompletions.$inferSelect;
export type NewTaskCompletion = typeof taskCompletions.$inferInsert;
export type RecurrenceMode = Task['recurrenceMode'];

/* ---------- Billing (the simple frontend's pay-per-token wallet) ---------- */

/**
 * One wallet per human user. Balance is in cents; it goes up on a Stripe
 * payment (or a starter grant) and down on every host-run AI call. Agents
 * connecting over MCP with their own tokens cost nothing here — only the AI
 * the host runs on the user's behalf (the staff manager) is metered.
 */
export const billingAccounts = sqliteTable('billing_accounts', {
  userId: text('user_id').primaryKey(),
  balanceCents: integer('balance_cents').notNull().default(0),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Every metered AI call and every credit, one row each, so the balance is
 * always reproducible as the sum of the ledger. `costCents` is negative for
 * usage and positive for credits.
 */
export const usageLedger = sqliteTable(
  'usage_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    /** 'usage' = an AI call, 'credit' = a payment / grant. */
    kind: text('kind', { enum: ['usage', 'credit'] }).notNull(),
    /** What the call was for, e.g. 'staff_manager.plan'. Or the credit source. */
    ref: text('ref').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull(),
    /** Stripe checkout session id for credits — unique so a webhook retry can't double-credit. */
    stripeSessionId: text('stripe_session_id').unique(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userCreated: index('idx_usage_ledger_user_created').on(t.userId, t.createdAt),
  }),
);

export type BillingAccount = typeof billingAccounts.$inferSelect;
export type UsageLedgerRow = typeof usageLedger.$inferSelect;

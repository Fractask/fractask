/**
 * Structured human-in-the-loop prompts. An agent posts a prompt against a
 * task and ends its turn; the human answers via the web UI; the agent picks
 * up the answer on its next `get_task` call.
 *
 * The body is strictly structured JSON — no HTML, no markdown — so the web
 * layer can render each `kind` to a polished component without sanitizing
 * arbitrary content and so the payload stays small for MCP round-trips.
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import {
  agentPrompts,
  tasks,
  type AgentPromptKind,
  type AgentPromptRow,
  type AgentPromptStatus,
  type Task,
} from './schema.js';
import { assertAccessibleExists, assertOwnedExists, NotFoundError } from './access.js';
import { isAgentRuleEnabled } from './settings.js';
import { idSchema } from './types.js';
import { findUserById, isAgentCall } from './auth.js';
import { createComment, deleteComment, listCommentsForTask } from './comments.js';
import { deleteLatestFocusEvent, logFocusEvent, UNDO_WINDOW_MS } from './focus.js';

export const promptKindSchema = z.enum(['text', 'choice', 'approval', 'pick_image']);

export const promptOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().optional(),
  attachmentId: idSchema.optional(),
});
export type PromptOption = z.infer<typeof promptOptionSchema>;

/**
 * Review templates — a structured, realistic preview of the thing being
 * reviewed. The web UI renders each `type` as a faithful mock of the real
 * surface (Gmail draft, WhatsApp conversation, live-chat widget, Instagram
 * post) so the human approves exactly what will go out. Required fields per
 * type are enforced here, which is what forces agents to fill the template
 * out completely.
 */
export const templateMessageSchema = z.object({
  /** 'us' = sent by us/the agent (right side), 'them' = the other party. */
  from: z.enum(['us', 'them']),
  text: z.string().min(1).max(4000),
  author: z.string().max(120).optional(),
  /** Free-form display time, e.g. "14:32" or "Yesterday". */
  time: z.string().max(64).optional(),
});
export type TemplateMessage = z.infer<typeof templateMessageSchema>;

export const emailTemplateSchema = z.object({
  type: z.literal('email'),
  from: z.string().min(1).max(320).optional(),
  to: z.array(z.string().min(1).max(320)).min(1).max(20),
  cc: z.array(z.string().min(1).max(320)).max(20).optional(),
  bcc: z.array(z.string().min(1).max(320)).max(20).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const whatsappTemplateSchema = z.object({
  type: z.literal('whatsapp'),
  contactName: z.string().min(1).max(120),
  contactPhone: z.string().max(40).optional(),
  /** Prior conversation for context, oldest first. Omit for a fresh thread. */
  history: z.array(templateMessageSchema).max(50).optional(),
  /** The outgoing message awaiting approval. */
  draft: z.string().min(1).max(4000),
});
export type WhatsappTemplate = z.infer<typeof whatsappTemplateSchema>;

export const chatTemplateSchema = z.object({
  type: z.literal('chat'),
  /** Where the conversation lives, e.g. "Website live chat", "Intercom". */
  channel: z.string().max(120).optional(),
  customerName: z.string().min(1).max(120),
  history: z.array(templateMessageSchema).max(50).optional(),
  /** The proposed reply awaiting approval. */
  draft: z.string().min(1).max(4000),
});
export type ChatTemplate = z.infer<typeof chatTemplateSchema>;

export const tweetTemplateSchema = z.object({
  type: z.literal('tweet'),
  /** Posting account, e.g. "@verikal". Shown under the display name. */
  handle: z.string().min(1).max(60).optional(),
  displayName: z.string().max(120).optional(),
  /** The post text awaiting approval, verbatim. */
  text: z.string().min(1).max(4000),
});
export type TweetTemplate = z.infer<typeof tweetTemplateSchema>;

/**
 * One slide of an Instagram post. Carousels are ordered, so the array order in
 * `media` is the swipe order the human will see.
 */
export const instagramMediaSchema = z
  .object({
    /** An attachment on this task (preferred — it is already stored and durable). */
    attachmentId: idSchema.optional(),
    /** Public URL, when the asset is not attached to the task. */
    url: z.string().url().optional(),
    /** 'video' draws the play affordance on the slide. Defaults to image. */
    kind: z.enum(['image', 'video']).optional(),
  })
  .refine((m) => Boolean(m.attachmentId || m.url), {
    message: 'each media item needs attachmentId or url',
  });
export type InstagramMedia = z.infer<typeof instagramMediaSchema>;

/**
 * Instagram post/reel/story. The visual IS the post, so `media` is required —
 * a caption on its own is not something a human can approve. Carousels pass
 * several media items in swipe order.
 */
export const instagramTemplateSchema = z.object({
  type: z.literal('instagram'),
  /** Posting account, e.g. "verikal". Shown as the username on the post. */
  handle: z.string().min(1).max(60).optional(),
  /** Feed post (default), reel, or story — sets the frame ratio of the preview. */
  format: z.enum(['post', 'reel', 'story']).optional(),
  /** The image(s)/video awaiting approval, in swipe order. */
  media: z.array(instagramMediaSchema).min(1).max(10),
  /** The caption awaiting approval, verbatim, hashtags included. */
  caption: z.string().max(2200).optional(),
  /** Hashtags/mentions to be posted as the first comment instead of in the caption. */
  firstComment: z.string().max(2200).optional(),
  /** Location tag shown under the username. */
  location: z.string().max(120).optional(),
  /** Accessibility alt text for the first slide. */
  altText: z.string().max(1000).optional(),
});
export type InstagramTemplate = z.infer<typeof instagramTemplateSchema>;

export const promptTemplateSchema = z.discriminatedUnion('type', [
  emailTemplateSchema,
  whatsappTemplateSchema,
  chatTemplateSchema,
  tweetTemplateSchema,
  instagramTemplateSchema,
]);
export type PromptTemplate = z.infer<typeof promptTemplateSchema>;

/**
 * Focus Mode deck — the evidence an agent packages with its question so the
 * human can answer in under two minutes without reconstructing context.
 * Blocks render in array order inside any prompt kind. Media references use
 * the existing attachments store (`attachmentId` → /api/files/<id>) or an
 * external URL; charts are a tiny inline spec rendered without a library.
 */
export const deckTextBlockSchema = z.object({
  kind: z.literal('text'),
  /** Markdown; RTL (Hebrew) supported by the renderer. */
  body: z.string().min(1).max(4000),
});
export const deckImageBlockSchema = z.object({
  kind: z.literal('image'),
  attachmentId: idSchema.optional(),
  url: z.string().url().optional(),
  caption: z.string().max(300).optional(),
});
export const deckVideoBlockSchema = z.object({
  kind: z.literal('video'),
  attachmentId: idSchema.optional(),
  url: z.string().url().optional(),
  /** Poster frame shown before play. */
  poster: z.string().url().optional(),
});
export const deckPdfBlockSchema = z.object({
  kind: z.literal('pdf'),
  attachmentId: idSchema,
  page: z.number().int().positive().optional(),
});
export const deckChartBlockSchema = z.object({
  kind: z.literal('chart'),
  spec: z.object({
    type: z.enum(['bar', 'line']),
    title: z.string().max(120).optional(),
    unit: z.string().max(20).optional(),
    series: z
      .array(z.object({ label: z.string().min(1).max(60), value: z.number() }))
      .min(1)
      .max(24),
  }),
});
export const deckBlockSchema = z.discriminatedUnion('kind', [
  deckTextBlockSchema,
  deckImageBlockSchema,
  deckVideoBlockSchema,
  deckPdfBlockSchema,
  deckChartBlockSchema,
]);
export type DeckBlock = z.infer<typeof deckBlockSchema>;

export const deckSchema = z
  .array(deckBlockSchema)
  .min(1)
  .max(12)
  .superRefine((blocks, ctx) => {
    blocks.forEach((b, i) => {
      if ((b.kind === 'image' || b.kind === 'video') && !b.attachmentId && !b.url) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `${b.kind} block needs attachmentId or url`,
        });
      }
    });
  });

/** Agent cards must be answerable in ≤2 minutes; bigger asks become quests. */
export const MAX_AGENT_EST_SECONDS = 120;
export const MIN_AGENT_EST_SECONDS = 5;

const DECK_FORMAT_HELP = `Required for agent asks:
- deck: 1–12 evidence blocks, in render order — everything the human needs to answer. Block shapes:
  {"kind":"text","body":"<markdown, RTL ok>"}
  {"kind":"image","attachmentId":"<id>"} or {"kind":"image","url":"https://…"} (caption? optional)
  {"kind":"video","attachmentId":"<id>","poster":"https://…"} (poster optional)
  {"kind":"pdf","attachmentId":"<id>","page":2} (page optional)
  {"kind":"chart","spec":{"type":"bar","series":[{"label":"Mon","value":12},…],"title":"…","unit":"…"}}
  Attach files first (attach_file / attach_file_from_url) and reference them by attachmentId.
- recommendation: your recommended answer in one or two sentences, e.g. "Approve — the copy matches the brief and the price was confirmed on the parent task."
- estSeconds: honest answer-time estimate, ${MIN_AGENT_EST_SECONDS}–${MAX_AGENT_EST_SECONDS} seconds. Estimates are calibrated against actuals per agent, so keep them honest.`;

/**
 * Thrown when an agent's ask exceeds the 2-minute card cap. The error text is
 * the documentation — agents learn the quest format from the rejection.
 */
export class QuestRequiredError extends Error {
  constructor(estSeconds: number) {
    super(
      `estSeconds=${estSeconds} is over the ${MAX_AGENT_EST_SECONDS}s cap — every card must be answerable in 2 minutes, with no exception for big decisions. ` +
        `Split this into a quest: create one master task describing the whole ask, add one child task per sub-decision (create_task with parentId=<master>), ` +
        `and call ask_human once per child with its own deck, recommendation, and estSeconds ≤ ${MAX_AGENT_EST_SECONDS}. ` +
        `The cards flow consecutively for the human under the master task's banner, so the big decision still reads as one story.`,
    );
    this.name = 'QuestRequiredError';
  }
}

/**
 * Thrown when an agent's ask_human is missing the Focus packaging. The error
 * body documents the format so agents self-correct on the next call.
 */
export class DeckRequiredError extends Error {
  constructor(missing: string[]) {
    super(
      `ask_human requires ${missing.join(' + ')} for agent callers — the human answers questions as prepared cards, one at a time, and an unpackaged question would force them to reconstruct your context.\n${DECK_FORMAT_HELP}`,
    );
    this.name = 'DeckRequiredError';
  }
}

/**
 * The mechanical §5.1 checks behind the `prompt_requires_deck` workspace
 * rule. Quality review of decks (is the evidence sufficient, is the
 * recommendation honest) is deliberately NOT here — that's deck-QA, an
 * agent's job, not a server rule.
 */
function assertAgentDeckRequirements(parsed: CreatePromptInput): void {
  if (parsed.estSeconds !== undefined && parsed.estSeconds > MAX_AGENT_EST_SECONDS) {
    throw new QuestRequiredError(parsed.estSeconds);
  }
  const missing: string[] = [];
  if (!parsed.deck || parsed.deck.length === 0) missing.push('deck');
  if (!parsed.recommendation) missing.push('recommendation');
  if (parsed.estSeconds === undefined || parsed.estSeconds < MIN_AGENT_EST_SECONDS) {
    missing.push(`estSeconds (${MIN_AGENT_EST_SECONDS}–${MAX_AGENT_EST_SECONDS})`);
  }
  if (missing.length > 0) throw new DeckRequiredError(missing);
}

/**
 * Thrown when an agent's ask_human would be addressed to another agent and no
 * human owns anything above it in the tree. The message is the documentation:
 * this failed silently for weeks precisely because a misrouted ask returns the
 * same `{id}` as a good one, so the rejection has to teach the whole mechanism.
 */
export class AgentRecipientError extends Error {
  constructor(taskId: string, ownerLabel: string, chainLabel: string) {
    super(
      `ask_human addresses its question to the task's OWNER, and task ${taskId} is owned by ${ownerLabel} — an agent. ` +
        `No human owns any task above it either (${chainLabel}), so this question would be filed pending against an agent and no human would ever be shown it. ` +
        `Nothing was written.\n\n` +
        `A task's owner is fixed at creation, so the fix is a parent, not a field. Two remedies, cheapest first:\n` +
        `  1. move_task(${taskId}, <a task the human owns — a venture/entity card>), then ask again. This does NOT change the owner — but the recipient is resolved by walking the PARENT chain at ask time, so a human above the card receives it and the card keeps its comments, attachments and history. Prefer this.\n` +
        `  2. Only if there is nowhere to file it: create_task(..., parentId: <a human-owned card>) — the new task is owned by that human — and ask_human on THAT task instead. You lose this card's thread.\n` +
        `Setting reviewerId does NOT re-address the question (measured 2026-09-03: reviewerId=<human> and the prompt still went to the owner). Neither does move_task on its own: it re-routes the NEXT ask, never a prompt already filed.\n\n` +
        `Then verify rather than trusting the return value: list_prompts and check the new prompt's userId is the human's. ` +
        `A misrouted ask returns an id exactly like a delivered one, which is why nine of these sat pending for up to 29 days before anyone noticed.`,
    );
    this.name = 'AgentRecipientError';
  }
}

/**
 * Who should actually receive this question.
 *
 * The defect this exists for: the recipient is `task.userId`, a top-level task
 * created by an agent is owned by that agent, and six of the nine stranded
 * prompts found on 2026-09-03 were agents asking *themselves*. Every one read
 * as healthy — task `review`, prompt `pending`, counted in the human's queue.
 *
 * Two steps, in this order:
 *   1. walk the ancestor chain for the nearest human owner and use them. This
 *      is the case `move_task` creates: ownership is fixed at creation, so a
 *      card created top-level and later filed under a human's venture keeps its
 *      agent owner while sitting under a human the whole time.
 *   2. if the entire chain is agent-owned, throw. A loud failure on the way in
 *      is the whole point — the silent version cost 29 days on one card.
 *
 * Humans are never checked: the rule is about agents addressing agents.
 */
async function resolvePromptRecipient(
  ctx: Context,
  task: Task,
): Promise<{ userId: string; reroutedFrom?: string }> {
  const owner = await findUserById(task.userId);
  if (owner?.kind !== 'agent') return { userId: task.userId };

  const db = getDb();
  const seen = new Set<string>([task.id]);
  const chain: string[] = [];
  let cursor: string | null = task.parentId;
  // Bounded by `seen`, not by a depth constant: a cycle would otherwise spin
  // here, and a legitimately deep tree must not be silently given up on.
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const [parent]: { userId: string; parentId: string | null }[] = await db
      .select({ userId: tasks.userId, parentId: tasks.parentId })
      .from(tasks)
      .where(eq(tasks.id, cursor))
      .limit(1);
    if (!parent) break;
    const parentOwner = await findUserById(parent.userId);
    if (parentOwner && parentOwner.kind !== 'agent') {
      return { userId: parent.userId, reroutedFrom: task.userId };
    }
    chain.push(parentOwner?.name ?? parent.userId);
    cursor = parent.parentId;
  }

  throw new AgentRecipientError(
    task.id,
    owner.name ?? task.userId,
    chain.length ? `checked ${chain.length} ancestor(s): ${chain.join(' → ')}` : 'it has no parent',
  );
}

/**
 * Canned comment posted when the human sends a review back as "unclear".
 * Written as a direct instruction to the agent: first re-check relevance,
 * then either close the task or re-ask with a concrete, answerable prompt.
 */
export const UNCLEAR_REVIEW_COMMENT = `⚠️ Sent back: it's not clear what needs to be reviewed here.

Before asking again, do this in order:
1. **Re-check this task is still relevant.** If it's part of a bigger project/task that already moved forward somewhere else (superseded, duplicated, or done as part of other work), do NOT re-ask — close it (status "archived", or "done" if the work genuinely happened) with a one-line comment saying where it was superseded.
2. **If it IS still relevant**, re-submit ONE concrete ask via \`ask_human\`:
   - an outgoing message → \`kind:"approval"\` + the matching \`template\` (email / whatsapp / chat / tweet / instagram) with the exact content to be sent, or
   - a decision → a closed-ended question: \`kind:"approval"\` (yes/no) or \`kind:"choice"\` (options), so the human knows exactly what they're deciding and what happens on approve.

Never send a task to review without a concrete, answerable ask.`;

export const createPromptInputSchema = z
  .object({
    taskId: idSchema,
    kind: promptKindSchema,
    prompt: z.string().min(1).max(2000),
    options: z.array(promptOptionSchema).max(50).optional(),
    multiple: z.boolean().optional(),
    template: promptTemplateSchema.optional(),
    /** Focus deck — evidence blocks rendered above the question. Required for agent askers (prompt_requires_deck rule). */
    deck: deckSchema.optional(),
    /** The asker's recommended answer, one or two sentences. Required for agent askers. */
    recommendation: z.string().min(1).max(2000).optional(),
    /** Honest answer-time estimate in seconds. Agents: 5–120; over 120 must be split into a quest. */
    estSeconds: z.number().int().min(1).max(86_400).optional(),
    /** Link the task to a big goal (a task with kind="goal"). Omit for a specific, self-contained task. */
    goalTaskId: idSchema.optional(),
    /**
     * Keep this asker's earlier pending prompts on the task alive instead of
     * superseding them. Only for genuinely parallel questions — see the
     * supersede block in `createPrompt`.
     */
    keepPrevious: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.kind === 'choice' || v.kind === 'pick_image') && (!v.options || v.options.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `Kind '${v.kind}' requires at least one option`,
      });
    }
    if (v.kind === 'pick_image' && v.options) {
      for (let i = 0; i < v.options.length; i++) {
        const o = v.options[i]!;
        if (!o.imageUrl && !o.attachmentId) {
          ctx.addIssue({
            code: 'custom',
            path: ['options', i],
            message: "pick_image options need imageUrl or attachmentId",
          });
        }
      }
    }
    if (v.kind === 'approval' && v.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: "approval prompts don't take options",
      });
    }
    if (v.kind === 'text' && v.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: "text prompts don't take options",
      });
    }
    const ids = (v.options ?? []).map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'option ids must be unique' });
    }
  });
export type CreatePromptInput = z.infer<typeof createPromptInputSchema>;

export const promptAnswerSchema = z.object({
  text: z.string().max(20_000).optional(),
  selectedIds: z.array(z.string().max(64)).max(50).optional(),
  approved: z.boolean().optional(),
  comment: z.string().max(2000).optional(),
});
export type PromptAnswer = z.infer<typeof promptAnswerSchema>;

export type AgentPrompt = Omit<
  AgentPromptRow,
  'options' | 'answer' | 'multiple' | 'template' | 'deck'
> & {
  options: PromptOption[] | null;
  answer: PromptAnswer | null;
  template: PromptTemplate | null;
  deck: DeckBlock[] | null;
  multiple: boolean;
};

/**
 * A freshly created prompt, plus the ids of the asker's own prompts it
 * superseded. Surfaced in the `ask_human` tool result so an agent that
 * re-asked can see its earlier question was retired rather than lost.
 */
export type CreatePromptResult = AgentPrompt & {
  supersededPromptIds: string[];
  /**
   * Set only when the question was addressed to a human further up the tree
   * because the task's own owner is an agent. Present so a reroute is visible
   * in the tool result — the whole failure mode here was a return value that
   * looked identical whether the ask landed or vanished.
   */
  reroutedFromUserId?: string;
};

function deserialize(row: AgentPromptRow): AgentPrompt {
  return {
    ...row,
    multiple: row.multiple === 1,
    options: row.options ? (JSON.parse(row.options) as PromptOption[]) : null,
    answer: row.answer ? (JSON.parse(row.answer) as PromptAnswer) : null,
    template: row.template ? (JSON.parse(row.template) as PromptTemplate) : null,
    deck: row.deck ? (JSON.parse(row.deck) as DeckBlock[]) : null,
  };
}

export async function listPromptsForTask(ctx: Context, taskId: string): Promise<AgentPrompt[]> {
  await assertAccessibleExists(ctx, taskId);
  const db = getDb();
  const rows = await db
    .select()
    .from(agentPrompts)
    .where(eq(agentPrompts.taskId, taskId))
    .orderBy(asc(agentPrompts.createdAt));
  return rows.map(deserialize);
}

export async function listPromptsForTasks(
  ctx: Context,
  taskIds: string[],
): Promise<Map<string, AgentPrompt[]>> {
  const out = new Map<string, AgentPrompt[]>();
  if (taskIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select()
    .from(agentPrompts)
    .where(and(eq(agentPrompts.userId, ctx.userId), inArray(agentPrompts.taskId, taskIds)))
    .orderBy(asc(agentPrompts.createdAt));
  for (const row of rows) {
    const list = out.get(row.taskId) ?? [];
    list.push(deserialize(row));
    out.set(row.taskId, list);
  }
  return out;
}

/** The bit of a pending ask_human a queue view needs: who must answer, how
 * long it should take, and what is being asked. */
export type PendingPromptSummary = {
  id: string;
  kind: AgentPrompt['kind'];
  prompt: string;
  estSeconds: number | null;
  askedByUserId: string;
  /** The user who must answer — the prompt's owner, not the asker. */
  userId: string;
  createdAt: number;
};

/**
 * Newest pending prompt per task, for a batch of task ids.
 *
 * Deliberately NOT filtered by `ctx.userId`, unlike `listPromptsForTasks`: a
 * coordinator asking "what is in the review queue" needs prompts addressed to
 * the *human owner*, which never match the calling agent's id. Visibility is
 * already enforced upstream — callers pass ids that came out of an
 * access-checked `listTasks`, so this only ever describes tasks the caller
 * can already see. Same reasoning as `getReviewQueueHours`.
 */
export async function getPendingPromptSummaries(
  taskIds: string[],
): Promise<Map<string, PendingPromptSummary>> {
  const out = new Map<string, PendingPromptSummary>();
  if (taskIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select({
      id: agentPrompts.id,
      taskId: agentPrompts.taskId,
      kind: agentPrompts.kind,
      prompt: agentPrompts.prompt,
      estSeconds: agentPrompts.estSeconds,
      askedByUserId: agentPrompts.askedByUserId,
      userId: agentPrompts.userId,
      createdAt: agentPrompts.createdAt,
    })
    .from(agentPrompts)
    .where(and(eq(agentPrompts.status, 'pending'), inArray(agentPrompts.taskId, taskIds)))
    .orderBy(asc(agentPrompts.createdAt));
  // Ascending order + overwrite ⇒ the newest pending prompt wins, matching
  // ask_human's supersede semantics (a new question replaces the old one).
  for (const row of rows) {
    const { taskId, ...rest } = row;
    out.set(taskId, rest);
  }
  return out;
}

/**
 * True when the task carries at least one prompt still waiting on the human.
 * Access is not re-checked here — callers reach this after their own
 * assertAccessible* check (see the review guard in `updateTask`).
 */
export async function hasPendingPrompt(taskId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: agentPrompts.id })
    .from(agentPrompts)
    .where(and(eq(agentPrompts.taskId, taskId), eq(agentPrompts.status, 'pending')))
    .limit(1);
  return rows.length > 0;
}

export async function listPendingPromptsForUser(ctx: Context): Promise<AgentPrompt[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentPrompts)
    .where(and(eq(agentPrompts.userId, ctx.userId), eq(agentPrompts.status, 'pending')))
    .orderBy(desc(agentPrompts.createdAt));
  return rows.map(deserialize);
}

export async function createPrompt(
  ctx: Context,
  input: CreatePromptInput,
): Promise<CreatePromptResult> {
  const parsed = createPromptInputSchema.parse(input);
  const task = await assertAccessibleExists(ctx, parsed.taskId);

  // §5.1 Focus packaging — agents must ship a deck, a recommendation, and a
  // ≤120s estimate; humans and the web UI are exempt. Checked before any
  // write so a rejected ask leaves nothing behind, and keyed on the caller's
  // user kind (same pattern as assertMayEnterReview).
  const asker = await findUserById(ctx.userId);
  if (isAgentCall(ctx, asker) && (await isAgentRuleEnabled('prompt_requires_deck'))) {
    assertAgentDeckRequirements(parsed);
  }

  // §5.2 Addressing — a question filed against an agent is never answered by a
  // human on purpose. Resolved before any write, same as the deck check, so a
  // rejected ask leaves nothing behind: a half-filed undeliverable prompt is
  // strictly worse than none, because it still reads as "waiting on the human".
  let recipientId = task.userId;
  let reroutedFrom: string | undefined;
  if (isAgentCall(ctx, asker) && (await isAgentRuleEnabled('prompt_reaches_a_human'))) {
    const resolved = await resolvePromptRecipient(ctx, task);
    recipientId = resolved.userId;
    reroutedFrom = resolved.reroutedFrom;
  }

  // Validate the goal link before insert; write it after, next to the review bump.
  if (parsed.goalTaskId !== undefined) {
    const goal = await assertAccessibleExists(ctx, parsed.goalTaskId);
    if (goal.kind !== 'goal') {
      throw new Error(
        `goalTaskId must reference a task with kind="goal" — "${goal.title}" is kind="${goal.kind}". ` +
          `Pass the goal task's id, or omit goalTaskId entirely for a specific (self-contained) ask.`,
      );
    }
  }

  const ts = Date.now();
  const row: AgentPromptRow = {
    id: nanoid(12),
    taskId: parsed.taskId,
    userId: recipientId,
    askedByUserId: ctx.userId,
    kind: parsed.kind as AgentPromptKind,
    prompt: parsed.prompt,
    options: parsed.options ? JSON.stringify(parsed.options) : null,
    template: parsed.template ? JSON.stringify(parsed.template) : null,
    deck: parsed.deck ? JSON.stringify(parsed.deck) : null,
    recommendation: parsed.recommendation ?? null,
    estSeconds: parsed.estSeconds ?? null,
    openedAt: null,
    answerKind: null,
    multiple: parsed.multiple ? 1 : 0,
    status: 'pending' as AgentPromptStatus,
    answer: null,
    answeredByUserId: null,
    createdAt: ts,
    answeredAt: null,
    cancelledAt: null,
  };
  const db = getDb();
  await db.insert(agentPrompts).values(row);

  if (parsed.goalTaskId !== undefined && task.goalId !== parsed.goalTaskId) {
    await db
      .update(tasks)
      .set({ goalId: parsed.goalTaskId, updatedAt: ts })
      .where(eq(tasks.id, task.id));
  }

  // Supersede this asker's own earlier pending prompts on the same task. A
  // revised question replaces the one it revises; leaving both pending makes
  // the human answer a stale version or wade through duplicates (one
  // storyboard task carried v1 + v2 + v3 approvals pending at once, and a
  // shipped task kept its original prompt pending for ten days).
  //
  // Scoped to askedByUserId so two agents working the same task never cancel
  // each other's questions, and run after the insert so a failed insert leaves
  // the existing prompts untouched. Pass keepPrevious to opt out when the
  // questions are genuinely parallel rather than successive.
  let supersededPromptIds: string[] = [];
  if (!parsed.keepPrevious && (await isAgentRuleEnabled('supersede_prompts'))) {
    const stale = await db
      .select({ id: agentPrompts.id })
      .from(agentPrompts)
      .where(
        and(
          eq(agentPrompts.taskId, parsed.taskId),
          eq(agentPrompts.askedByUserId, ctx.userId),
          eq(agentPrompts.status, 'pending'),
          ne(agentPrompts.id, row.id),
        ),
      );
    if (stale.length > 0) {
      supersededPromptIds = stale.map((s) => s.id);
      await db
        .update(agentPrompts)
        .set({ status: 'cancelled', cancelledAt: ts })
        .where(inArray(agentPrompts.id, supersededPromptIds));
    }
  }

  // A pending prompt is a review request. Bump the task to status='review'
  // with the owner as reviewer so it surfaces in /reviews next to other
  // approvals waiting on the human. Skipped if the task is already in
  // review or in a terminal state (done/archived/snoozed).
  if (task.status === 'open' || task.status === 'doing') {
    await db
      .update(tasks)
      // reviewerId follows the recipient, not the owner. If the question was
      // rerouted up to a human, leaving an agent as reviewer would put the card
      // back in the same nobody-reads-this bucket the reroute just took it out of.
      .set({ status: 'review', reviewerId: recipientId, updatedAt: ts })
      .where(eq(tasks.id, task.id));
  }

  return {
    ...deserialize(row),
    supersededPromptIds,
    ...(reroutedFrom !== undefined ? { reroutedFromUserId: reroutedFrom } : {}),
  };
}

/**
 * Thrown when an agent-kind caller tries to resolve a prompt. Resolving —
 * answering, sending back, or closing as not relevant — is the human half of
 * the loop: an agent that could do it could approve its own outgoing-message
 * ask. The web transport already exposes these paths only behind a session
 * login, but the property is enforced here in core so it survives any future
 * tool or bearer route.
 */
export class HumanResolutionRequiredError extends Error {
  constructor(
    message = 'Prompts are resolved by the human, never by agents. If your question is moot, ' +
      'call cancel_prompt (the task returns to the doer); otherwise wait for the answer on get_task.',
  ) {
    super(message);
    this.name = 'HumanResolutionRequiredError';
  }
}

async function assertHumanResolver(ctx: Context): Promise<void> {
  const caller = await findUserById(ctx.userId);
  if (!caller || caller.kind === 'agent') throw new HumanResolutionRequiredError();
}

export async function answerPrompt(
  ctx: Context,
  id: string,
  rawAnswer: PromptAnswer,
  opts: AnswerOpts = {},
): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.status !== 'pending') throw new Error(`Prompt is already ${row.status}`);

  await assertAccessibleExists(ctx, row.taskId);
  await assertHumanResolver(ctx);

  const parsedAnswer = promptAnswerSchema.parse(rawAnswer);
  validateAnswerShape(row, parsedAnswer);

  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({
      status: 'answered',
      answerKind: 'answered',
      answer: JSON.stringify(parsedAnswer),
      answeredAt: ts,
      answeredByUserId: ctx.userId,
    })
    .where(eq(agentPrompts.id, id));

  await logAnswerEvent(ctx, row, 'answered', ts, opts);

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

/**
 * Answer-time telemetry passed by the surface doing the answering. `seconds`
 * is the Focus card timer's reading — time the card was actually in front of
 * the human — which beats wall-clock openedAt→answeredAt (that includes time
 * the tab sat in the background or the card waited behind a skip).
 */
export type AnswerOpts = { seconds?: number };

/**
 * One focus_events row per answered/sent-back/not-relevant prompt — the raw
 * material for quota, streaks, and estimate calibration. `seconds` prefers
 * the client-measured card time, bounded by the wall-clock openedAt window;
 * falls back to the wall-clock diff when the surface sent nothing (classic
 * review UI), and stays null when the prompt was never opened at all.
 */
async function logAnswerEvent(
  ctx: Context,
  row: AgentPromptRow,
  type: 'answered' | 'sent_back' | 'not_relevant',
  ts: number,
  opts: AnswerOpts = {},
  extraMeta: Record<string, unknown> = {},
): Promise<void> {
  const wallClock =
    row.openedAt !== null ? Math.max(0, Math.round((ts - row.openedAt) / 1000)) : undefined;
  const client =
    opts.seconds !== undefined ? Math.max(0, Math.round(opts.seconds)) : undefined;
  const seconds =
    client !== undefined
      ? wallClock !== undefined
        ? Math.min(client, wallClock)
        : client
      : wallClock;
  const meta = {
    ...(row.estSeconds !== null ? { estSeconds: row.estSeconds } : {}),
    ...extraMeta,
  };
  await logFocusEvent(ctx, {
    taskId: row.taskId,
    promptId: row.id,
    type,
    ...(seconds !== undefined ? { seconds } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  });
}

/**
 * Stamp the moment a prompt is first dealt in Focus Mode — starts the card
 * timer that `answered` events measure against. Idempotent: only the first
 * call writes; re-renders and re-queues (skip) keep the original openedAt.
 */
export async function markPromptOpened(ctx: Context, id: string): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  await assertAccessibleExists(ctx, row.taskId);
  if (row.status === 'pending' && row.openedAt === null) {
    const ts = Date.now();
    await db.update(agentPrompts).set({ openedAt: ts }).where(eq(agentPrompts.id, id));
    await logFocusEvent(ctx, { taskId: row.taskId, promptId: row.id, type: 'opened' });
    return deserialize({ ...row, openedAt: ts });
  }
  return deserialize(row);
}

/**
 * Canned comment posted when the human answers "not relevant" in Focus. The
 * task is archived in the same stroke, so the message tells the agent this is
 * a full stop, not feedback to iterate on.
 */
export const NOT_RELEVANT_COMMENT = `✕ Not relevant: the human closed this from Focus. The question and the task are archived — do not re-ask, re-open, or re-create this task. If you believe some work here is genuinely still needed, raise it as a NEW task with fresh context explaining what changed.`;

/**
 * Focus "send back": the answer is "this needs another pass". The prompt is
 * resolved (answerKind="sent_back") so it leaves the queue, the note lands in
 * the task thread, and the task returns to `doing` for the asking agent.
 */
export async function sendBackPrompt(
  ctx: Context,
  id: string,
  note?: string,
  opts: AnswerOpts = {},
): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.status !== 'pending') throw new Error(`Prompt is already ${row.status}`);
  await assertAccessibleExists(ctx, row.taskId);
  await assertHumanResolver(ctx);

  const ts = Date.now();
  const trimmed = note?.trim();
  const answer: PromptAnswer = {
    ...(row.kind === 'approval' ? { approved: false } : {}),
    ...(trimmed ? { comment: trimmed } : {}),
  };
  await db
    .update(agentPrompts)
    .set({
      status: 'answered',
      answerKind: 'sent_back',
      answer: JSON.stringify(answer),
      answeredAt: ts,
      answeredByUserId: ctx.userId,
    })
    .where(eq(agentPrompts.id, id));

  if (trimmed) {
    await createComment(ctx, {
      taskId: row.taskId,
      body: `↩️ Sent back: ${trimmed}`,
      source: 'human',
    });
  }

  // Hand the task back to the doer. Guarded the same way as createPrompt's
  // review bump: only an in-review task moves; terminal states stay put.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
  const task = taskRows[0];
  if (task && task.status === 'review') {
    await db
      .update(tasks)
      .set({ status: 'doing', updatedAt: ts })
      .where(eq(tasks.id, task.id));
  }

  await logAnswerEvent(ctx, row, 'sent_back', ts, opts);

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

/**
 * Focus "not relevant": the ask (and its task) should never come back. The
 * prompt is cancelled with answerKind="not_relevant", the asking agent gets
 * the canned full-stop comment, and the task is archived.
 */
export async function markPromptNotRelevant(
  ctx: Context,
  id: string,
  note?: string,
  opts: AnswerOpts = {},
): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.status !== 'pending') throw new Error(`Prompt is already ${row.status}`);
  await assertAccessibleExists(ctx, row.taskId);
  await assertHumanResolver(ctx);

  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({
      status: 'cancelled',
      answerKind: 'not_relevant',
      cancelledAt: ts,
      answeredByUserId: ctx.userId,
    })
    .where(eq(agentPrompts.id, id));

  const trimmed = note?.trim();
  await createComment(ctx, {
    taskId: row.taskId,
    body: trimmed ? `${NOT_RELEVANT_COMMENT}\n\n**Note from the human:** ${trimmed}` : NOT_RELEVANT_COMMENT,
    source: 'human',
  });

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
  const task = taskRows[0];
  if (task && task.status !== 'archived') {
    await db
      .update(tasks)
      .set({ status: 'archived', updatedAt: ts, completedAt: null })
      .where(eq(tasks.id, task.id));
  }

  await logAnswerEvent(ctx, row, 'not_relevant', ts, opts);

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

/**
 * Comment posted when the human passes a question to someone else from Focus
 * instead of answering it. Not an answer and not a hand-off of the work: the
 * question stays a human question — it just shouldn't be sitting in the
 * human's queue as-is (moot, already handled elsewhere, or not asked per the
 * guidelines). The recipient — usually a triage agent — settles it.
 */
export function passedOnComment(input: {
  to: string;
  from: string;
  note?: string | undefined;
}): string {
  const note = input.note?.trim();
  return [
    `↪️ Passed to ${input.to} from Focus${note ? `: ${note}` : ''}`,
    '',
    `@${input.to} — ${input.from} passed you this instead of answering it. Settle it, in this order:`,
    '1. **Re-check the task is still relevant.** If it was superseded, duplicated, or already handled as part of other work, close it (status "archived", or "done" if the work genuinely happened) with a one-line comment saying where.',
    '2. **Check the ask followed the guidelines.** No concrete question, wrong kind, missing template or deck, not a closed-ended decision — fix it, or tell the asker exactly what to change.',
    `3. **Only if ${input.from} still has a real decision to make**, re-submit ONE concrete, answerable ask via \`ask_human\`.`,
  ].join('\n');
}

export type PassOnInput = { toUserId: string; note?: string | undefined };

type PassOnParties = { toName: string; fromName: string };

/** Validate the recipient before anything is written — a bad id must not leave a half-done pass. */
async function resolvePassOnParties(ctx: Context, input: PassOnInput): Promise<PassOnParties> {
  if (input.toUserId === ctx.userId) {
    throw new Error('Pass it to someone else — it is already in your queue');
  }
  const to = await findUserById(input.toUserId);
  if (!to) throw new NotFoundError(input.toUserId);
  const from = await findUserById(ctx.userId);
  return {
    toName: to.name ?? to.email ?? 'someone',
    fromName: from?.name ?? from?.email ?? 'the human',
  };
}

/**
 * Shared tail of both pass-on paths: tag the recipient on the task with what
 * to check, then move the task to them. An active task (review / doing) lands
 * in their queue as "open" — they haven't started it; a terminal one keeps its
 * status but still changes hands so the pass shows up where they look.
 */
async function applyPassOn(
  ctx: Context,
  taskId: string,
  input: PassOnInput,
  parties: PassOnParties,
  ts: number,
): Promise<void> {
  await createComment(ctx, {
    taskId,
    body: passedOnComment({ to: parties.toName, from: parties.fromName, note: input.note }),
    source: 'human',
  });
  const db = getDb();
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const task = taskRows[0];
  if (!task) return;
  const active = task.status === 'review' || task.status === 'doing';
  await db
    .update(tasks)
    .set({
      assigneeId: input.toUserId,
      updatedAt: ts,
      ...(active ? { status: 'open' as const } : {}),
    })
    .where(eq(tasks.id, taskId));
}

/**
 * Focus "pass on" for a pending ask: the human routes the question to someone
 * else (usually a triage agent) rather than answering it. The prompt is
 * cancelled with answerKind="sent_back" — it left the queue unanswered, and
 * not because it was moot — so the asker sees it withdrawn, not decided.
 * Distinct from sendBackPrompt (bounces to the asker) and from a do-card
 * hand-off (the work itself changes hands). Not undoable: the task has
 * already moved to someone else.
 */
export async function passPromptOn(
  ctx: Context,
  id: string,
  input: PassOnInput,
  opts: AnswerOpts = {},
): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  if (row.status !== 'pending') throw new Error(`Prompt is already ${row.status}`);
  await assertAccessibleExists(ctx, row.taskId);
  await assertHumanResolver(ctx);
  const parties = await resolvePassOnParties(ctx, input);

  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({
      status: 'cancelled',
      answerKind: 'sent_back',
      cancelledAt: ts,
      answeredByUserId: ctx.userId,
    })
    .where(eq(agentPrompts.id, id));

  await applyPassOn(ctx, row.taskId, input, parties, ts);
  await logAnswerEvent(ctx, row, 'sent_back', ts, opts, { passedTo: input.toUserId });

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

/**
 * Focus "pass on" for a review card — a task in review with nothing pending
 * — same routing, no prompt to cancel. Logs its own sent_back focus event.
 */
export async function passTaskOn(
  ctx: Context,
  taskId: string,
  input: PassOnInput,
  opts: AnswerOpts = {},
): Promise<void> {
  await assertAccessibleExists(ctx, taskId);
  await assertHumanResolver(ctx);
  const parties = await resolvePassOnParties(ctx, input);
  const ts = Date.now();
  await applyPassOn(ctx, taskId, input, parties, ts);
  await logFocusEvent(ctx, {
    taskId,
    type: 'sent_back',
    ...(opts.seconds !== undefined ? { seconds: Math.max(0, Math.round(opts.seconds)) } : {}),
    meta: { passedTo: input.toUserId },
  });
}

/**
 * Comment posted when an agent cancels its own pending ask on a task sitting
 * in review. The withdrawal must be loud: silently cancelling used to leave
 * the task parked in review looking resolved, one `update_task done` away
 * from skipping the human entirely.
 */
export const WITHDREW_ASK_COMMENT =
  '⤺ Withdrew the pending question before it was answered. The task is back at "doing" — ' +
  'if a decision is still needed, a fresh ask_human must go out before this task can complete.';

export async function cancelPrompt(ctx: Context, id: string): Promise<AgentPrompt> {
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(id);
  // A prompt id is an object type of its own, and the idempotent early return
  // below used to sit ABOVE every access check: a caller who knew the id of an
  // already-answered prompt got the question text AND the human's answer back,
  // on a task never shared with them. The pending branch was guarded; the
  // not-pending branch was not, so the leak was invisible to a test that only
  // exercised cancelling.
  //
  // Weakest sufficient guard on purpose: anyone who can reach the task keeps
  // the idempotent read they have today, and only the unreachable case changes
  // — from a silent success to NotSharedError. The stronger asker/owner split
  // below still governs who may actually *cancel*.
  await assertAccessibleExists(ctx, row.taskId);
  if (row.status !== 'pending') return deserialize(row);
  // Either the asker or the task owner can cancel.
  if (row.askedByUserId !== ctx.userId) {
    await assertOwnedExists(ctx, row.taskId);
  } else {
    await assertAccessibleExists(ctx, row.taskId);
  }
  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({ status: 'cancelled', cancelledAt: ts, answeredByUserId: ctx.userId })
    .where(eq(agentPrompts.id, id));

  // An agent withdrawing its own ask must not leave the task in review with
  // nothing pending: the task goes back to the doer with a visible comment,
  // and updateTask refuses to let the withdrawer self-complete afterwards
  // (see assertAgentMayComplete in tasks.ts).
  if (row.askedByUserId === ctx.userId) {
    const caller = await findUserById(ctx.userId);
    if (caller?.kind === 'agent') {
      const taskRows = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
      const task = taskRows[0];
      if (task && task.status === 'review') {
        const stillPending = await db
          .select({ id: agentPrompts.id })
          .from(agentPrompts)
          .where(and(eq(agentPrompts.taskId, row.taskId), eq(agentPrompts.status, 'pending')));
        if (stillPending.length === 0) {
          await db
            .update(tasks)
            .set({ status: 'doing', updatedAt: ts })
            .where(eq(tasks.id, task.id));
          await createComment(ctx, {
            taskId: row.taskId,
            body: WITHDREW_ASK_COMMENT,
            source: 'agent',
          });
        }
      }
    }
  }

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, id));
  return deserialize(updated[0]!);
}

/**
 * Undo a prompt resolution in Focus — revert to pending within the undo window.
 * Reverses task side-effects (send-back → review, not-relevant → unarchive) and
 * removes the resolution comment + focus event when possible.
 */
export async function undoPromptResolution(ctx: Context, promptId: string): Promise<AgentPrompt> {
  await assertHumanResolver(ctx);
  const db = getDb();
  const rows = await db.select().from(agentPrompts).where(eq(agentPrompts.id, promptId));
  const row = rows[0];
  if (!row) throw new NotFoundError(promptId);
  await assertAccessibleExists(ctx, row.taskId);

  if (row.answeredByUserId !== ctx.userId) {
    throw new Error('Only the resolver can undo');
  }

  const resolvedAt = row.answeredAt ?? row.cancelledAt;
  if (resolvedAt === null || Date.now() - resolvedAt > UNDO_WINDOW_MS) {
    throw new Error('Undo window expired');
  }

  const answerKind = row.answerKind;
  if (
    !answerKind ||
    (answerKind === 'answered' && row.status !== 'answered') ||
    (answerKind === 'sent_back' && row.status !== 'answered') ||
    (answerKind === 'not_relevant' && row.status !== 'cancelled')
  ) {
    throw new Error('Prompt is not in an undoable state');
  }

  const ts = Date.now();
  await db
    .update(agentPrompts)
    .set({
      status: 'pending',
      answerKind: null,
      answer: null,
      answeredAt: null,
      answeredByUserId: null,
      cancelledAt: null,
    })
    .where(eq(agentPrompts.id, promptId));

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
  const task = taskRows[0];

  if (answerKind === 'sent_back' && task?.status === 'doing') {
    await db.update(tasks).set({ status: 'review', updatedAt: ts }).where(eq(tasks.id, task.id));
  }

  if (answerKind === 'not_relevant' && task?.status === 'archived') {
    await db
      .update(tasks)
      .set({ status: 'review', updatedAt: ts, completedAt: null })
      .where(eq(tasks.id, task.id));
  }

  const eventType =
    answerKind === 'answered' ? 'answered' : answerKind === 'sent_back' ? 'sent_back' : 'not_relevant';
  await deleteLatestFocusEvent(ctx, { promptId, types: [eventType] });

  // Drop the resolution comment if it was posted in the same stroke.
  const comments = await listCommentsForTask(ctx, row.taskId);
  const resolutionComment = [...comments]
    .reverse()
    .find(
      (c) =>
        c.authorUserId === ctx.userId &&
        c.createdAt >= resolvedAt - 1000 &&
        c.createdAt <= resolvedAt + 1000 &&
        (c.body.startsWith('↩️ Sent back:') || c.body.startsWith('✕ Not relevant:')),
    );
  if (resolutionComment) {
    await deleteComment(ctx, resolutionComment.id);
  }

  const updated = await db.select().from(agentPrompts).where(eq(agentPrompts.id, promptId));
  return deserialize(updated[0]!);
}

function validateAnswerShape(row: AgentPromptRow, answer: PromptAnswer): void {
  switch (row.kind) {
    case 'text': {
      if (!answer.text || answer.text.length === 0) throw new Error('text answer required');
      return;
    }
    case 'approval': {
      if (typeof answer.approved !== 'boolean') {
        throw new Error('approval answer requires `approved` boolean');
      }
      return;
    }
    case 'choice':
    case 'pick_image': {
      const opts = row.options ? (JSON.parse(row.options) as PromptOption[]) : [];
      const validIds = new Set(opts.map((o) => o.id));
      const picked = answer.selectedIds ?? [];
      if (picked.length === 0) throw new Error('`selectedIds` required');
      if (!row.multiple && picked.length > 1) throw new Error('single-select prompt');
      for (const id of picked) {
        if (!validIds.has(id)) throw new Error(`Unknown option id: ${id}`);
      }
      return;
    }
  }
}

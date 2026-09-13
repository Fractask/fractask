import { and, eq } from 'drizzle-orm';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { settings } from './schema.js';

const KEY_TASK_GUIDELINES = 'task_guidelines';
const SCOPE_GLOBAL = 'global';
const KEY_REC_ARCHIVE_DAYS = 'recurrence_archive_days';
const KEY_REC_ARCHIVE_ON_NEXT = 'recurrence_archive_on_next';
const RULE_KEY_PREFIX = 'rule_';

export const DEFAULT_TASK_GUIDELINES = `# Task guidelines

When you create or break down a task, follow these conventions so the tree stays useful for both humans and agents:

- **Concrete & actionable.** A title is something a person or agent can pick up today. Prefer "Rewrite onboarding email subject line" over "Improve onboarding."
- **Imperative single-verb titles.** Start with a verb (Add, Fix, Write, Decide, Investigate). One short line, no period.
- **Atomic.** Each task is one shippable unit. If the title contains "and" or the body has a TODO list, split it into children.
- **Decompose ambitious work.** A \`project\` holds children. Don't park implementation details on the project — call \`create_task\` once per concrete subtask, with \`parentId\` set.
- **Use \`kind\` correctly.** \`entity\` = company/area, \`project\` = a project under an entity, \`task\` = a to-do, \`goal\` = a qualitative outcome, \`kpi\` = a measurable check-in (combine with \`recurrence\`).
- **Don't duplicate existing children.** Before decomposing, list the parent's children and skip what's already there.
- **Note context, not narration.** The description should help a future reader pick up the task — links, decisions, gotchas — not "as we discussed."

## Asking the human (ask_human)

When you need a decision, approval, or open-ended input, call \`ask_human\` and **end your turn**. Don't poll. The next time you call \`get_task\` on that task, the answered prompt will be in \`prompts[].answer\`.

- \`approval\` for go/no-go decisions ("Approve deleting these 142 archived tasks?").
- \`choice\` when there's a finite set ("Which framework? Next.js / Remix / SvelteKit"). Set \`multiple: true\` for multi-select.
- \`text\` for open-ended answers ("What should I name the new dataset?").
- \`pick_image\` when the decision is visual. Reference attached images via \`option.attachmentId\` or external URLs via \`option.imageUrl\`.

Side effect: the task moves to \`status="review"\` automatically so the human sees it as a card in their Focus queue. Don't try to set status yourself for an in-flight question.

### Setting status="review" directly (finished work, no question)

You can also move a task to \`status="review"\` yourself via \`update_task\` — for finished work you want approved rather than a question you're asking. This is gated the same way \`ask_human\` is: a task entering review with no pending prompt MUST already carry a \`description\` or at least one comment (\`post_comment\`) explaining what to check. A bare task with nothing attached is rejected outright (\`ReviewWithoutContextError\`) — it would land in the human's Focus queue as a card with no question and no way to know why it's there. Set a real \`description\` (or post a comment) before the status flip, not after.

### Come prepared: deck + recommendation + estSeconds — REQUIRED for agents

The human answers questions as prepared cards, one at a time, under a daily time budget. Every agent \`ask_human\` must therefore carry:

- \`deck\` — 1–12 evidence blocks, in render order: everything needed to answer without opening the task. Shapes: \`{kind:"text", body:"<markdown, RTL ok>"}\`, \`{kind:"image", attachmentId|url, caption?}\`, \`{kind:"video", attachmentId|url, poster?}\`, \`{kind:"pdf", attachmentId, page?}\`, \`{kind:"chart", spec:{type:"bar"|"line", series:[{label,value}], title?, unit?}}\`. Attach files first, then reference them by \`attachmentId\`.
- \`recommendation\` — your recommended answer in one or two sentences, with the reason ("Approve — matches the brief; price confirmed on the parent task").
- \`estSeconds\` — honest answer-time estimate, 5–120. Estimates are calibrated against actuals per agent, so don't lowball.

**Hard cap: 120 seconds per card.** A bigger ask must become a **quest**: create one master task describing the whole ask, one child task per sub-decision, and one \`ask_human\` (with its own deck) per child. The cards flow consecutively for the human under the master's banner. There is no exception for big decisions — split them.

Optionally pass \`goalTaskId\` (a task with \`kind="goal"\`) to link the work to a big goal; omit it for small self-contained asks — both are valid.

### Before you ask: only file it when it's actually needed

Every \`ask_human\` becomes a Focus card the moment you call it — the human works through Focus as a queue against a daily time budget, so a premature or sloppy ask doesn't sit quietly, it interrupts real work today. Check before calling:

- **Can you resolve it yourself?** A reasonable default, something already in the task's \`description\`/\`comments\`, or a judgment call you're equipped to make — don't outsource what you can decide. Ask only for genuine decisions, approvals, or open-ended input only a human can give.
- **Is it actually answerable in one glance?** If you're not sure what you're asking, don't file it — that's a sign the task itself needs rewriting first (clearer scope, a decision you can make, or splitting into what you can do vs. the one real unknown). Fix that, then re-check whether an ask is still needed.
- **One ask = one decision.** Bundling several unresolved questions into one card isn't a shortcut — it's the quest-split case above (one master task, one child + one \`ask_human\` per sub-decision).
- **The deck/recommendation/estSeconds gate is not a formality.** A missing field or a >120s estimate is rejected at the call, instantly, before anything reaches the human — that rejection is the entry-point check working as intended. Rewrite and resubmit; don't retry the same incomplete ask.

### Review templates (\`template\`) — REQUIRED for outgoing-message approvals

Any approval about a message that will be sent somewhere MUST include \`template\` so the human reviews it as a realistic preview instead of raw text:

- **Email approval** → \`kind:"approval"\` + \`template: {type:"email", to:["dana@acme.com"], subject:"…", body:"…", cc?, bcc?, from?}\` — rendered as a Gmail-style draft.
- **WhatsApp message approval** → \`template: {type:"whatsapp", contactName:"Dana Levy", draft:"…", contactPhone?, history?:[{from:"them", text:"…", time?:"14:02"}, {from:"us", text:"…"}]}\` — rendered as a WhatsApp conversation with the draft as the pending bubble. Include recent \`history\` whenever prior context matters to the decision.
- **Live-chat reply approval** → \`template: {type:"chat", customerName:"Dana", draft:"…", channel?:"Website live chat", history?}\` — rendered as a chat widget showing the prior transcript and your proposed reply.
- **Tweet / X post approval** → \`template: {type:"tweet", text:"…", handle?:"@verikal", displayName?:"Verikal"}\` — rendered as an X post card with a live character count.
- **Instagram post approval** → \`template: {type:"instagram", media:[{attachmentId:"…"}], caption:"…", handle?:"verikal", format?:"post"|"reel"|"story", location?, firstComment?, altText?}\` — rendered as an Instagram post card: the visual, the caption, and a live 2200-char / 30-hashtag count. \`media\` is required (the visual IS the post) and takes several items for a carousel, in swipe order; attach the image with \`attach_file_from_url\` first and pass its \`attachmentId\`. Put hashtags in \`firstComment\` when that is where they will actually go.

Rules:
- Put the one-line ask in \`prompt\` ("OK to send this reply to Dana?"); put ALL message content in the template fields. Don't paste the email/message into \`prompt\`.
- The human approves exactly what they see — the template must match what you will actually send, **verbatim**. After approval, send it unchanged; if you need to change it, ask again.
- If the human rejects with a comment, revise and post a fresh \`ask_human\` with the updated template.

## Attaching files

Three paths, and which one you pick matters:

- **\`create_upload\` + \`finalize_upload\`** — a private presigned upload straight into the attachment store. No size ceiling, works from a headless box, and the file is never publicly readable at any point. **REQUIRED for anything holding a named person's details** (CV, contract, ID document, customer conversation), and the best default for any large local file.
- **\`attach_file\`** (base64) — fine for small files you already have in hand; the bytes travel through the model, so a few hundred KB is the real ceiling.
- **\`attach_file_from_url\`** — when the source genuinely IS a public URL. Never publish a file to a public CDN just to create a URL to pass here: that mints a permanent, undeletable public copy. Use \`create_upload\` instead.

When you generate or fetch an artifact (screenshot, PDF, diagram, image), call \`attach_file_from_url\` with a public URL. The server stores it and returns metadata; the file shows up in \`get_task(taskId).attachments\` and at \`/api/files/<id>\`. Combine with \`pick_image\` to ask the human to choose between two options.

### Downloading an existing attachment

Every attachment object (from \`get_task\`, \`list_attachments\`, \`get_note\`, or the result of \`attach_file\`/\`attach_file_from_url\`/\`finalize_upload\`) carries a \`downloadUrl\` — GET it directly, no auth needed. It's usually a presigned URL (expires in 1h; if it's gone stale, re-fetch the task/note for a fresh one). Only on a self-hosted local-disk setup does \`downloadUrl\` fall back to \`/api/files/<id>\`, which DOES need an \`Authorization: Bearer <GETSHIT_TOKEN>\` header — if your environment doesn't have that token available, or your fetch tool can't set custom headers, that path will 401 and there's no workaround from inside the tool call. Say so plainly (\`ask_human\` or a comment) rather than guessing at the content.
`;

/**
 * Lookup helper. Returns null if no row exists for that scope+key.
 */
async function getSetting(scope: string, key: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.scope, scope), eq(settings.key, key)));
  return rows[0]?.value ?? null;
}

async function upsertSetting(scope: string, key: string, value: string): Promise<void> {
  const db = getDb();
  const ts = Date.now();
  await db
    .insert(settings)
    .values({ scope, key, value, updatedAt: ts })
    .onConflictDoUpdate({
      target: [settings.scope, settings.key],
      set: { value, updatedAt: ts },
    });
}

async function deleteSetting(scope: string, key: string): Promise<void> {
  const db = getDb();
  await db.delete(settings).where(and(eq(settings.scope, scope), eq(settings.key, key)));
}

export async function getGlobalTaskGuidelines(): Promise<string> {
  return (await getSetting(SCOPE_GLOBAL, KEY_TASK_GUIDELINES)) ?? DEFAULT_TASK_GUIDELINES;
}

export async function setGlobalTaskGuidelines(value: string): Promise<void> {
  await upsertSetting(SCOPE_GLOBAL, KEY_TASK_GUIDELINES, value);
}

export async function resetGlobalTaskGuidelines(): Promise<void> {
  await deleteSetting(SCOPE_GLOBAL, KEY_TASK_GUIDELINES);
}

/**
 * Workspace-wide archival policy for spawned `deliverable` recurring instances.
 * `archiveDays`: archive a done instance this many days after completion (0 =
 * off). `archiveOnNextOccurrence`: also archive the prior done instance when the
 * next occurrence spawns.
 */
export type RecurrenceSettings = { archiveDays: number; archiveOnNextOccurrence: boolean };
export const DEFAULT_RECURRENCE_SETTINGS: RecurrenceSettings = {
  archiveDays: 7,
  archiveOnNextOccurrence: false,
};

export async function getRecurrenceSettings(): Promise<RecurrenceSettings> {
  const [days, onNext] = await Promise.all([
    getSetting(SCOPE_GLOBAL, KEY_REC_ARCHIVE_DAYS),
    getSetting(SCOPE_GLOBAL, KEY_REC_ARCHIVE_ON_NEXT),
  ]);
  const parsed = days == null ? NaN : Number(days);
  return {
    archiveDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RECURRENCE_SETTINGS.archiveDays,
    archiveOnNextOccurrence: onNext == null ? DEFAULT_RECURRENCE_SETTINGS.archiveOnNextOccurrence : onNext === '1',
  };
}

export async function setRecurrenceSettings(patch: Partial<RecurrenceSettings>): Promise<void> {
  if (patch.archiveDays !== undefined) {
    await upsertSetting(SCOPE_GLOBAL, KEY_REC_ARCHIVE_DAYS, String(Math.max(0, Math.floor(patch.archiveDays))));
  }
  if (patch.archiveOnNextOccurrence !== undefined) {
    await upsertSetting(SCOPE_GLOBAL, KEY_REC_ARCHIVE_ON_NEXT, patch.archiveOnNextOccurrence ? '1' : '0');
  }
}

/**
 * Agent rules — workspace-wide behaviors the server enforces on agent writes,
 * as opposed to the task *guidelines*, which are only advice injected into
 * tool descriptions. A rule is enforced whether or not the agent read anything.
 *
 * The prose here is the documentation. It is deliberately stored next to the
 * rule rather than in a separate doc, and the settings page renders straight
 * from this list, so adding a rule means adding one entry and wiring its
 * enforcement point — the UI, the copy, and the toggle come for free and
 * cannot drift out of sync with the list of rules that actually exist.
 */
export type AgentRuleKey =
  | 'review_requires_prompt'
  | 'supersede_prompts'
  | 'prompt_requires_deck'
  | 'prompt_reaches_a_human';

export type AgentRuleDoc = {
  key: AgentRuleKey;
  /** Plain-language name, as shown in settings. */
  title: string;
  /** What the server does while the rule is on. */
  summary: string;
  /** What you lose by turning it off — i.e. why the rule exists at all. */
  whenOff: string;
  /** What the rule deliberately does not do. Prevents over-reading the rule. */
  limits: string;
  /** Where the rule is enforced, for whoever goes looking. */
  enforcedIn: string;
  enabledByDefault: boolean;
};

export const AGENT_RULES: readonly AgentRuleDoc[] = [
  {
    key: 'review_requires_prompt',
    title: 'Review needs a question',
    summary:
      'An agent cannot move a task into "review" unless the task has a question waiting for you. To reach review it must call ask_human, which posts a real question and moves the task itself. Work that is merely finished or needs no decision goes to "done", or stays at "doing" with a comment.',
    whenOff:
      'Agents can put anything in your needs-input queue, including finished deliverables and status notes with nothing to answer — which is what makes the queue untrustworthy. On one sampled day 19 of 28 tasks sitting in review had no question attached.',
    limits:
      'Only agents are affected. You and any human collaborator can move work to review freely from the web UI, and an agent can still edit a task that is already in review, or re-enter review while its own question is still pending.',
    enforcedIn: 'packages/core/src/tasks.ts — assertMayEnterReview()',
    enabledByDefault: true,
  },
  {
    key: 'supersede_prompts',
    title: 'A new question replaces the old one',
    summary:
      'When an agent asks again on a task it already has a question pending on, the earlier question is cancelled automatically. A revised question replaces the one it revises instead of queueing behind it. The agent can pass keepPrevious to opt out when its questions are genuinely parallel.',
    whenOff:
      'Revised questions pile up and you answer the same thing several times, or answer a stale version. One storyboard task reached three pending approvals for the same decision; another kept its question open for ten days after the work shipped.',
    limits:
      'Scoped to the asker: two agents working the same task never cancel each other, and only pending questions are touched — anything you already answered keeps its answer.',
    enforcedIn: 'packages/core/src/prompts.ts — createPrompt()',
    enabledByDefault: true,
  },
  {
    key: 'prompt_requires_deck',
    title: 'Questions come prepared',
    summary:
      'An agent calling ask_human must package the question as a ready-to-answer card: a deck of evidence blocks (text, images, video, PDF pages, small charts), a recommendation, and an honest time estimate of at most 120 seconds. Anything bigger is rejected with instructions to split it into a quest — several small prompts on child tasks under one master task.',
    whenOff:
      'Questions arrive bare and unbounded: to answer one, you reconstruct the context yourself — open the task, read the thread, find the artifacts — which is why review items pile up for weeks. The 2-minute cap is what makes a Focus session possible at all.',
    limits:
      'Only agents are affected — you and any human collaborator can create prompts from the web UI without a deck. Prompts created before the rule (or while it was off) stay valid and render as legacy cards. The rejection errors teach the format, so agents self-correct without redeployment.',
    enforcedIn: 'packages/core/src/prompts.ts — assertAgentDeckRequirements()',
    enabledByDefault: true,
  },
  {
    key: 'prompt_reaches_a_human',
    title: 'Questions must reach a human',
    summary:
      'A question is addressed to the task OWNER, and a task an agent created at the top level is owned by that agent — so an agent asking on its own card addresses the question to itself. While this rule is on, the server first walks up the task tree for the nearest human-owned ancestor and addresses the question there; if the whole chain is agent-owned it rejects the call with instructions instead of filing an undeliverable question.',
    whenOff:
      'Agent-addressed questions are accepted silently. They read as healthy everywhere — task "review", prompt "pending", counted in your needs-input queue — but never enter Focus, so they are only ever answered if you happen to open the card. Nine were found stranded this way on 2026-09-03; the oldest had been pending 29 days, and one held a finished thread that an explicit instruction from you had already told the agent not to park.',
    limits:
      'Only agent callers are checked — you can ask anyone anything from the web UI. It fixes addressing, not packaging: a rerouted question still needs its deck. And it only governs NEW questions; a prompt already pending keeps the recipient it was filed with, so the ones already stranded have to be re-raised rather than re-addressed.',
    enforcedIn: 'packages/core/src/prompts.ts — resolvePromptRecipient()',
    enabledByDefault: true,
  },
];

export type AgentRules = Record<AgentRuleKey, boolean>;

export const DEFAULT_AGENT_RULES: AgentRules = Object.fromEntries(
  AGENT_RULES.map((r) => [r.key, r.enabledByDefault]),
) as AgentRules;

export async function getAgentRules(): Promise<AgentRules> {
  const entries = await Promise.all(
    AGENT_RULES.map(async (r) => {
      const stored = await getSetting(SCOPE_GLOBAL, RULE_KEY_PREFIX + r.key);
      return [r.key, stored == null ? r.enabledByDefault : stored === '1'] as const;
    }),
  );
  return Object.fromEntries(entries) as AgentRules;
}

/**
 * Single-rule read for enforcement points, so a hot path doesn't load every
 * rule to check one. Unset means the rule's default.
 */
export async function isAgentRuleEnabled(key: AgentRuleKey): Promise<boolean> {
  const stored = await getSetting(SCOPE_GLOBAL, RULE_KEY_PREFIX + key);
  if (stored !== null) return stored === '1';
  return AGENT_RULES.find((r) => r.key === key)?.enabledByDefault ?? true;
}

export async function setAgentRules(patch: Partial<AgentRules>): Promise<void> {
  for (const rule of AGENT_RULES) {
    const value = patch[rule.key];
    if (value === undefined) continue;
    await upsertSetting(SCOPE_GLOBAL, RULE_KEY_PREFIX + rule.key, value ? '1' : '0');
  }
}

/**
 * Focus Mode per-user settings (§4.5 of the Focus build spec). Stored in the
 * generic settings bag under the user's scope with `focus_`-prefixed keys, so
 * no migration is needed and each field defaults sensibly when unset.
 */
export type FocusSortMode = 'deadline' | 'goal' | 'minutes';

/**
 * Focus visual skin: 'fractask' (default) matches the rest of the app;
 * 'game' is the Duolingo-style treatment from the approved mock — colors,
 * chunky buttons, motion. Same behavior either way.
 */
export type FocusSkin = 'fractask' | 'game';

/**
 * What feeds the Focus stack: 'due' = pending prompts + own tasks due today
 * (the original spec); 'all' = also every open/doing task assigned to the
 * user regardless of due date — regular tasks run through the same cards.
 */
export type FocusScope = 'due' | 'all';

export type FocusSettings = {
  /** Daily quota of answer-credit, in seconds. Default 45 min. */
  dailyQuotaSeconds: number;
  /** Do-card "Still on it?" check-in interval, seconds. */
  checkinIntervalSec: number;
  /** Grace countdown on the check-in dialog before auto-pause, seconds. */
  checkinGraceSec: number;
  /** Stack ordering; the UI persists the user's last choice here. */
  focusSort: FocusSortMode;
  /** Visual skin; the UI persists the user's last choice here. */
  focusSkin: FocusSkin;
  /** Stack scope; the UI persists the user's last choice here. */
  focusScope: FocusScope;
  soundOn: boolean;
  /** Web Push subscription JSON, null until the user enables push. */
  pushSubscription: string | null;
  /** Phone / channel id the nag queue delivers WhatsApp nags to. */
  whatsappTarget: string | null;
};

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
  dailyQuotaSeconds: 2700,
  checkinIntervalSec: 300,
  checkinGraceSec: 60,
  focusSort: 'deadline',
  focusSkin: 'fractask',
  focusScope: 'due',
  soundOn: true,
  pushSubscription: null,
  whatsappTarget: null,
};

const FOCUS_KEYS = {
  dailyQuotaSeconds: 'focus_daily_quota_seconds',
  checkinIntervalSec: 'focus_checkin_interval_sec',
  checkinGraceSec: 'focus_checkin_grace_sec',
  focusSort: 'focus_sort',
  focusSkin: 'focus_skin',
  focusScope: 'focus_scope',
  soundOn: 'focus_sound_on',
  pushSubscription: 'focus_push_subscription',
  whatsappTarget: 'focus_whatsapp_target',
} as const;

function positiveIntOr(stored: string | null, fallback: number): number {
  const n = stored == null ? NaN : Number(stored);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function getFocusSettings(ctx: Context): Promise<FocusSettings> {
  const [quota, interval, grace, sort, skin, scope, sound, push, whatsapp] = await Promise.all([
    getSetting(ctx.userId, FOCUS_KEYS.dailyQuotaSeconds),
    getSetting(ctx.userId, FOCUS_KEYS.checkinIntervalSec),
    getSetting(ctx.userId, FOCUS_KEYS.checkinGraceSec),
    getSetting(ctx.userId, FOCUS_KEYS.focusSort),
    getSetting(ctx.userId, FOCUS_KEYS.focusSkin),
    getSetting(ctx.userId, FOCUS_KEYS.focusScope),
    getSetting(ctx.userId, FOCUS_KEYS.soundOn),
    getSetting(ctx.userId, FOCUS_KEYS.pushSubscription),
    getSetting(ctx.userId, FOCUS_KEYS.whatsappTarget),
  ]);
  const d = DEFAULT_FOCUS_SETTINGS;
  return {
    dailyQuotaSeconds: positiveIntOr(quota, d.dailyQuotaSeconds),
    checkinIntervalSec: positiveIntOr(interval, d.checkinIntervalSec),
    checkinGraceSec: positiveIntOr(grace, d.checkinGraceSec),
    focusSort:
      sort === 'deadline' || sort === 'goal' || sort === 'minutes' ? sort : d.focusSort,
    focusSkin: skin === 'game' || skin === 'fractask' ? skin : d.focusSkin,
    focusScope: scope === 'all' || scope === 'due' ? scope : d.focusScope,
    soundOn: sound == null ? d.soundOn : sound === '1',
    pushSubscription: push,
    whatsappTarget: whatsapp,
  };
}

export async function setFocusSettings(
  ctx: Context,
  patch: Partial<FocusSettings>,
): Promise<void> {
  const writes: Array<Promise<void>> = [];
  if (patch.dailyQuotaSeconds !== undefined) {
    writes.push(
      upsertSetting(
        ctx.userId,
        FOCUS_KEYS.dailyQuotaSeconds,
        String(Math.max(60, Math.floor(patch.dailyQuotaSeconds))),
      ),
    );
  }
  if (patch.checkinIntervalSec !== undefined) {
    writes.push(
      upsertSetting(
        ctx.userId,
        FOCUS_KEYS.checkinIntervalSec,
        String(Math.max(30, Math.floor(patch.checkinIntervalSec))),
      ),
    );
  }
  if (patch.checkinGraceSec !== undefined) {
    writes.push(
      upsertSetting(
        ctx.userId,
        FOCUS_KEYS.checkinGraceSec,
        String(Math.max(10, Math.floor(patch.checkinGraceSec))),
      ),
    );
  }
  if (patch.focusSort !== undefined) {
    writes.push(upsertSetting(ctx.userId, FOCUS_KEYS.focusSort, patch.focusSort));
  }
  if (patch.focusSkin !== undefined) {
    writes.push(upsertSetting(ctx.userId, FOCUS_KEYS.focusSkin, patch.focusSkin));
  }
  if (patch.focusScope !== undefined) {
    writes.push(upsertSetting(ctx.userId, FOCUS_KEYS.focusScope, patch.focusScope));
  }
  if (patch.soundOn !== undefined) {
    writes.push(upsertSetting(ctx.userId, FOCUS_KEYS.soundOn, patch.soundOn ? '1' : '0'));
  }
  if (patch.pushSubscription !== undefined) {
    writes.push(
      patch.pushSubscription === null
        ? deleteSetting(ctx.userId, FOCUS_KEYS.pushSubscription)
        : upsertSetting(ctx.userId, FOCUS_KEYS.pushSubscription, patch.pushSubscription),
    );
  }
  if (patch.whatsappTarget !== undefined) {
    writes.push(
      patch.whatsappTarget === null
        ? deleteSetting(ctx.userId, FOCUS_KEYS.whatsappTarget)
        : upsertSetting(ctx.userId, FOCUS_KEYS.whatsappTarget, patch.whatsappTarget),
    );
  }
  await Promise.all(writes);
}

/**
 * The user's personal override, if any. Returns null when the user is using
 * the global default.
 */
export async function getUserTaskGuidelines(ctx: Context): Promise<string | null> {
  return getSetting(ctx.userId, KEY_TASK_GUIDELINES);
}

export async function setUserTaskGuidelines(ctx: Context, value: string): Promise<void> {
  await upsertSetting(ctx.userId, KEY_TASK_GUIDELINES, value);
}

export async function clearUserTaskGuidelines(ctx: Context): Promise<void> {
  await deleteSetting(ctx.userId, KEY_TASK_GUIDELINES);
}

/**
 * What the MCP server should actually inject into tool descriptions: the
 * user's override if set, otherwise the global default.
 */
export async function getEffectiveTaskGuidelines(ctx: Context): Promise<string> {
  const personal = await getUserTaskGuidelines(ctx);
  if (personal !== null) return personal;
  return getGlobalTaskGuidelines();
}

/**
 * Tiptap `contentJson` example for the Brain notes section of the MCP server
 * instructions. Held outside the template literal so the triple-backtick fence
 * doesn't need to be escaped against the surrounding template.
 */
const BRAIN_NOTE_EXAMPLE_FENCE = [
  '```json',
  '{',
  '  "type": "doc",',
  '  "content": [',
  '    { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "Page title" }] },',
  '    { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Section" }] },',
  '    { "type": "paragraph", "content": [',
  '      { "type": "text", "text": "Plain " },',
  '      { "type": "text", "marks": [{ "type": "bold" }], "text": "bold" },',
  '      { "type": "text", "text": " and " },',
  '      { "type": "text", "marks": [{ "type": "italic" }], "text": "italic" },',
  '      { "type": "text", "text": " and a " },',
  '      { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }], "text": "link" },',
  '      { "type": "text", "text": "." }',
  '    ]},',
  '    { "type": "bulletList", "content": [',
  '      { "type": "listItem", "content": [',
  '        { "type": "paragraph", "content": [{ "type": "text", "text": "first item" }] }',
  '      ]},',
  '      { "type": "listItem", "content": [',
  '        { "type": "paragraph", "content": [{ "type": "text", "text": "second item" }] }',
  '      ]}',
  '    ]},',
  '    { "type": "blockquote", "content": [',
  '      { "type": "paragraph", "content": [{ "type": "text", "text": "callout text" }] }',
  '    ]},',
  '    { "type": "codeBlock", "content": [{ "type": "text", "text": "const x = 1;" }] },',
  '    { "type": "horizontalRule" }',
  '  ]',
  '}',
  '```',
].join('\n');

/**
 * Top-level operating instructions returned in the MCP `initialize` response.
 * MCP clients surface this to the agent as system-level guidance — it's the
 * one place to tell the agent, before any tool is even called, what this
 * server is for and where to put things.
 *
 * Composed from a fixed preamble (what Fractask is, when to reach for
 * `ask_human` / `attach_file_from_url`) plus the user-configurable task
 * guidelines so the same overrides flow everywhere.
 */
export async function getServerInstructions(ctx: Context): Promise<string> {
  const guidelines = await getEffectiveTaskGuidelines(ctx);
  return `# Fractask

You are connected to the user's Fractask task tree — a shared, durable workspace where every meaningful unit of work lives as a task. Read it, write to it, and don't keep important state only in chat.

## When to use this server

- **A question or approval needed from the human** (decision, yes/no, choice between options, pick an image) — and only once you've checked it's genuinely needed (see "Before you ask" in the guidelines below): call \`ask_human\` against the relevant task and **end your turn**. If the approval is about an outgoing message (email, WhatsApp, live-chat reply), you MUST pass \`template\` so the human reviews a realistic preview — see "Review templates" in the guidelines below. Do NOT ask the question only in chat — Fractask is the durable channel; chat is ephemeral. The task auto-moves to \`status="review"\` and surfaces as a worked card in the human's Focus queue (both approvals and questions land there, one at a time). On your next \`get_task\` the answer is in \`prompts[].answer\`. The human will then either mark the task \`done\` or send it back to \`doing\` — when you see it back at \`doing\`, continue the work.
- **A file, image, PDF, screenshot, or any artifact** worth keeping: call \`attach_file_from_url\` (or accept an upload through the web UI). The file is then visible to the human on the task and to future agent sessions via \`get_task(taskId).attachments\`.
- **A short status update, observation, or non-blocking reply to human feedback**: call \`post_comment(taskId, body)\`. Comments are the persistent conversation per task — a linear thread, humans and agents in the same stream. Use this when you'd otherwise dump a paragraph in chat the human will never see again. \`post_comment\` does NOT move the task to review; for a blocking decision still use \`ask_human\`.
- **Progress, decisions, or notes** that future-you or another agent will need: write them to the task's \`description\` (\`update_task\`) or as a child task. Cold-start sessions read from here, not from chat history.

## Status lifecycle

Active path: \`open\` → \`doing\` → \`review\` → \`done\`. Use \`review\` whenever the human needs to act (either via \`ask_human\` or because work is ready for approval). The human moves it forward; you don't have to flip status to \`done\` yourself unless the human delegated that explicitly.

Parked states (not in the active queue):
- \`backlog\` — "noted, not now, no schedule". Use when the user says "we'll do this later", "park this", "add to backlog", or when you're decomposing and a sub-task is real but clearly post-MVP. Backlog tasks don't show up in Today/Inbox/default subtask lists — they live in each parent's collapsible Backlog section.
- \`snoozed\` — hidden until a wake date/condition. Different from backlog: snooze has a *when*, backlog has no schedule.
- \`archived\` — dead, kept for reference.

If the user mentions "backlog" or "ideas pile" or "not now", create or move the task with \`status: "backlog"\` — don't park it as \`open\` (which would pollute their active queue).
- **A breakdown / plan**: create child tasks (\`create_task\` with \`parentId\`). Don't park a TODO list inside one task's description — split it.

## The Scratchpad (scratchpad_list / scratchpad_file)

The human has one page — the Scratchpad — where they dump raw ideas, goals and half-thoughts without deciding where they belong. It is a **queue for you**, not a task list. Whenever you start a session, run a digest, or the human says "check my notes / ideas / scratchpad", call \`scratchpad_list\` and work every \`new\` entry:

1. Read the tree first (\`list_tasks\` for entities/projects, \`get_task\` on the likely parent) so the idea lands in the **correct project or entity**, not at the root.
2. Act with the normal tools: \`create_task\` under that parent (kind \`goal\`/\`kpi\` when it is one), \`post_comment\`/\`update_task\` when it is detail for existing work, \`create_note\` when it is knowledge rather than work.
3. Then \`scratchpad_file(id, taskId, note)\` pointing at the task you created or placed it under, with a one-line note the human will read ("Created under Verikal › Website as 'Add pricing FAQ'").
4. Duplicate / already done / noise → \`scratchpad_dismiss(id, note)\`. Unclear which project → leave it \`new\` and mention it in your digest; never guess a home for it.

Never delete scratchpad entries. Never leave an entry \`new\` after you have created a task for it — that makes the human see it twice.

## Recurring work (daily / weekly)

For anything that repeats, set \`recurrence\` on \`create_task\`/\`update_task\` (needs a \`dueAt\` to anchor the schedule):
- Interval: \`1d\` (daily), \`1w\` (weekly), \`4h\`, \`1mo\`. Weekdays: \`weekdays\` (Mon–Fri) or a list like \`mon,wed,fri\`.
- \`recurrenceMode\` picks the behavior:
  - \`"checkbox"\` (default) — one rolling task for heartbeats / KPI check-ins. Marking it \`done\` rolls it to the next occurrence and logs the completion; the task itself stays.
  - \`"deliverable"\` — for repeating work that produces an artifact and/or needs per-day approval (a **daily social post**, **contact N leads**, a daily report). It becomes a **template**: a cron spawns ONE fresh child task each due day. Do that day's work **on the spawned instance** — attach the artifact, \`ask_human\` for approval — and complete it normally. Never work the template itself; only its daily instances.

Example — a weekday IG post needing approval: \`create_task(title:"Daily IG post", recurrence:"weekdays", recurrenceMode:"deliverable", dueAt:<first weekday>, assigneeId:<you>)\`. Each weekday morning you'll find a new open instance to fulfill.

## Read the task before you act

When the user mentions a task by name or id, call \`get_task(id)\` first. It returns the task, its direct children, its \`attachments\`, its \`prompts\`, and its \`comments\` — that's your full context. If \`prompts[]\` contains a pending entry where you are the asker, **don't repeat the question** — the human will answer it in the web UI.

## Check comments on review and resumed tasks

\`comments[]\` is the persistent conversation per task — short notes from humans and agents, oldest first. **Before you act on any task in \`status="review"\` or a task that was just bounced from \`review\` back to \`doing\`, scan the tail of \`comments[]\` first.** If the latest comments mean the work needs to change, reply with \`post_comment\` summarizing what you're doing about it before continuing. Don't silently override human feedback.

## Brain notes (create_note / update_note) — use contentJson, NOT markdown

Brain notes are rendered by a Tiptap editor. The editor has **native** support for h1/h2/h3, bold, italic, strike, inline code, bulleted and numbered lists, blockquote, code blocks, horizontal rules, and links. **It does not parse markdown.**

Pick the right field:

- \`contentText\` (string) — **plain text only.** Blank lines split paragraphs, single newlines become line breaks. That is the whole grammar. Any markdown you type — \`##\` headings, \`**bold**\`, \`- bullets\`, \`| table |\` — will be stored and displayed as **literal characters**. Use this only for unformatted prose.
- \`contentJson\` (Tiptap doc, preferred) — pass a proper doc and headings/bold/lists render as real headings/bold/lists. **This is what you want any time you'd reach for markdown.**

### contentJson shape

${BRAIN_NOTE_EXAMPLE_FENCE}

Rules of thumb:
- Headings: \`{type:"heading", attrs:{level: 1|2|3}, content:[…]}\`. Only levels 1, 2, 3 are configured.
- Lists: \`bulletList\` or \`orderedList\` → \`listItem\` → \`paragraph\` (don't put text directly inside listItem).
- Marks (\`bold\`, \`italic\`, \`strike\`, \`code\`, \`link\`) go on a text node's \`marks\` array. Combine them by listing multiple marks.
- Tables are **not** supported — flatten to headings + paragraphs or a bulleted list.
- Round-trip an existing note by calling \`get_note(id, format="json")\` first; you'll get the canonical \`contentJson\` back and can mutate it before \`update_note\`.

If you ever feel the urge to write \`## Heading\` or \`**bold**\` into \`contentText\`, stop and build a \`contentJson\` doc instead.

---

${guidelines}`;
}

/* ---------- UI mode (which frontend the user lands on) ---------- */

export type UiMode = 'simple' | 'full';
const KEY_UI_MODE = 'ui_mode';

/** Where `/` sends this user: the simple surface (/go) or the full app. null = never chose. */
export async function getUiMode(ctx: Context): Promise<UiMode | null> {
  const v = await getSetting(ctx.userId, KEY_UI_MODE);
  return v === 'simple' || v === 'full' ? v : null;
}

export async function setUiMode(ctx: Context, mode: UiMode): Promise<void> {
  await upsertSetting(ctx.userId, KEY_UI_MODE, mode);
}

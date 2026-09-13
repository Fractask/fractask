/**
 * The staff manager — the one piece of AI the simple frontend runs itself.
 *
 * Given a venture (name, concept, goal) it proposes the route: three
 * milestones on the way to the goal, the first concrete tasks under each,
 * and which agents from the library to hire for which lane. The human edits
 * and approves; `applyVenturePlan` in go.ts then writes it to the tree with
 * the ordinary primitives. Metered through the billing ledger.
 */
import { z } from 'zod';
import type { Context } from './context.js';
import { AGENT_TEMPLATES, suggestAgentTemplates, type AgentTemplateKey } from './agent-templates.js';
import { assertCanSpend, recordUsage } from './billing.js';
import { generateWithUsage, pickAvailableModel } from './llm.js';

const templateKeys = AGENT_TEMPLATES.map((t) => t.key) as [AgentTemplateKey, ...AgentTemplateKey[]];

export const venturePlanSchema = z.object({
  milestones: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        /** Which lane owns it — a template key, or null for the human. */
        owner: z.enum(templateKeys).nullable(),
        tasks: z.array(z.string().min(1).max(200)).min(1).max(5),
      }),
    )
    .min(1)
    .max(5),
  team: z
    .array(
      z.object({
        template: z.enum(templateKeys),
        /** One line: why this venture needs this role now. */
        why: z.string().min(1).max(240),
      }),
    )
    .max(4),
  /** A KPI worth checking weekly, or null when the goal has no obvious number. */
  kpi: z.string().min(1).max(160).nullable(),
});
export type VenturePlan = z.infer<typeof venturePlanSchema>;

export type PlanInput = { name: string; concept: string; goal: string; locale?: string };

const SYSTEM = `You are the staff manager of a small venture. You plan work the Fractask way:
- Start with the goal. Break it down as a duo. Chunk by three.
- A milestone is a stop on the route to the goal: a real, checkable state of the world, not a phase name.
- A task is one shippable thing someone can start today: imperative, single verb, no "and".
- Hire only the roles the next few weeks actually need. Two is common, four is the ceiling. The human is on the team already.
Answer with JSON only — no prose, no code fences.`;

function userPrompt(input: PlanInput): string {
  const library = AGENT_TEMPLATES.map((t) => `- ${t.key}: ${t.roleLine} — ${t.pitch}`).join('\n');
  return `Venture: ${input.name}
Concept: ${input.concept || '(none given)'}
Goal — what "done" looks like: ${input.goal}
${input.locale ? `Write titles in the same language as the goal (${input.locale}).` : 'Write titles in the same language as the goal.'}

Agent library (template keys):
${library}

Return exactly this JSON shape:
{
  "milestones": [
    { "title": "…", "owner": "<template key or null>", "tasks": ["…", "…", "…"] }
  ],
  "team": [ { "template": "<template key>", "why": "…" } ],
  "kpi": "… or null"
}
Rules: exactly 3 milestones in route order, 3 tasks each; team of 1–3 templates that also appear as milestone owners; every owner must be in the team.`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('The staff manager did not return a plan.');
  }
}

/** No-key / no-credit fallback: a plain three-stop route from the goal text plus tag-matched hires. */
export function fallbackPlan(input: PlanInput): VenturePlan {
  const picks = suggestAgentTemplates(`${input.name} ${input.concept} ${input.goal}`, 2);
  const lead = picks[0]?.key ?? null;
  return {
    milestones: [
      {
        title: `Decide the smallest version of "${input.goal}"`,
        owner: null,
        tasks: ['Write down who this is for', 'List what must be true to call it done', 'Pick the first thing to ship'],
      },
      {
        title: 'Ship the first version',
        owner: lead,
        tasks: ['Break the first version into three parts', 'Ship part one', 'Show it to three people'],
      },
      {
        title: `Reach the goal: ${input.goal}`,
        owner: lead,
        tasks: ['Fix what the first three people tripped on', 'Ship the remaining parts', 'Check the goal against reality'],
      },
    ],
    team: picks.map((t) => ({ template: t.key, why: t.pitch })),
    kpi: null,
  };
}

export type ProposedPlan = {
  plan: VenturePlan;
  /** 'ai' when a model produced it; 'fallback' when no provider key or no credit. */
  source: 'ai' | 'fallback';
  model: string | null;
  chargedCents: number;
};

/**
 * Ask the model for a plan; meter it; fall back to the tag-matched route
 * when there is no provider key configured. A wallet with no credit throws
 * InsufficientCreditError so the UI can offer a top-up instead of silently
 * degrading.
 */
export async function proposeVenturePlan(ctx: Context, input: PlanInput): Promise<ProposedPlan> {
  const model = pickAvailableModel(process.env['GO_STAFF_MODEL'] ?? null);
  if (!model) return { plan: fallbackPlan(input), source: 'fallback', model: null, chargedCents: 0 };

  await assertCanSpend(ctx, 1);
  const r = await generateWithUsage({
    modelId: model.id,
    system: SYSTEM,
    user: userPrompt(input),
    maxTokens: 1500,
  });
  const chargedCents = await recordUsage(ctx, { ref: 'staff_manager.plan', model: r.model, usage: r.usage });

  const parsed = venturePlanSchema.safeParse(extractJson(r.text));
  if (!parsed.success) {
    return { plan: fallbackPlan(input), source: 'fallback', model: model.id, chargedCents };
  }
  // Every milestone owner must be on the team — the model is asked, we enforce.
  const plan = parsed.data;
  const teamKeys = new Set(plan.team.map((t) => t.template));
  for (const m of plan.milestones) {
    if (m.owner && !teamKeys.has(m.owner)) {
      const t = AGENT_TEMPLATES.find((x) => x.key === m.owner)!;
      plan.team.push({ template: t.key, why: t.pitch });
      teamKeys.add(t.key);
    }
  }
  return { plan, source: 'ai', model: model.id, chargedCents };
}

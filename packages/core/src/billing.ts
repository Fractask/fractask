/**
 * Pay-per-token wallet for the simple frontend.
 *
 * The host runs AI on the user's behalf (the staff manager that plans a
 * venture and staffs it). Every such call is metered here at the provider's
 * list price times a markup, and deducted from a prepaid balance that is
 * topped up through Stripe. Agents the user connects with their own tokens
 * are never metered — that is their AI, not ours.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Context } from './context.js';
import { getDb } from './db/client.js';
import { billingAccounts, usageLedger, type UsageLedgerRow } from './schema.js';
import type { GenerateUsage, ModelOption } from './llm.js';

/** Starter credit for a brand-new wallet, in cents. Enough to plan a venture or two. */
export const STARTER_CREDIT_CENTS = Number(process.env['GO_STARTER_CREDIT_CENTS'] ?? 200);

/** Multiplier over provider list price. 2× keeps the unit economics honest. */
export const TOKEN_MARKUP = Number(process.env['GO_TOKEN_MARKUP'] ?? 2);

/** USD per million tokens, provider list price. Unknown models fall back to the most expensive row. */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

export function estimateCostCents(model: ModelOption | string, usage: GenerateUsage): number {
  const key = typeof model === 'string' ? model : model.model;
  const price = PRICE_PER_MTOK[key] ?? { input: 15, output: 75 };
  const usd =
    ((usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000) * TOKEN_MARKUP;
  // Never bill zero for a real call — a cent is the floor.
  return Math.max(1, Math.ceil(usd * 100));
}

export type Wallet = {
  balanceCents: number;
  /** True when the wallet was just created and the starter credit landed. */
  fresh: boolean;
};

/** The user's wallet, created with the starter credit on first touch. */
export async function getWallet(ctx: Context): Promise<Wallet> {
  const db = getDb();
  const rows = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, ctx.userId));
  if (rows[0]) return { balanceCents: rows[0].balanceCents, fresh: false };
  const ts = Date.now();
  await db.insert(billingAccounts).values({
    userId: ctx.userId,
    balanceCents: 0,
    stripeCustomerId: null,
    createdAt: ts,
    updatedAt: ts,
  });
  if (STARTER_CREDIT_CENTS > 0) {
    await credit(ctx.userId, { ref: 'starter', cents: STARTER_CREDIT_CENTS });
  }
  return { balanceCents: STARTER_CREDIT_CENTS, fresh: true };
}

export class InsufficientCreditError extends Error {
  constructor(public readonly balanceCents: number) {
    super('Not enough credit — top up to keep going.');
    this.name = 'InsufficientCreditError';
  }
}

/** Throws when the wallet can't cover a call. The check is soft (pre-call, estimated). */
export async function assertCanSpend(ctx: Context, minCents = 1): Promise<void> {
  const w = await getWallet(ctx);
  if (w.balanceCents < minCents) throw new InsufficientCreditError(w.balanceCents);
}

/** Meter one AI call: ledger row + balance decrement. Returns the cents charged. */
export async function recordUsage(
  ctx: Context,
  input: { ref: string; model: ModelOption; usage: GenerateUsage },
): Promise<number> {
  const cents = estimateCostCents(input.model, input.usage);
  const db = getDb();
  const ts = Date.now();
  await getWallet(ctx);
  await db.insert(usageLedger).values({
    id: nanoid(12),
    userId: ctx.userId,
    kind: 'usage',
    ref: input.ref,
    model: input.model.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    costCents: -cents,
    stripeSessionId: null,
    createdAt: ts,
  });
  await db
    .update(billingAccounts)
    .set({ balanceCents: sql`${billingAccounts.balanceCents} - ${cents}`, updatedAt: ts })
    .where(eq(billingAccounts.userId, ctx.userId));
  return cents;
}

async function credit(
  userId: string,
  input: { ref: string; cents: number; stripeSessionId?: string },
): Promise<boolean> {
  const db = getDb();
  const ts = Date.now();
  if (input.stripeSessionId) {
    const dupe = await db
      .select({ id: usageLedger.id })
      .from(usageLedger)
      .where(eq(usageLedger.stripeSessionId, input.stripeSessionId));
    if (dupe[0]) return false;
  }
  await db.insert(usageLedger).values({
    id: nanoid(12),
    userId,
    kind: 'credit',
    ref: input.ref,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costCents: input.cents,
    stripeSessionId: input.stripeSessionId ?? null,
    createdAt: ts,
  });
  await db
    .update(billingAccounts)
    .set({ balanceCents: sql`${billingAccounts.balanceCents} + ${input.cents}`, updatedAt: ts })
    .where(eq(billingAccounts.userId, userId));
  return true;
}

/**
 * Credit a completed Stripe Checkout. Idempotent on the session id, so the
 * webhook and the success-page fallback can both call it. Returns false when
 * the session was already credited. Not ctx-scoped: the webhook has no session.
 */
export async function recordPayment(input: {
  userId: string;
  stripeSessionId: string;
  amountCents: number;
  stripeCustomerId?: string | null;
}): Promise<boolean> {
  const db = getDb();
  await getWallet({ userId: input.userId });
  if (input.stripeCustomerId) {
    await db
      .update(billingAccounts)
      .set({ stripeCustomerId: input.stripeCustomerId })
      .where(and(eq(billingAccounts.userId, input.userId), sql`${billingAccounts.stripeCustomerId} IS NULL`));
  }
  return credit(input.userId, {
    ref: 'stripe',
    cents: input.amountCents,
    stripeSessionId: input.stripeSessionId,
  });
}

export async function listLedger(ctx: Context, limit = 30): Promise<UsageLedgerRow[]> {
  const db = getDb();
  return db
    .select()
    .from(usageLedger)
    .where(eq(usageLedger.userId, ctx.userId))
    .orderBy(desc(usageLedger.createdAt))
    .limit(limit);
}

export type UsageSummary = {
  balanceCents: number;
  spentCents30d: number;
  calls30d: number;
  tokens30d: number;
};

export async function getUsageSummary(ctx: Context): Promise<UsageSummary> {
  const w = await getWallet(ctx);
  const db = getDb();
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const rows = await db
    .select({
      spent: sql<number>`COALESCE(SUM(CASE WHEN ${usageLedger.kind} = 'usage' THEN -${usageLedger.costCents} ELSE 0 END), 0)`,
      calls: sql<number>`COALESCE(SUM(CASE WHEN ${usageLedger.kind} = 'usage' THEN 1 ELSE 0 END), 0)`,
      tokens: sql<number>`COALESCE(SUM(${usageLedger.inputTokens} + ${usageLedger.outputTokens}), 0)`,
    })
    .from(usageLedger)
    .where(and(eq(usageLedger.userId, ctx.userId), sql`${usageLedger.createdAt} >= ${since}`));
  const r = rows[0];
  return {
    balanceCents: w.balanceCents,
    spentCents30d: Number(r?.spent ?? 0),
    calls30d: Number(r?.calls ?? 0),
    tokens30d: Number(r?.tokens ?? 0),
  };
}

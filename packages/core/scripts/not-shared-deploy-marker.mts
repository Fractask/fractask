/**
 * The `not_shared` deploy marker, as a command instead of a hand-typed census.
 *
 * `Tx5g85uLq96D` is held behind a deploy. Its cheapest signal is that a tool
 * which now ANSWERS `not_shared` also SAYS so in the description `tools/list`
 * serves — so the marker is: how many of prod's tool descriptions carry the
 * string, against how many of this tree's do.
 *
 * ## ⚠️ 2026-09-14 18:4xZ — that "so" is a PROXY, and it was measured false
 *
 * This script reads what a tool SAYS. The card is about what a tool ANSWERS.
 * Two objects, and on prod today they disagree:
 *
 * ```
 *   ANSWERS not_shared (measured, subject TfmR7QJFqluo)   6 of 7 probed tools
 *   SAYS    not_shared (this script, tools/list)          1 of 32
 * ```
 *
 * So this marker's red is true — prod's descriptions ARE behind — but for 27
 * hours it was quoted as if it meant the *behaviour* had not shipped, and the
 * behaviour had. Do not read a NOT_DEPLOYED here as "an agent can still be
 * told not_found for a task that exists": that question is answered by
 * `npm run not-shared-behaviour` (`not-shared-behaviour-probe.mts`), which
 * calls the tools instead of reading their prose. Run and quote BOTH; neither
 * substitutes for the other.
 *
 * The one thing the behaviour probe finds still broken on prod is the
 * COLLECTION half — `list_tasks(parentId=<not shared>)` answers `[]`, which is
 * the success shape. That is what this deploy is actually still carrying.
 *
 * ## Why this is a file and not four lines of shell
 *
 * The census was re-typed by hand every hour for a day, and the figure it
 * carried — *"`1 of 32 → 2 of 32` remains the cheapest signal this card has"* —
 * went stale silently. `2 of 32` is the number of documented tools this tree
 * had when that sentence was written. Measured 2026-09-14 10:4xZ this tree has
 * **5** and carries **39** tools against prod's 32, so the target was wrong in
 * both terms: a runner who saw `5 of 39` after a perfect deploy had no way to
 * tell "it shipped" from "something else shipped". A remembered target rots; a
 * DERIVED one cannot. This script never states an expected value — it reads
 * the local side as the target, every run.
 *
 * ## The three controls, and why a NOT-DEPLOYED verdict needs all of them
 *
 *  - **POPULATION.** `n tools = 0` is not a small census, it is no census. A
 *    zero denominator exits 2, never 1.
 *  - **AUTH.** A garbage bearer returns a well-formed 403, and a 403 parses
 *    into zero tools, zero matches — i.e. into NOT-DEPLOYED, which is the
 *    alarming reading. If the real run is indistinguishable from the garbage
 *    control, the reading is VOID (exit 2), not negative. This has fired for
 *    real: an empty token once printed "the work has been reverted on prod".
 *  - **MATCHER.** A string no description contains must count 0, or the
 *    matcher's zeroes mean nothing.
 *
 * ## ⚠️ 2026-09-18 09:4xZ — the headline number RISES WHEN YOU DO THE WORK
 *
 * `missing` is `local.documented \ prod.documented`. Prod is frozen between
 * deploys, so that set is monotonically increasing in how much THIS TREE
 * documents. Measured this run: 4 today, and `not-shared-doc-gap` names 13
 * more tools that answer `not_shared` and never say it — writing those 13
 * sentences, a correct and wanted local repair, takes the old headline from
 * *"prod is missing 4"* to *"prod is missing 17"* with nothing deployed and
 * nothing on prod changed.
 *
 * The EXIT CODE is not keyed on that — it was 1 before the repair and 1 after,
 * because `missing.length > 0` either way. It is the sentence a human reads
 * that moves, and it moves in the alarming direction. So the repair is to the
 * sentence, not to the gate:
 *
 *  - the reason carries its own DENOMINATOR (`behind by N of M documented
 *    here`), so N cannot be read as a size without M beside it;
 *  - `missing` is split into `deployableNow` (prod's build HAS the tool — a
 *    description deploy carries it) and `needsCodeFirst` (prod's build lacks
 *    the tool; no description deploy can close it). Both derived on the same
 *    run, no remembered value;
 *  - `regressedOnProd` — documented on prod, not here — is printed on EVERY
 *    run including at zero. It is the only number in this report whose growth
 *    is bad news about prod. Without it the reader has no channel that can
 *    ever say "prod went backwards", and reads growth in `missing` as that.
 *
 * ## Exit codes
 *
 *   0  DEPLOYED       every locally-documented tool is documented on prod too
 *   1  NOT DEPLOYED   prod is behind on at least one, and all three controls held
 *   2  INCONCLUSIVE   a control failed or the transport did not answer
 *
 * Run from packages/core:
 *   npx tsx scripts/not-shared-deploy-marker.mts
 *   npx tsx scripts/not-shared-deploy-marker.mts --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TOOLS } from '../src/mcp-tools.ts';

export const MARKER = 'not_shared';

/** A token no description contains — the matcher's negative control. */
export const MATCHER_NEG_CTL = 'zzz_no_such_marker_token';

/** The bearer used for the auth control. Must not be a real token. */
export const AUTH_NEG_CTL_TOKEN = 'Bearer zzz-not-a-token';

export type ListedTool = { name: string; description?: string };

export type Side = {
  /** Total tools enumerated. Zero means "no census", not "a small one". */
  total: number;
  /** Names whose description carries the marker, sorted. */
  documented: string[];
};

export type Verdict = {
  status: 'DEPLOYED' | 'NOT_DEPLOYED' | 'INCONCLUSIVE';
  reason: string;
  /** Locally-documented tools prod does not document. Empty on DEPLOYED. */
  missing: string[];
  /**
   * `missing` where prod's build HAS the tool — a description deploy carries
   * these as they stand.
   */
  deployableNow: string[];
  /**
   * `missing` where prod's build does not carry the tool at all. No
   * description deploy can close these; the code has to land first.
   */
  needsCodeFirst: string[];
  /**
   * Documented on PROD and NOT in this tree. The ONLY set whose growth means
   * prod went BACKWARDS — every other number here grows when this tree
   * improves. Printed at zero on purpose.
   */
  regressedOnProd: string[];
  /** Tools this tree has that prod's build does not carry at all. */
  onlyLocal: string[];
  /** Tools prod carries that this tree does not — a backwards deploy. */
  onlyProd: string[];
};

/** Count the marker over one side. Pure, so the tests can drive it. */
export function censusSide(tools: ListedTool[]): Side {
  return {
    total: tools.length,
    documented: tools
      .filter((t) => (t.description ?? '').includes(MARKER))
      .map((t) => t.name)
      .sort(),
  };
}

/**
 * Decide, from both sides plus both control readings.
 *
 * `authControlSameAsReal` is the load-bearing argument: when a garbage bearer
 * produces the same response shape as the real call, the real call measured
 * the credential, not the deploy.
 */
export function decide(args: {
  local: Side;
  prod: Side;
  prodNames: string[];
  localNames: string[];
  authControlSameAsReal: boolean;
  matcherControlHits: number;
}): Verdict {
  const { local, prod, prodNames, localNames } = args;
  const onlyLocal = localNames.filter((n) => !prodNames.includes(n));
  const onlyProd = prodNames.filter((n) => !localNames.includes(n));
  const missing = local.documented.filter((n) => !prod.documented.includes(n));
  // `missing` fuses two causes that move in opposite directions: prod falling
  // behind, and this tree documenting more. Split on the SAME run — no
  // remembered previous value, which this script is not allowed to keep.
  const deployableNow = missing.filter((n) => prodNames.includes(n));
  const needsCodeFirst = missing.filter((n) => !prodNames.includes(n));
  // The opposite direction. This is the only set here whose growth is bad news
  // about PROD; `missing` grows when somebody does the work locally.
  const regressedOnProd = prod.documented.filter((n) => !local.documented.includes(n));
  const base = { missing, deployableNow, needsCodeFirst, regressedOnProd, onlyLocal, onlyProd };

  // The auth control is tested FIRST on purpose. A 403 parses into zero tools,
  // so it trips the population guard too — and "no denominator" is a true but
  // useless sentence that sends the reader to look at prod. "Your credential
  // did not work" is the one that names the actual cause. Both exit 2; only
  // one of them is a diagnosis.
  if (args.authControlSameAsReal) {
    return {
      status: 'INCONCLUSIVE',
      reason:
        'the garbage-bearer control returned the SAME response as the real call — ' +
        'this run measured the credential, not the deploy',
      ...base,
    };
  }
  if (prod.total === 0) {
    return { status: 'INCONCLUSIVE', reason: 'prod enumerated 0 tools — no denominator', ...base };
  }
  if (local.total === 0) {
    return { status: 'INCONCLUSIVE', reason: 'this tree enumerated 0 tools — no target', ...base };
  }
  if (args.matcherControlHits !== 0) {
    return {
      status: 'INCONCLUSIVE',
      reason: `the matcher control matched ${args.matcherControlHits} description(s) — its zeroes prove nothing`,
      ...base,
    };
  }
  if (local.documented.length === 0) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'this tree documents the marker on 0 tools — there is nothing for a deploy to carry',
      ...base,
    };
  }
  return missing.length === 0
    ? { status: 'DEPLOYED', reason: 'prod documents every tool this tree does', ...base }
    : {
        status: 'NOT_DEPLOYED',
        // NOT "prod is missing N". N is |local.documented \ prod.documented|,
        // so with prod frozen it rises every time this tree documents another
        // tool — the alarming direction is "somebody did the work". The
        // sentence carries its own denominator and names which side moved.
        reason:
          `the deploy is BEHIND by ${missing.length} of the ${local.documented.length} ` +
          `description(s) this tree documents — prod carries ${local.documented.length - missing.length}` +
          `; prod documents ${regressedOnProd.length} this tree does not`,
        ...base,
      };
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

/** Read the MCP endpoint + bearer out of the agent's own config. */
export function readEndpoint(): { url: string; auth: string } {
  const url = process.env.GETSHIT_MCP_URL;
  const envTok = process.env.GETSHIT_TOKEN;
  // An EMPTY env var is the exact shape that produced the false regression on
  // 2026-09-14 09:4x, so it is treated as absent rather than as a credential.
  if (url && envTok) return { url, auth: `Bearer ${envTok}` };

  const cfg = path.join(os.homedir(), '.claude.json');
  const raw = JSON.parse(fs.readFileSync(cfg, 'utf8')) as unknown;
  let found: { url?: string; headers?: Record<string, string> } | undefined;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'getshit' && v && typeof v === 'object' && 'url' in (v as object)) {
        found = v as { url?: string; headers?: Record<string, string> };
      }
      walk(v);
    }
  };
  walk(raw);
  const auth = found?.headers?.['Authorization'] ?? found?.headers?.['authorization'];
  if (!found?.url || !auth) {
    throw new Error(`no getshit MCP endpoint with an Authorization header in ${cfg}`);
  }
  return { url: found.url, auth };
}

export type Response = { status: number; bytes: number; sha256: string; tools: ListedTool[] };

/** One `tools/list` call. Never throws on a non-200 — the status IS data. */
export async function listTools(url: string, auth: string): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: auth,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await res.text();
  const sha256 = createHash('sha256').update(text).digest('hex');
  let tools: ListedTool[] = [];
  try {
    // The endpoint answers either bare JSON or an SSE frame.
    const body = text.startsWith('event:')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n')
      : text;
    tools = (JSON.parse(body)?.result?.tools ?? []) as ListedTool[];
  } catch {
    tools = [];
  }
  return { status: res.status, bytes: Buffer.byteLength(text), sha256, tools };
}

/* ------------------------------------------------------------------ */
/* cli                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const asJson = process.argv.includes('--json');
  const { url, auth } = readEndpoint();

  const real = await listTools(url, auth);
  const control = await listTools(url, AUTH_NEG_CTL_TOKEN);
  // Same status AND same body hash ⇒ the two calls are indistinguishable, so
  // whatever the real one said, it said about the credential.
  const authControlSameAsReal = real.status === control.status && real.sha256 === control.sha256;

  const prod = censusSide(real.tools);
  const local = censusSide(TOOLS as unknown as ListedTool[]);
  const matcherControlHits = [...real.tools, ...(TOOLS as unknown as ListedTool[])].filter((t) =>
    (t.description ?? '').includes(MATCHER_NEG_CTL),
  ).length;

  const verdict = decide({
    local,
    prod,
    prodNames: real.tools.map((t) => t.name),
    localNames: (TOOLS as unknown as ListedTool[]).map((t) => t.name),
    authControlSameAsReal,
    matcherControlHits,
  });

  const code = verdict.status === 'DEPLOYED' ? 0 : verdict.status === 'NOT_DEPLOYED' ? 1 : 2;

  if (asJson) {
    console.log(JSON.stringify({ url, real: { ...real, tools: undefined }, prod, local, verdict }, null, 2));
    return code;
  }

  const glyph = { DEPLOYED: '🟢', NOT_DEPLOYED: '🔴', INCONCLUSIVE: '⛔' }[verdict.status];
  console.log(`# not_shared deploy marker — ${url}`);
  console.log(`  transport   http ${real.status} · ${real.bytes} B · sha ${real.sha256}`);
  console.log(`  POPULATION  prod ${prod.total} tool(s) · this tree ${local.total}`);
  console.log(
    `  AUTH  CTL   garbage bearer → http ${control.status} · ${control.bytes} B` +
      (authControlSameAsReal ? '   ⛔ IDENTICAL to the real call' : '   ✅ distinguishable'),
  );
  console.log(`  MATCH CTL   "${MATCHER_NEG_CTL}" → ${matcherControlHits} description(s)`);
  console.log('');
  console.log(`  documented on prod        ${prod.documented.length} of ${prod.total}   ${prod.documented.join(', ') || '—'}`);
  console.log(`  documented in this tree   ${local.documented.length} of ${local.total}   ${local.documented.join(', ') || '—'}`);
  console.log('');
  console.log(`  ${glyph} ${verdict.status} — ${verdict.reason}`);
  // With no prod census, every local tool trivially reads as "missing" and
  // "only local". Those are facts about the empty answer, not about the build,
  // and printing them as a 39-item to-do list would be a finding invented by a
  // failed fetch.
  if (prod.total === 0) {
    console.log('     (set differences suppressed — prod returned no tool list to difference against)');
    return code;
  }
  if (verdict.missing.length) {
    console.log(`     behind on prod:  ${verdict.missing.join(', ')}`);
    console.log(
      `       deployable now (prod's build HAS the tool)   ${verdict.deployableNow.length}` +
        (verdict.deployableNow.length ? `: ${verdict.deployableNow.join(', ')}` : ''),
    );
    console.log(
      `       needs the CODE deploy first (prod lacks it)  ${verdict.needsCodeFirst.length}` +
        (verdict.needsCodeFirst.length ? `: ${verdict.needsCodeFirst.join(', ')}` : ''),
    );
  }
  // Printed at zero on purpose, and printed on DEPLOYED too. Every other
  // number above rises when THIS TREE documents another tool; this is the one
  // that can only rise when prod has something this tree lost.
  console.log(
    `     documented on PROD and not here  ${verdict.regressedOnProd.length}` +
      (verdict.regressedOnProd.length ? `: ${verdict.regressedOnProd.join(', ')}   ⚠ prod is AHEAD` : '   ← the only shape that means prod regressed'),
  );
  if (verdict.onlyLocal.length) {
    console.log(
      `     tools this tree has and prod's build does not (${verdict.onlyLocal.length}): ${verdict.onlyLocal.join(', ')}`,
    );
  }
  if (verdict.onlyProd.length) {
    console.log(`     ⚠ tools PROD has and this tree does not: ${verdict.onlyProd.join(', ')}`);
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      console.error(`⛔ INCONCLUSIVE — ${String(e)}`);
      process.exit(2);
    },
  );
}

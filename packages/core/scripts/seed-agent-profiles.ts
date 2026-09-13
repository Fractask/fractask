/**
 * Seeds `agent_profiles` with the fleet roster (the 2026-08-30 corrected org:
 * 7 groups, 17 desks incl. the Jibin manager row).
 *
 * Rules learned from the "empty floor" incident (project xY94MjuhfTYx):
 *  - user ids are NEVER hardcoded or invented — every desk resolves against
 *    the live `users` table by name (case-insensitive, kind=agent);
 *  - a desk whose user is missing is SKIPPED WITH A LOUD WARNING, not seeded
 *    with a made-up id (an unresolvable row used to silently shrink the floor;
 *    getOfficeOrg now also renders any bad row as a red "unlinked" desk);
 *  - after seeding, every profile row is verified to join `users`, and every
 *    charter id to exist in `tasks` — problems print as ⚠️ lines.
 *
 * Idempotent: profiles upsert by user id. No users are created here — putting
 * someone on the floor requires their agent user to exist first (token
 * provisioning stays a deliberate act).
 *
 * Run: GETSHIT_DB_URL=... [GETSHIT_DB_AUTH_TOKEN=...] npx tsx scripts/seed-agent-profiles.ts
 */
import { eq, inArray } from 'drizzle-orm';
import { getDb, getDbUrl } from '../src/db/client.js';
import { agentProfiles, tasks, users } from '../src/schema.js';

type Seed = {
  /** Must match a kind=agent users row by name, case-insensitively. */
  name: string;
  group: string;
  role: string;
  charter?: string;
  sub?: number;
  box?: string;
  brainScopes?: string[];
  managesFleet?: boolean; // the reports-to-Joel manager row
};

// Charter/scope task ids are prod ids; harmless in a dev DB (the columns stay
// set, joins simply find nothing — and the verify pass warns about them).
const SEEDS: Seed[] = [
  { name: 'jibin', group: 'MANAGEMENT', role: 'Chief of Staff', charter: 'j_RXKFKcnWm-', managesFleet: true },
  // HQ OFFICE
  { name: 'harry', group: 'HQ OFFICE', role: 'Accountant', charter: 'kF6I7lbWpg9p', box: 'ubuntu-4gb-hel1-1', brainScopes: ['Zkbjg8tCF1mv'] },
  { name: 'Yoel', group: 'HQ OFFICE', role: 'Dev agent' },
  // VERIKAL
  { name: 'Jason', group: 'VERIKAL', role: 'Paid acquisition', charter: '7jMTOTZUiBVl', box: 'jason-marketing', brainScopes: ['XKUK6IUDLY6j'] },
  { name: 'website-builder', group: 'VERIKAL', role: 'verikal.com', charter: 'Tuvlpx8Dw8jg', box: 'yoel', brainScopes: ['XKUK6IUDLY6j'] },
  { name: 'seo-geo', group: 'VERIKAL', role: 'SEO / GEO / AEO', charter: 'IHzuO6ASTSD9', box: 'box157', brainScopes: ['XKUK6IUDLY6j'] },
  { name: 'social-media', group: 'VERIKAL', role: 'Organic · multi-brand', charter: 'NMV9f1q45eMa', sub: 7, box: 'social-media', brainScopes: ['XKUK6IUDLY6j', 'udK6cbtkyXDb', 'aBhXuGE8UwdQ'] },
  // SALES
  { name: 'sdr', group: 'SALES', role: 'Outbound box', charter: 'avoa4cDSSD43', sub: 3, box: 'kitkoo-sales', brainScopes: ['XKUK6IUDLY6j', 'udK6cbtkyXDb', 'aBhXuGE8UwdQ'] },
  // FELIX · CLIENT
  { name: 'felix', group: 'FELIX · CLIENT', role: 'Coordinator', charter: 'pbyq2paaBIgP', box: 'underoutfit', brainScopes: ['G1SW51a2GdzL', 'LmQcrXGVhciF'] },
  { name: 'underoutfit', group: 'FELIX · CLIENT', role: 'Brand agent', charter: 'fYn-ITDZ8Tow', box: 'underoutfit', brainScopes: ['G1SW51a2GdzL'] },
  { name: 'version7b', group: 'FELIX · CLIENT', role: 'Brand agent', charter: 'aw5fsLvRMd-v', box: 'underoutfit', brainScopes: ['LmQcrXGVhciF'] },
  // STORES
  { name: 'inkjet-shopify', group: 'STORES', role: 'Inkjet Coating', charter: '_dilSIYJfAPl', box: 'inkjet', brainScopes: ['aBhXuGE8UwdQ'] },
  { name: 'shopify-general', group: 'STORES', role: 'In-house stores', charter: 'HJrHCaAMw9i0', brainScopes: ['udK6cbtkyXDb'] },
  { name: 'video-editor', group: 'STORES', role: 'Video Editor desk', charter: 'KGBzjyVbhXzG', box: 'whatsappvideo', brainScopes: ['XKUK6IUDLY6j'] },
  // JERRY & JOEL
  { name: 'jerry', group: 'JERRY & JOEL', role: 'Portfolio ops', charter: 'kQ1Fj3xDf2R8', sub: 7, box: 'jerry-incentive', brainScopes: ['NyOH_RTkbuXP'] },
  // PERSONAL
  { name: 'shava', group: 'PERSONAL', role: 'Israel Shava', charter: '790fsJmIN-a6', box: 'shava', brainScopes: ['WENUmP3dhsR1'] },
  { name: 'joel-hackett', group: 'PERSONAL', role: 'Wholesale shop' },
];

async function main() {
  const db = getDb();
  console.log(`Seeding agent_profiles on ${getDbUrl()}`);

  const agents = await db.select().from(users).where(eq(users.kind, 'agent'));
  const byName = new Map(agents.map((u) => [(u.name ?? '').toLowerCase(), u]));

  const warnings: string[] = [];
  const resolved: { seed: Seed; userId: string }[] = [];
  let managerUserId: string | null = null;
  for (const seed of SEEDS) {
    const user = byName.get(seed.name.toLowerCase());
    if (!user) {
      warnings.push(
        `⚠️  SKIPPED "${seed.name}" (${seed.group}) — no kind=agent user with that name. ` +
          'Create the agent user first, then re-run; ids are never invented.',
      );
      continue;
    }
    if (seed.managesFleet) managerUserId = user.id;
    resolved.push({ seed, userId: user.id });
  }
  if (managerUserId === null) {
    warnings.push('⚠️  No manager row resolved (managesFleet) — reportsTo will be NULL for everyone.');
  }

  let sort = 0;
  for (const { seed, userId } of resolved) {
    sort += 10;
    const values = {
      groupName: seed.group,
      roleLine: seed.role,
      reportsTo: seed.managesFleet ? null : managerUserId,
      charterTaskId: seed.charter ?? null,
      subAgents: seed.sub ?? 0,
      box: seed.box ?? null,
      brainScopeTaskIds: seed.brainScopes ? JSON.stringify(seed.brainScopes) : null,
      sort,
    };
    await db
      .insert(agentProfiles)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: agentProfiles.userId, set: values });
  }

  // Verify pass — the whole table, not just what we wrote, so pre-existing
  // garbage surfaces too.
  const all = await db
    .select({ profile: agentProfiles, user: users })
    .from(agentProfiles)
    .leftJoin(users, eq(users.id, agentProfiles.userId));
  for (const r of all) {
    if (!r.user) {
      warnings.push(`⚠️  agent_profiles row ${r.profile.userId} does not join users — red "unlinked" desk on the floor.`);
    } else if (r.user.kind !== 'agent') {
      warnings.push(`⚠️  agent_profiles row ${r.profile.userId} ("${r.user.name}") points at a ${r.user.kind} user, not an agent.`);
    }
  }
  const charterIds = [...new Set(all.map((r) => r.profile.charterTaskId).filter((c): c is string => c !== null))];
  if (charterIds.length > 0) {
    const found = new Set(
      (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, charterIds))).map((t) => t.id),
    );
    for (const r of all) {
      const c = r.profile.charterTaskId;
      if (c && !found.has(c)) {
        warnings.push(`⚠️  charter task ${c} (desk ${r.user?.name ?? r.profile.userId}) does not exist in tasks.`);
      }
    }
  }

  for (const w of warnings) console.warn(w);
  console.log(
    `Done: ${resolved.length}/${SEEDS.length} profiles upserted, ${SEEDS.length - resolved.length} skipped, ` +
      `${warnings.length} warning(s); ${all.length} rows now on the floor.`,
  );
  if (warnings.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

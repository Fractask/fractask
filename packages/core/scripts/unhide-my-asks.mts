/**
 * Make every pending ask reachable by the human it is addressed to.
 *
 * Agents that create their own root trees own work Joel was never shared on,
 * so their `ask_human` prompts sit pending forever: invisible in /reviews and
 * /focus, and their "open" links 404. This walks every pending prompt, and
 * where the human cannot reach the task, shares that task's ROOT with them
 * (sharing cascades down the subtree).
 *
 * Additive and reversible — it only inserts task_shares rows.
 *
 * Run from packages/core:
 *   npx tsx scripts/unhide-my-asks.mts           # preview
 *   npx tsx scripts/unhide-my-asks.mts --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.GETSHIT_DB_URL) {
  const envFile = path.join(__dirname, '../../web/.env.local');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}

const APPLY = process.argv.includes('--apply');
const HUMAN = process.env.GETSHIT_HUMAN_ID ?? 'zDNBp6zwzoa7'; // joel@combinaz.com

const db = createClient({
  url: process.env.GETSHIT_DB_URL!,
  authToken: process.env.GETSHIT_DB_AUTH_TOKEN,
});

async function accessible(): Promise<Set<string>> {
  const r = await db.execute({
    sql: `WITH RECURSIVE roots(id) AS (
      SELECT id FROM tasks WHERE user_id = ?1
      UNION SELECT task_id FROM task_shares WHERE user_id = ?1
      UNION SELECT id FROM tasks WHERE assignee_id = ?1
      UNION SELECT id FROM tasks WHERE reviewer_id = ?1
    ), accessible(id) AS (
      SELECT id FROM roots UNION SELECT t.id FROM tasks t JOIN accessible a ON t.parent_id = a.id
    ) SELECT id FROM accessible`,
    args: [HUMAN],
  });
  return new Set(r.rows.map((x) => x.id as string));
}

const ok = await accessible();
const pending = await db.execute(`
  SELECT p.id, p.task_id, t.title, u.name AS asker
  FROM agent_prompts p
  JOIN tasks t ON t.id = p.task_id
  LEFT JOIN users u ON u.id = p.asked_by_user_id
  WHERE p.status = 'pending'
`);

const hidden = pending.rows.filter((r) => !ok.has(r.task_id as string));
console.log(`pending asks: ${pending.rows.length} · unreachable: ${hidden.length}`);

const rootsToShare = new Map<string, string>(); // rootId -> title
for (const h of hidden) {
  let cur = h.task_id as string;
  let root = cur;
  for (let i = 0; i < 60; i++) {
    const q = await db.execute({ sql: 'SELECT parent_id, title FROM tasks WHERE id = ?', args: [cur] });
    const row = q.rows[0];
    if (!row) break;
    root = cur;
    const parent = row.parent_id as string | null;
    if (!parent) break;
    cur = parent;
  }
  const t = await db.execute({ sql: 'SELECT title FROM tasks WHERE id = ?', args: [root] });
  rootsToShare.set(root, String(t.rows[0]?.title ?? root));
  console.log(`  🚫 ${h.asker} · "${h.title}"  → share root "${t.rows[0]?.title}" (${root})`);
}

if (APPLY && rootsToShare.size > 0) {
  const now = Date.now();
  for (const [rootId] of rootsToShare) {
    await db.execute({
      sql: 'INSERT INTO task_shares (task_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      args: [rootId, HUMAN, now],
    });
  }
  const after = await accessible();
  const still = hidden.filter((h) => !after.has(h.task_id as string));
  console.log(`\nSHARED ${rootsToShare.size} roots · still unreachable: ${still.length}`);
} else {
  console.log(`\n${rootsToShare.size} roots would be shared   (re-run with --apply)`);
}

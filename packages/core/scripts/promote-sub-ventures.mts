/**
 * Promote department venture-ideas from `project` to `entity` (2026-08-31).
 *
 * A sub-venture is an entity nested inside another entity — that is the whole
 * definition. The seven department buckets Joel created hold their venture
 * ideas as projects, so they render as work-inside-a-venture instead of
 * ventures-inside-a-department.
 *
 * The rule is deliberately narrow: only entities whose charter child is a
 * "📕 Department charter" are treated as departments. Real ventures
 * (Verikal, Kitkoo…) carry a "📕 Venture charter" and their projects are
 * genuine projects — those are never touched.
 *
 * Reversible: kind is a single column. `--revert` puts them back to project.
 * Dry by default; pass --apply to write.
 *
 * Run from packages/core:
 *   npx tsx scripts/promote-sub-ventures.mts            # preview
 *   npx tsx scripts/promote-sub-ventures.mts --apply
 *   npx tsx scripts/promote-sub-ventures.mts --revert --apply
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
const REVERT = process.argv.includes('--revert');
const from = REVERT ? 'entity' : 'project';
const to = REVERT ? 'project' : 'entity';

const db = createClient({
  url: process.env.GETSHIT_DB_URL!,
  authToken: process.env.GETSHIT_DB_AUTH_TOKEN,
});

const departments = await db.execute(`
  SELECT p.id, p.title
  FROM tasks c JOIN tasks p ON p.id = c.parent_id
  WHERE c.title LIKE '%📕%' AND c.title LIKE '%Department charter%'
`);
console.log(`Departments: ${departments.rows.length}`);

let total = 0;
for (const d of departments.rows) {
  const kids = await db.execute({
    sql: 'SELECT id, title FROM tasks WHERE parent_id = ? AND kind = ? ORDER BY position',
    args: [d.id, from],
  });
  if (kids.rows.length === 0) continue;
  console.log(`\n${d.title} — ${kids.rows.length} → ${to}`);
  for (const k of kids.rows) {
    console.log(`   ${k.title}`);
    if (APPLY) {
      await db.execute({
        sql: 'UPDATE tasks SET kind = ?, updated_at = ? WHERE id = ?',
        args: [to, Date.now(), k.id],
      });
    }
    total++;
  }
}

console.log(
  `\n${APPLY ? 'PROMOTED' : 'WOULD PROMOTE'} ${total} ${from} → ${to}` +
    (APPLY ? '' : '   (re-run with --apply to write)'),
);

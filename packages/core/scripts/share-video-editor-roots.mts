/**
 * One-off fix (2026-08-30): the video-editor agent built 7 root trees in its
 * own space with zero shares — 7 pending asks (Stayfront VO auditions, site
 * builds, the Trace tweet series) were invisible to Joel everywhere in the
 * app, and the Office dive's "open" links to them 404'd. Shares each
 * video-editor root with Joel (cascade-by-subtree covers the children).
 *
 * Reads DB creds from packages/web/.env.local when not already in the env.
 * Run from packages/core: npx tsx scripts/share-video-editor-roots.mts
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

const db = createClient({
  url: process.env.GETSHIT_DB_URL!,
  authToken: process.env.GETSHIT_DB_AUTH_TOKEN,
});
const JOEL = 'zDNBp6zwzoa7'; // joel@combinaz.com
const VIDEO_EDITOR = 'zJQf8mZ2lfIs';

const roots = await db.execute({
  sql: 'select id, title from tasks where user_id = ? and parent_id is null',
  args: [VIDEO_EDITOR],
});
const now = Date.now();
for (const r of roots.rows) {
  await db.execute({
    sql: 'insert into task_shares (task_id, user_id, created_at) values (?, ?, ?) on conflict do nothing',
    args: [r.id, JOEL, now],
  });
  console.log('shared →', r.title, `(${r.id})`);
}

const acc = await db.execute({
  sql: `WITH RECURSIVE roots(id) AS (
    SELECT id FROM tasks WHERE user_id = ?1
    UNION SELECT task_id FROM task_shares WHERE user_id = ?1
    UNION SELECT id FROM tasks WHERE assignee_id = ?1
    UNION SELECT id FROM tasks WHERE reviewer_id = ?1
  ), accessible(id) AS (
    SELECT id FROM roots UNION SELECT t.id FROM tasks t JOIN accessible a ON t.parent_id = a.id
  ) SELECT id FROM accessible`,
  args: [JOEL],
});
const ok = new Set(acc.rows.map((r) => r.id as string));
const check = [
  '8mzA9XPIjzf4', 'pfH4MtFcJ2gF', '9idXpXzPo2mX', 'z_Nll0QHhd5L',
  'FG_dtBCyioR4', 'e_LO1xazVT27', 'LQYLdqa7aEYO',
];
console.log('verify:', check.map((id) => `${id}:${ok.has(id) ? 'OK' : 'STILL HIDDEN'}`).join(' '));
console.log(`Joel now reaches ${ok.size} tasks; the 7 hidden asks land in /reviews + /focus on next load.`);

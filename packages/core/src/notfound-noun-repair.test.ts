/**
 * `NotFoundError` names its REFERENT — one test per call site. Card `Tx5g85uLq96D`
 * (`not_shared` is not `not_found`), noun half, carded as `24DfXc7As7I3`.
 *
 * ## What this pins, and why it is one test per site rather than one per class
 *
 * The parent card's own fix brief says it, and this repo has now failed it
 * twice: *"Add a test per tool, not one shared test — the current single-site
 * guarantee is exactly what made this look covered."* A test that constructs
 * `new NotFoundError(id, 'Note')` and asserts the string proves the
 * CONSTRUCTOR. It says nothing about whether `delete_note` passes the
 * argument. Every assertion below drives the real exported function that the
 * MCP tool calls, with a never-real id, and reads the message off the thrown
 * error.
 *
 * ## The measurement that made this file necessary
 *
 * Before the repair, `npm test` was **608 tests, 607 pass, 0 fail**. After
 * changing the noun at **14 call sites**, it was **608 tests, 607 pass, 0
 * fail** — byte-identical counts. No existing test could see the defect, and
 * none could have seen the repair either. The suite had zero power over this
 * axis, which is exactly why prod shipped five wrong nouns for months without
 * a red anywhere.
 *
 * ## Two populations, and they are not the same size
 *
 *   prod, at the ANSWER surface (`npm run notfound-noun`, 2026-09-16)
 *     5 of 11 probed tools → update_note · delete_note · cancel_prompt ·
 *                            delete_comment · delete_attachment
 *
 *   this tree, at the SOURCE (census in the last test below)
 *     14 of 19 non-test call sites
 *
 * The probe cannot reach the other nine: `answerPrompt`, `sendBackPrompt`,
 * `markPromptOpened`, `markPromptNotRelevant`, `passPromptOn`,
 * `undoPromptResolution` and the two defensive attachment branches are Focus /
 * web paths with no MCP tool in front of them. **The probe's 5 is a floor on
 * the harm, not the population** — and the census here is a claim about this
 * tree only, never about prod's build. Those stay two objects; that confusion
 * is this card's oldest recorded error.
 *
 * ## The leg that matters most is the last one
 *
 * Fourteen per-site assertions pin fourteen sites that exist TODAY. They are
 * blind to the fifteenth, written next month, that forgets the argument and
 * inherits `Task` silently — the same default that made this bug invisible is
 * still there, on purpose, because removing it would change the five messages
 * that were already right. So the final test is a source census: every
 * non-test `new NotFoundError(` site must either pass a noun or be on a
 * DECLARED allow-list of genuine task referents. A new nounless site fails it
 * by construction. The census carries its own POS-CTL (its matcher must fire
 * on a synthetic nounless line) and a conservation check, because a census
 * whose buckets do not add up is reporting on two populations at once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { closeDb, getDb } from './db/client.js';
import { taskAttachments, users } from './schema.js';
import { createTask, reorderSiblings } from './tasks.js';
import { deleteComment } from './comments.js';
import { deleteAttachment, getAttachment } from './attachments.js';
import { createBrainNote, deleteBrainNote, updateBrainNote } from './brain.js';
import {
  answerPrompt,
  cancelPrompt,
  createPrompt,
  markPromptNotRelevant,
  markPromptOpened,
  passPromptOn,
  sendBackPrompt,
  undoPromptResolution,
} from './prompts.js';
import { assertAccessibleExists, NotFoundError } from './access.js';
import type { Context } from './context.js';
import { resetStorageCache } from './storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** No row of any kind has this id. Every assertion below uses exactly this one. */
const NEVER_REAL = 'zzNeverReal9x';

let tmpDir: string;
let joel: Context;
let jibin: Context;

async function addUser(name: string): Promise<Context> {
  const id = nanoid(12);
  await getDb().insert(users).values({
    id,
    email: null,
    name,
    googleId: null,
    image: null,
    createdAt: Date.now(),
  });
  return { userId: id };
}

/**
 * Run `fn`, require it to throw a NotFoundError, and return the message.
 *
 * Asserting the CLASS before the string is what keeps this from passing by
 * accident: several of these call sites sit behind other guards
 * (`assertHumanResolver`, status checks, schema parsing), and a test that only
 * grepped the message would report a silent pass if an earlier guard answered
 * first and the site was never reached at all.
 */
async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof NotFoundError,
      `expected NotFoundError, got ${(err as Error)?.name}: ${(err as Error)?.message}`,
    );
    return (err as Error).message;
  }
  assert.fail('expected a throw, got a value — the call site was never reached');
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getshit-nfnoun-'));
  process.env['GETSHIT_DB_URL'] = `file:${path.join(tmpDir, 'db.sqlite')}`;
  process.env['HOME'] = tmpDir;
  process.env['GETSHIT_STORAGE'] = 'local';
  process.env['GETSHIT_FILES_DIR'] = path.join(tmpDir, 'files');
  resetStorageCache();
  await migrate(getDb(), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  joel = await addUser('joel');
  jibin = await addUser('jibin');
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('NotFoundError names its referent — NOTE (access.ts, assertAccessibleNoteExists)', () => {
  // Both note tools reach the SAME assert, and they still get a test each.
  // `create_task` and `create_note` are the standing lesson on this card: two
  // creates that looked like siblings asserted on different arguments, and the
  // sibling's guarantee did not transfer. A shared call site today is one
  // refactor away from two.
  it('update_note → updateBrainNote', async () => {
    const msg = await messageOf(() => updateBrainNote(joel, NEVER_REAL, { title: 'x' }));
    assert.equal(msg, `Note ${NEVER_REAL} not found`);
  });

  it('delete_note → deleteBrainNote', async () => {
    const msg = await messageOf(() => deleteBrainNote(joel, NEVER_REAL));
    assert.equal(msg, `Note ${NEVER_REAL} not found`);
  });
});

describe('NotFoundError names its referent — COMMENT (comments.ts)', () => {
  it('delete_comment → deleteComment', async () => {
    const msg = await messageOf(() => deleteComment(joel, NEVER_REAL));
    assert.equal(msg, `Comment ${NEVER_REAL} not found`);
  });
});

describe('NotFoundError names its referent — ATTACHMENT (attachments.ts)', () => {
  it('getAttachment, missing row', async () => {
    const msg = await messageOf(() => getAttachment(joel, NEVER_REAL));
    assert.equal(msg, `Attachment ${NEVER_REAL} not found`);
  });

  it('delete_attachment → deleteAttachment, missing row', async () => {
    const msg = await messageOf(() => deleteAttachment(joel, NEVER_REAL));
    assert.equal(msg, `Attachment ${NEVER_REAL} not found`);
  });

  // The two defensive branches — a row owned by NEITHER a task nor a note.
  // They are unreachable through any public write path (the invariant is
  // app-level, with no DB CHECK), so the row is inserted directly. Without
  // these two the census below would have to carve out an exception for a
  // line no test drives, and an unreached line is exactly where a wrong noun
  // survives a repair.
  it('getAttachment, orphaned row (defensive branch)', async () => {
    const id = nanoid(12);
    await getDb().insert(taskAttachments).values({
      id,
      userId: joel.userId,
      taskId: null,
      brainNoteId: null,
      filename: 'orphan.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storage: 'local',
      storageKey: `k-${id}`,
      createdAt: Date.now(),
    });
    const msg = await messageOf(() => getAttachment(joel, id));
    assert.equal(msg, `Attachment ${id} not found`);
  });

  it('deleteAttachment, orphaned row (defensive branch)', async () => {
    const id = nanoid(12);
    await getDb().insert(taskAttachments).values({
      id,
      userId: joel.userId,
      taskId: null,
      brainNoteId: null,
      filename: 'orphan2.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storage: 'local',
      storageKey: `k-${id}`,
      createdAt: Date.now(),
    });
    const msg = await messageOf(() => deleteAttachment(joel, id));
    assert.equal(msg, `Attachment ${id} not found`);
  });
});

describe('NotFoundError names its referent — PROMPT (prompts.ts)', () => {
  // Six of these seven have no MCP tool in front of them, so `npm run
  // notfound-noun` — which probes the wire — is structurally unable to see
  // them. They are the difference between "5 tools" and "14 sites".
  it('answerPrompt', async () => {
    const msg = await messageOf(() => answerPrompt(joel, NEVER_REAL, { text: 'x' }));
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });

  it('markPromptOpened', async () => {
    const msg = await messageOf(() => markPromptOpened(joel, NEVER_REAL));
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });

  it('sendBackPrompt', async () => {
    const msg = await messageOf(() => sendBackPrompt(joel, NEVER_REAL));
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });

  it('markPromptNotRelevant', async () => {
    const msg = await messageOf(() => markPromptNotRelevant(joel, NEVER_REAL));
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });

  it('passPromptOn', async () => {
    const msg = await messageOf(() =>
      passPromptOn(joel, NEVER_REAL, { toUserId: jibin.userId }),
    );
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });

  it('cancel_prompt → cancelPrompt', async () => {
    const msg = await messageOf(() => cancelPrompt(joel, NEVER_REAL));
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });

  it('undoPromptResolution', async () => {
    // The only prompt site whose human-resolver gate answers BEFORE the row
    // lookup, so `joel` (kind defaults to 'human') is required here — an agent
    // context would throw HumanResolutionRequiredError and `messageOf` would
    // fail on the class check rather than silently pass on a substring.
    const msg = await messageOf(() => undoPromptResolution(joel, NEVER_REAL));
    assert.equal(msg, `Prompt ${NEVER_REAL} not found`);
  });
});

describe('NotFoundError names its referent — USER (prompts.ts, resolvePassOnParties)', () => {
  it('passPromptOn with a never-real recipient', async () => {
    // Needs a REAL prompt: the recipient is resolved after the row lookup and
    // after the human-resolver gate, so a never-real prompt id would never
    // reach it. This is the site the probe could not have found at all — the
    // id is not a task, a note, a prompt or a comment, it is a USER.
    const task = await createTask(joel, { title: 'pass-on subject' });
    // `createPrompt` returns the prompt itself (AgentPrompt & {…}), not a
    // wrapper — destructuring a `prompt` key off it yields the question TEXT,
    // and `passPromptOn(joel, undefined)` then dies in the driver with a query
    // error. The class check in `messageOf` is what turned that into a red
    // instead of a green on a substring that happened to match.
    const created = await createPrompt(joel, {
      taskId: task.id,
      kind: 'text',
      prompt: 'who owns this?',
    });
    const msg = await messageOf(() =>
      passPromptOn(joel, created.id, { toUserId: NEVER_REAL }),
    );
    assert.equal(msg, `User ${NEVER_REAL} not found`);
  });
});

describe('NEG-CTL — the five genuine task referents still read "Task"', () => {
  // Without these the repair is indistinguishable from "rename the noun
  // everywhere", which would be a regression on the sites that were already
  // right and would quietly break `mcp-errors.test.ts`'s wire-format table.
  it('assertAccessibleExists (access.ts)', async () => {
    const msg = await messageOf(() => assertAccessibleExists(joel, NEVER_REAL));
    assert.equal(msg, `Task ${NEVER_REAL} not found`);
  });

  it('reorderSiblings (tasks.ts)', async () => {
    // The NotFoundError sits BELOW a cardinality guard — `orderedIds.length`
    // must equal the sibling count or a plain Error answers first and this
    // site is never reached. So: two real siblings, and one of the two ids
    // swapped for the never-real one. Getting this wrong is not a cosmetic
    // slip; a test that stopped at the guard would have been green while
    // proving nothing about the noun.
    const parent = await createTask(joel, { title: 'parent' });
    const a = await createTask(joel, { title: 'child a', parentId: parent.id });
    await createTask(joel, { title: 'child b', parentId: parent.id });
    const msg = await messageOf(() => reorderSiblings(joel, parent.id, [a.id, NEVER_REAL]));
    assert.equal(msg, `Task ${NEVER_REAL} not found`);
  });

  it('the bare constructor still defaults to Task', () => {
    assert.equal(new NotFoundError(NEVER_REAL).message, `Task ${NEVER_REAL} not found`);
  });
});

describe('the census — a FUTURE call site cannot inherit "Task" silently', () => {
  /**
   * Every genuine task referent, by file and by the argument expression it
   * throws with. Declared, not derived, because "this id really is a task" is
   * a fact about the surrounding code that no matcher can read off the line.
   *
   * To add a row here you are asserting the id names a TASK. If it names
   * anything else, pass the noun instead.
   */
  const DECLARED_TASK_REFERENTS: ReadonlyArray<{ file: string; arg: string; why: string }> = [
    { file: 'access.ts', arg: 'id', why: 'assertAccessibleExists — the id IS a task id' },
    { file: 'tasks.ts', arg: 'idOrPrefix', why: 'resolveTaskIdOrPrefix, empty input' },
    { file: 'tasks.ts', arg: 'idOrPrefix', why: 'resolveTaskIdOrPrefix, nothing accessible' },
    { file: 'tasks.ts', arg: 'idOrPrefix', why: 'resolveTaskIdOrPrefix, no prefix match' },
    { file: 'tasks.ts', arg: 'id', why: 'reorderSiblings — orderedIds are task ids' },
  ];

  const SRC = __dirname;
  const SITE = /new NotFoundError\(([^)]*)\)/g;

  type Site = { file: string; line: number; args: string; hasNoun: boolean };

  function censusOf(files: string[]): Site[] {
    const out: Site[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      text.split('\n').forEach((line, i) => {
        // A commented-out line is not a call site. `tasks.test.ts:1482` is
        // exactly that, and counting it would put a row in the census that no
        // repair can ever move.
        if (/^\s*(\/\/|\*)/.test(line)) return;
        for (const m of line.matchAll(SITE)) {
          const args = (m[1] ?? '').trim();
          out.push({ file, line: i + 1, args, hasNoun: /,\s*'[^']+'\s*$/.test(args) });
        }
      });
    }
    return out;
  }

  const SOURCE_FILES = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();

  it('POS-CTL — the matcher fires on a nounless line and not on a noun-bearing one', () => {
    // Without this, every green below is equally explained by a regex that
    // matches nothing. It is checked on synthetic lines, not on the tree, so
    // it cannot be satisfied by the very sites it is meant to judge.
    const probe = (line: string) => {
      const m = [...line.matchAll(SITE)];
      assert.equal(m.length, 1, `matcher did not fire on: ${line}`);
      return /,\s*'[^']+'\s*$/.test((m[0]![1] ?? '').trim());
    };
    assert.equal(probe(`  if (!row) throw new NotFoundError(id);`), false);
    assert.equal(probe(`  if (!row) throw new NotFoundError(id, 'Note');`), true);
    assert.equal(probe(`  throw new NotFoundError(input.toUserId, 'User');`), true);
    // A commented site is skipped by the census, not classified by the regex.
    assert.equal([...`  //   if (!row) throw new NotFoundError(id);`.matchAll(SITE)].length, 1);
  });

  it('every nounless call site is a DECLARED task referent — and the buckets conserve', () => {
    const sites = censusOf(SOURCE_FILES);
    const nounless = sites.filter((s) => !s.hasNoun);
    const withNoun = sites.filter((s) => s.hasNoun);

    // Conservation first. Three independent predicates that do not add up are
    // describing two different populations in one table — the failure mode
    // this repo caught once already in `control-anchoring`.
    assert.equal(nounless.length + withNoun.length, sites.length);

    const undeclared = nounless.filter(
      (s) => !DECLARED_TASK_REFERENTS.some((d) => d.file === s.file && d.arg === s.args),
    );
    assert.deepEqual(
      undeclared.map((s) => `${s.file}:${s.line} — new NotFoundError(${s.args})`),
      [],
      'a NotFoundError site with no noun and no declared task referent: either pass the ' +
        'referent, or add it to DECLARED_TASK_REFERENTS with the reason it really is a task',
    );

    // …and the allow-list must not outlive its rows. A declared entry whose
    // site has been deleted or given a noun is a stale exemption, and a stale
    // exemption is how the NEXT nounless site slips through unnoticed.
    assert.equal(
      nounless.length,
      DECLARED_TASK_REFERENTS.length,
      `DECLARED_TASK_REFERENTS has ${DECLARED_TASK_REFERENTS.length} entries but the tree has ` +
        `${nounless.length} nounless sites — the allow-list has gone stale`,
    );

    // The population is printed rather than assumed: a census that silently
    // read zero files would satisfy every assertion above.
    assert.ok(
      sites.length >= 19,
      `expected the census to find the known 19 call sites, found ${sites.length} across ` +
        `${SOURCE_FILES.length} source files — the census is reading the wrong tree`,
    );
  });
});

#!/usr/bin/env tsx
/* not-shared-doc-gap.mts — WHICH TOOLS ANSWER `not_shared` WITHOUT EVER SAYING SO?
 *
 *   npm run not-shared-doc-gap
 *   npm run not-shared-doc-gap -- --json
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔑 THE GAP THIS CARD HAS BEEN MEASURING PAST.
 *
 * `Tx5g85uLq96D` carries two instruments and they are both about prod:
 *
 *     not-shared-marker      what a tool SAYS      tools/list prose   prod 1 of 32
 *     not-shared-behaviour   what a tool ANSWERS   tools/call         prod 14 NOT_SHARED
 *
 * The marker's verdict is that the deploy is BEHIND by four — the four the
 * LOCAL TREE documents and prod's build does not. That is a deploy-lag number,
 * and it is correct. But it is computed SAY-vs-SAY, across two builds. Nobody
 * has ever crossed the two axes on the SAME build. (The marker's reason string
 * is quoted live below, never re-typed here — it was re-worded on 2026-09-18
 * and a quotation in this header would already be the stale copy.)
 *
 * Do that and the 4 is the small number. On prod today, fourteen tools answer
 * `not_shared` and one of them mentions it in its description.
 *
 * ⚠️ WHY THAT IS NOT A PEDANTIC GAP. This card's founding sentence is about
 * PROSE: `get_task`'s message exists *"precisely because 'not found' invites an
 * agent to recreate a task that already exists."* An agent that reads a tool's
 * description before calling it — which is the only thing a description is for
 * — is told nothing by thirteen of these fourteen. The answer carries the code;
 * the documentation carries the decision.
 *
 * ⛔ WHAT THIS FILE DOES NOT MEASURE, stated because the number below is easy
 * to over-read: it reads whether the DESCRIPTION mentions `not_shared`. It does
 * NOT read whether the ANSWER's message carries the do-not-recreate WORDING —
 * that is a third object again, it needs the message text off each live call,
 * and it is the sharper question. Named here as the next row rather than
 * folded into this one.
 *
 * ⚠️ 2026-09-18 09:4xZ — THE TRIPWIRE THIS HEADER USED TO DESCRIBE IS GONE, and
 * the header outlived it by an hour. It read: *"`tasks.test.ts` pins the doc
 * half for the three collection tools with `move_task` as its NEG-CTL …
 * `DG-NEGCTL-ALIVE` fails loudly if it ever leaves the list."* `93797d2`
 * (08:4xZ) retired that NEG-CTL — it was a control keyed on the defect, so it
 * would have alarmed at its own fix — and `DG-NEGCTL-ALIVE` **stayed green
 * through the change**, because it tested `gap.includes('move_task')` and the
 * claim was about a file it never opened.
 *
 * So for an hour this script printed a live blocker on writing the gap's prose,
 * for a control that had already been removed. Replaced by `DG-NEGCTL-FREE`,
 * which READS `tasks.test.ts` and screens the whole gap list, with
 * `DG-NEGCTL-MATCHER` as its POS-CTL so a zero reads as absent rather than as
 * an unread file.
 *
 *   exit 0  no gap — every tool that answers it, documents it
 *   exit 1  GAP — at least one tool answers `not_shared` and does not say so
 *   exit 2  INCONCLUSIVE — an upstream instrument did not return, or a control failed
 * ════════════════════════════════════════════════════════════════════════════
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const JSON_OUT = process.argv.includes('--json')
const say = (s = '') => { if (!JSON_OUT) console.log(s) }
const cannot = (why: string): never => {
  console.error(`INCONCLUSIVE — ${why}; nothing was measured`)
  process.exit(2)
}

/* ── the two upstream instruments, RUN, not re-implemented ──────────────────
 * Both own their own derivation and both already print their own controls.
 * Re-deriving either here would produce agreement with a copy — this card's
 * oldest recorded error. Both exit 1 when they have a finding, so a non-zero
 * exit is expected and only a missing PAYLOAD is inconclusive. */
const runJson = (script: string): any => {
  try {
    /* ⚠️ `node_modules/.bin/tsx` is a SHELL wrapper, not JS — handing it to
     * `process.execPath` makes node parse `basedir=$(dirname …)` and throw a
     * SyntaxError, which arrives here as "the instrument did not return". The
     * first version of this file did exactly that and correctly reported
     * INCONCLUSIVE, which is the only reason it was not read as a gap of 14. */
    const out = execFileSync('npx', ['tsx', join(HERE, script), '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000, cwd: join(HERE, '..'),
    })
    return JSON.parse(out)
  } catch (e: any) {
    // A finding exits 1 and still prints its payload on stdout.
    const out = e?.stdout
    if (typeof out === 'string' && out.trim().startsWith('{')) {
      try { return JSON.parse(out) } catch { /* fall through */ }
    }
    return cannot(`${script} --json did not return a payload: ${String(e?.message).slice(0, 200)}`)
  }
}

say('# not_shared — SAY vs ANSWER, on the SAME build\n')

const marker = runJson('not-shared-deploy-marker.mts')
const behaviour = runJson('not-shared-behaviour-probe.mts')

/* ── controls first, and the AUTH one is not re-derived here ────────────────
 * Both upstream instruments run their own AUTH control against the same
 * endpoint and refuse to report on a 403. What THIS file has to control for is
 * its own JOIN: two payloads that describe two different endpoints, or two
 * different populations, would produce a difference that is about the join. */
const prodUrl = marker?.url
const behUrl = behaviour?.url
if (!prodUrl || !behUrl) cannot('one of the payloads carries no endpoint url — the join cannot be shown to be about one build')
if (prodUrl !== behUrl) cannot(`the two instruments read DIFFERENT endpoints (${prodUrl} vs ${behUrl}) — any gap would be about the endpoints`)

const documented: string[] = marker?.prod?.documented ?? []
const prodTotal: number = marker?.prod?.total ?? 0
if (!prodTotal) cannot('prod enumerated 0 tools — no denominator, and every local tool would trivially read as a gap')

const rows: any[] = behaviour?.rows ?? []
if (!rows.length) cannot('the behaviour probe returned no rows — nothing was asked, so nothing can be missing')

const answers = new Set(rows.filter((r) => r.notShared === 'NOT_SHARED').map((r) => r.tool as string))
const saysSet = new Set(documented)
const probed = new Set(rows.map((r) => r.tool as string))

const gap = [...answers].filter((t) => !saysSet.has(t)).sort()
const saysNotAnswers = [...saysSet].filter((t) => probed.has(t) && !answers.has(t)).sort()
const both = [...answers].filter((t) => saysSet.has(t)).sort()
/* RULE 30 — an unread row must not land in the healthy bucket. A tool nobody
 * probed has an UNKNOWN answer axis, so it cannot be counted as "no gap". */
const unread = documented.filter((t) => !probed.has(t)).sort()

say('```')
say(`  endpoint          ${prodUrl}`)
say(`  build sha256      ${marker?.real?.sha256 ?? '(none)'}`)
say(`  prod population   ${prodTotal} tool(s) registered`)
say(`  probed by the behaviour axis   ${probed.size}`)
say(`  ⇒ ${prodTotal - probed.size} prod tool(s) have NO answer-axis reading and are counted UNREAD, never "no gap"`)
say('')
say(`  SAY ∧ ANSWER      ${both.length}   ${both.join(', ') || '—'}`)
say(`  ANSWER ∧ ¬SAY     ${gap.length}   🔴 the gap — full list, no cap`)
for (const t of gap) say(`      ${t}`)
say(`  SAY ∧ ¬ANSWER     ${saysNotAnswers.length}   ${saysNotAnswers.join(', ') || '—'}   ← prose promising a shape the tool does not produce`)
say(`  SAY, answer UNREAD ${unread.length}   ${unread.join(', ') || '—'}`)
say('```\n')

/* ── controls, each printed at its value ───────────────────────────────────*/
const controls: { id: string, ok: boolean, what: string }[] = []
const ctl = (id: string, ok: boolean, what: string) => {
  controls.push({ id, ok, what })
  say(`  ${ok ? '✅' : '🔴'} ${id.padEnd(20)} ${what}`)
}

say('  CONTROLS')
ctl('DG-JOIN-KEY', probed.size > 0 && [...probed].some((t) => saysSet.has(t)),
  `the two axes share at least one tool name — the join is not over disjoint key spaces (${both.length} in both)`)
ctl('DG-SAY-POS', saysSet.has('get_task'),
  'POS-CTL — get_task is on the SAY axis, so a documented tool IS detectable (an empty SAY set would make every row a gap)')
ctl('DG-ANSWER-POS', answers.has('get_task'),
  'POS-CTL — get_task is on the ANSWER axis too, so the two axes can agree; a gap is not an artefact of one always being empty')
ctl('DG-ANSWER-NEG', rows.some((r) => r.notShared !== 'NOT_SHARED'),
  'NEG-CTL — at least one probed tool does NOT answer not_shared, so the ANSWER set is not "everything"')
/* The tripwire — a pass/fail about whether writing the gap's prose would kill
 * a control in another file.
 *
 * ⚠️ 2026-09-18 09:4xZ — REPLACED. It used to be `gap.includes('move_task')`,
 * a PROXY for "tasks.test.ts still uses move_task as its undocumented-write-
 * path NEG-CTL". That control was retired one file over at 93797d2 (08:4xZ)
 * and this leg stayed ✅ GREEN straight through the change — the proxy reads
 * the gap list, and the claim is about a file it never opens. So it went on
 * printing a live blocker for a control that no longer exists. A tripwire that
 * never reads its subject cannot see its subject leave.
 *
 * It reads the file now, and it is keyed on the GAP list rather than on a
 * named tool, so it survives the day the 13 get written. */
const tasksTest = readFileSync(join(HERE, '..', 'src', 'tasks.test.ts'), 'utf8')
const describesRe = (t: string) => new RegExp(`describes\\(\\s*findTool\\('${t}'\\)`)
const namedNegCtl = gap.filter((t) => describesRe(t).test(tasksTest))
ctl('DG-NEGCTL-MATCHER', describesRe('get_task').test(tasksTest),
  "POS-CTL — the same regex DOES find get_task's describes() assertion in tasks.test.ts, so a zero below reads as absent rather than as an unread file")
ctl('DG-NEGCTL-FREE', namedNegCtl.length === 0,
  namedNegCtl.length === 0
    ? 'no tool on the gap list is named in a describes() assertion in tasks.test.ts — writing the gap prose kills no control there (read off the file, not inferred)'
    : `documenting ${namedNegCtl.join(', ')} would kill a NEG-CTL in tasks.test.ts — retire it there FIRST`)
say('')

const ctlFail = controls.filter((c) => !c.ok)

if (JSON_OUT) {
  console.log(JSON.stringify({
    endpoint: prodUrl, sha256: marker?.real?.sha256 ?? null,
    prodTotal, probed: probed.size, unreadOnAnswerAxis: prodTotal - probed.size,
    both, gap, saysNotAnswers, documentedButUnread: unread,
    controls,
    markerVerdict: marker?.verdict ?? null,
  }, null, 1))
}

if (ctlFail.length) {
  say(`🔴 INCONCLUSIVE — ${ctlFail.length} control(s) failed: ${ctlFail.map((c) => c.id).join(', ')}. Exit 2. NOT a finding.`)
  process.exit(2)
}

if (!gap.length) {
  say(`✅ NO GAP — every tool that answers not_shared on this build also documents it (${both.length} of ${probed.size} probed).`)
  process.exit(0)
}

say(`🔴 GAP — ${gap.length} of ${answers.size} tool(s) that ANSWER not_shared on this build never mention it in their description.`)
say(`   The marker's headline for the same build is "${marker?.verdict?.reason ?? '(none)'}", which is a SAY-vs-SAY number across two builds.`)
say('   Both are true. This one is larger and nothing on this card was reading it.')
process.exit(1)

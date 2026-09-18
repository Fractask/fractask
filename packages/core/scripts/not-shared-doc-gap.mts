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
 * that is a third object again, and it needs the message text off each live
 * call.
 *
 * ⚠️ 2026-09-18 12:4xZ — THAT SENTENCE USED TO END *"Named here as the next row
 * rather than folded into this one."* It is no longer a next row: the message
 * axis SHIPPED in the sibling instrument as the `GUIDANCE` column (`f6db4a2`,
 * 07:52Z) and reaches an exit code as `SILENT_GUIDANCE` (`a9dde95`, 11:5xZ).
 * So run `npm run not-shared-behaviour` for that axis — it is measured, it is
 * gated, and this header was advertising it as unbuilt for 4.9 h.
 *
 * 🔑 The reason this is a control (`DG-XREF-FRESH`) and not just a correction:
 * this section is the guard against over-reading the number below. A guard that
 * describes a sibling file as it stood five hours ago is exactly the defect the
 * marker's `2 of 32` target was — a correct sentence with no clock, outliving
 * the commit that falsified it. So the claim is now DERIVED from the sibling's
 * source on every run rather than re-typed here, and it voids the run (exit 2)
 * rather than printing red into a gate that cannot see it.
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
 * which READS the test sources and screens the whole gap list, with
 * `DG-NEGCTL-MATCHER` as its POS-CTL so a zero reads as absent rather than as
 * unread files.
 *
 * ⚠️ 2026-09-18 11:1xZ — AND THE REPLACEMENT HAD THE SAME DEFECT ONE LEVEL
 * OVER. It screened `tasks.test.ts` alone, read ✅ GREEN, the 13 sentences went
 * in, and `not-shared-behaviour-probe.test.ts:702` went RED: a THIRD copy of the
 * retired pin, in a file the leg never opened. The matcher had been fixed; the
 * POPULATION had not. It now enumerates every `src/*.test.ts` at run time (15
 * today) and matches two spellings, and the widening is pinned by an ablation —
 * restore that pin and the leg goes red naming the file, restore the file and it
 * goes green.
 *
 *   exit 0  no gap — every tool that answers it, documents it
 *   exit 1  GAP — at least one tool answers `not_shared` and does not say so
 *   exit 2  INCONCLUSIVE — an upstream instrument did not return, or a control failed
 * ════════════════════════════════════════════════════════════════════════════
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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
 * named tool, so it survives the day the 13 get written.
 *
 * ⚠️ 2026-09-18 11:1xZ — WIDENED, and the reason is that the narrow version
 * cleared an edit it should have blocked. It screened `tasks.test.ts` alone,
 * read ✅ GREEN, the 13 sentences went in — and
 * `not-shared-behaviour-probe.test.ts:702` went RED, because it carried a THIRD
 * copy of the same retired pin (`move_task must stay undocumented — it is the
 * doc-half NEG-CTL in tasks.test.ts`). The leg's claim was "writing the gap
 * prose kills no control"; its test was "…in this one file I happened to
 * name". Exactly the defect one revision earlier, moved from the matcher to
 * the population. So the population is now every `*.test.ts` in `src/`,
 * enumerated at run time rather than listed — a file added tomorrow is screened
 * without anyone remembering to add it here. Two regexes, because the two
 * copies were not spelled the same: the `describes(findTool('x'))` form AND a
 * bare `!description.includes('not_shared')` assertion naming the tool. */
const TEST_DIR = join(HERE, '..', 'src')
const testFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).sort()
const testSrc = testFiles.map((f) => ({ file: f, src: readFileSync(join(TEST_DIR, f), 'utf8') }))
const describesRe = (t: string) => new RegExp(`describes\\(\\s*findTool\\('${t}'\\)`)
/* The second spelling: a test asserting a named tool must NOT carry the marker.
 * That is a pin keyed on the defect wherever it appears, and it is the shape
 * the narrow leg walked past. */
const staysUndocRe = (t: string) =>
  new RegExp(`'${t}'[\\s\\S]{0,600}?!\\s*String\\([^)]*\\)[^\\n]*includes\\(\\s*'not_shared'`)
const hits = gap.flatMap((t) =>
  testSrc
    .filter(({ src }) => describesRe(t).test(src) || staysUndocRe(t).test(src))
    .map(({ file }) => `${t} (${file})`),
)
ctl('DG-NEGCTL-MATCHER', testSrc.some(({ src }) => describesRe('get_task').test(src)),
  `POS-CTL — the same regex DOES find get_task's describes() assertion somewhere in the ${testFiles.length} src/*.test.ts file(s) read, so a zero below reads as absent rather than as unread files`)
ctl('DG-NEGCTL-FREE', hits.length === 0,
  hits.length === 0
    ? `no tool on the gap list is pinned as undocumented in any of the ${testFiles.length} src/*.test.ts file(s) — writing the gap prose kills no control (read off the files, not inferred)`
    : `documenting ${hits.join(', ')} would kill a NEG-CTL — retire it THERE first`)

/* DG-XREF-FRESH — this file's ⛔ DOES-NOT-MEASURE section makes a claim about a
 * SIBLING file, and nothing re-derived it. Found 2026-09-18 12:4xZ: the section
 * called the message axis a "next row" for 4.9 h after that axis shipped and was
 * gated next door. The repair is not the reworded sentence — it is that the
 * claim is now read off the sibling's SOURCE on every run.
 *
 * Keyed on the axis being GATED, not merely present: a printed column that no
 * exit code reads is the state `a9dde95` repaired, and "the sharper question is
 * still open" would have been a fair description of it.
 *
 * Two spellings, for the reason DG-NEGCTL-FREE carries two: the deferral can be
 * re-introduced in words other than the ones just retired. */
const PROBE_FILE = 'not-shared-behaviour-probe.mts'
let probeSrc = ''
try { probeSrc = readFileSync(join(HERE, PROBE_FILE), 'utf8') } catch { probeSrc = '' }
const SELF_SRC = readFileSync(join(HERE, 'not-shared-doc-gap.mts'), 'utf8')
const selfHeaderRaw = SELF_SRC.slice(0, SELF_SRC.indexOf('*/') + 2)
/* 🔑 A phrase matcher over a header CANNOT SEE ITS OWN RETRACTION. Measured
 * 12:5xZ: the reworded section above quotes the retired sentence verbatim — as
 * the record of what changed — and the first version of this control scored that
 * quotation as a live deferral and went red at its own fix.
 *
 * Deleting the quotation would have made the control green by deleting the
 * record, which is what "consolidating" is called here. So the RETRACTIONS are
 * excluded instead, and an exclusion is only honest if it prints what it
 * declined and is shown to be non-vacuous — DG-XREF-QUOTE-CTL below does both.
 * A `*"…"*` span in this header is a quotation of superseded text, by the
 * convention every dated ⚠️ note in this file already follows. */
const QUOTED = /\*"[\s\S]*?"\*/g
/* ⚠️ FLATTEN BEFORE MATCHING. This header is a block comment, so any sentence
 * longer than one line carries `\n * ` inside it — "next row\n * rather than
 * folded" is not the string "next row rather than folded". Measured 13:1xZ: the
 * first version's POS-CTL fired on a one-line LITERAL and passed, while the same
 * regex could never match the real header. A control that does not share the
 * caller's input shape reports on the fixture. */
const flatten = (s: string) => s.replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ')
const quotedSpans = (selfHeaderRaw.match(QUOTED) ?? []).map(flatten)
const selfHeader = flatten(selfHeaderRaw.replace(QUOTED, ' '))
const selfHeaderFlatRaw = flatten(selfHeaderRaw)
/* The sibling's axis is GATED iff its exit-code path reads the status. */
const guidanceGatedRe = /verdict\.status === 'SILENT_GUIDANCE'/
const messageAxisGated = guidanceGatedRe.test(probeSrc)
const deferralRes = [
  /next row rather than folded/i,
  /(sharper question|message axis|do-not-recreate WORDING)[\s\S]{0,240}?(is the next row|named here as the next row|not yet built|remains unbuilt)/i,
]
/* POS-CTL over a LITERAL — the retired sentence itself. A matcher that cannot
 * fire on the exact text it was written to catch is not a matcher, and this
 * proves it without needing the defect to be present in the file. */
/* Comment-SHAPED on purpose — `\n * ` inside the sentence, exactly as it sat in
 * this header — and put through the same `flatten` the live corpus goes through.
 * The flat one-line version of this fixture passed while the regex was dead
 * against the real file; a POS-CTL is only a control over the shape the caller
 * actually hands it. */
const RETIRED_SENTENCE = flatten('and it is the sharper question. Named here as the next row\n * rather than folded into this one.')
ctl('DG-XREF-MATCHER', deferralRes.some((re) => re.test(RETIRED_SENTENCE)),
  'POS-CTL — the deferral matcher fires on the verbatim sentence retired at 12:4xZ, so a zero below reads as "the header does not defer" rather than as a dead regex')
ctl('DG-XREF-PROBE-READ', guidanceGatedRe.test(probeSrc) || /GUIDANCE_NEEDLE/.test(probeSrc),
  probeSrc
    ? `POS-CTL — ${PROBE_FILE} was read (${probeSrc.length} ch) and carries the GUIDANCE axis, so "gated" below is a reading of that file`
    : `${PROBE_FILE} could not be read from ${HERE} — the cross-reference cannot be derived, so it must not be reported either way`)
/* The exclusion's own control. Both legs, because either one alone passes for
 * the wrong reason: if no span was stripped the filter is vacuous (it would have
 * scored the same with no code at all), and if the raw header does not carry the
 * retired sentence there was nothing to exclude, so "it is gone from the
 * stripped copy" is true of an empty difference. */
const nMatches = (s: string) => deferralRes.filter((re) => re.test(s)).length
const quotedCarryingDeferral = quotedSpans.filter((q) => deferralRes.some((re) => re.test(q)))
const quoteCtlNonVacuous = quotedCarryingDeferral.length > 0
/* ⚠️ Counted, not `.some()`. The 12:5xZ ablation injected a LIVE deferral beside
 * the quoted one and this leg went red saying *"the raw header carries no
 * deferral either"* — false, it carried two. A boolean "matches before, does not
 * match after" cannot survive a second, unquoted match, so it reported the
 * stripper as broken in exactly the run that was testing something else. Two
 * controls moving on one injection is a confounded ablation, and the message
 * named the wrong cause. Counts distinguish "the stripper removed a reading"
 * from "no reading survived". */
/* ⚠️ And the count is measured PER SPAN, not over the whole header. The 13:2xZ
 * ablation injected a live deferral and this leg went red at `2 raw → 2
 * stripped`: `nMatches` counts how many of the two REGEXES match, so a single
 * live deferral saturates it and the stripper's work becomes invisible. Two
 * controls moved on one injection again — the same confound, one level in.
 * The stripper's claim is about the SPANS, so that is what is tested: every
 * quoted deferral must be absent from the stripped text, regardless of what
 * else the header says. */
const quoteCtlBites = quotedCarryingDeferral.every((q) => !selfHeader.includes(q))
ctl('DG-XREF-QUOTE-CTL', quoteCtlNonVacuous && quoteCtlBites,
  quoteCtlNonVacuous && quoteCtlBites
    ? `${quotedSpans.length} quoted span(s) declined, ${quotedCarryingDeferral.length} of them carrying a deferral, and all ${quotedCarryingDeferral.length} are absent from the stripped text (whole-header reading, for context only: ${nMatches(selfHeaderFlatRaw)} raw → ${nMatches(selfHeader)} stripped). Declined: ${quotedSpans.map((q) => JSON.stringify(q.slice(0, 60))).join(' · ')}`
    : !quoteCtlNonVacuous
      ? `no *"…"* span in this header carries a deferral (${quotedSpans.length} span(s) found), so the retraction filter has nothing to exclude — it cannot be shown to do anything and must not be credited with the verdict below`
      : `the filter found ${quotedCarryingDeferral.length} quoted deferral(s) and at least one SURVIVED into the stripped text — the stripper is not removing what it claims to remove`)
const headerDefers = deferralRes.some((re) => re.test(selfHeader))
ctl('DG-XREF-FRESH', !(messageAxisGated && headerDefers),
  messageAxisGated && headerDefers
    ? `this header still defers the MESSAGE axis to a "next row" while ${PROBE_FILE} already gates it (SILENT_GUIDANCE reaches the exit code) — the guard against over-reading the number below is describing a sibling file as it no longer is`
    : `the ⛔ DOES-NOT-MEASURE section agrees with ${PROBE_FILE} as it stands (axis gated there: ${messageAxisGated ? 'yes' : 'no'} · header defers here: ${headerDefers ? 'yes' : 'no'}) — read off the sibling's source, not re-typed`)
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

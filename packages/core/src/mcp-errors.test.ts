import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  ForbiddenError,
  NotFoundError,
  NotSharedError,
  NotSharedNoteError,
  NotSharedScratchError,
} from './access.js';
import { AmbiguousIdError, CycleError } from './tasks.js';
import { mcpErrorText, rootCause } from './mcp-errors.js';

/**
 * The join nobody was testing.
 *
 * Every other suite in this repo proves the right error CLASS is thrown. The
 * caller does not see a class — it sees a string, produced by a dispatch table
 * that lived in two hand-copied transport files with no test of its own. A
 * class could therefore be added, thrown correctly, asserted by a green suite,
 * and still reach agents as `error:`. That is exactly what happened to
 * ForbiddenError, which this card's own earlier fixes introduced.
 */
describe('mcpErrorText — the error class -> wire prefix table', () => {
  it('reports not_shared BEFORE not_found (NotSharedError extends NotFoundError)', () => {
    const text = mcpErrorText(new NotSharedError('abc123'));
    assert.ok(text.startsWith('not_shared: '), text);
    assert.ok(text.includes('do not recreate it'), text);
  });

  it('reports the note and scratch subclasses as not_shared too', () => {
    assert.ok(mcpErrorText(new NotSharedNoteError('n1')).startsWith('not_shared: '));
    assert.ok(mcpErrorText(new NotSharedScratchError('s1')).startsWith('not_shared: '));
  });

  it('a genuinely missing row stays not_found — this is not a blanket relabel', () => {
    assert.equal(mcpErrorText(new NotFoundError('gone')), 'not_found: Task gone not found');
  });

  it('reports forbidden as forbidden, not as a catch-all error', () => {
    const text = mcpErrorText(new ForbiddenError('abc123'));
    assert.ok(text.startsWith('forbidden: '), text);
    // The regression this case exists for: before the branch was added it read
    // `error: Task abc123 requires owner permission` — the same prefix a
    // database outage produces.
    assert.ok(!text.startsWith('error: '), text);
  });

  it('forbidden is NOT reported as not_shared — they are different answers', () => {
    // "You cannot see this" and "you can see it but may not do this" must not
    // collapse into one another in either direction.
    assert.ok(!mcpErrorText(new ForbiddenError('abc123')).startsWith('not_shared'));
    assert.ok(!mcpErrorText(new NotSharedError('abc123')).startsWith('forbidden'));
  });

  it('keeps the pre-existing prefixes', () => {
    assert.ok(mcpErrorText(new AmbiguousIdError('x', [])).startsWith('ambiguous_id: '));
    assert.ok(mcpErrorText(new CycleError()).startsWith('cycle: '));
  });

  it('an unclassified Error is still error:, and a non-Error is still reported', () => {
    assert.equal(mcpErrorText(new Error('boom')), 'error: boom');
    assert.equal(mcpErrorText('a bare string'), 'error: unknown failure');
    assert.equal(mcpErrorText(undefined), 'error: unknown failure');
  });

  it('unwraps a wrapped driver error to its root cause', () => {
    // The HTTP transport's copy of this table did NOT do this, so the same
    // failure read differently depending on which transport you came through —
    // and the HTTP one is what production runs.
    const inner = new Error('BLOCKED: do you need to upgrade your plan?');
    const outer = new Error('Failed query: select * from tasks', { cause: inner });
    assert.equal(mcpErrorText(outer), 'error: BLOCKED: do you need to upgrade your plan?');
  });

  it('survives a cause cycle instead of hanging', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    assert.equal(rootCause(a), 'b');
  });
});

describe('ForbiddenError — the noun', () => {
  it('defaults to Task, so every pre-existing call site is byte-identical', () => {
    assert.equal(new ForbiddenError('t1').message, 'Task t1 requires owner permission');
  });

  it('names the object it is actually about', () => {
    // A comment id reported as "Task <id>" is wrong on the noun, and the
    // agent reading it goes looking for a task.
    assert.equal(new ForbiddenError('c1', 'Comment').message, 'Comment c1 requires owner permission');
    assert.equal(
      new ForbiddenError('s1', 'Scratch entry').message,
      'Scratch entry s1 requires owner permission',
    );
    assert.equal(new ForbiddenError('n1', 'Note').message, 'Note n1 requires owner permission');
  });
});

/**
 * Source-level, and deliberately so: the defect was never that either copy was
 * wrong on the day it was written. It was that there were two, so adding a
 * class to the product mapped it in neither. A behavioural test on this module
 * cannot see a transport that has stopped calling it.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Every file that dispatches a TOOL — i.e. the complete set of places an agent's
 * call can turn into an error string.
 *
 * Derived by scanning the source tree, NOT hand-typed, and that is the whole
 * point. The suite below used to iterate a literal two-entry list. Both entries
 * were right, so it was green — and a third transport added tomorrow would have
 * been outside its denominator, mapped by nobody, with nothing red. That is the
 * same defect one level up from the one this card was opened for: a guarantee
 * held at the call sites somebody remembered to enumerate, read as a guarantee
 * about the class.
 *
 * The discriminator is `tool.handler(` — invoking a TOOLS entry's handler is
 * what makes a file a transport, and it is the line immediately above the catch
 * block that has to classify the error.
 */
function findToolDispatchers(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Test files are excluded: a suite calling tool.handler() is exercising a
      // tool, not shipping an error string to an agent.
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (fs.readFileSync(full, 'utf8').includes('tool.handler(')) {
        found.push(path.relative(repoRoot, full));
      }
    }
  };
  for (const pkg of fs.readdirSync(path.join(repoRoot, 'packages'))) {
    const src = path.join(repoRoot, 'packages', pkg, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  return found.sort();
}

describe('every tool dispatcher routes through the ONE table', () => {
  const dispatchers = findToolDispatchers();

  // Population precondition, asserted before any per-row verdict: a scan that
  // found nothing would make every `for` below vacuous and the suite green.
  it('the census finds a non-empty set of dispatchers', () => {
    assert.ok(dispatchers.length > 0, 'found no tool dispatchers at all — the scan is broken');
  });

  // Floor, in the other direction: the derived set shrinking to one is ALSO a
  // way for this suite to cover less while staying green, so the two known
  // transports are named and must still be in it. Named as a floor, never as
  // the denominator.
  for (const known of ['packages/mcp/src/index.ts', 'packages/web/src/app/api/mcp/route.ts']) {
    it(`the census still contains the known transport ${known}`, () => {
      assert.ok(
        dispatchers.includes(known),
        `${known} dropped out of the census — either it moved, or the scan stopped matching it. ` +
          `Census returned: ${dispatchers.join(', ')}`,
      );
    });
  }

  for (const rel of dispatchers) {
    it(`${rel} calls mcpErrorText and defines no private copy`, () => {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.ok(src.includes('mcpErrorText('), `${rel} never calls mcpErrorText`);
      assert.ok(
        !/function\s+errorText\s*\(/.test(src),
        `${rel} has grown its own copy of the dispatch table again`,
      );
    });
  }

  it('the control: both assertions above can fail', () => {
    // access.ts is a file that certainly does NOT call mcpErrorText, so the
    // matcher is shown to be capable of returning false — and it is equally
    // certainly not in the dispatcher census, so the scan is shown to exclude.
    const src = fs.readFileSync(path.join(repoRoot, 'packages/core/src/access.ts'), 'utf8');
    assert.ok(!src.includes('mcpErrorText('));
    assert.ok(!dispatchers.includes('packages/core/src/access.ts'));
  });
});

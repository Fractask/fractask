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
describe('both transports route through the ONE table', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const transports = [
    'packages/mcp/src/index.ts',
    'packages/web/src/app/api/mcp/route.ts',
  ];

  for (const rel of transports) {
    it(`${rel} calls mcpErrorText and defines no private copy`, () => {
      const file = path.join(repoRoot, rel);
      // If this file moves, fail loudly rather than passing over an empty read.
      assert.ok(fs.existsSync(file), `transport not found at ${file} — fix this path`);
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes('mcpErrorText('), `${rel} never calls mcpErrorText`);
      assert.ok(
        !/function\s+errorText\s*\(/.test(src),
        `${rel} has grown its own copy of the dispatch table again`,
      );
    });
  }

  it('the control: this assertion can fail', () => {
    // A file that certainly does NOT call mcpErrorText, so the matcher above is
    // shown to be capable of returning false.
    const src = fs.readFileSync(path.join(repoRoot, 'packages/core/src/access.ts'), 'utf8');
    assert.ok(!src.includes('mcpErrorText('));
  });
});

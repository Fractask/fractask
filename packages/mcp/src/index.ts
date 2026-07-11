#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AmbiguousIdError,
  CycleError,
  NotFoundError,
  TOOLS,
  getCurrentContext,
  getEffectiveTaskGuidelines,
  getServerInstructions,
  runMigrations,
  zodInputShape,
} from '@getshit/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ZodRawShape } from 'zod';

// libSQL embedded replicas are not safe for concurrent multi-process access —
// multiple MCP instances racing on a shared replica.db corrupt the WAL and
// sync metadata. Give each MCP process its own replica file in tmp.
// Caller can still override via GETSHIT_REPLICA_PATH.
//
// Cleanup runs at startup: scan tmp for getshit-mcp-<pid>.db files whose pid
// is no longer alive and unlink them. This is more reliable than exit/signal
// handlers, which the MCP SDK can intercept, and also covers SIGKILL and
// crashes.
if (!process.env['GETSHIT_REPLICA_PATH']) {
  const tmpdir = os.tmpdir();
  try {
    for (const entry of fs.readdirSync(tmpdir)) {
      const match = entry.match(/^getshit-mcp-(\d+)\.db(-wal|-shm|-info)?$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        // ESRCH = no such process; EPERM = exists but not ours (still alive)
        alive = (err as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (!alive) {
        try { fs.unlinkSync(path.join(tmpdir, entry)); } catch { /* best-effort */ }
      }
    }
  } catch { /* tmpdir unreadable — skip sweep */ }
  process.env['GETSHIT_REPLICA_PATH'] = path.join(tmpdir, `getshit-mcp-${process.pid}.db`);
}

await runMigrations();
const ctx = await getCurrentContext();
// Pulled at startup; restart the MCP server after editing /settings/guidelines
// for new text to land in client tool descriptions and server instructions.
const [guidelines, instructions] = await Promise.all([
  getEffectiveTaskGuidelines(ctx),
  getServerInstructions(ctx),
]);
const guidelinesBlock = `\n\n--- Additional instructions (configured at /settings/guidelines) ---\n${guidelines}`;

const server = new McpServer(
  {
    name: 'getshit',
    version: '0.0.0',
  },
  {
    // MCP clients surface `instructions` as system-level guidance to the
    // agent before any tool call. This is where we tell agents that
    // questions go through ask_human and artifacts through attach_file_from_url.
    instructions,
  },
);

function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function errorText(err: unknown): string {
  if (err instanceof NotFoundError) return `not_found: ${err.message}`;
  if (err instanceof AmbiguousIdError) return `ambiguous_id: ${err.message}`;
  if (err instanceof CycleError) return `cycle: ${err.message}`;
  if (err instanceof Error) return `error: ${err.message}`;
  return 'error: unknown failure';
}

for (const tool of TOOLS) {
  // Append guidelines only to create_task — the others are reads or simple
  // mutations that don't benefit from the extra context.
  const description =
    tool.name === 'create_task' ? tool.description + guidelinesBlock : tool.description;

  // The MCP SDK accepts a Zod *raw shape* (object of zod schemas), not a full
  // ZodObject. Our shared defs hold a ZodObject — but some are wrapped in
  // ZodEffects by `.refine()` (cross-field checks like "exactly one of
  // taskId/noteId"). Unwrap those wrappers to reach the object shape; without
  // this the tool advertises an EMPTY schema and clients drop every argument
  // (this is why attach_file / attach_file_from_url / get_user silently lost
  // their params). The refine still runs — the handler re-parses with the full
  // schema — so no validation is lost by advertising the base shape.
  const inputSchema = zodInputShape(tool.inputSchemaZod) as ZodRawShape;

  server.registerTool(tool.name, { description, inputSchema }, async (args: unknown) => {
    try {
      return ok(await tool.handler(ctx, args));
    } catch (err) {
      return fail(errorText(err));
    }
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);

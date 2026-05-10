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
  runMigrations,
} from '@getshit/core';
import type { ZodRawShape } from 'zod';

const server = new McpServer({
  name: 'getshit',
  version: '0.0.0',
});

await runMigrations();
const ctx = await getCurrentContext();
// Pulled at startup; restart the MCP server after editing /settings/guidelines
// for new text to land in client tool descriptions.
const guidelines = await getEffectiveTaskGuidelines(ctx);
const guidelinesBlock = `\n\n--- Additional instructions (configured at /settings/guidelines) ---\n${guidelines}`;

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
  // ZodObject. Our shared defs hold a ZodObject, so unwrap to the shape here.
  const inputSchema =
    tool.inputSchemaZod._def.typeName === 'ZodObject'
      ? ((tool.inputSchemaZod as unknown as { shape: ZodRawShape }).shape)
      : ({} as ZodRawShape);

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

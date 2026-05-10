import {
  AmbiguousIdError,
  CycleError,
  NotFoundError,
  TOOLS,
  findTool,
  getEffectiveTaskGuidelines,
  resolveTokenToUser,
} from '@getshit/core';
import type { Context } from '@getshit/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MCP Streamable HTTP endpoint, stateless mode.
 *
 * Each POST is a single JSON-RPC request from a client (Claude Code, Cursor,
 * Claude Desktop bridged via mcp-remote, etc.). Auth is a bearer token in
 * `Authorization: Bearer <gs_…>` matched against `cli_tokens`. The token is
 * the user's identity — Turso credentials live only on the server.
 *
 * Supported methods: `initialize`, `tools/list`, `tools/call`, plus a no-op
 * for `notifications/*`. We don't keep session state, so the client doesn't
 * need to send `Mcp-Session-Id` headers.
 */

const SERVER_INFO = { name: 'getshit', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type ToolCallParams = {
  name: string;
  arguments?: Record<string, unknown>;
};

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errEnvelope(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function errorText(err: unknown): string {
  if (err instanceof NotFoundError) return `not_found: ${err.message}`;
  if (err instanceof AmbiguousIdError) return `ambiguous_id: ${err.message}`;
  if (err instanceof CycleError) return `cycle: ${err.message}`;
  if (err instanceof Error) return `error: ${err.message}`;
  return 'error: unknown failure';
}

async function authenticate(req: Request): Promise<{ ok: true; ctx: Context } | { ok: false; status: number; reason: string }> {
  const auth = req.headers.get('authorization') ?? req.headers.get('x-getshit-token');
  if (!auth) {
    return { ok: false, status: 401, reason: 'missing Authorization header' };
  }
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : auth.trim();
  if (token.length === 0) {
    return { ok: false, status: 401, reason: 'empty bearer token' };
  }
  const user = await resolveTokenToUser(token);
  if (!user) {
    return { ok: false, status: 403, reason: 'token does not match any active CLI token' };
  }
  return { ok: true, ctx: { userId: user.id } };
}

async function buildToolList(ctx: Context) {
  const guidelines = await getEffectiveTaskGuidelines(ctx);
  const guidelinesBlock = `\n\n--- Additional instructions (configured at /settings/guidelines) ---\n${guidelines}`;
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.name === 'create_task' ? t.description + guidelinesBlock : t.description,
    inputSchema: t.inputSchemaJson,
  }));
}

async function handleRpc(req: JsonRpcRequest, ctx: Context): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications (per JSON-RPC spec) carry no id and expect no response.
  if (req.method.startsWith('notifications/')) {
    return null;
  }

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: await buildToolList(ctx) } };

    case 'tools/call': {
      const params = (req.params ?? {}) as ToolCallParams;
      if (typeof params.name !== 'string') {
        return errEnvelope(id, ERR_INVALID_PARAMS, 'missing tool name');
      }
      const tool = findTool(params.name);
      if (!tool) {
        return errEnvelope(id, ERR_METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
      }
      try {
        const result = await tool.handler(ctx, params.arguments ?? {});
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err) {
        // Tool-level errors return as `isError: true` content blocks rather
        // than a JSON-RPC error so the agent can read them and recover.
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: errorText(err) }],
          },
        };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return errEnvelope(id, ERR_METHOD_NOT_FOUND, `method not supported: ${req.method}`);
  }
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return jsonResponse({ error: auth.reason }, auth.status);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(errEnvelope(null, ERR_PARSE, 'invalid JSON'), 400);
  }

  // JSON-RPC permits batch (array of requests). Handle both shapes.
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      if (!isJsonRpcRequest(item)) {
        responses.push(errEnvelope(null, ERR_INVALID_REQUEST, 'invalid JSON-RPC request'));
        continue;
      }
      const resp = await handleRpc(item, auth.ctx);
      if (resp) responses.push(resp);
    }
    return jsonResponse(responses);
  }

  if (!isJsonRpcRequest(body)) {
    return jsonResponse(errEnvelope(null, ERR_INVALID_REQUEST, 'invalid JSON-RPC request'), 400);
  }

  try {
    const resp = await handleRpc(body, auth.ctx);
    // Notifications expect no response body — return 204.
    if (resp === null) return new Response(null, { status: 204 });
    return jsonResponse(resp);
  } catch (err) {
    return jsonResponse(
      errEnvelope(body.id ?? null, ERR_INTERNAL, err instanceof Error ? err.message : 'unknown error'),
      500,
    );
  }
}

export async function GET(): Promise<Response> {
  // Some clients probe the URL with GET. We don't support server-initiated
  // streaming in stateless mode, so just describe the endpoint.
  return jsonResponse({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: 'streamable-http',
    note: 'POST JSON-RPC 2.0 with Authorization: Bearer <GETSHIT_TOKEN>. See /setup for client examples.',
  });
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (v as { method?: unknown }).method === 'string'
  );
}

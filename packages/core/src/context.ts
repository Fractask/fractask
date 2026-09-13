/**
 * Who is calling, and — separately — HOW.
 *
 * `userId` is the account. `viaAgentTool` is the channel: true only when the
 * call arrived through the MCP tool surface (`/api/mcp`), which is the agent
 * surface by construction — `mcp-tools.ts` stamps every comment it creates
 * `source: 'agent'` without consulting the account at all.
 *
 * These two are NOT the same question, and every agent-facing guard in this
 * package was asking the wrong one. Measured 2026-09-09 against the live
 * workspace DB: the Mac lane of `website-builder` posts through `/api/mcp` on a
 * CLI token belonging to `zDNBp6zwzoa7` — Joel — whose `users.kind` is
 * `'human'`. Its five most recent comments are `author_user_id=zDNBp6zwzoa7`
 * with `source='agent'`, the newest at 2026-09-09T11:44:58Z. So a guard written
 * as `caller?.kind === 'agent'` is structurally blind to that whole lane, while
 * the comment writer one layer up has already decided it is an agent.
 *
 * `viaAgentTool` is optional and absent everywhere except the MCP route, so
 * every other construction site (web UI, server actions, tests) keeps its old
 * behaviour exactly. It only ever widens a guard, never relaxes one.
 */
export type Context = { userId: string; viaAgentTool?: boolean };

# Contributing

Thanks for thinking about it.

## Setup

```sh
pnpm install
pnpm typecheck
pnpm --filter @getshit/core test
```

If those three pass, you're ready.

> The legacy `@getshit/*` package names will be renamed to `@fractask/*` when the project moves to its new repository. For now, real commands still use the old names.

## What we'll merge

- Bug fixes with a test case.
- New CLI commands or MCP tools that fit the existing six-primitives model (`list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task`, `move_task`).
- Web surface improvements that align with the [Fractask method](https://fractask.ai).
- Documentation, examples, integrations with other agent runtimes.

## What we probably won't merge

- New schema fields without a clear use case across CLI, MCP, and web.
- New "specials" in the MCP (e.g. a `decompose` tool) — decomposition is a workflow agents drive with the six primitives, not a new tool.
- Postgres support, multi-tenancy, billing — those live in the hosted product, not the OSS.

## Code style

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` (see `tsconfig.base.json`).
- `pnpm typecheck` is the source of truth for code correctness; please run it before opening a PR.
- Every domain row has `userId`. Every query filters by it.
- Every core function takes `Context` first.
- New tables get `user_id` + a composite index that starts with `user_id`.

## Pull requests

- Branch off `main`, push to your fork, open a PR.
- One change per PR. Small and focused beats sweeping.
- Describe the *why*, not just the *what*.
- If you're touching schema, include the migration and a note in `CLAUDE.md`.

## Discussion

Big-shape questions belong in an Issue before code. "What if we…" is welcome; surprise PRs that change the architecture are not.

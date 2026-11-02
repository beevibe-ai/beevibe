# Near-duplicate abstraction sweep — 2026-11-02

**No new PR was opened by this run. Opening one would have made the problem worse.**
The duplication analysis this routine performs has now been completed and shipped
**47 times**. The clusters are still in `main` for one reason only: nothing merges.

## The actual blocker

| Metric | Value |
| --- | --- |
| Open PRs on `beevibe-ai/beevibe` | **208** |
| PRs merged since 2026-08-10 | **0** (12 weeks) |
| `main` HEAD | `81530cc`, 2026-08-10 |
| Open PRs titled "near-duplicate" (this routine) | **47** |
| Open `refactor:` PRs | 63 |

203 of the 208 open PRs come from four scheduled routines firing every weekday:

| Branch family | Routine | Open branches |
| --- | --- | --- |
| `claude/clever-fermat-*` | near-duplicate unification (this one) | 64 |
| `claude/busy-fermat-*` | test coverage | 64 |
| `claude/intelligent-fermat-*` | test cleanup | 38 |
| `claude/amazing-fermi-*` | dead-code removal | 37 |

Every one of these branches is cut from the same frozen `main`, so each run
rediscovers the same clusters and re-fixes them under a new helper name.

## Collision map: how many open PRs already rewrite each file

Measured with `git diff --name-only` over all 64 `clever-fermat` branches
(test files excluded):

| File | Open PRs rewriting it |
| --- | --- |
| `packages/core/src/adapters/runtime-common.ts` | **23** |
| `packages/core/src/adapters/{claude-code,codex,opencode}/runtime.ts` | **21** each |
| `packages/api/src/routes/http-errors.ts` | **21** |
| `packages/api/src/routes/task.ts` | 19 |
| `packages/web/app/sign-{in,up}/sign-*-client.tsx` | 17 / 16 |
| `packages/api/src/tools/{hierarchy,mesh}.ts` | 13 each |
| `packages/web/components/detail/detail-gate.tsx` | 13 |

The CLI-runtime cluster alone has 23 competing implementations:
#288, #292, #306, #333, #337, #345, #359, #364, #386, #390, #412, #415, #418,
#424, #427, #436, #451, #453, #463, #465, #468, #480, #483 — with helper names
including `streamCliEvents`, `runCliRuntime`, `runStreamingCli`,
`createNdjsonEventCollector` and `runCliEventStream`.

Each of these merges **cleanly onto `main` on its own**. They **conflict with each
other**: merging #480 then #483 conflicts in all three runtimes plus
`runtime-common.ts`. Whichever lands first, the other 46 need rework.

PR #475 (2026-10-27) reached this same conclusion and asked for a merge decision
before more landed. Two more runs landed anyway (#480, #483).

## Findings: the clusters, and who already fixed them

All verified still present in `main` today. For each, merge the recommended PR
rather than writing a 24th implementation.

### P1 — CLI runtime `execute()` lifecycle (3 copies, ~40 lines each)
`packages/core/src/adapters/{claude-code,codex,opencode}/runtime.ts`

Each carries the identical sequence: `createStdoutLineReader` + event-collector
closure, the order-sensitive env build (`{...process.env}` → strip auth vars →
overlay `context.env`), the `pid`→`process_pid` spawn adapter, `flush()`,
`warnIfTruncated`, abort→`cancelledResult`, `finalizeCliResult`. Only the
provider's line parser, step extractor and roll-up differ — all three already
import from the shared `adapters/runtime-common.ts`, so the home exists.

**Recommend: #483** (newest, `runCliEventStream` + `buildCliEnv`, parameterises
exactly the four varying pieces, 11 new unit tests on the shared helper).

### P2 — hand-written fetch-or-404 guards (14 route files)
`packages/api/src/routes/*.ts`, home already exists at `routes/http-errors.ts`

`http-errors.ts` already owns `requireParam` / `invalidBody` / `loadOwned` /
`makeErrorHandler`, but the fetch-or-404 shape is still spelled out by hand ~13
times; two sites are byte-identical including the prose.

**Recommend: #480** (`loadOr404`, and `loadOwned` delegates its first half to it
so the 404 envelope has one implementation instead of two).

### P3 — escalation `proposals` / `open_questions` (2 copies + a third shape decl)
`packages/api/src/tools/hierarchy.ts`, `packages/api/src/tools/mesh.ts`

Both tools hand the same two fields to `EscalationService`; each carries its own
copy of the JSON Schema fragment and its own `Array.isArray(...) ? cast :
undefined` parse, with `add_to_escalation` restating the `Proposal` shape inline
as a third declaration.

**Recommend: #483** (`tools/escalation-input.ts`; keeps the per-tool `description`
wording at the call site, since agents read it).

### P4 — list-limit clamp (3 copies)
`packages/api/src/views/{inbox,memory,promotions}.ts`

Same `Math.min(Math.max(1, limit ?? DEFAULT), MAX)` inline in all three.

**Recommend: #483** (`clampListLimit` in `views/format.ts`; bounds stay per-view).

### P5 — `McpRouterDeps` restates 17 fields of `AssembleToolsServices`
`packages/api/src/routes/mcp.ts`

Every field exists only to be forwarded to `assembleTools`, and had to be kept in
step by hand in three places (interface, destructure, call).

**Recommend: #483** (`extends Omit<AssembleToolsServices, "memoryAgent">`).

### P6 — web: auth form chrome, detail footer, loading shells
`packages/web/app/sign-{in,up}/*-client.tsx`, the 7 detail clients, 5 `loading.tsx`

**Recommend: #480** (`AuthCard`/`AuthField`/`AuthError`/`AuthSubmit`, `DetailFooter`;
skeletons reuse the existing `components/detail/detail-shell.tsx`). DOM diffed
before/after. **This one has user-visible pixels** — worth an eye.

### P7 — "Save as capability" dialog (~95 duplicated lines, two drifted copies)
task detail page vs `/capabilities/runs/[id]`

Largest remaining clone; both call sites hand-roll a backdrop instead of using the
existing `components/modal-overlay.tsx`.

**Recommend: #475** (deliberately restricted to files no other open PR touches, so
it merges before or after any of them).

### Non-findings (declined repeatedly, correctly)
`anthropic/llm-provider.ts` vs `openai/llm-provider.ts` (only the 8-line
constructor is shared); `app/error.tsx` vs `global-error.tsx` (Next.js requires
the duplication); the ~40 local `*Row` interfaces in `api/src/views/` (query
projections, not copies); everything in the CLAUDE.md false-positive table.

## Recommended unblock plan

Three merges clear every P1–P7 cluster above:

1. **Merge #483** → P1, P3, P4, P5
2. **Merge #480** → P2, P6 (rebase after #483; expect conflicts in the three
   runtimes + `runtime-common.ts`, resolve in favour of #483's `runCliEventStream`)
3. **Merge #475** → P7 (merges cleanly either way by construction)

Then **close the other 44 near-duplicate PRs as superseded** — they are
re-implementations of the same clusters, not additional coverage.

Finally, **pause or throttle the four routines until the backlog clears.** They
are currently adding ~4 PRs per weekday to a queue with zero throughput; the
analysis is not the scarce resource, review is.

# Task 3 Runtime Fix Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude process launch, interruption, resume selection, and confirmed-dead recovery failure-safe and durable.

**Architecture:** Buffer process events until the runner/runtime ownership record is ready, and drive resume/recovery decisions from SQLite rather than in-memory turn guesses. Process cleanup returns success only after an exit event; ambiguous ownership remains durable for Task 4 attention handling.

**Tech Stack:** TypeScript, Vitest, SQLite WAL, node-pty 1.1.0, Windows ConPTY

**Spec:** `docs/spec.md`

## Global Constraints

- Claude Code CLI 2.1.238 or newer; no Anthropic API or Agent SDK.
- Windows hard cancel is Ctrl+C then best-effort `taskkill /PID <pid> /T /F`; no Job Object guarantee.
- Every production fix needs a witnessed failing regression test.
- Real CLI query/resume smoke remains environment-gated and is not run in this fix round.
- No subagent or reviewer dispatch.

---

### Task 1: Failure-atomic runner lifecycle

**Files:** Modify `src/claude/runner.ts`; test `test/claude-runtime.test.ts`.

**Interfaces:** `ClaudeRunner.spawn()` becomes async, registers an ordered bootstrap buffer immediately after `nodePty.spawn`, cleans up after later initialization failure, and shares only in-flight interrupts.

- [x] Add tests for creation-time failure cleanup, early output/exit ordering, delayed exit after taskkill, and a second interrupt after an earlier false result.
- [x] Run the focused runner tests and record expected failures.
- [x] Implement immediate buffered listeners, bounded post-taskkill exit confirmation, and clearing of settled interrupt promises.
- [x] Re-run focused tests.

### Task 2: Durable launch and resume state

**Files:** Modify `src/domain.ts`, `src/store.ts`, `src/claude/runtime.ts`; test `test/claude-runtime.test.ts` and `test/store.test.ts`.

**Interfaces:** Persist `sessionStartedAt`; choose `--resume` from store state; buffer startup JSON/diagnostics/exit until process identity, lease, and active runtime are ready; record the resolved executable/version once per runtime server.

- [x] Add tests for startup unknown/raw persistence, same-turn crash retry using resume, explicit resume errors, and one-time executable metadata.
- [x] Run focused tests and record failures.
- [x] Add schema migrations/store APIs, launch buffer draining, and one-time default factory resolution.
- [x] Re-run focused tests.

### Task 3: Atomic confirmed-dead recovery

**Files:** Modify `src/store.ts`; test `test/claude-runtime.test.ts` or `test/store.test.ts`.

**Interfaces:** `reconcileConfirmedDeadRuntime(agentId, identity)` atomically restores leased message IDs to pending, removes their manifest, requeues the same running turn ID, releases matching locks/lease, and recreates the scheduler queue entry. Broken invariants retain ownership and set `needs_attention`.

- [x] Add a failing state-level test for exact identity, same turn/message IDs, queued states, manifest removal, and scheduler queue restoration.
- [x] Run the test and record the disconnected/running/leased failure.
- [x] Implement the single SQLite transaction and invariant fallback.
- [x] Re-run store/scheduler/runtime tests.

### Task 4: Opt-in live smoke contract and completion

**Files:** Modify `test/claude-real-smoke.test.ts`, `docs/protocol.md`, and append `.superpowers/sdd/2026-09-01-claude-code-subagent-mcp/task-3-report.md`.

**Interfaces:** The gated smoke specifies initial query, context-only result, query boundary, resume, and graceful interruption but remains skipped unless `CLAUDE_MCP_RUN_REAL_CLI_TESTS=1`.

- [x] Expand the gated smoke without running it in ordinary verification.
- [x] Run focused tests, full `npm test`, `npm run typecheck`, and `git diff --check`.
- [x] Append RED/GREEN evidence and remaining concerns to the Task 3 report.
- [x] Commit the verified fix round.

# Task 3 Runtime Fix Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve exact process ownership through attach failures and let Scheduler safely requeue only after a Claude child is confirmed dead.

**Architecture:** `ClaudeRuntime` will return an exact confirmed-dead identity from interruption and throw a structured identity-bearing containment error for ambiguous children. `Scheduler` will distinguish exact confirmed-dead recovery from PID-less fake/runtime failures, while the store performs all requeue or needs-attention transitions transactionally.

**Tech Stack:** TypeScript, Vitest, SQLite WAL, fake PTY/runtime seam

**Spec:** `.superpowers/sdd/2026-09-01-claude-code-subagent-mcp/task-3-brief.md`

## Global Constraints

- Base commit is `c715290`.
- Use real `ClaudeRuntime + Scheduler + AgentStore` in integration regression coverage; fake only the PTY runner boundary.
- Never release PID-bearing ownership without exact PID + creation-time confirmed-dead evidence.
- Windows termination remains Ctrl+C then best-effort taskkill; no Job Object guarantee.
- Do not run the opt-in paid real CLI smoke.
- Do not dispatch subagents or reviewers.

---

### Task 1: Attach-failure containment

**Files:** Modify `src/claude/runtime.ts`, `src/store.ts`, `src/scheduler.ts`; test `test/claude-runtime.test.ts`.

**Interfaces:** Add an exact-identity containment store operation and a structured runtime process error carrying `{ identity, ownershipContained, confirmedDead }`.

- [x] Add a test where `attachRuntimeProcess` fails, interrupt cannot confirm exit, and SQLite retains exact PID/creation-time ownership with `agent=needs_attention`.
- [x] Add a test where the containment write throws and verify the propagated error still carries exact identity while the original lease/lock remains untouched.
- [x] Run those tests and record the expected generic-error/missing-containment RED results.
- [x] Implement the containment transaction and identity-bearing error with no generic recovery path.
- [x] Re-run the focused runtime tests.

### Task 2: Scheduler exact-dead integration recovery

**Files:** Modify `src/scheduler.ts`, `src/claude/runtime.ts`; test `test/scheduler.test.ts`.

**Interfaces:** `AgentRuntime.interrupt(agentId)` may return `{ status: 'confirmed_dead', identity }`; `void` retains the existing PID-less fake-runtime recovery behavior.

- [x] Add a seam test with real Scheduler, ClaudeRuntime, and AgentStore where initial send fails and runner interruption confirms exit.
- [x] Assert literal durable state: same turn/message IDs queued/pending, manifest/lease/lock removed, scheduler queue restored, and retry leases the same IDs.
- [x] Add the paired unconfirmed-exit seam test asserting `needs_attention`, running/leased state, and retained exact lease/lock.
- [x] Run both tests and record the expected stuck-running and missing-needs-attention RED results.
- [x] Implement Scheduler failure recovery branching: exact confirmed identity uses atomic confirmed-dead reconciliation; PID-less fake failure uses `recoverRuntimeFailure`; ambiguous process ownership is retained.
- [x] Re-run scheduler/runtime/store focused tests.

### Task 3: Verification and report

**Files:** Append `.superpowers/sdd/2026-09-01-claude-code-subagent-mcp/task-3-report.md`.

**Interfaces:** No production interface changes beyond Tasks 1-2.

- [x] Run focused tests, full `npm test`, `npm run typecheck`, `git diff --check`, and dependency verification.
- [x] Append RED/GREEN evidence, test totals, changes, self-review, and remaining Task 4 concerns.
- [x] Commit the verified fix round.

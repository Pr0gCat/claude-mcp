# Task 3 Runtime Fix Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry exact confirmed-dead launch identity into Scheduler recovery and propagate uncontained interruption errors to Task 4 callers.

**Architecture:** Reuse `RuntimeProcessContainmentError` as the evidence envelope for launch-window exit. Scheduler will reconcile a contained confirmed identity and rethrow an uncontained typed interruption error with both the original operation failure and containment failure available as causes.

**Tech Stack:** TypeScript, Vitest, SQLite WAL, real Scheduler/ClaudeRuntime/AgentStore seam with fake runner

**Spec:** `.superpowers/sdd/2026-09-01-claude-code-subagent-mcp/task-3-brief.md`

## Global Constraints

- Base commit is `6c4eb1d`.
- Exact PID + creation time + confirmed-dead evidence is required before durable ownership release.
- Real CLI smoke remains environment-gated and is not run.
- No subagents or reviewers.

---

### Task 1: Launch-window confirmed exit

**Files:** Modify `src/claude/runtime.ts`; test `test/claude-runtime.test.ts`, `test/scheduler.test.ts`.

**Interfaces:** A launch-window exit throws `RuntimeProcessContainmentError(identity, ownershipContained=true, confirmedDead=true)` after durable confirmation.

- [x] Add a real Scheduler/ClaudeRuntime/Store test whose runner exits before `start` becomes active.
- [x] Assert the same literal turn/message IDs are queued/pending, manifest/lease/lock are removed, and scheduler queue is restored.
- [x] Run the test and record the stuck running/leased RED state.
- [x] Replace the generic launch error with the exact typed evidence envelope.
- [x] Re-run runtime/scheduler focused tests.

### Task 2: Uncontained interrupt propagation

**Files:** Modify `src/scheduler.ts`; test `test/scheduler.test.ts`.

**Interfaces:** When interruption throws `RuntimeProcessContainmentError` with `ownershipContained=false`, Scheduler rethrows a typed error with exact identity/flags and an aggregate cause containing the original start/deliver failure plus containment persistence failure.

- [x] Add an integration test where initial send fails, interruption is unconfirmed, and `containRuntimeProcess` throws.
- [x] Assert caller receives exact identity/flags and both cause messages while agent/turn/message/lease/lock remain conservatively owned.
- [x] Run the test and record that Scheduler currently returns only the original send failure.
- [x] Implement typed propagation without calling generic recovery.
- [x] Re-run focused tests.

### Task 3: Verification and report

**Files:** Append `.superpowers/sdd/2026-09-01-claude-code-subagent-mcp/task-3-report.md`.

**Interfaces:** No additional runtime behavior.

- [x] Run focused tests, full `npm test`, `npm run typecheck`, `git diff --check`, and `npm ls node-pty --depth=0`.
- [x] Append RED/GREEN evidence, totals, changes, and remaining concerns.
- [x] Commit the verified fix round.

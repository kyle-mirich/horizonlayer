---
name: horizonlayer-coordination
description: Use when Codex should coordinate durable HorizonLayer tasks, leases, handoffs, runs, checkpoints, or multi-agent execution state.
---

# HorizonLayer Coordination

Use coordination when work has ownership, retries, handoffs, or needs to resume after interruption.

## Task Loop

1. Search/list open tasks with `memory.search` and `coordination.task_list`.
2. Create tasks with `coordination.task_create`; use clear titles, owner agent, and priority.
3. Claim with `coordination.task_claim` before doing work; set a lease long enough for the next step.
4. Heartbeat with `coordination.task_heartbeat` during long work.
5. Complete, fail, or hand off with `coordination.task_complete`, `coordination.task_fail`, or `coordination.task_handoff`.
6. Keep custom event flows outside the public OSS loop.

## Run Loop

1. Start a run with `coordination.run_start` for a concrete execution attempt.
2. Checkpoint with `coordination.run_checkpoint` after each meaningful phase with summary plus minimal state.
3. Keep the run associated with the relevant `task_id` and `session_id`.
4. Complete or fail the run with `coordination.run_complete` or `coordination.run_fail`.

Tasks describe durable work. Runs describe attempts to execute it.

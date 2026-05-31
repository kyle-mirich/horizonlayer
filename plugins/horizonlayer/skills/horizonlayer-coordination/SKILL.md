---
name: horizonlayer-coordination
description: Use when Codex should coordinate durable HorizonLayer tasks, leases, handoffs, inboxes, runs, checkpoints, or multi-agent execution state.
---

# HorizonLayer Coordination

Use coordination when work has ownership, dependencies, retries, handoffs, or needs to resume after interruption.

## Task Loop

1. Search/list open tasks in the workspace/session.
2. Create tasks with clear titles, owner agent, priority, and dependencies.
3. Claim before doing work; set a lease long enough for the next step.
4. Heartbeat during long work.
5. Complete, fail, or hand off with a concise payload.
6. Use inbox actions for cross-agent messages that need acknowledgement.

## Run Loop

1. Start a run for a concrete execution attempt.
2. Checkpoint after each meaningful phase with summary plus minimal state.
3. Link the run to relevant tasks, pages, and rows.
4. Complete/fail/cancel the run explicitly.

Tasks describe durable work. Runs describe attempts to execute it.

---
name: using-horizonlayer
description: Explain HorizonLayer capabilities and choose its Knowledge, Issues, search, recovery, and agent workflows when a task involves HorizonLayer or the user asks what it can do.
---

# Using HorizonLayer

Use this skill as the orientation layer for HorizonLayer. Ground explanations in the current MCP catalog, project configuration, and repository documentation. Hand detailed operations to the `knowledge` or `issues` skill; this skill explains which capability fits and what the complete workflow looks like.

## What HorizonLayer is

HorizonLayer is a local-first MCP server for durable coding-agent context and work coordination. PostgreSQL is the canonical store. Qdrant is an optional, derived semantic index that can be rebuilt from PostgreSQL. The local dashboard is a loopback interface for human inspection and editing.

## Capability map

| Need | HorizonLayer capability | Choose it when |
| --- | --- | --- |
| Discover or isolate durable context | Knowledge Workspace | Pages and typed records need a stable scope |
| Store decisions, plans, research, or procedures | Page and ordered Blocks | The material is narrative or needs readable history |
| Store repeated structured records | Typed Database and Rows | Values need property types, exact filters, or sorting |
| Find canonical records | Knowledge search with `mode: "records"` | The agent needs a page or row to inspect, change, or link |
| Find semantic evidence | Knowledge search with `mode: "rag"` | Meaning matters more than exact wording and citations are useful |
| Resume work across agents or turns | Session and Run checkpoints | Progress, state, and the latest durable context must survive a handoff |
| Relate records without expanding them | Explicit Links and bounded Navigation | A relationship matters but linked content should stay on demand |
| Coordinate executable work | Issue Project and Issues | Work needs status, ownership, comments, subtasks, or dependencies |
| Find safe work for an agent | `issue.query` with `ready = true` | The Issue must be open, unassigned, and free of unfinished blockers |
| Claim work exclusively | `issue.claim` | One agent should own the next Issue |
| Preserve or recover local data | Backup and Runtime Recovery | The managed PostgreSQL runtime needs a portable safety artifact |

## The normal Knowledge workflow

1. List active Workspaces and reuse the closest one.
2. Search existing Pages or Databases before creating a duplicate.
3. Read the canonical record before changing it.
4. Send the latest `revision` with every mutable-record update, archive, or restore.
5. On `CONFLICT`, reread, reconcile, and retry once.
6. Use Pages for prose, typed Rows for repeated facts, and explicit Links when the relationship itself is useful.

## The normal Issues workflow

1. List Issue Projects and reuse the configured project.
2. Query for existing Issues before creating work.
3. Read one candidate, then claim it with its latest revision before editing.
4. Add a concise progress or resolution Comment, update the explicit status, and preserve durable context in a linked Knowledge Page when needed.
5. Use a Subtask for same-project decomposition and a Dependency when one Issue must finish before another can proceed.
6. Use bounded link traversal when cross-domain context is needed; open the referenced record explicitly before changing it.

## Choosing the agent workflow

- Use **Wayfinder** when the destination is large or uncertain and the decisions needed before implementation are not yet visible.
- Use **To Spec** when the conversation is understood and needs a durable specification.
- Use **To Tickets** when the plan is understood and needs independently verifiable implementation slices.
- Use **Implement** when a specification or build ticket is ready; drive TDD at an agreed seam and finish with code review.
- Use **Diagnosing Bugs** when the work starts from a failure or regression and needs a red-capable feedback loop.
- Use **Improve Codebase Architecture** when the question is where to deepen a shallow module or improve locality and leverage.

## Honest boundaries

HorizonLayer provides context storage, retrieval, issue coordination, MCP integration, and local runtime lifecycle. It does not itself generate code, call an LLM, automatically complete Issues, provide hosted multi-tenant authorization, or replace a project's CI/CD system. Archive and restore are the public record lifecycle; Runtime Recovery is the separate operation that recreates the managed local database from a trusted Backup.

When explaining a workflow, name the scope, the MCP tool/action, the expected result, and the verification step. Prefer a small concrete path over a catalog dump, and say when a capability is optional, local-only, or outside the current product.

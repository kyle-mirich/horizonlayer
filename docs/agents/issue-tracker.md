# Issue tracker: HorizonLayer MCP

This repository uses the local HorizonLayer MCP as its issue tracker for engineering work. Use the `issues` tool for plans, decision tickets, implementation tickets, comments, status, ownership, and dependencies. Use the `knowledge` tool for durable research, specifications, decisions, and other context. Do not use GitHub Issues as the workflow state for this repository.

## Configuration

The project-local `.horizonlayer.json` records the selected modules and the default Knowledge Workspace and Issue Project names. Runtime credentials stay in HorizonLayer's private local runtime configuration. If the project configuration is absent, list existing Issue Projects and Knowledge Workspaces before creating new ones.

## Core operations

- **List projects**: call `issues` with `action: "project.list"`.
- **Create an Issue**: call `issues` with `action: "issue.create"`, the configured `project_id`, a concise title, `created_by`, a durable description, and tags.
- **Read an Issue**: call `issues` with `action: "issue.get"` and its UUID or readable key. Request comments or links only when they affect the work.
- **Query Issues**: call `issues` with `action: "issue.query"`. Use the AND-only query language, for example `project = HORIZONLAYER AND status = open AND assignee IS EMPTY` or `tag = wayfinder:map`.
- **Comment**: call `issues` with `action: "comment.add"`. Keep comments concise and durable.
- **Claim**: call `issues` with `action: "issue.claim"` using the latest Issue revision. Claiming is exclusive and is the first write of an implementation session.
- **Update**: call `issues` with `action: "issue.update"` using the latest revision. Status, description, assignee, tags, and other mutable fields are explicit; read the current tags before replacing them.
- **Block**: call `issues` with `action: "dependency.create"` using `blocking_issue` for the prerequisite and `blocked_issue` for the dependent ticket.
- **Link context**: call `issues` with `action: "link.create"` to connect an Issue to a Knowledge Page, then use bounded `link.traverse` when navigation is useful.

Issue keys such as `HORIZONLAYER-12` are the human-facing names. UUIDs are also valid. Every mutable record write uses its latest `revision`; on `CONFLICT`, reread, reconcile, and retry once. Use explicit `done` or `closed` status rather than inferring completion from a comment, dependency, or subtask.

## Workflow tags

The five triage role names are stored as HorizonLayer Issue tags: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. Category tags such as `bug` and `enhancement` may accompany one state tag. Wayfinder tags (`wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, and `wayfinder:task`) describe planning artifacts and remain distinct from implementation workflow tags.

## Wayfinding operations

- **Map**: one open Issue tagged `wayfinder:map`; put `Destination`, `Notes`, `Decisions so far`, `Not yet specified`, and `Out of scope` in its description.
- **Decision ticket**: a child Issue created with `parent_issue` set to the map and exactly one `wayfinder:<type>` tag. Its description contains a focused `Question`.
- **Frontier**: read the map, inspect its returned subtasks, and intersect them with `issue.query` results for `ready = true`. An Issue is ready when it is open, unassigned, and has no unfinished blocking dependency.
- **Resolution**: add one resolution comment, update the ticket to `done` with its latest revision, store durable material as a linked Knowledge Page, and update the map description with a concise context pointer.
- **Out of scope**: update the ticket to `closed` and record the reason in the map's `Out of scope` section.

## Knowledge operations

Reuse the closest active Knowledge Workspace. Search with `knowledge` `operation: "search"` and `input.mode: "records"` before creating a Page or Database. Use `mode: "rag"` only when semantic evidence is needed. Read the canonical Page or Row before mutating it, preserve its revision, and keep linked content on demand rather than expanding it automatically.

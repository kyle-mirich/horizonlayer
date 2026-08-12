# HorizonLayer

HorizonLayer preserves durable, workspace-scoped knowledge for coding agents and makes that knowledge inspectable and resumable across sessions.

## Language

**Managed Local Runtime**:
A user-owned HorizonLayer environment provisioned and operated on the user's machine.
_Avoid_: Hosted instance, deployment

**Canonical Knowledge**:
The authoritative representation of a user's HorizonLayer content, sufficient to reconstruct any derived representation.
_Avoid_: Cache, index

**Derived Search Index**:
A disposable retrieval representation that contains no knowledge unavailable from Canonical Knowledge.
_Avoid_: Canonical store, source of truth

**Backup**:
A portable, point-in-time copy of all Canonical Knowledge in one Managed Local Runtime, created for disaster recovery.
_Avoid_: Workspace export, snapshot

**Runtime Recovery**:
Recreating a Managed Local Runtime's Canonical Knowledge from a validated Backup.
_Avoid_: Record restore, import

**Record Restore**:
Returning an archived workspace, page, database, row, property, block, or link to its active lifecycle state.
_Avoid_: Runtime recovery

**Knowledge Module**:
The optional HorizonLayer MCP module for the existing workspace-scoped knowledge records.
_Avoid_: Separate Knowledge MCP, Notion MCP

**Issue Module**:
The optional HorizonLayer MCP module for first-class work-tracking records, independent of Knowledge Workspaces.
_Avoid_: Separate Issue MCP, Jira clone, workspace-scoped task database

**Issue Tracker**:
The Issue Module's collection of Jira-style Issue Projects and their Issues in a Shared Canonical Database.
_Avoid_: Knowledge Workspace

**Issue Project**:
A Jira-style container that organizes related Issues without being a Knowledge Workspace; every Issue belongs to exactly one Issue Project.
_Avoid_: Knowledge Workspace, Host Project

**HorizonLayer MCP**:
The single MCP server that exposes the Knowledge Module, Issue Module, and their shared capabilities selected for a project.
_Avoid_: Separate KB and Issue servers

**Issue Tag**:
A label used to organize and retrieve related Issues.
_Avoid_: Custom field, workspace

**Issue Comment**:
An append-only discussion entry attached to an Issue, attributed to a human or agent.
_Avoid_: Knowledge Page, Issue description

**Knowledge-Issue Link**:
An optional, many-to-many relationship between a Knowledge Page and an Issue that agents can follow from either module, without making the Issue belong to the Page's Workspace or the Page belong to the Issue's Project.
_Avoid_: Required issue documentation, duplicated content, shared workspace

**Link Navigation**:
An on-demand, CLI-like traversal from a Knowledge Page or Issue through compact linked-record references, where an agent chooses the branches and records to open.
_Avoid_: Automatic context expansion, forced cross-module reads

**Compact MCP Surface**:
The smallest set of clearly described MCP tools needed for an agent to operate installed HorizonLayer modules without wasting its context budget.
_Avoid_: One tool per minor operation, repeated verbose tool descriptions

**Subtask**:
An Issue with one parent Issue, used to divide that parent’s work into independently trackable work.
_Avoid_: Comment, tag

**Issue Dependency**:
An explicit relationship that says one Issue must be completed before another Issue can proceed.
_Avoid_: Parent-child relationship, informal note

**Issue Lifecycle**:
The simple work flow of open, in progress, blocked, done, and closed; closed means intentionally abandoned rather than completed, and completion is always explicit.
_Avoid_: Required review workflow, automatic completion

**Issue Assignment**:
The exclusive current owner of an Issue; an assigned Issue is unavailable for other agents to take until released, reassigned, or completed.
_Avoid_: Advisory assignee, permission system

**Issue Query**:
A filterable view of Issues that agents use to find work, including work that is open, unassigned, and unblocked.
_Avoid_: Separate task queue, raw database query

**Shared Canonical Database**:
The one PostgreSQL database that authoritatively stores both Knowledge Module records and Issue Module records, in their respective tables.
_Avoid_: Separate issue database, duplicated knowledge store

**Host Project Installation**:
An interactive HorizonLayer setup run from a host code project that selects and configures the MCP modules the project will use; it can create a default Issue Project named for that host project.
_Avoid_: Issue Project, global installation, separate installer per module

**Module Selection**:
The Host Project Installation choice to configure the Knowledge Module, the Issue Module, or both.
_Avoid_: Two required products, implicit all-modules setup

**Project Module Configuration**:
Project-local configuration that declares the HorizonLayer MCP modules a project uses while the records remain in the user's Shared Canonical Database by default.
_Avoid_: Per-project database, global module selection

**Default Knowledge Workspace**:
The Knowledge Module's initial Workspace, named `Default`, created by setup as an optional parent container for Pages; agents can create other Knowledge Workspaces.
_Avoid_: Issue Project, required issue scope

**Dedicated Runtime**:
An explicitly configured Managed Local Runtime with separate local services and Canonical Knowledge from the default runtime.
_Avoid_: Default project setup, isolated workspace

**HorizonLayer Skills**:
Optional agent-facing guidance installed by HorizonLayer's own installer alongside selected HorizonLayer MCP modules.
_Avoid_: MCP tools, required runtime dependency, externally managed skill installation

**HorizonLayer Bootstrap**:
The HorizonLayer-owned interactive CLI that selects modules and optionally installs their bundled skills for a project.
_Avoid_: Generic skills CLI, separate module installers

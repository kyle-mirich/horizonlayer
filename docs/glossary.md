# HorizonLayer Glossary

The shared vocabulary used across HorizonLayer's code, documentation, and agent-facing skills. Terms are normative: when writing docs or tool descriptions, prefer these names over the listed avoid-terms. Every term below names something referenced outside this file; anything else is described inline where it is used.

## Language

**HorizonLayer**:
The product name, always written as one word with capital H and L.
_Avoid_: Horizon Layer, horizon-layer

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
_Avoid_: Archived-record restore, import

**Knowledge Module**:
The optional HorizonLayer MCP module for the existing workspace-scoped knowledge records.
_Avoid_: Separate Knowledge MCP, Notion MCP

**Issue Module**:
The optional HorizonLayer MCP module for first-class work-tracking records, independent of Knowledge Workspaces.
_Avoid_: Separate Issue MCP, Jira clone, workspace-scoped task database

**Issue Tracker**:
The Issue Module's collection of Jira-style Issue Projects and their Issues in one shared PostgreSQL database.
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

**Module Selection**:
The setup choice to configure the Knowledge Module, the Issue Module, or both.
_Avoid_: Two required products, implicit all-modules setup

**Default Knowledge Workspace**:
The Knowledge Module's initial Workspace, named `Default`, created by setup as an optional parent container for Pages; agents can create other Knowledge Workspaces.
_Avoid_: Issue Project, required issue scope

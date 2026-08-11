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

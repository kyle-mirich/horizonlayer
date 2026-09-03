# Backup and Runtime Recovery

HorizonLayer Backup protects canonical Knowledge and Issue data stored in the saved Docker-managed PostgreSQL 17 runtime. It does not manage an external `DATABASE_URL`, copy Docker volumes, or include Qdrant. Qdrant is a Derived Search Index and is cleared, then rebuilt lazily from recovered PostgreSQL data. Managed Backup refuses only a `DATABASE_URL` override; `RAG_ENABLED` and `QDRANT_URL` are allowed. Runtime Recovery refuses both `DATABASE_URL` and `QDRANT_URL` overrides.

## Create and verify a Backup

```bash
npx -y horizonlayer@latest doctor
npx -y horizonlayer@latest backup
npx -y horizonlayer@latest backup /secure/path/horizonlayer-data.hlbackup
```

The default destination is the private `backups/` directory beside `runtime.json`; it survives `npx -y horizonlayer@latest reset --yes`. An explicit parent directory must already exist. HorizonLayer writes a PostgreSQL custom-format payload to a private temporary file beside the destination, validates it with the managed container's PostgreSQL 17 tools, adds a versioned manifest and SHA-256 checksum, and atomically publishes a mode-`0600` `.hlbackup` with a hard link, which requires staging and destination to share a filesystem. Existing destinations are never replaced.

Treat the artifact as sensitive: it contains all workspaces, pages and blocks, typed databases and rows, Issue Projects, Issues, comments, subtasks, dependencies, cross-domain links, sessions, runs, checkpoints, tags, importance values, revisions, and archived records. Store it with the same controls as the original data. Do not recover an artifact from an untrusted source because PostgreSQL archives can contain executable database definitions.

The receipt's snapshot interval bounds when PostgreSQL selected its consistent point-in-time view. Ordinary writes may continue during Backup, but commits made after the snapshot began are not guaranteed to be present.

## Preview before confirmation

```bash
npx -y horizonlayer@latest recover /secure/path/horizonlayer-data.hlbackup
```

Preview fully validates framing, compatibility, length, and checksum without starting or stopping services. It prints the absolute artifact, saved `runtime.json`, target Compose project, snapshot interval, scope and versions, Derived Search Index policy, and exact confirmation command. Its exit status is `1` by design.

Confirm only after verifying all displayed paths and the source:

```bash
npx -y horizonlayer@latest recover /secure/path/horizonlayer-data.hlbackup --yes
```

Confirmed recovery acquires the lifecycle lock and rejects `DATABASE_URL` or `QDRANT_URL` overrides. It starts and health-checks the saved runtime, validates both the requested archive and an automatic safety Backup, then stops the normal PostgreSQL and Qdrant services. A uniquely named PostgreSQL container mounts the existing managed volume without publishing its normal host port. `pg_restore` uses `--clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error`, so an SQL failure before commit leaves the old database intact.

After restore, HorizonLayer runs `ANALYZE`, validates the canonical schema with a 16-table presence count, clears the managed Qdrant collection, removes the isolated container, and restarts healthy services. The receipt records both checksums, the recovered snapshot interval, the retained safety Backup, completion time, health, and configuration path. Inspect important records through MCP or `npx -y horizonlayer@latest dashboard` before deleting that safety artifact.

## Failure outcomes and troubleshooting

- **Preflight failure:** invalid, corrupt, incompatible, or changing input is rejected before published services stop. Current canonical data remains unchanged.
- **Failure before commit:** the single restore transaction does not commit; HorizonLayer validates the preserved database and restarts the managed runtime.
- **Failure after commit but before canonical/Qdrant validation:** HorizonLayer restores the retained safety Backup, clears Qdrant, and restarts. Both artifact paths remain in the error.
- **Failure after canonical and Qdrant validation:** valid recovered data is retained. HorizonLayer does not overwrite it merely because the final service restart failed; run `npx -y horizonlayer@latest doctor`, then `npx -y horizonlayer@latest setup`.
- **Recovery and rollback both fail:** services remain stopped. Keep both artifacts, do not start clients, and inspect the named Docker container/logs before taking further action.

`SIGINT` and `SIGTERM` are deferred between safety-critical phases so cleanup, preserved-state restart, or rollback can complete. After any interrupted or failed operation, run:

```bash
npx -y horizonlayer@latest doctor
```

Never use `reset --yes` as recovery cleanup. It deletes the named volumes. If a lifecycle command is genuinely no longer running but left the reported `.setup.lock`, remove only that exact lock file and retry.

The PostgreSQL guarantees behind this design are recorded in [the primary-source research note](research/postgresql-backup-recovery.md).

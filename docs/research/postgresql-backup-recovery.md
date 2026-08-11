# PostgreSQL Backup and Recovery Guarantees

## Decision

Back up the managed PostgreSQL 17 database with the `pg_dump` binary from its
running `postgres:17` container and a **custom-format archive** (`-Fc`). Stream
that archive through `docker compose exec -T` into a host-side temporary file,
then publish it only after `pg_dump` exits successfully and the application has
validated and durably written the artifact. Recover with the container's
`pg_restore`, targeting the already provisioned managed database and using
`--clean --if-exists --no-owner --no-acl --single-transaction`.

This is a logical, single-database backup. Do not copy the live PostgreSQL data
volume as HorizonLayer's portable artifact, and do not include Qdrant: PostgreSQL
is canonical and Qdrant is derived. The recovery command must target only the
saved Docker Compose project, refuse explicit external `DATABASE_URL` targets,
validate the archive before changing the database, and require an exclusive
recovery window with MCP and dashboard clients stopped.

## Guarantees and constraints

### Snapshot consistency under concurrent writes

`pg_dump` creates an internally consistent snapshot from the time the dump
begins, does not block ordinary readers or writers, and produces a portable
logical representation. Operations requiring exclusive table locks, such as
many `ALTER TABLE` forms, are the exception and can conflict with the dump.
These are explicit PostgreSQL guarantees, so normal HorizonLayer writes may
continue during backup without creating a torn snapshot
([SQL Dump](https://www.postgresql.org/docs/17/backup-dump.html),
[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)).

The backup represents one point in time, not necessarily the state when the
command finishes. A successful command therefore needs to report the snapshot
start time (or conservatively the operation interval), not imply that writes
committed after the snapshot are present. `--serializable-deferrable` is not
needed for disaster recovery; PostgreSQL documents it for cases where the dump
must correspond to a later serial execution while a reporting copy is made.

### Archive format, streaming, and parallelism

PostgreSQL identifies custom and directory archives as its most flexible
formats. Both are compressed by default, selectable/reorderable with
`pg_restore`, and support parallel restore; only directory format supports a
parallel dump. Tar archives are uncompressed and restrict table-data ordering
([pg_dump formats](https://www.postgresql.org/docs/17/app-pgdump.html)).

Use custom format because HorizonLayer needs one portable file and a bounded,
streaming implementation more than parallel dump throughput. `pg_dump -Fc`
can write to standard output. Compose allocates a TTY by default, so scripted
binary transfer must use `docker compose exec -T` to disable it
([docker compose exec](https://docs.docker.com/reference/cli/docker/compose/exec/)).
Keep stdout exclusively for archive bytes and capture stderr separately; warnings
matter even when the process succeeds. Write to a sibling temporary file, check
the child and stream exit paths, flush/sync it, structurally inspect its table of
contents with `pg_restore --list`, checksum it, and atomically rename it. Never
expose a partial file at the requested destination.

Parallel restore is a future optimization, not the default safety contract.
`pg_restore --jobs` works only with custom/directory input that is a regular
file or directory, not a pipe or standard input, and cannot be combined with
`--single-transaction`
([pg_restore parallelism](https://www.postgresql.org/docs/17/app-pgrestore.html)).
Atomic recovery is more valuable for this local runtime than parallel speed.

### Version compatibility

Use the client utilities inside the managed PostgreSQL container. That keeps the
dump/restore tools on the runtime's PostgreSQL 17 major line and avoids depending
on host installations. PostgreSQL states that `pg_dump` refuses a server newer
than the utility's own major version. Dumps are expected to load into servers
newer than the dump utility, but loading into an older major version is not
guaranteed, even if the source server had that older version
([pg_dump notes](https://www.postgresql.org/docs/17/app-pgdump.html)).

The artifact manifest should record the source server version, `pg_dump`
version, archive format, HorizonLayer artifact/schema version, database name,
creation interval, byte length, and checksum. Recovery should accept PostgreSQL
17 archives for the current runtime, reject a source major newer than the target,
and leave future-major support to an explicitly tested compatibility decision.
The floating `postgres:17` image can change minor releases; this is desirable
for fixes, but the actual versions must be recorded rather than inferred from
the Compose tag.

### Ownership, ACLs, and cluster globals

`pg_dump` backs up one database, not cluster-wide roles or tablespaces. Full
cluster globals require `pg_dumpall`; snapshots across multiple databases would
not be synchronized
([SQL Dump: pg_dumpall](https://www.postgresql.org/docs/17/backup-dump.html)).
HorizonLayer manages one application database and re-provisions its configured
login role, so role and tablespace portability should not become part of this
artifact.

Restore with `--no-owner --no-acl`. Without `--no-owner`, `pg_restore` emits
ownership changes that can fail unless the restoring role is a superuser or the
original owner. `--no-acl` suppresses grants/revokes that depend on roles already
existing. With `--no-owner`, the restoring managed role owns the restored
objects
([pg_restore ownership and privileges](https://www.postgresql.org/docs/17/app-pgrestore.html)).
These flags belong on `pg_restore` for archive formats; PostgreSQL documents that
`pg_dump --no-owner` is ignored for non-text archives.

### Restore target and failure behavior

Restore into the managed database, never into an arbitrary database embedded in
an archive. Avoid `pg_restore --create`: it restores to the archive's database
name and uses the `--dbname` connection only to issue drop/create operations.
Instead, explicitly select the database from the trusted saved runtime config.
A pristine database based on `template0` is the strongest destination;
PostgreSQL warns that restoring into a database with local additions can produce
duplicate-definition errors
([pg_restore notes](https://www.postgresql.org/docs/17/app-pgrestore.html)).

When the launcher has already initialized the canonical schema, use:

```text
pg_restore --dbname DB --clean --if-exists --no-owner --no-acl \
  --single-transaction < ARCHIVE
```

`--clean` drops objects represented by the archive before recreating them, and
`--if-exists` suppresses only absent-object noise. It does not promise to remove
unrelated objects that are absent from the archive, so recovery must target a
known managed schema/runtime rather than treat this as a general database merge.
Without `--exit-on-error`, `pg_restore` continues and reports an error count;
`--single-transaction` implies exit-on-error and guarantees that all restore
commands apply or none do
([pg_restore options](https://www.postgresql.org/docs/17/app-pgrestore.html)).
That transaction also makes the clean-and-recreate sequence roll back on an SQL
failure. PostgreSQL cautions that a single transaction can exhaust lock-table
space for very large numbers of objects, but HorizonLayer should preserve this
atomic contract until measured archive scale proves it unsuitable.

The transaction does not protect against external clients writing during
recovery or against host/container loss after commit. Recovery therefore needs
an exclusive window, a preflight connection check, a verified safety backup of
the current state before destructive work, and post-restore `ANALYZE`, canonical
schema/integrity checks, and end-to-end MCP/dashboard reads before declaring
success. PostgreSQL explicitly notes that dump archives omit optimizer
statistics and recommends `ANALYZE` after restore.

### Docker-managed runtime boundary

The current Compose file correctly mounts PostgreSQL 17 at
`/var/lib/postgresql/data`; the official image warns that this exact path is
required for persistent data on PostgreSQL 17 and below
([Postgres Official Image](https://hub.docker.com/_/postgres)). Named volumes
persist independently of containers, while `docker compose down --volumes`
removes declared named volumes
([Docker volumes](https://docs.docker.com/engine/storage/volumes/),
[docker compose down](https://docs.docker.com/reference/cli/docker/compose/down/)).

Those volume semantics explain the reset hazard, but a raw copy of a live
database volume is not the portable recovery contract. HorizonLayer should run
PostgreSQL utilities inside the identified Compose service, stream the logical
archive across the container boundary, and keep the final artifact in a
user-owned host path outside all Compose volumes. A reset must never run until
that artifact has been closed, validated, checksummed, and made durable.

## Required local proofs

- Write while `pg_dump` runs, then prove the restored database is internally
  consistent and corresponds to a valid snapshot.
- Interrupt or fail the dump at multiple points and prove no final artifact is
  published; detect truncation or checksum corruption before recovery.
- Fail `pg_restore` after cleanup begins and prove `--single-transaction` leaves
  the pre-recovery database unchanged.
- Exercise recovery into a freshly reset runtime and an already initialized
  managed database; refuse an external `DATABASE_URL`, wrong Compose project,
  incompatible manifest, corrupt archive, and active-client window.
- Verify all canonical rows through SQL, MCP, and dashboard, then rebuild and
  verify the derived Qdrant index. Run `ANALYZE` as part of successful recovery.

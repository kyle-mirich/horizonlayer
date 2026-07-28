export interface ArchiveState {
  archived_at: string | null;
  revision: number;
}

/**
 * Report an attempted archive lifecycle transition that did not update a row.
 *
 * A matching revision can fail either because the record is already in the
 * requested state or because it was deleted between the update and this read.
 * The former is a state conflict; callers retain their existing null/not-found
 * behavior for the latter.
 */
export function assertArchiveTransition(
  entity: string,
  id: string,
  revision: number,
  archived: boolean,
  current: ArchiveState | undefined
): void {
  if (!current) return;
  if (current.revision !== revision) {
    throw new Error(`Conflict: ${entity} ${id} is at revision ${current.revision}, not ${revision}`);
  }
  if ((current.archived_at !== null) === archived) {
    throw new Error(`${entity} ${id} is already ${archived ? 'archived' : 'restored'}`);
  }
}

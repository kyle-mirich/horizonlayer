export type RevisionState = 'conflict' | 'error' | 'saved' | 'saving';

const labels: Record<RevisionState, string> = {
  conflict: 'Changed elsewhere',
  error: 'Could not save',
  saved: 'Saved',
  saving: 'Saving',
};

export function RevisionRing({ state = 'saved' }: { state?: RevisionState }) {
  return (
    <span className={`revision-ring revision-ring--${state}`} role="status" aria-label={labels[state]}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle className="revision-ring__track" cx="12" cy="12" r="8.5" />
        <circle className="revision-ring__arc revision-ring__arc--one" cx="12" cy="12" r="8.5" />
        <circle className="revision-ring__arc revision-ring__arc--two" cx="12" cy="12" r="8.5" />
        <circle className="revision-ring__arc revision-ring__arc--three" cx="12" cy="12" r="8.5" />
      </svg>
      <span>{labels[state]}</span>
    </span>
  );
}

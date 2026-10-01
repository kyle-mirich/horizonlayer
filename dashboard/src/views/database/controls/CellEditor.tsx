import { memo, useEffect, useRef, useState } from 'react';

import { Icon } from '../../../components/Icon';
import type { DatabaseProperty, JsonValue } from '../../../types';
import {
  cellDraftValue,
  choicesFrom,
  multiValue,
  sameJsonValue,
  textInputValue,
} from './DatabaseControlUtils';

export const CellEditor = memo(function CellEditor({
  choiceResetKey = 0,
  disabled,
  onCommit,
  property,
  rowLabel,
  value,
}: {
  choiceResetKey?: number;
  disabled: boolean;
  onCommit(value: JsonValue): Promise<unknown>;
  property: DatabaseProperty;
  rowLabel: string;
  value: JsonValue | undefined;
}) {
  const label = `${property.name} for ${rowLabel}`;
  const choices = property.options.choices ?? [];
  const choicesConfigured = property.options.choices !== undefined;
  const initialDraft = cellDraftValue(property.property_type, value);
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(initialDraft);
  const dirtyRef = useRef(false);
  const submittedDraftRef = useRef<string | null>(null);
  const [choiceDraft, setChoiceDraft] = useState(value);
  const choiceDraftRef = useRef(value);
  const choicePendingRef = useRef(false);
  const choiceSubmissionRef = useRef(0);
  const choicePropertyRef = useRef(property.id);
  const choiceResetKeyRef = useRef(choiceResetKey);

  useEffect(() => {
    const resetChoice = choicePropertyRef.current !== property.id
      || choiceResetKeyRef.current !== choiceResetKey;
    choicePropertyRef.current = property.id;
    choiceResetKeyRef.current = choiceResetKey;
    // Save completion is independent of React rendering every acknowledgement.
    if (resetChoice) {
      choiceSubmissionRef.current += 1;
      choicePendingRef.current = false;
    } else if (choicePendingRef.current) {
      return;
    }
    choiceDraftRef.current = value;
    setChoiceDraft(value);
  }, [choiceResetKey, property.id, value]);

  useEffect(() => {
    const serverDraft = cellDraftValue(property.property_type, value);
    const submitted = submittedDraftRef.current;
    if (submitted !== null && serverDraft === submitted) {
      submittedDraftRef.current = null;
      if (draftRef.current !== submitted) return;
      dirtyRef.current = false;
      draftRef.current = serverDraft;
      setDraft(serverDraft);
      return;
    }
    if (dirtyRef.current) return;
    draftRef.current = serverDraft;
    setDraft(serverDraft);
  }, [property.property_type, value]);

  const submitDraft = (parsed: JsonValue) => {
    const submittedDraft = cellDraftValue(property.property_type, parsed);
    draftRef.current = submittedDraft;
    setDraft(submittedDraft);
    if (!sameJsonValue(value, parsed)) {
      dirtyRef.current = true;
      submittedDraftRef.current = submittedDraft;
      onCommit(parsed);
    } else {
      dirtyRef.current = false;
      submittedDraftRef.current = null;
    }
  };

  const commitText = (next: string) => {
    let parsed: JsonValue = next;
    if (property.property_type === 'title') {
      const normalized = next.trim();
      if (!normalized) {
        const restored = textInputValue(value);
        draftRef.current = restored;
        dirtyRef.current = false;
        submittedDraftRef.current = null;
        setDraft(restored);
        return;
      }
      parsed = normalized;
    } else if (property.property_type === 'number') {
      parsed = next === '' ? null : Number(next);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) return;
    } else if (next === '') {
      parsed = null;
    }
    submitDraft(parsed);
  };

  const commitChoice = (next: JsonValue) => {
    if (sameJsonValue(next, choiceDraftRef.current)) return;
    const submission = ++choiceSubmissionRef.current;
    choiceDraftRef.current = next;
    choicePendingRef.current = true;
    setChoiceDraft(next);
    const finishChoice = () => {
      if (choiceSubmissionRef.current === submission) choicePendingRef.current = false;
    };
    void onCommit(next).then(finishChoice, finishChoice);
  };

  if (property.property_type === 'checkbox') {
    return (
      <label className="cell-checkbox" title={label}>
        <input
          aria-label={label}
          checked={choiceDraft === true}
          disabled={disabled}
          onChange={(event) => commitChoice(event.target.checked)}
          type="checkbox"
        />
        <span aria-hidden="true"><Icon name="check" size={13} /></span>
      </label>
    );
  }

  if (property.property_type === 'select' && choicesConfigured) {
    return (
      <select
        aria-label={label}
        className="cell-input cell-input--select"
        disabled={disabled}
        onChange={(event) => commitChoice(event.target.value || null)}
        value={typeof choiceDraft === 'string' ? choiceDraft : ''}
      >
        <option value="">None</option>
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    );
  }

  if (property.property_type === 'multi_select' && choicesConfigured) {
    const selected = multiValue(choiceDraft);
    const remaining = choices.filter((choice) => !selected.includes(choice));
    return (
      <div className="cell-multi" aria-label={label} role="group">
        {selected.map((choice) => (
          <button
            aria-label={`Remove ${choice} from ${property.name}`}
            className="choice-chip"
            disabled={disabled}
            key={choice}
            onClick={() => commitChoice(multiValue(choiceDraftRef.current).filter((item) => item !== choice))}
            type="button"
          >
            {choice}<span aria-hidden="true">×</span>
          </button>
        ))}
        {remaining.length > 0 ? (
          <select
            aria-label={`Add ${property.name} choice for ${rowLabel}`}
            className="choice-adder"
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) commitChoice([...multiValue(choiceDraftRef.current), event.target.value]);
              event.target.value = '';
            }}
            value=""
          >
            <option value="">＋</option>
            {remaining.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        ) : null}
      </div>
    );
  }

  const multiWithoutChoices = property.property_type === 'multi_select';
  return (
    <input
      aria-label={label}
      className={`cell-input cell-input--${property.property_type}`}
      disabled={disabled}
      inputMode={property.property_type === 'number' ? 'decimal' : undefined}
      onBlur={(event) => {
        if (multiWithoutChoices) {
          submitDraft(choicesFrom(event.target.value));
        } else {
          commitText(event.target.value);
        }
      }}
      onChange={(event) => {
        dirtyRef.current = true;
        draftRef.current = event.target.value;
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          const restored = cellDraftValue(property.property_type, value);
          dirtyRef.current = false;
          submittedDraftRef.current = null;
          draftRef.current = restored;
          setDraft(restored);
        }
      }}
      placeholder={property.property_type === 'title' ? 'Untitled' : '—'}
      step={property.property_type === 'number' ? 'any' : undefined}
      type={property.property_type === 'number'
        ? 'number'
        : property.property_type === 'date'
          ? 'date'
          : property.property_type === 'url'
            ? 'url'
            : 'text'}
      value={draft}
    />
  );
}, (previous, next) => previous.choiceResetKey === next.choiceResetKey
  && previous.disabled === next.disabled
  && previous.property.id === next.property.id
  && previous.property.revision === next.property.revision
  && previous.rowLabel === next.rowLabel
  && sameJsonValue(previous.value, next.value));

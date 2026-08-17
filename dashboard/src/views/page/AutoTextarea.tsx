import { useLayoutEffect, useRef } from 'react';

export function AutoTextarea({
  className,
  disabled,
  label,
  onBlur,
  onChange,
  placeholder,
  spellCheck,
  value,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onBlur?(): void;
  onChange(value: string): void;
  placeholder?: string;
  spellCheck?: boolean;
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      aria-label={label}
      className={className}
      disabled={disabled}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      ref={textareaRef}
      rows={1}
      spellCheck={spellCheck}
      value={value}
    />
  );
}

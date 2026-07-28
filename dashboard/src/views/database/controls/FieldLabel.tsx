import type { ReactNode } from 'react';

export function FieldLabel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="database-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

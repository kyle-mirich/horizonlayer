import { useEffect, useState } from 'react';

const COMPACT_ROWS_QUERY = '(max-width: 860px)';

export function useCompactRows(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_ROWS_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_ROWS_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setCompact(event.matches);
    };
    media.addEventListener('change', onChange);
    setCompact(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return compact;
}

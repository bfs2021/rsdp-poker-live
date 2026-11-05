import { useEffect, useState } from 'react';

/** Phones (either way up), and windows taller than they are wide, get the one-column table. */
export function usePortrait() {
  const query = '(max-width: 700px), (max-aspect-ratio: 4/5), (max-height: 500px)';
  const [portrait, setPortrait] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setPortrait(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return portrait;
}

/** Desktop windows at least this wide have room for chat beside the action bar, so the table drops its side column. */
export const WIDE_MIN = 1440;

/** The wide desktop layout: chat in the bottom-left corner, the records behind the top bar's Log button. */
export function useWide(portrait: boolean) {
  const query = `(min-width: ${WIDE_MIN}px)`;
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return wide && !portrait;
}

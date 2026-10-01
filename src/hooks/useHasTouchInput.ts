import { useEffect, useState } from 'react';

/** Input capability only: a wide touch screen still keeps its wide layout. */
export function useHasTouchInput(): boolean {
  const read = () => typeof window !== 'undefined' && (
    navigator.maxTouchPoints > 0
    || window.matchMedia('(pointer: coarse)').matches
    || window.matchMedia('(any-pointer: coarse)').matches
  );
  const [hasTouchInput, setHasTouchInput] = useState(read);

  useEffect(() => {
    const queries = ['(pointer: coarse)', '(any-pointer: coarse)'].map(query => window.matchMedia(query));
    const update = () => setHasTouchInput(read());
    update();
    queries.forEach(query => query.addEventListener('change', update));
    return () => queries.forEach(query => query.removeEventListener('change', update));
  }, []);

  return hasTouchInput;
}

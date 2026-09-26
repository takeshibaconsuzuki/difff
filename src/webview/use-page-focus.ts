import { useEffect, useState } from 'react';

export function usePageFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus() && document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => { setFocused(document.hasFocus() && document.visibilityState === 'visible'); };
    const blur = () => { setFocused(false); };
    const pointer = () => { document.documentElement.dataset.keyboardNav = 'false'; };
    const keyboard = (event: KeyboardEvent) => {
      if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) document.documentElement.dataset.keyboardNav = 'true';
    };
    pointer();
    window.addEventListener('focus', update);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', update);
    document.addEventListener('focusin', update);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
    };
  }, []);
  return focused;
}

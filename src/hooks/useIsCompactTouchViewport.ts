import { useHasTouchInput } from './useHasTouchInput';
import { useIsMobileViewport } from './useIsMobileViewport';

/**
 * True on touch devices whose layout width sits in the compact band
 * (600–1023 px): a phone in landscape, or a small touch tablet. These
 * sessions use the mobile tool dock, sheet menus, and rotation-aware
 * document fitting even though they are past the phone breakpoint.
 * Wide touch screens and desktop windows keep the desktop layout.
 */
export function useIsCompactTouchViewport(): boolean {
  const compact = useIsMobileViewport(1023);
  const hasTouchInput = useHasTouchInput();
  return compact && hasTouchInput;
}

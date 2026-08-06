import { useEffect, useRef } from 'react';

/**
 * Navigates home after an 8-second timeout if the entity (lobby/game) is absent.
 * Clears on error or when the entity arrives.
 */
export function useNavigationGuard(
  entity: unknown,
  error: string | null,
  navigate: (path: string, opts?: { replace?: boolean }) => void,
  timeoutMs = 8000,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (navigatedRef.current) return;
    if (entity) {
      clearTimeout(timerRef.current);
      return;
    }
    if (error) {
      clearTimeout(timerRef.current);
      navigatedRef.current = true;
      navigate('/', { replace: true });
      return;
    }
    timerRef.current = setTimeout(() => {
      if (!navigatedRef.current) {
        navigatedRef.current = true;
        navigate('/', { replace: true });
      }
    }, timeoutMs);
    return () => clearTimeout(timerRef.current);
  }, [entity, error, navigate, timeoutMs]);
}

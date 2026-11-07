import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AppState } from '../core/store';
import type { Ctx } from './actions';

export const AppCtx = createContext<Ctx | null>(null);

export function useCtx(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppCtx missing');
  return c;
}

/** Subscribe to a slice of app state. Selector must return a stable value for unchanged state. */
export function useApp<T>(select: (s: AppState) => T): T {
  const { store } = useCtx();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

import React, { useRef } from 'react';

// Heavy panels load on first open so the start page ships without them.
export const GroupStoreModal = React.lazy(() => import('./GroupStoreModal').then((module) => ({ default: module.GroupStoreModal })));
export const FavoritesDrawer = React.lazy(() => import('./FavoritesDrawer').then((module) => ({ default: module.FavoritesDrawer })));

/** True from the first time `open` is true; keeps the panel mounted so its close animation still plays. */
export function useMountedOnce(open: boolean): boolean {
  const mounted = useRef(false);
  if (open) mounted.current = true;
  return mounted.current;
}

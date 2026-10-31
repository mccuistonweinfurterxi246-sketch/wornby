import { useEffect, useRef } from 'react';
import { fetchLinkedGroup, readStoreParam } from '../lib/urlParams';

type LinkedGroup = { id: number; name: string; memberCount?: number };

/**
 * Keeps one store modal owner in step with ?store= on load and on browser back/forward:
 * opens the linked store (when `canOpen` allows), switches to it, or closes when the URL has none.
 */
export function useStoreLink<G extends LinkedGroup>(
  openId: number | null,
  setGroup: (group: G | LinkedGroup | null) => void,
  options: { canOpen: () => boolean; findGroup?: (id: number) => G | undefined },
) {
  const latest = useRef({ openId, setGroup, options });
  latest.current = { openId, setGroup, options };

  useEffect(() => {
    let request = 0;
    const sync = () => {
      const { openId: current, setGroup: set, options: opts } = latest.current;
      const id = readStoreParam();
      if (id === current) return;
      if (id === null || !opts.canOpen()) {
        if (current !== null) set(null);
        return;
      }
      const local = opts.findGroup?.(id);
      if (local) { set(local); return; }
      const mine = ++request;
      void fetchLinkedGroup(id).then((group) => {
        // ignore if the user navigated again while the name was loading
        if (mine === request && readStoreParam() === id) latest.current.setGroup(group);
      });
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => { request++; window.removeEventListener('popstate', sync); };
  }, []);
}

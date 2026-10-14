import { useEffect, useState } from 'react';

/**
 * Hash routes, so the static build works from any sub-path and a hall or proposal link can be shared.
 *   #/  #/found  #/guild/<name>  #/proposal/<guild>/<id>  #/mint/<guild>  #/voice  #/tribute
 */
export type Route =
  | { name: 'home' }
  | { name: 'found' }
  | { name: 'guild'; guild: string }
  | { name: 'proposal'; guild: string; id: number }
  | { name: 'mint'; guild: string }
  | { name: 'voice' }
  | { name: 'tribute' }
  | { name: 'notfound'; path: string };

const HANDLE = /^[a-z0-9_-]{1,64}$/;

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/'] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: 'home' };
  const [head, arg, arg2] = parts;
  switch (head) {
    case 'found':
    case 'voice':
    case 'tribute':
      return parts.length === 1 ? { name: head } : { name: 'notfound', path };
    case 'guild':
    case 'mint':
      return arg && HANDLE.test(arg) && parts.length === 2
        ? { name: head, guild: arg }
        : { name: 'notfound', path };
    case 'proposal':
      return arg && HANDLE.test(arg) && arg2 && /^\d{1,10}$/.test(arg2) && parts.length === 3
        ? { name: 'proposal', guild: arg, id: Number(arg2) }
        : { name: 'notfound', path };
    default:
      return { name: 'notfound', path };
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'guild':
      return `#/guild/${encodeURIComponent(route.guild)}`;
    case 'mint':
      return `#/mint/${encodeURIComponent(route.guild)}`;
    case 'proposal':
      return `#/proposal/${encodeURIComponent(route.guild)}/${route.id}`;
    case 'notfound':
      return '#/';
    default:
      return `#/${route.name}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

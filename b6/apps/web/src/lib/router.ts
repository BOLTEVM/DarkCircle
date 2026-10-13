import { useEffect, useState } from 'react';

/**
 * Hash routes, so the static build works from any sub-path and a listing link can be shared.
 *   #/  #/listings?q=…  #/listing/<id>  #/sell  #/portfolio  #/brokers  #/registrar
 */
export type Route =
  | { name: 'home' }
  | { name: 'listings'; q: string }
  | { name: 'listing'; id: bigint }
  | { name: 'sell' }
  | { name: 'portfolio' }
  | { name: 'brokers' }
  | { name: 'registrar' }
  | { name: 'notfound'; path: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts.length === 0) return { name: 'home' };
  const [head, arg] = parts;
  switch (head) {
    case 'listings':
      return { name: 'listings', q: params.get('q') ?? '' };
    case 'listing':
      return arg && /^\d{1,30}$/.test(arg) && parts.length === 2 ? { name: 'listing', id: BigInt(arg) } : { name: 'notfound', path };
    case 'sell':
    case 'portfolio':
    case 'brokers':
    case 'registrar':
      return parts.length === 1 ? { name: head } : { name: 'notfound', path };
    default:
      return { name: 'notfound', path };
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'listings':
      return route.q ? `#/listings?q=${encodeURIComponent(route.q)}` : '#/listings';
    case 'listing':
      return `#/listing/${route.id.toString()}`;
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

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

export interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

interface Props<T extends string> {
  items: NavItem<T>[];
  active: T;
  onNavigate: (id: T) => void;
}

const FADE_PX = 22;

/**
 * The app's primary tabs.
 *  - The bar is as wide as its tabs (never narrower), so the active pill can no longer spill out of it, and it
 *    scrolls sideways without a scrollbar when the screen is narrower than the tabs, fading at whichever edge has more.
 *  - The active tab is kept in view.
 *  - Tabs are real links (#swap, #farms...): middle-click and "open in new tab" work, and the current one is
 *    announced with aria-current. Arrow keys, Home and End move between them.
 *  - It sticks to the top while a long page scrolls underneath.
 */
export default function PrimaryNav<T extends string>({ items, active, onNavigate }: Props<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, items.length]);

  // keep the active tab on screen (a phone can show only some of them)
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [active, items.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(scroller.current?.querySelectorAll<HTMLAnchorElement>('a.circleswap-nav-btn') ?? []);
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    links[(next + links.length) % links.length].focus();
  };

  const click = (e: MouseEvent<HTMLAnchorElement>, id: T) => {
    // let the browser handle modified clicks (new tab, new window, download)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(id);
  };

  const style = { '--fade-l': fade.left ? `${FADE_PX}px` : '0px', '--fade-r': fade.right ? `${FADE_PX}px` : '0px' } as CSSProperties;

  return (
    <nav className="circleswap-nav" aria-label="Primary">
      <div className="circleswap-nav-scroll" ref={scroller} style={style} onKeyDown={onKeyDown}>
        {items.map(item => (
          <a
            key={item.id}
            href={`#${item.id.toLowerCase()}`}
            className={`circleswap-nav-btn${item.id === active ? ' active' : ''}`}
            aria-current={item.id === active ? 'page' : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={e => click(e, item.id)}
          >
            {item.icon}
            <span className="circleswap-nav-label">{item.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}

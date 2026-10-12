import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './modal.css';

/*
 * The one shell every dialog and sheet in Circleswap is drawn in (the swap token list, the liquidity form, the farm and
 * deploy dialogs, import, artwork, governance, pair details).
 *
 * Why it exists. Two screens were reported unusable inside a wallet's in-app browser on a Galaxy S10e: the liquidity form
 * collapsed to a ~30px strip in the middle of the screen, and the token list showed a blurred page and no sheet at all.
 * Both were sized in viewport units (`max-height: 95vh`, `height: 88dvh`), and in that WebView those units resolve to
 * ~0 while the fixed overlay itself is the full screen. A card whose max-height is 0 is clamped to its own padding and
 * border (30.8px: exactly the strip in the screenshot, header text half clipped), and a zero-height sheet pinned to the
 * bottom is a single 1px line above the wallet's own tab bar (visible in the second screenshot).
 *
 * So the rules here are:
 *  - nothing is sized in vh / dvh / svh / lvh. Sizes come from the overlay's own box (percentages of a `position: fixed`
 *    element with all four offsets), and a rem floor on the panel means a mis-resolved percentage can at worst make the
 *    overlay scroll, never produce a strip;
 *  - it is portalled into <body>, because an ancestor with backdrop-filter / transform / filter turns `position: fixed`
 *    into "relative to that ancestor" (the .glass-card cards all have a backdrop-filter);
 *  - the page behind does not scroll while a dialog is open, the panel scrolls inside (header and footer stay put),
 *    and a soft keyboard that covers the bottom of the screen shrinks the overlay instead of hiding the end of the form;
 *  - Escape and a tap outside close it (unless `locked`, i.e. a transaction is in flight), focus goes to the dialog
 *    (not to a text field on a touch screen, which would raise the keyboard before anyone has read anything) and comes
 *    back to where it was.
 */

export type ModalVariant = 'dialog' | 'sheet';

// ---- page scroll lock (shared by every open dialog, so stacking two of them never unlocks early) ----
let scrollLocks = 0;
function lockPageScroll() {
  if (scrollLocks++ > 0) return;
  const root = document.documentElement;
  // Hiding the scrollbar widens the page; the same width is added back so the page behind does not jump sideways.
  const scrollbar = Math.max(0, window.innerWidth - root.clientWidth);
  root.style.setProperty('--cs-sbw', `${scrollbar}px`);
  root.classList.add('cs-modal-open');
}
function unlockPageScroll() {
  if (--scrollLocks > 0) return;
  scrollLocks = 0;
  const root = document.documentElement;
  root.classList.remove('cs-modal-open');
  root.style.removeProperty('--cs-sbw');
}

// ---- Escape: only the topmost dialog answers ----
interface StackEntry { close: () => void; locked: () => boolean }
const stack: StackEntry[] = [];
function onDocumentKeyDown(event: globalThis.KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top || top.locked()) return;
  event.stopPropagation();
  top.close();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const typesAtOnce = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

interface ShellProps {
  /** Accessible name of the dialog. */
  label: string;
  onClose: () => void;
  /** While true (a transaction is in flight) neither Escape nor a tap outside closes it. */
  locked?: boolean;
  /** `sheet` is a bottom sheet on phones and a centred dialog elsewhere; `dialog` is centred everywhere. */
  variant?: ModalVariant;
  /** Widest the panel gets on a large screen, in px. It is never wider than the screen. */
  maxWidth?: number;
  /** Extra class on the panel, for a dialog that needs its own rules. */
  className?: string;
  panelRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export function ModalShell({ label, onClose, locked = false, variant = 'dialog', maxWidth = 480, className = '', panelRef, children }: ShellProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const pressedOnBackdrop = useRef(false);
  // Latest props, read from handlers registered once.
  const live = useRef({ onClose, locked });
  live.current = { onClose, locked };

  const setPanel = useCallback((node: HTMLDivElement | null) => {
    innerRef.current = node;
    if (typeof panelRef === 'function') panelRef(node);
    else if (panelRef) (panelRef as { current: HTMLDivElement | null }).current = node;
  }, [panelRef]);

  // Scroll lock, Escape, focus in and back out.
  useEffect(() => {
    lockPageScroll();
    const entry: StackEntry = { close: () => live.current.onClose(), locked: () => live.current.locked };
    if (stack.length === 0) document.addEventListener('keydown', onDocumentKeyDown, true);
    stack.push(entry);

    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      const panel = innerRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const preferred = typesAtOnce() ? panel.querySelector<HTMLElement>('[data-autofocus]') : null;
      (preferred ?? panel).focus({ preventScroll: true });
    }, 0);

    return () => {
      clearTimeout(timer);
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener('keydown', onDocumentKeyDown, true);
      unlockPageScroll();
      // Put focus back, but never into a text field on a touch screen: that would raise the keyboard as the dialog closes.
      const field = previous && /^(INPUT|TEXTAREA|SELECT)$/.test(previous.tagName);
      if (previous && previous.isConnected && !(field && !typesAtOnce())) previous.focus?.({ preventScroll: true });
    };
  }, []);

  // The soft keyboard. Most Android browsers draw it over the page without resizing the layout viewport, so a fixed
  // overlay stays full height and the keyboard covers its lower part. The visual viewport knows how much is covered.
  useEffect(() => {
    const viewport = window.visualViewport;
    const backdrop = backdropRef.current;
    if (!viewport || !backdrop) return;
    const update = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      // Pinch-zoom also shrinks the visual viewport; that is not a keyboard, and small differences are browser bars.
      const keyboard = viewport.scale <= 1.01 && covered > 80 ? Math.round(covered) : 0;
      backdrop.style.setProperty('--cs-kb', `${keyboard}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  // Safety net, not the mechanism. The panel's height is a percentage of the overlay (see modal.css); if some engine
  // resolves that to nothing, the panel would sit at its rem floor with a form that plainly needs more room. Detect that
  // (a panel far shorter than the room it has, whose own body has to scroll) and give it the overlay's measured height.
  useEffect(() => {
    const backdrop = backdropRef.current;
    const panel = innerRef.current;
    if (!backdrop || !panel) return;
    let forced = false;
    const fit = () => {
      const style = window.getComputedStyle(backdrop);
      const room = backdrop.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      if (!(room > 0)) return;
      const apply = () => {
        panel.style.maxHeight = room + 'px';
        // the phone sheet is a fixed share of the overlay, not content-sized
        if (panel.classList.contains('cs-modal--sheet') && window.matchMedia('(max-width: 560px)').matches) {
          panel.style.height = Math.round(room * 0.88) + 'px';
        }
      };
      if (forced) {
        apply();
        return;
      }
      const scroller = panel.querySelector<HTMLElement>('.cs-modal-body, .token-picker-list') ?? panel;
      const needsMore = scroller.scrollHeight > scroller.clientHeight + 1;
      const starved = panel.offsetHeight < Math.min(room, 480) * 0.75;
      if (needsMore && starved) {
        forced = true;
        apply();
      }
    };
    const frame = requestAnimationFrame(fit);
    window.addEventListener('resize', fit);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(backdrop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, []);

  // Keep Tab inside the dialog.
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const panel = innerRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const style = { '--cs-max': `${maxWidth}px` } as CSSProperties;

  return createPortal(
    <div
      ref={backdropRef}
      className={`cs-backdrop cs-backdrop--${variant}`}
      // A tap that starts and ends on the backdrop closes; a text selection dragged out of the panel does not.
      onPointerDown={event => { pressedOnBackdrop.current = event.target === event.currentTarget; }}
      onClick={event => {
        if (pressedOnBackdrop.current && event.target === event.currentTarget && !live.current.locked) live.current.onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <div
        ref={setPanel}
        tabIndex={-1}
        className={`cs-modal cs-modal--${variant} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={style}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

/** Title row: always visible, the close button is a 44px touch target. */
export function ModalHeader({ title, icon, onClose, locked = false, children }: { title: string; icon?: ReactNode; onClose: () => void; locked?: boolean; children?: ReactNode }) {
  return (
    <div className="cs-modal-header">
      <h3 className="cs-modal-title">
        {icon}
        <span>{title}</span>
      </h3>
      <span className="cs-modal-header-actions">
        {children}
        <button
          type="button"
          className="cs-modal-close"
          onClick={onClose}
          disabled={locked}
          aria-label="Close"
          title={locked ? 'A transaction is in progress' : 'Close'}
        >
          <X size={20} />
        </button>
      </span>
    </div>
  );
}

/** The part that scrolls. */
export function ModalBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`cs-modal-body ${className}`.trim()}>{children}</div>;
}

/** The part that stays: the primary action lives here so it is reachable however long the form is. */
export function ModalFooter({ children }: { children: ReactNode }) {
  return <div className="cs-modal-footer">{children}</div>;
}

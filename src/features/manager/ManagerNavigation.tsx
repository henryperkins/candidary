import { ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ManagerSection } from '../../app/manager-location';
import { Brand } from '../../components/Brand';
import { GALLERY_WIDE_MIN_WIDTH } from '../gallery/viewport';

const SECTION_LABELS: Record<ManagerSection, string> = {
  gallery: 'Gallery', rsvp: 'RSVP', guestbook: 'Guestbook', share: 'Share', settings: 'Settings',
};

export function ManagerNavigation({ section, navigationKey, mobile, reviewCount, liveHost, children }: {
  section: ManagerSection;
  navigationKey: string;
  mobile: boolean;
  reviewCount: number;
  liveHost: HTMLElement;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // A breakpoint can hide the focused control before React handles resize.
  // Retain its role so focus can move to the corresponding visible control.
  const focusedControl = useRef<'trigger' | 'destination' | null>(null);
  const navigationId = useId();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const expanded = mobile && openKey === navigationKey;
  const label = SECTION_LABELS[section];
  const close = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setOpenKey(null);
  }, []);

  useLayoutEffect(() => {
    if (mobile && focusedControl.current === 'destination') {
      trigger.current?.focus({ preventScroll: true });
    } else if (!mobile && focusedControl.current === 'trigger') {
      navigation.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    setOpenKey(null);
  }, [mobile]);

  useLayoutEffect(() => {
    if (mobile && openKey !== null && openKey !== navigationKey) {
      close(document.activeElement === document.body || navigation.current?.contains(document.activeElement) === true);
    }
  }, [mobile, openKey, navigationKey, close]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) || root.current?.closest('[inert]')) return;
      close(event.type === 'pointerdown');
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [expanded, close]);

  // Text enlargement can make the header wrap. Gallery focus/Undo offsets must
  // follow its actual height, while the overlaid section list reserves no space.
  useLayoutEffect(() => {
    const header = root.current;
    const shell = header?.closest<HTMLElement>('.manager-shell');
    if (!mobile || !header || !shell) return;
    const measure = () => {
      const height = `${Math.ceil(header.getBoundingClientRect().height)}px`;
      shell.style.setProperty('--manager-sticky-offset', height);
      liveHost.style.setProperty('--manager-sticky-offset', height);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(header);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      shell.style.removeProperty('--manager-sticky-offset');
      liveHost.style.removeProperty('--manager-sticky-offset');
    };
  }, [mobile, liveHost]);

  return <header className="manager-nav" ref={root} data-navigation-open={expanded || undefined} onFocusCapture={event => {
    focusedControl.current = event.target === trigger.current ? 'trigger'
      : navigation.current?.contains(event.target) ? 'destination' : null;
  }} onBlurCapture={event => {
    const remainsInside = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
    const breakpointHidFocus = event.relatedTarget === null && (window.innerWidth < GALLERY_WIDE_MIN_WIDTH) !== mobile;
    if (!remainsInside && !breakpointHidFocus) {
      focusedControl.current = null;
    }
  }} onKeyDown={event => {
    if (expanded && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }}>
    <Brand compact />
    <button
      type="button"
      className="manager-nav__toggle"
      ref={trigger}
      aria-expanded={expanded}
      aria-controls={navigationId}
      aria-label={`${label}, ${expanded ? 'close' : 'open'} navigation${reviewCount > 0 ? `; ${reviewCount} guestbook ${reviewCount === 1 ? 'note needs' : 'notes need'} review` : ''}`}
      onClick={() => expanded ? close(true) : setOpenKey(navigationKey)}
    >
      <span>{label}</span>
      {reviewCount > 0 && <span className="manager-nav__count" aria-hidden="true">{reviewCount}</span>}
      {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>
    <nav id={navigationId} ref={navigation} aria-label="Manager sections" hidden={mobile && !expanded} onClickCapture={event => {
      if (expanded && event.target instanceof Element && event.target.closest('button:not(:disabled)')) {
        // Focus a persistent origin before the existing destination handler can
        // open an unsaved-work prompt or carry out a route-specific focus intent.
        close(true);
      }
    }}>{children}</nav>
  </header>;
}

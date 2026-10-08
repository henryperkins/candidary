import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { ModalSurface } from '../../components/ModalSurface';

export type TourDestination = 'overview' | 'rsvp' | 'share' | 'library' | 'settings';
const steps: { destination: TourDestination; anchor: string; title: string; text: string }[] = [
  { destination: 'overview', anchor: 'overview-task', title: 'Your next task', text: 'Start with your event’s current phase and one useful next task. Return to Overview whenever you need your bearings.' },
  { destination: 'rsvp', anchor: 'rsvp', title: 'Your guest list', text: 'Prepare named invitations and review household attendance here. You send the invitations. RSVP is optional: guests can still deliver photos without responding.' },
  { destination: 'share', anchor: 'share-qr', title: 'One QR for your event', text: 'Use the same permanent QR on invitations and venue signs. It takes guests to RSVP or photo delivery as your event moves forward.' },
  { destination: 'library', anchor: 'library', title: 'Your delivered photos', text: 'Originals arrive privately in Library. Album and Guest gallery are separate, optional ways to share photos; neither is required to receive originals.' },
  { destination: 'library', anchor: 'exports', title: 'Keep your originals', text: 'Open Exports when you want to prepare or retrieve originals. A ready export is available to download; it does not confirm that you have downloaded it.' },
  { destination: 'settings', anchor: 'settings', title: 'Event details and access', text: 'Review event details, RSVP availability and photo delivery here. This tour changes no settings. Finish returns you to your next task.' },
];

function visible(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && !element.closest('[hidden]')
    && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden'
    && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
}
function competingDialog() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], dialog[open]')]
    .some(el => !el.hasAttribute('data-host-welcome-tour') && !el.closest('[hidden]'));
}

export function HostWelcomeTour({ location, blocked, onNavigate, onClose }: {
  location: string; blocked: boolean;
  onNavigate(destination: TourDestination): void;
  onClose(status: 'dismissed' | 'completed'): void;
}) {
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState<number | 'finish' | null>(null);
  const [otherModal, setOtherModal] = useState(competingDialog);
  const [retry, setRetry] = useState(0);
  const [geometry, setGeometry] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [mobileReserve, setMobileReserve] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  const noReturnFocus = useRef<HTMLElement | null>(null);
  const navigation = useRef(onNavigate); navigation.current = onNavigate;
  const close = useRef(onClose); close.current = onClose;
  const requested = useRef<number | 'finish' | null>(null);
  const previousLocation = useRef(location);
  // Indexes originate only from the bounded Back/Next controls below.
  const step = steps[index]!;
  const suspended = blocked || otherModal || pending !== null;

  useEffect(() => {
    const observer = new MutationObserver(() => setOtherModal(competingDialog()));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'hidden', 'open'] });
    setOtherModal(competingDialog());
    return () => observer.disconnect();
  }, []);

  // The modal unmounts in this commit, releasing its focus/scroll boundary
  // before the existing navigation guards are asked to change destination.
  useEffect(() => {
    if (pending === null || blocked || otherModal || requested.current === pending) return;
    requested.current = pending;
    navigation.current(pending === 'finish' ? 'overview' : steps[pending]!.destination);
  }, [pending, blocked, otherModal]);

  useEffect(() => {
    if (pending === null) return;
    const target = pending === 'finish' ? 'overview' : steps[pending]!.destination;
    if (location === target && !blocked && !otherModal) {
      if (pending === 'finish') {
        invoker.current = null;
        close.current('completed');
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-host-tour-recommended-action]')?.focus());
      } else { setIndex(pending); setPending(null); requested.current = null; }
      return;
    }
    if (blocked || otherModal) return;
    const timeout = window.setTimeout(() => { setPending(null); requested.current = null; }, 1800);
    return () => window.clearTimeout(timeout);
  }, [pending, location, blocked, otherModal]);

  useEffect(() => {
    const expected = pending === 'finish' ? 'overview' : pending === null ? step.destination : steps[pending]!.destination;
    // A refused guard keeps the same committed location. A different committed
    // destination supersedes this request even while another modal owns focus.
    if (previousLocation.current !== location && location !== expected) close.current('dismissed');
    previousLocation.current = location;
  }, [location, pending, step.destination]);

  useLayoutEffect(() => {
    if (suspended) return;
    let frame = 0; let timeout = 0; let lastBounds = ''; let stableFrames = 0; let didScroll = false; let found = false;
    setGeometry(null); setUnavailable(false); setMobileReserve(null);
    let scrolledAnchor: HTMLElement | null = null;
    const update = () => {
      let anchor = document.querySelector<HTMLElement>(`[data-host-tour-anchor="${step.anchor}"]`);
      const mobile = window.innerWidth <= 760;
      const headerBottom = Math.max(0, document.querySelector('.manager-nav')?.getBoundingClientRect().bottom ?? 52);
      const targetTop = headerBottom + 12;
      // On a short phone the whole task section cannot share the viewport with
      // guidance. Highlight its real action, preserving the panel's readable copy.
      if (mobile && step.destination === 'overview' && visible(anchor)) {
        const action = document.querySelector<HTMLElement>('[data-host-tour-recommended-action]');
        const naturalPanelHeight = panel.current?.scrollHeight ?? 340;
        if (visible(action) && anchor.getBoundingClientRect().height + naturalPanelHeight + targetTop + 32 > window.innerHeight) anchor = action;
      }
      if (!visible(anchor) || location !== step.destination) {
        if (found) { setGeometry(null); setUnavailable(true); }
        else frame = requestAnimationFrame(update);
        return;
      }
      if (!didScroll || scrolledAnchor !== anchor) {
        anchor.scrollIntoView?.({ block: 'center', behavior: 'instant' });
        if (mobile) window.scrollBy?.({ top: anchor.getBoundingClientRect().top - targetTop, behavior: 'instant' });
        didScroll = true; scrolledAnchor = anchor;
      }
      const rect = anchor.getBoundingClientRect();
      if (mobile) {
        // The sheet's bottom remains fixed; this measured ceiling leaves room
        // for the complete target and its focus outline above the sheet.
        const bottomGap = Math.max(8, window.innerHeight - (panel.current?.getBoundingClientRect().bottom ?? window.innerHeight - 8));
        const reserve = Math.max(44, window.innerHeight - rect.bottom - 16 - bottomGap);
        setMobileReserve(current => current === reserve ? current : reserve);
      }
      const bounds = `${rect.top},${rect.left},${rect.width},${rect.height}`;
      stableFrames = bounds === lastBounds ? stableFrames + 1 : 0; lastBounds = bounds;
      if (stableFrames >= 2) {
        found = true; clearTimeout(timeout);
        setGeometry({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        setUnavailable(false); return;
      }
      frame = requestAnimationFrame(update);
    };
    const refresh = () => { cancelAnimationFrame(frame); stableFrames = 0; frame = requestAnimationFrame(update); };
    frame = requestAnimationFrame(update);
    timeout = window.setTimeout(() => { cancelAnimationFrame(frame); setGeometry(null); setUnavailable(true); }, 1500);
    const observer = new ResizeObserver(refresh);
    const anchor = document.querySelector<HTMLElement>(`[data-host-tour-anchor="${step.anchor}"]`);
    if (anchor) observer.observe(anchor);
    const action = document.querySelector<HTMLElement>('[data-host-tour-recommended-action]');
    if (action) observer.observe(action);
    if (panel.current) observer.observe(panel.current);
    const mutations = new MutationObserver(refresh);
    mutations.observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    window.addEventListener('resize', refresh); window.addEventListener('scroll', refresh, true);
    heading.current?.focus({ preventScroll: true });
    return () => { cancelAnimationFrame(frame); clearTimeout(timeout); observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', refresh); window.removeEventListener('scroll', refresh, true); };
  }, [step, location, suspended, retry]);

  function exit() {
    const target = invoker.current;
    close.current('dismissed');
    requestAnimationFrame(() => {
      if (visible(target) && target.matches('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]') && !target.closest('[inert]')) { target.focus({ preventScroll: true }); return; }
      const destination = location === step.destination ? step : steps.find(candidate => candidate.destination === location);
      const anchor = destination ? document.querySelector<HTMLElement>(`[data-host-tour-anchor="${destination.anchor}"]`) : null;
      const fallback = location === 'overview'
        ? document.querySelector<HTMLElement>('[data-host-tour-recommended-action]')
        : anchor;
      if (visible(fallback) && !fallback.closest('[inert]')) {
        const focusTarget = fallback.matches('button, a[href], summary, [tabindex]') ? fallback
          : fallback.querySelector<HTMLElement>('h1, h2, h3, button, a[href]') ?? fallback;
        if (!focusTarget.matches('button, a[href], summary, [tabindex]')) focusTarget.tabIndex = -1;
        focusTarget.focus({ preventScroll: true });
      }
    });
  }
  function move(next: number | 'finish') {
    if (suspended || !geometry) return;
    setPending(next);
  }
  if (suspended) return null;
  const desktop = window.innerWidth > 760;
  const panelWidth = Math.min(400, window.innerWidth - 32);
  const panelHeight = panel.current?.getBoundingClientRect().height ?? 340;
  const fitsRight = geometry && geometry.left + geometry.width + panelWidth + 36 <= window.innerWidth;
  const preferredTop = geometry ? (fitsRight ? geometry.top : geometry.top + geometry.height + 24) : 16;
  const panelTop = Math.max(16, Math.min(window.innerHeight - panelHeight - 16,
    !fitsRight && geometry && preferredTop + panelHeight > window.innerHeight - 16 && geometry.top - panelHeight - 24 >= 16
      ? geometry.top - panelHeight - 24 : preferredTop));
  const panelLeft = geometry ? Math.max(16, Math.min(window.innerWidth - panelWidth - 16,
    fitsRight ? geometry.left + geometry.width + 20 : geometry.left + geometry.width - panelWidth)) : 16;
  const style: CSSProperties = desktop && geometry ? { left: panelLeft, top: panelTop }
    : !desktop && mobileReserve !== null ? { maxHeight: mobileReserve } : {};
  return <ModalSurface labelledBy="host-welcome-title" initialFocusRef={heading} returnFocusRef={noReturnFocus}
    onRequestClose={exit} closePolicy={{ escape: true, backdrop: false }}>
    <div className="host-welcome" data-host-welcome-tour>
      {geometry && <div className="host-welcome__target" aria-hidden="true" style={geometry} />}
      {desktop && geometry && <svg className="host-welcome__leader" aria-hidden="true">
        <line x1={fitsRight ? geometry.left + geometry.width + 6 : Math.min(geometry.left + geometry.width - 16, panelLeft + 32)}
          y1={fitsRight ? geometry.top + Math.min(geometry.height / 2, 32) : panelTop > geometry.top ? geometry.top + geometry.height + 6 : geometry.top - 6}
          x2={fitsRight ? panelLeft : panelLeft + 32} y2={fitsRight ? panelTop + 32 : panelTop > geometry.top ? panelTop : panelTop + panelHeight} />
      </svg>}
      <div className="host-welcome__panel" ref={panel} style={style}>
        <div className="host-welcome__heading"><h2 id="host-welcome-title" tabIndex={-1} ref={heading}>{step.title}</h2>
          <button className="button button--quiet" type="button" aria-label="Close tour" onClick={exit}><X aria-hidden="true" /></button></div>
        <p className="host-welcome__count">Step {index + 1} of {steps.length}</p>
        <p>{step.text}</p>
        {unavailable && <p role="status">This part of the page is not available yet. Retry this step, or skip the tour and return later.</p>}
        {!geometry && !unavailable && <p role="status">Finding this part of the page…</p>}
        <div className="host-welcome__actions">
          <button type="button" className="button button--quiet" onClick={exit}>Skip tour</button>
          {index > 0 && <button type="button" className="button button--secondary" disabled={!geometry} onClick={() => move(index - 1)}>Back</button>}
          {unavailable ? <button type="button" className="button button--primary" onClick={() => setRetry(n => n + 1)}>Retry step</button>
            : <button type="button" className="button button--primary" disabled={!geometry} onClick={() => move(index === steps.length - 1 ? 'finish' : index + 1)}>{index === steps.length - 1 ? 'Finish' : 'Next'}</button>}
        </div>
      </div>
    </div>
  </ModalSurface>;
}

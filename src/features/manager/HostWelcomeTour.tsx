import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { ModalSurface } from '../../components/ModalSurface';

import { getHostWelcomeIntroduction, getHostWelcomeToolSteps, hostWelcomeTaskAnchor, type HostWelcomeContext, type HostWelcomeMode, type TourDestination } from './host-welcome-content';
import type { OverviewDestination } from './overview-policy';
export type { TourDestination } from './host-welcome-content';
const unknownContext: HostWelcomeContext = {
  lifecycle: null, phaseLabel: 'Current phase not confirmed', recommendation: { label: 'Open Settings', reason: 'The current phase is not confirmed yet. Retry in Overview.', destination: 'settings' },
  eventStartLabel: null, namedGuests: null, photos: null, entryAvailability: 'unknown',
};

function visible(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && !element.closest('[hidden]')
    && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden'
    && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
}
function competingDialog() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], dialog[open]')]
    .some(el => !el.hasAttribute('data-host-welcome-tour') && !el.closest('[hidden]'));
}


const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]';

// Select from the committed workspace only after the guide's inert boundary and
// temporary layout space have gone. Revealing a control never activates it.
function restoreExitFocus(destination: string, anchorName?: string, invoker: HTMLElement | null = null, onRestored?: () => void, stillCurrent: () => boolean = () => true) {
  const deadline = performance.now() + 1800;
  function restore() {
    if (!stillCurrent()) return;
    if (competingDialog() || document.querySelector('[data-host-welcome-tour]')) {
      if (performance.now() < deadline) requestAnimationFrame(restore);
      return;
    }
    const anchor = anchorName ? document.querySelector<HTMLElement>(`[data-host-tour-anchor="${anchorName}"]`) : null;
    const main = document.querySelector('main');
    const eligibleInvoker = invoker !== document.body && invoker?.matches(focusable) ? invoker : null;
    const candidates = onRestored ? [anchor] : [eligibleInvoker,
      destination === 'overview' ? document.querySelector<HTMLElement>('[data-host-tour-recommended-action]') : null,
      anchor,
      ...(main?.querySelectorAll<HTMLElement>('h2, h3, [role="status"], h1') ?? []),
    ];
    for (const candidate of candidates) {
      if (!visible(candidate) || candidate.closest('[inert]') || candidate.matches(':disabled, [aria-disabled="true"]')) continue;
      const target = candidate.matches(focusable) ? candidate
        : [...candidate.querySelectorAll<HTMLElement>('button[aria-pressed="true"], h1, h2, h3, ' + focusable)]
          .find(element => visible(element) && !element.matches(':disabled, [aria-disabled="true"]')) ?? candidate;
      if (!target.matches(focusable)) target.tabIndex = -1;
      target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const nav = document.querySelector<HTMLElement>('.manager-nav');
      const rect = target.getBoundingClientRect();
      if (visible(nav) && ['sticky', 'fixed'].includes(getComputedStyle(nav).position)) {
        const navigationRect = nav.getBoundingClientRect();
        // Desktop's full-height rail is not a sticky header.
        if (navigationRect.width >= window.innerWidth / 2 && rect.top < navigationRect.bottom + 16) {
          window.scrollBy?.({ top: rect.top - navigationRect.bottom - 16, behavior: 'instant' });
        }
      }
      target.focus({ preventScroll: true });
      if (document.activeElement === target) { onRestored?.(); return; }
    }
    // Async destination content and a departing competing modal may settle a
    // frame later. Never navigate to recover a missing focus target.
    if (performance.now() < deadline) requestAnimationFrame(restore);
  }
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

export function HostWelcomeTour({ location, blocked, onNavigate, onClose, mode = 'intro', context = unknownContext, onNavigateTask, saveFailed = false, onRetrySave }: {
  location: string; blocked: boolean; mode?: HostWelcomeMode; context?: HostWelcomeContext;
  onNavigateTask?(destination: OverviewDestination): void;
  saveFailed?: boolean;
  onRetrySave?(): void;
  onNavigate(destination: TourDestination): void;
  onClose(status: 'dismissed' | 'completed'): void;
}) {
  const steps = useMemo(() => getHostWelcomeToolSteps(context), [context]);
  const introduction = getHostWelcomeIntroduction(context);
  const introductionKey = JSON.stringify([context.lifecycle && { ...context.lifecycle, lifecycleRecheckAfterMs: null }, context.recommendation, context.entryAvailability, context.namedGuests, context.photos]);
  const currentIntro = useRef(introductionKey); currentIntro.current = introductionKey;
  const introAttempt = useRef<{ destination: OverviewDestination; key: string } | null>(null);
  const taskNavigation = useRef(onNavigateTask); taskNavigation.current = onNavigateTask;
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState<number | 'finish' | 'intro' | null>(null);
  const [otherModal, setOtherModal] = useState(competingDialog);
  const [retry, setRetry] = useState(0);
  const [geometry, setGeometry] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const [compact, setCompact] = useState(false);
  const [inline, setInline] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const saveRetryHadFocus = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  const invokerLocation = useRef(location);
  const noReturnFocus = useRef<HTMLElement | null>(null);
  const navigation = useRef(onNavigate); navigation.current = onNavigate;
  const close = useRef(onClose); close.current = onClose;
  const requested = useRef<number | 'finish' | 'intro' | null>(null);
  const previousLocation = useRef(location);
  // Indexes originate only from the bounded Back/Next controls below.
  const toolStep = steps[index]!;
  const currentWorkspaceStep = steps.find(candidate => candidate.destination === location) ?? toolStep;
  const step = useMemo(() => mode === 'intro'
    ? { ...currentWorkspaceStep, title: introduction.title, text: introduction.text }
    : toolStep, [mode, currentWorkspaceStep, introduction.title, introduction.text, toolStep]);
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
    if (pending === 'intro') { if (introAttempt.current) taskNavigation.current?.(introAttempt.current.destination); }
    else navigation.current(pending === 'finish' ? 'overview' : steps[pending]!.destination);
  }, [pending, blocked, otherModal]);

  useEffect(() => {
    if (pending === null) return;
    if (pending === 'intro') {
      const attempt = introAttempt.current;
      if (!attempt || attempt.key !== introductionKey) {
        setPending(null); requested.current = null; return;
      }
      if (blocked || otherModal) return;
      const target = attempt.destination === 'originals' ? 'library' : attempt.destination;
      let cancelled = false;
      let frame = 0;
      function checkTarget() {
        if (cancelled || currentIntro.current !== attempt!.key) return;
        const anchor = document.querySelector<HTMLElement>(`[data-host-tour-anchor="${hostWelcomeTaskAnchor(attempt!.destination)}"]`);
        const exportsOpen = attempt!.destination !== 'originals' || !!document.querySelector('.gallery-export-tools[open]');
        if (location === target && visible(anchor) && exportsOpen) {
          restoreExitFocus(target, hostWelcomeTaskAnchor(attempt!.destination), null,
            () => { if (!cancelled && currentIntro.current === attempt!.key) close.current('completed'); },
            () => !cancelled && currentIntro.current === attempt!.key);
        } else frame = requestAnimationFrame(checkTarget);
      }
      frame = requestAnimationFrame(checkTarget);
      const timeout = window.setTimeout(() => { cancelled = true; setPending(null); requested.current = null; introAttempt.current = null; }, 1800);
      return () => { cancelled = true; cancelAnimationFrame(frame); clearTimeout(timeout); };
    }
    const target = pending === 'finish' ? 'overview' : steps[pending]!.destination;
    if (location === target && !blocked && !otherModal) {
      if (pending === 'finish') {
        close.current('completed');
        restoreExitFocus('overview', 'overview-task');
      } else { setIndex(pending); setPending(null); requested.current = null; }
      return;
    }
    if (blocked || otherModal) return;
    const timeout = window.setTimeout(() => { setPending(null); requested.current = null; }, 1800);
    return () => window.clearTimeout(timeout);
  }, [pending, location, blocked, otherModal, introductionKey]);

  useEffect(() => {
    const expected = pending === 'intro' ? (introAttempt.current?.destination === 'originals' ? 'library' : introAttempt.current?.destination) : pending === 'finish' ? 'overview' : pending === null ? step.destination : steps[pending]!.destination;
    // A refused guard keeps the same committed location. A different committed
    // destination supersedes this request even while another modal owns focus.
    if (previousLocation.current !== location && location !== expected) {
      close.current('dismissed');
      restoreExitFocus(location, steps.find(candidate => candidate.destination === location)?.anchor);
    }
    previousLocation.current = location;
  }, [location, pending, step.destination]);

  useLayoutEffect(() => {
    if (suspended) return;
    let frame = 0; let timeout = 0; let found = false; let lost = false;
    const observed = new Set<HTMLElement>();
    setGeometry(null); setUnavailable(false); setCompact(false); setInline(false);
    const observer = new ResizeObserver(refresh);
    function watch(element: HTMLElement | null) {
      if (element && !observed.has(element)) { observed.add(element); observer.observe(element); }
    }
    // Reserve against the actual navigation shape: a phone's sticky header or
    // a desktop's left rail. The rail's full height is not a header height.
    function availableArea() {
      const margin = window.innerWidth <= 760 ? 8 : 16;
      let left = margin; let top = margin;
      const nav = document.querySelector<HTMLElement>('.manager-nav');
      if (visible(nav)) {
        const rect = nav.getBoundingClientRect();
        if (rect.width < window.innerWidth / 2 && rect.height > window.innerHeight / 2) left = Math.max(left, rect.right + 16);
        else if (['sticky', 'fixed'].includes(getComputedStyle(nav).position)) top = Math.max(top, rect.bottom + 16);
      }
      return { left, top, right: window.innerWidth - margin, bottom: window.innerHeight - margin };
    }
    function positionPanel(style: CSSProperties) {
      setPlacement(current => JSON.stringify(current) === JSON.stringify(style) ? current : style);
    }
    const update = () => {
      const area = availableArea();
      const width = Math.min(400, area.right - area.left);
      if (lost) {
        // Missing-target controls must still reflow if the viewport changes.
        positionPanel({ left: area.left, top: area.top, width, maxHeight: Math.max(44, area.bottom - area.top) });
        return; // Restoration is an explicit Retry, never a stale outline.
      }
      const naturalHeight = panel.current?.scrollHeight || 340;
      const primary = document.querySelector<HTMLElement>(`[data-host-tour-anchor="${step.anchor}"]`);
      watch(primary); watch(panel.current); watch(document.querySelector<HTMLElement>('.manager-nav'));
      if (!visible(primary) || location !== step.destination) {
        positionPanel({ left: area.left, top: area.top, width, maxHeight: Math.max(44, area.bottom - area.top) });
        if (found) { lost = true; setGeometry(null); setUnavailable(true); setInline(false); }
        else frame = requestAnimationFrame(update);
        return;
      }
      const fallback = step.destination === 'overview'
        ? document.querySelector<HTMLElement>('[data-host-tour-recommended-action]')
        : document.querySelector<HTMLElement>(`[data-host-tour-compact="${step.anchor}"]`);
      watch(fallback);
      const gap = 24;
      const minPanelHeight = Math.min(240, naturalHeight);
      function fit(anchor: HTMLElement, desiredHeight: number) {
        const rect = anchor.getBoundingClientRect();
        if (rect.width > area.right - area.left || rect.height > area.bottom - area.top) return null;
        const right = rect.right + gap;
        const left = rect.left - gap - width;
        if ((right + width <= area.right || left >= area.left) && area.bottom - area.top >= desiredHeight) {
          return { side: right + width <= area.right ? right : left, maxHeight: area.bottom - area.top };
        }
        const maxHeight = area.bottom - area.top - rect.height - gap;
        return maxHeight >= desiredHeight ? { side: null, maxHeight } : null;
      }
      let anchor = primary;
      let layout = fit(primary, naturalHeight);
      if (!layout && visible(fallback)) { anchor = fallback; layout = fit(fallback, minPanelHeight); }
      if (!layout) { anchor = primary; layout = fit(primary, minPanelHeight); }
      if (!layout) {
        // Some viewports cannot fit even a real compact control beside readable
        // guidance. Explain inline; do not draw a pointer to concealed content.
        found = true; clearTimeout(timeout); setGeometry(null); setUnavailable(false); setInline(true); setCompact(false);
        positionPanel({ left: area.left, top: area.top, width, maxHeight: Math.max(44, area.bottom - area.top) });
        return;
      }
      // A little document space beneath the workspace (CSS) lets even the last
      // control clear the sticky header without inventing target coordinates.
      const before = anchor.getBoundingClientRect();
      if (Math.abs(before.top - area.top) > 1) window.scrollBy?.({ top: before.top - area.top, behavior: 'instant' });
      const rect = anchor.getBoundingClientRect();
      const panelHeight = Math.min(naturalHeight, layout.maxHeight);
      const panelTop = layout.side === null ? area.bottom - panelHeight : area.top;
      const panelLeft = layout.side ?? Math.max(area.left, Math.min(area.right - width, rect.right - width));
      // Fixed/sticky or oversized targets can resist scrolling. Fall back
      // truthfully instead of outlining clipped or occluded page content.
      const panelOverlaps = rect.left < panelLeft + width && rect.right > panelLeft && rect.top < panelTop + panelHeight && rect.bottom > panelTop;
      if (rect.top < area.top - 1 || rect.bottom > area.bottom + 1 || rect.left < area.left - 1 || rect.right > area.right + 1 || panelOverlaps) {
        found = true; clearTimeout(timeout); setGeometry(null); setInline(true); setCompact(false);
        positionPanel({ left: area.left, top: area.top, width, maxHeight: Math.max(44, area.bottom - area.top) });
        return;
      }
      found = true; clearTimeout(timeout); setUnavailable(false); setInline(false); setCompact(anchor !== primary);
      positionPanel({ left: panelLeft, top: panelTop, width, maxHeight: layout.maxHeight });
      const next = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      setGeometry(current => current && Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    function refresh() { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); }
    frame = requestAnimationFrame(update);
    timeout = window.setTimeout(() => { cancelAnimationFrame(frame); lost = true; setGeometry(null); setUnavailable(true); }, 1500);
    const mutations = new MutationObserver(refresh);
    mutations.observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'data-host-tour-anchor', 'data-host-tour-compact'] });
    window.addEventListener('resize', refresh); window.addEventListener('scroll', refresh, true);
    heading.current?.focus({ preventScroll: true });
    return () => { cancelAnimationFrame(frame); clearTimeout(timeout); observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', refresh); window.removeEventListener('scroll', refresh, true); };
  }, [step, location, suspended, retry]);

  useLayoutEffect(() => {
    if (!saveFailed && saveRetryHadFocus.current) {
      // Success removes its retry control. Recover focus only if it was lost;
      // do not pull a host away from another dialog control they moved to.
      if (!suspended && !panel.current?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
      saveRetryHadFocus.current = false;
    }
  }, [saveFailed, suspended]);

  function exit() {
    close.current('dismissed');
    const destination = location === step.destination ? step : steps.find(candidate => candidate.destination === location);
    restoreExitFocus(location, destination?.anchor, location === invokerLocation.current ? invoker.current : null);
  }
  function move(next: number | 'finish' | 'intro') {
    if (suspended || (!geometry && !inline)) return;
    if (next === 'intro') introAttempt.current = { destination: introduction.destination, key: introductionKey };
    setPending(next);
  }
  if (suspended) return null;
  const descriptionIds = 'host-welcome-progress host-welcome-description';
  // Context is read through the focused heading/dialog description. Only
  // recovery messages are live, in one region rather than duplicate owners.
  const status = [unavailable ? 'This part of the page is not available yet. Retry this step, or skip the tour and return later.'
    : !geometry && !inline ? 'Finding this part of the page…' : '',
    saveFailed ? 'Your tour preference could not be saved. It will not reopen automatically in this session.' : '',
  ].filter(Boolean).join(' ');
  return <ModalSurface labelledBy="host-welcome-title" describedBy={descriptionIds} initialFocusRef={heading} returnFocusRef={noReturnFocus}
    onRequestClose={exit} closePolicy={{ escape: true, backdrop: false }}>
    <div className="host-welcome" data-host-welcome-tour data-compact-target={compact} data-inline-target={inline}>
      {geometry && <div className="host-welcome__target" aria-hidden="true" style={geometry} />}
      <div className="host-welcome__panel" ref={panel} style={placement}>
        <div className="host-welcome__heading"><h2 id="host-welcome-title" aria-describedby="host-welcome-progress" tabIndex={-1} ref={heading}>{step.title}</h2>
          <button className="button button--quiet" type="button" aria-label="Close tour" onClick={exit}><X aria-hidden="true" /></button></div>
        <p id="host-welcome-progress" className="host-welcome__count">{mode === 'tools' ? `Step ${index + 1} of ${steps.length}` : 'Introduction'}</p>
        <p id="host-welcome-description">{step.text}</p>
        {compact && step.anchor === 'share-qr' && <p>The highlighted controls hold your guest link. Close the tour to inspect the QR below.</p>}
        {compact && step.anchor === 'settings' && <p>The highlighted region shows Guest uploads status. Close the tour to inspect the available controls below.</p>}
        {inline && <p>This part of the page cannot fit beside the guide at this size. Close the tour to inspect it in the workspace, or continue the tour.</p>}
        <div className="host-welcome__status" role="status" aria-live="polite" aria-atomic="true">
          <p aria-atomic="true" className={status ? undefined : 'sr-only'}>{status}</p>
        </div>
        {saveFailed && onRetrySave && <button type="button" className="button button--secondary" onClick={event => {
          saveRetryHadFocus.current = document.activeElement === event.currentTarget;
          onRetrySave();
        }}>Retry saving tour preference</button>}
        <div className="host-welcome__actions">
          <button type="button" className="button button--quiet" onClick={exit}>Skip tour</button>
          {mode === 'tools' && index > 0 && <button type="button" className="button button--secondary" disabled={!geometry && !inline} onClick={() => move(index - 1)}>Back</button>}
          {unavailable ? <button type="button" className="button button--primary" onClick={() => setRetry(n => n + 1)}>Retry step</button>
            : <button type="button" className="button button--primary" disabled={!geometry && !inline} onClick={() => move(mode === 'intro' ? 'intro' : index === steps.length - 1 ? 'finish' : index + 1)}>{mode === 'intro' ? introduction.label : index === steps.length - 1 ? 'Finish' : 'Next'}</button>}
        </div>
      </div>
    </div>
  </ModalSurface>;
}

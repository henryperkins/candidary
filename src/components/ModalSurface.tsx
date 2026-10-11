import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

export interface ModalSurfaceProps {
  labelledBy: string;
  describedBy?: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  onRequestClose(): void;
  closePolicy: { escape: boolean; backdrop: boolean };
  dialogRef?: RefObject<HTMLDivElement | null>;
  inertExceptionRef?: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

type ModalChildProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

function focusableElements(dialog: HTMLElement | null): HTMLElement[] {
  if (!dialog) return [];
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

// Shared ownership matters when a tour yields while a second dialog opens.
// Recompute from the top surface; an earlier cleanup must never unlock it.
const surfaces: { host: HTMLElement; exception?: HTMLElement | null }[] = [];
const originalInert = new Map<HTMLElement, boolean>();
let originalOverflow = '';
function reconcileModalOwnership() {
  const top = surfaces.at(-1);
  if (!top) {
    for (const [element, inert] of originalInert) {
      if (inert) element.setAttribute('inert', ''); else element.removeAttribute('inert');
    }
    originalInert.clear();
    document.body.style.overflow = originalOverflow;
    return;
  }
  for (const element of Array.from(document.body.children)) {
    if (!(element instanceof HTMLElement)) continue;
    if (!originalInert.has(element)) originalInert.set(element, element.hasAttribute('inert'));
    if (element === top.host || element === top.exception) element.removeAttribute('inert');
    else element.setAttribute('inert', '');
  }
  document.body.style.overflow = 'hidden';
}

/** Register custom portal dialogs in the same inert/scroll ownership boundary. */
export function acquireModalOwnership(host: HTMLElement, exception?: HTMLElement | null) {
  if (surfaces.length === 0) originalOverflow = document.body.style.overflow;
  const surface = { host, exception };
  surfaces.push(surface);
  reconcileModalOwnership();
  return () => {
    const wasTop = surfaces.at(-1) === surface;
    surfaces.splice(surfaces.indexOf(surface), 1);
    reconcileModalOwnership();
    return wasTop;
  };
}

export function ModalSurface({
  labelledBy,
  describedBy,
  initialFocusRef,
  onRequestClose,
  closePolicy,
  dialogRef,
  inertExceptionRef,
  returnFocusRef,
  children,
}: ModalSurfaceProps) {
  const [host] = useState(() => document.createElement('div'));
  const onlyChild = Children.count(children) === 1 && isValidElement<ModalChildProps>(children)
    ? children
    : createElement('div', null, children);
  const child = onlyChild as ReactElement<ModalChildProps>;
  const childRef = child.props.ref;

  useLayoutEffect(() => {
    document.body.append(host);
    const release = acquireModalOwnership(host, inertExceptionRef?.current);
    initialFocusRef.current?.focus({ preventScroll: true });
    return () => {
      host.remove();
      const wasTop = release();
      const target = returnFocusRef.current;
      if (wasTop && target?.isConnected && !target.closest('[inert], [hidden]')) target.focus();
    };
  }, [host, inertExceptionRef, initialFocusRef, returnFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (surfaces.at(-1)?.host !== host) return;
      if (event.key === 'Escape') {
        if (!closePolicy.escape) return;
        event.preventDefault();
        event.stopPropagation();
        onRequestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef?.current ?? host.firstElementChild as HTMLElement | null;
      const focusable = focusableElements(dialog);
      const exception = inertExceptionRef?.current;
      const exceptionControls = exception?.isConnected && !exception.closest('[inert]')
        ? focusableElements(exception) : [];
      if (exceptionControls.length > 0) {
        // An explicitly allowed interactive portal (for example Manager Undo)
        // belongs to this focus boundary even though it is a separate DOM root.
        // Walk the combined ring explicitly: native DOM order may put the portal
        // before the dialog, or inert background controls between the two roots.
        const boundary = [...new Set([...focusable, ...exceptionControls])];
        const index = boundary.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (event.shiftKey ? boundary.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + boundary.length) % boundary.length;
        event.preventDefault();
        boundary[next]?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        initialFocusRef.current?.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      if (!active || !dialog?.contains(active) || !focusable.includes(active as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closePolicy.escape, dialogRef, host, inertExceptionRef, initialFocusRef, onRequestClose]);

  const originalMouseDown = child.props.onMouseDown;
  return createPortal(cloneElement(child, {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': labelledBy,
    ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
    ref: (node: HTMLDivElement | null) => {
      assignRef(childRef, node);
      assignRef(dialogRef, node);
    },
    onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
      originalMouseDown?.(event);
      if (!event.defaultPrevented && closePolicy.backdrop && event.target === event.currentTarget) {
        onRequestClose();
      }
    },
  }), host);
}

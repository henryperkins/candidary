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

export function ModalSurface({
  labelledBy,
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
    const inerted: HTMLElement[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === host || !(sibling instanceof HTMLElement)) continue;
      if (sibling === inertExceptionRef?.current) continue;
      if (sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      inerted.push(sibling);
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    initialFocusRef.current?.focus();
    return () => {
      for (const sibling of inerted) sibling.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      host.remove();
      returnFocusRef.current?.focus();
    };
  }, [host, inertExceptionRef, initialFocusRef, returnFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        initialFocusRef.current?.focus();
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
  }, [closePolicy.escape, dialogRef, host, initialFocusRef, onRequestClose]);

  const originalMouseDown = child.props.onMouseDown;
  return createPortal(cloneElement(child, {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': labelledBy,
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

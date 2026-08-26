import {
  act,
  cleanup,
  fireEvent,
  getRoles,
  queryAllByRole,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyableLinkCard } from '../../src/components/CopyableLinkCard';

const MASK = '••••••••••••';
const SECRET_A = 'https://example.test/manage/secret-a';
const SECRET_B = 'https://example.test/manage/secret-b';
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText } as Clipboard,
  });
}

function removeClipboard() {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
}

function restoreClipboard() {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
}

function expectSensitiveLinkHidden(container: HTMLElement, secret: string) {
  expect(container.innerHTML).not.toContain(secret);
  expect(container.textContent).not.toContain(secret);
  expect(container.querySelectorAll('input')).toHaveLength(0);
  expect(container.querySelectorAll('input[type="hidden"]')).toHaveLength(0);

  for (const element of [container, ...container.querySelectorAll('*')]) {
    for (const attribute of element.getAttributeNames()) {
      expect(element.getAttribute(attribute)).not.toContain(secret);
    }
  }

  for (const role of Object.keys(getRoles(container))) {
    expect(queryAllByRole(container, role, {
      hidden: true,
      name: (accessibleName) => accessibleName.includes(secret),
    })).toHaveLength(0);
  }

  const focusable = [...container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
  )];
  expect(focusable).toEqual([
    screen.getByRole('button', { name: 'Reveal management link' }),
    screen.getByRole('button', { name: 'Copy management link' }),
  ]);
  for (const element of focusable) expect(element.outerHTML).not.toContain(secret);
}

afterEach(() => {
  cleanup();
  restoreClipboard();
  vi.restoreAllMocks();
});

describe('CopyableLinkCard', () => {
  it.each([
    ['short', 'x.y'],
    ['long', `https://example.test/manage/${'credential'.repeat(30)}`],
  ])('keeps a %s sensitive link out of hidden DOM, attributes, names, inputs, and focusables', (_kind, secret) => {
    const { container } = render(
      <CopyableLinkCard label="Management link" value={secret} sensitive />,
    );

    expectSensitiveLinkHidden(container, secret);
    const mask = screen.getByText(MASK);
    expect(mask).toHaveTextContent(/^\u2022{12}$/u);
    expect([...mask.textContent ?? '']).toHaveLength(12);
    expect(mask).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Reveal management link' }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Copy management link' })).toBeVisible();
  });

  it('reveals one named readonly sensitive link input and removes it on Hide', () => {
    const { container } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );
    const reveal = screen.getByRole('button', { name: 'Reveal management link' });
    const controlledId = reveal.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();

    fireEvent.click(reveal);

    const input = screen.getByRole('textbox', { name: 'Management link' });
    expect(input).toHaveValue(SECRET_A);
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('id', controlledId);
    const hide = screen.getByRole('button', { name: 'Hide management link' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', controlledId);

    fireEvent.click(hide);

    expect(screen.queryByRole('textbox', { name: 'Management link' })).not.toBeInTheDocument();
    expectSensitiveLinkHidden(container, SECRET_A);
  });

  it('copies a hidden sensitive link and announces success only after Clipboard resolves', async () => {
    const copy = deferred<void>();
    const writeText = vi.fn(() => copy.promise);
    installClipboard(writeText);
    const { container } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));

    expect(writeText).toHaveBeenCalledWith(SECRET_A);
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
    expectSensitiveLinkHidden(container, SECRET_A);

    await act(async () => { copy.resolve(); });

    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    expectSensitiveLinkHidden(container, SECRET_A);
  });

  it.each(['rejected', 'absent'] as const)(
    '%s Clipboard refocuses and selects the complete sensitive fallback on every Copy attempt',
    async (clipboardState) => {
      if (clipboardState === 'rejected') {
        installClipboard(vi.fn().mockRejectedValue(new Error('Permission denied')));
      } else {
        removeClipboard();
      }
      render(<CopyableLinkCard label="Management link" value={SECRET_A} sensitive />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));

      const input = await screen.findByRole('textbox', { name: 'Management link' });
      expect(input).toHaveValue(SECRET_A);
      expect(input).toHaveAttribute('readonly');
      await waitFor(() => expect(input).toHaveFocus());
      expect(input).toHaveProperty('selectionStart', 0);
      expect(input).toHaveProperty('selectionEnd', SECRET_A.length);
      expect(screen.getByRole('status')).toHaveTextContent(
        'Copy unavailable. Select the link instead.',
      );
      expect(screen.queryByText('Copied')).not.toBeInTheDocument();

      const copy = screen.getByRole('button', { name: 'Copy management link' });
      copy.focus();
      expect(copy).toHaveFocus();
      fireEvent.click(copy);

      await waitFor(() => expect(input).toHaveFocus());
      expect(input).toHaveProperty('selectionStart', 0);
      expect(input).toHaveProperty('selectionEnd', SECRET_A.length);

      fireEvent.click(screen.getByRole('button', { name: 'Hide management link' }));
      expect(screen.queryByRole('textbox', { name: 'Management link' })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    },
  );

  it('remasks a replacement sensitive link and clears copied feedback synchronously', async () => {
    installClipboard(vi.fn().mockResolvedValue(undefined));
    const { container, rerender } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));
    expect(await screen.findByText('Copied')).toBeVisible();

    rerender(<CopyableLinkCard label="Management link" value={SECRET_B} sensitive />);

    expectSensitiveLinkHidden(container, SECRET_A);
    expectSensitiveLinkHidden(container, SECRET_B);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('remasks a replacement sensitive link and clears unavailable fallback synchronously', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('Permission denied')));
    const { container, rerender } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));
    expect(await screen.findByRole('textbox', { name: 'Management link' })).toHaveValue(SECRET_A);
    expect(screen.getByRole('status')).toHaveTextContent('Copy unavailable');

    rerender(<CopyableLinkCard label="Management link" value={SECRET_B} sensitive />);

    expectSensitiveLinkHidden(container, SECRET_A);
    expectSensitiveLinkHidden(container, SECRET_B);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not let a pending sensitive link A completion mark or reveal replacement link B', async () => {
    const copyA = deferred<void>();
    const writeText = vi.fn(() => copyA.promise);
    installClipboard(writeText);
    const { container, rerender } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));

    rerender(<CopyableLinkCard label="Management link" value={SECRET_B} sensitive />);
    await act(async () => { copyA.resolve(); });

    expect(writeText).toHaveBeenCalledWith(SECRET_A);
    expectSensitiveLinkHidden(container, SECRET_A);
    expectSensitiveLinkHidden(container, SECRET_B);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not let an older sensitive link success clear newer link copied feedback', async () => {
    const copyA = deferred<void>();
    const copyB = deferred<void>();
    installClipboard(vi.fn((value: string) => value === SECRET_A ? copyA.promise : copyB.promise));
    const { container, rerender } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));
    rerender(<CopyableLinkCard label="Management link" value={SECRET_B} sensitive />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));

    await act(async () => { copyB.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    await act(async () => { copyA.resolve(); });

    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    expectSensitiveLinkHidden(container, SECRET_A);
    expectSensitiveLinkHidden(container, SECRET_B);
  });

  it('does not let an older sensitive link rejection replace a newer link fallback', async () => {
    const copyA = deferred<void>();
    const copyB = deferred<void>();
    installClipboard(vi.fn((value: string) => value === SECRET_A ? copyA.promise : copyB.promise));
    const { rerender } = render(
      <CopyableLinkCard label="Management link" value={SECRET_A} sensitive />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));
    rerender(<CopyableLinkCard label="Management link" value={SECRET_B} sensitive />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy management link' }));

    await act(async () => { copyB.reject(new Error('B unavailable')); });
    const input = screen.getByRole('textbox', { name: 'Management link' });
    expect(input).toHaveValue(SECRET_B);
    expect(screen.getByRole('status')).toHaveTextContent('Copy unavailable');
    await act(async () => { copyA.reject(new Error('A unavailable')); });

    expect(screen.getByRole('textbox', { name: 'Management link' })).toBe(input);
    expect(input).toHaveValue(SECRET_B);
    expect(input).toHaveFocus();
    expect(input).toHaveProperty('selectionStart', 0);
    expect(input).toHaveProperty('selectionEnd', SECRET_B.length);
    expect(screen.getByRole('status')).toHaveTextContent('Copy unavailable');
  });

  it('forwards the sensitive link ref to the exact Copy button', () => {
    const copyRef = createRef<HTMLButtonElement>();
    render(
      <CopyableLinkCard ref={copyRef} label="Management link" value={SECRET_A} sensitive />,
    );

    expect(copyRef.current).toBe(screen.getByRole('button', { name: 'Copy management link' }));
  });

  it('allows one sensitive instance to preserve a proper-noun control label without changing defaults', () => {
    render(<CopyableLinkCard
      label="Album link"
      value={SECRET_A}
      sensitive
      {...({ controlNoun: 'Album link' } as Record<string, string>)}
    />);

    expect(screen.getByRole('button', { name: 'Copy Album link' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reveal Album link' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copy album link' })).not.toBeInTheDocument();
  });

  it('retains the exact non-sensitive Event-link DOM, controls, copy, and fallback behavior', async () => {
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Permission denied'));
    installClipboard(writeText);
    const { container } = render(
      <CopyableLinkCard label="Event link" value={SECRET_A} />,
    );
    const code = container.querySelector('code');
    const show = screen.getByRole('button', { name: 'Show full event link' });

    expect(code).toHaveTextContent(SECRET_A);
    expect(code).toHaveAttribute('tabindex', '0');
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(show).toHaveAttribute('aria-controls', code?.id);
    expect(screen.getByRole('button', { name: 'Copy event link' })).toBeVisible();

    fireEvent.click(show);
    const hide = screen.getByRole('button', { name: 'Hide full event link' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', code?.id);
    expect(container.firstElementChild).toHaveClass('link-card--expanded');
    fireEvent.click(hide);

    fireEvent.click(screen.getByRole('button', { name: 'Copy event link' }));
    expect(await screen.findByText('Copied')).toBeVisible();
    expect(writeText).toHaveBeenLastCalledWith(SECRET_A);

    fireEvent.click(screen.getByRole('button', { name: 'Copy event link' }));
    expect(await screen.findByText('Copy unavailable. Select the link instead.')).toBeVisible();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide full event link' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(code).toHaveTextContent(SECRET_A);
  });

  it.each(['rejected', 'absent'] as const)(
    '%s Clipboard refocuses and selects the complete Event-link fallback on every Copy attempt',
    async (clipboardState) => {
      if (clipboardState === 'rejected') {
        installClipboard(vi.fn().mockRejectedValue(new Error('Permission denied')));
      } else {
        removeClipboard();
      }
      const { container } = render(<CopyableLinkCard label="Event link" value={SECRET_A} />);
      const code = container.querySelector('code')!;
      const copy = screen.getByRole('button', { name: 'Copy event link' });

      fireEvent.click(copy);

      expect(await screen.findByRole('status')).toHaveTextContent('Copy unavailable');
      expect(code).toHaveFocus();
      expect(window.getSelection()?.toString()).toBe(SECRET_A);
      expect(container.querySelector('input')).toBeNull();

      copy.focus();
      expect(copy).toHaveFocus();
      fireEvent.click(copy);

      await waitFor(() => expect(code).toHaveFocus());
      expect(window.getSelection()?.toString()).toBe(SECRET_A);
    },
  );

  it('keeps a non-sensitive Event link expanded with feedback when its value rerenders', async () => {
    installClipboard(vi.fn().mockResolvedValue(undefined));
    const { container, rerender } = render(
      <CopyableLinkCard label="Event link" value={SECRET_A} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show full event link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy event link' }));
    expect(await screen.findByText('Copied')).toBeVisible();

    rerender(<CopyableLinkCard label="Event link" value={SECRET_B} />);

    expect(container.querySelector('code')).toHaveTextContent(SECRET_B);
    expect(screen.getByRole('button', { name: 'Hide full event link' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Copied')).toBeVisible();
  });
});

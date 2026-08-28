import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModalSurface } from '../../src/components/ModalSurface';

afterEach(() => cleanup());

function ModalHarness({
  onClose = vi.fn(),
  escape = true,
  backdrop = true,
  inertExceptionRef,
  actions = true,
}: {
  onClose?: () => void;
  escape?: boolean;
  backdrop?: boolean;
  inertExceptionRef?: React.RefObject<HTMLElement | null>;
  actions?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={returnFocusRef}>Open modal</button>
    {open && <ModalSurface
      labelledBy="modal-surface-title"
      initialFocusRef={titleRef}
      onRequestClose={() => { onClose(); setOpen(false); }}
      closePolicy={{ escape, backdrop }}
      returnFocusRef={returnFocusRef}
      inertExceptionRef={inertExceptionRef}
    >
      <div className="test-modal">
        <h2 id="modal-surface-title" ref={titleRef} tabIndex={-1}>Modal title</h2>
        {actions && <>
          <button>First action</button>
          <button>Last action</button>
        </>}
      </div>
    </ModalSurface>}
  </>;
}

describe('ModalSurface', () => {
  it('labels, focuses, contains focus, inerts the background, locks scroll, and restores focus', async () => {
    // Mutations caught: dropping any one of the shared modal mechanics.
    const background = document.createElement('section');
    document.body.append(background);
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<ModalHarness onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Modal title' });
    expect(screen.getByRole('heading', { name: 'Modal title' })).toHaveFocus();
    expect(background).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last action' })).toHaveFocus();

    screen.getByRole('button', { name: 'Open modal' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();

    const last = screen.getByRole('button', { name: 'Last action' });
    last.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open modal' })).toHaveFocus());
    expect(background).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('');
    background.remove();
  });

  it('keeps focus on the stable heading when the modal has no tabbable action', async () => {
    // Mutation caught: letting Tab escape when a pending state temporarily has no action.
    const user = userEvent.setup();
    render(<ModalHarness actions={false} />);
    const heading = screen.getByRole('heading', { name: 'Modal title' });

    expect(heading).toHaveFocus();
    await user.tab({ shift: true });
    expect(heading).toHaveFocus();

    screen.getByRole('button', { name: 'Open modal' }).focus();
    await user.tab();
    expect(heading).toHaveFocus();
  });

  it('honors the Escape and backdrop policy and leaves the live host interactive', async () => {
    // Mutation caught: bypassing the parent close gate or inerting the live announcement host.
    const liveHost = document.createElement('aside');
    document.body.append(liveHost);
    const inertExceptionRef = { current: liveHost };
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<ModalHarness
      onClose={onClose}
      escape={false}
      backdrop={false}
      inertExceptionRef={inertExceptionRef}
    />);

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('dialog', { name: 'Modal title' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(liveHost).not.toHaveAttribute('inert');
    liveHost.remove();
  });
});

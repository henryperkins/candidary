import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPrintPack, ShareGuestLink } from '../../src/features/print/EventPrintPack';
import { PrintToolsUnavailableError } from '../../src/features/print/print-pack';
import type * as PrintPackModule from '../../src/features/print/print-pack';

const { generatePdf } = vi.hoisted(() => ({ generatePdf: vi.fn() }));
vi.mock('../../src/features/print/print-pack', async (original) => ({
  ...await original<typeof PrintPackModule>(), createPrintPdf: generatePdf,
}));
const EVENT = { name: 'Zoë & René', eventDate: '2026-09-12', eventLink: 'https://example.test/join#entry.secret' };
const createObjectURL = vi.fn(() => 'blob:print-pdf');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  createObjectURL.mockClear(); revokeObjectURL.mockClear();
  generatePdf.mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'share'); Reflect.deleteProperty(navigator, 'pdfViewerEnabled');
});
function cards() { return screen.getByRole('article', { name: 'Table cards' }); }

 describe('print pack file actions', () => {
  it('passes the selected wording and stock to the PDF and offers a link when popups are blocked', async () => {
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.change(screen.getByLabelText('Wording'), { target: { value: 'memorial' } });
    fireEvent.click(screen.getByRole('radio', { name: /Flat 4 × 6/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'A4' }));
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 4 sheets' }));
    expect(await screen.findByRole('link', { name: 'Open print PDF' })).toHaveAttribute('href', 'blob:print-pdf');
    expect(generatePdf).toHaveBeenCalledWith(EVENT, 'memorial', { kind: 'cards', style: '4x6', paper: 'a4', count: 8 });
    expect(screen.getByText(/Your PDF is ready/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('download', 'candidary-Zoe-Rene-cards.pdf');
  });

  it('offers the file without a waiting tab when the browser downloads PDFs instead of showing them', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: false });
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(await screen.findByRole('link', { name: 'Download PDF' })).toHaveAttribute('download', 'candidary-Zoe-Rene-cards.pdf');
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByText(/Your PDF is ready/)).toBeVisible();
  });

  it('clears the previous file when the host changes the print selection', async () => {
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    await screen.findByRole('link', { name: 'Open print PDF' });
    fireEvent.click(screen.getByRole('radio', { name: 'A4' }));
    expect(screen.queryByRole('link', { name: 'Open print PDF' })).not.toBeInTheDocument();
  });

  it('does not release an old event file after the event entry is removed', async () => {
    let finish!: (value: Uint8Array) => void;
    generatePdf.mockReturnValue(new Promise<Uint8Array>((resolve) => { finish = resolve; }));
    const { unmount } = render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(within(cards()).getByRole('button', { name: 'Preparing PDF…' })).toBeDisabled();
    unmount();
    await act(async () => { finish(new Uint8Array([37, 80, 68, 70])); });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('names the file after the event without splitting accented letters', async () => {
    render(<EventPrintPack event={{ ...EVENT, name: 'Renée Côté' }} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(await screen.findByRole('link', { name: 'Download PDF' })).toHaveAttribute('download', 'candidary-Renee-Cote-cards.pdf');
  });

  it('keeps only the PDF it still offers in memory', async () => {
    createObjectURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(await screen.findByRole('link', { name: 'Open print PDF' })).toHaveAttribute('href', 'blob:first');
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Open print PDF' })).toHaveAttribute('href', 'blob:second'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:second');
    fireEvent.click(screen.getByRole('radio', { name: 'A4' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
  });

  it('releases downloaded artwork once the download has had time to start', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    createObjectURL.mockReturnValueOnce('blob:artwork');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download SVG' }));
    expect(await screen.findByText('SVG download prepared.')).toBeVisible();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:artwork');
  });

  it('offers a reload when this page’s print tools are gone after an update', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    generatePdf.mockRejectedValueOnce(new PrintToolsUnavailableError());
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(await screen.findByText('The print tools could not load. Reload the page, then print again.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('radio', { name: 'A4' }));
    expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument();
  });

  it('recovers from file generation failure without claiming a PDF exists', async () => {
    generatePdf.mockRejectedValueOnce(new Error('Fonts unavailable'));
    render(<EventPrintPack event={EVENT} qr="" />);
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(await screen.findByText(/The print file could not be prepared/)).toBeVisible();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(within(cards()).getByRole('button', { name: 'Print 8 sheets' })).toBeEnabled();
    fireEvent.click(within(cards()).getByRole('button', { name: 'Print 8 sheets' }));
    expect(await screen.findByRole('link', { name: 'Open print PDF' })).toBeVisible();
  });
});

describe('native event sharing', () => {
  it('shares only the guest URL and leaves cancellation quiet', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    render(<ShareGuestLink eventLink={EVENT.eventLink} eventName={EVENT.name} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share guest link' }));
    await act(async () => {});
    expect(share).toHaveBeenCalledWith({ title: 'Zoë & René', url: EVENT.eventLink });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('offers the existing copy control as recovery after a sharing failure', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn().mockRejectedValue(new Error('Denied')) });
    render(<ShareGuestLink eventLink={EVENT.eventLink} eventName={EVENT.name} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share guest link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copy the event link above instead');
  });
});

import { Download, Minus, Plus, Printer, Share2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  CARD_STYLES, STICKER_LAYOUTS, PRINT_EXPLAINER, PRINT_WORDING, MAX_CARDS, MAX_STICKER_SHEETS,
  clampCardCount, counted, createPrintPdf, getPrintLayout,
  type CardStyle, type PrintEvent, type PrintJob, type PrintPaper, type PrintWording, type StickerLayout,
} from './print-pack';
import { createQrArtwork } from './qr-artwork';
import './print-pack.css';

export function ShareGuestLink({ eventLink, eventName }: { eventLink: string; eventName: string }) {
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, [eventLink]);
  if (typeof navigator.share !== 'function') return null;
  async function share() {
    const current = ++attempt.current;
    setError('');
    setSharing(true);
    try {
      await navigator.share({ title: eventName, url: eventLink });
    } catch (reason) {
      if (attempt.current === current && !(reason && typeof reason === 'object' && 'name' in reason && reason.name === 'AbortError')) {
        setError('Sharing is unavailable. Copy the event link above instead.');
      }
    } finally {
      if (attempt.current === current) setSharing(false);
    }
  }
  return <div className="share-guest-link">
    <button type="button" className="button button--secondary" disabled={sharing} onClick={() => void share()}><Share2 aria-hidden="true" /> Share guest link</button>
    {error && <p role="status" className="print-pack__error">{error}</p>}
  </div>;
}

function Choices<T extends string>({ label, name, value, options, onChange, disabled = false, visibleLegend = false }: {
  label: string; name: string; value: T; options: readonly { id: T; label: string; spec?: string }[];
  onChange(value: T): void; disabled?: boolean; visibleLegend?: boolean;
}) {
  return <fieldset className="print-pack__choices" disabled={disabled}>
    <legend className={visibleLegend ? '' : 'sr-only'}>{label}</legend>
    <div className="print-pack__options">{options.map((option) => <label key={option.id} className="print-pack__option" data-selected={value === option.id}>
      <input type="radio" name={name} checked={value === option.id} value={option.id} onChange={() => onChange(option.id)} />
      <span>{option.label}</span>{option.spec && <small>{option.spec}</small>}
    </label>)}</div>
  </fieldset>;
}

function Quantity({ value, fewer, more, atMin, atMax, onChange, step = 1, disabled }: {
  value: number; fewer: string; more: string; atMin: boolean; atMax: boolean;
  onChange(value: number): void; step?: number; disabled: boolean;
}) {
  return <span className="print-pack__quantity">
    <button type="button" aria-label={fewer} disabled={disabled || atMin} onClick={() => onChange(value - step)}><Minus aria-hidden="true" /></button>
    <output aria-live="polite" aria-atomic="true">{value}</output>
    <button type="button" aria-label={more} disabled={disabled || atMax} onClick={() => onChange(value + step)}><Plus aria-hidden="true" /></button>
  </span>;
}

function Thumbnail({ kind, qr }: { kind: CardStyle | StickerLayout | 'sign' | 'art'; qr: string }) {
  const code = (className?: string) => qr ? <img className={className} src={qr} alt="" /> : <span className="print-pack__qr-placeholder" />;
  return <div aria-hidden="true" className="print-pack__thumbnail">
    {kind === '5163' || kind === '22806' ? <div className={'print-pack__mini-labels print-pack__mini-labels--' + kind}>
      {Array.from({ length: kind === '5163' ? 10 : 12 }, (_, i) => <span key={i}>{code()}</span>)}
    </div> : kind === 'art' ? code('print-pack__mini-art') : <div className={'print-pack__mini-card print-pack__mini-card--' + kind}>
      {kind === 'tent' && <div className="print-pack__mini-face print-pack__mini-face--back">{code()}<i /></div>}
      <div className="print-pack__mini-face">{code()}<i /><i /></div>
    </div>}
  </div>;
}

function PrintRow({ id, title, description, thumbnail, children }: { id: string; title: string; description: string; thumbnail: ReactNode; children: ReactNode }) {
  return <article className="print-pack__row" aria-labelledby={id}>
    {thumbnail}
    <div className="print-pack__body"><div className="print-pack__row-heading"><h4 id={id}>{title}</h4><p>{description}</p></div>{children}</div>
  </article>;
}

/** The parent keys this to the event and guest credential; an old render cannot publish a file. */
export function EventPrintPack({ event, qr }: { event: PrintEvent; qr: string }) {
  const id = useId();
  const [wording, setWording] = useState<PrintWording>('celebration');
  const [paper, setPaper] = useState<PrintPaper>('letter');
  const [style, setStyle] = useState<CardStyle>('tent');
  const [cardCount, setCardCount] = useState(8);
  const [stickerLayout, setStickerLayout] = useState<StickerLayout>('5163');
  const [stickerSheets, setStickerSheets] = useState(3);
  const [signSize, setSignSize] = useState<'sheet' | 'poster'>('sheet');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState<{ url: string; filename: string } | null>(null);
  const attempt = useRef(0);
  const working = useRef(false);
  const urls = useRef(new Set<string>());
  const printWindow = useRef<Window | null>(null);
  useEffect(() => {
    setReady(null); setMessage(''); setError('');
  }, [wording, paper, style, cardCount, stickerLayout, stickerSheets, signSize]);
  useEffect(() => () => {
    attempt.current++;
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    if (working.current) printWindow.current?.close();
  }, []);

  const cardJob: PrintJob = { kind: 'cards', style, paper, count: cardCount };
  const cards = getPrintLayout(cardJob);
  const stickers = getPrintLayout({ kind: 'stickers', layout: stickerLayout, sheets: stickerSheets });
  const per = style === '4x6' ? 2 : 1;
  const paperName = paper === 'a4' ? 'A4' : 'Letter';
  const disabled = busy !== null;
  const filePrefix = 'candidary-' + (event.name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'event');

  async function prepare(kind: PrintJob | 'svg' | 'png') {
    if (working.current) return;
    working.current = true;
    const current = ++attempt.current;
    const isPrint = typeof kind !== 'string';
    const action = isPrint ? kind.kind : kind;
    setBusy(action); setError(''); setMessage(''); setReady(null);
    let target: Window | null = null;
    // A browser that downloads PDFs instead of showing them would strand the waiting tab.
    if (isPrint && navigator.pdfViewerEnabled !== false) {
      // Open synchronously from the gesture. File generation must not consume activation first.
      try {
        target = window.open('', '_blank');
        if (target) { target.opener = null; target.document.title = 'Preparing print PDF'; target.document.body.textContent = 'Preparing your Candidary print PDF…'; }
      } catch { target = null; }
      printWindow.current = target;
    }
    try {
      const blob = isPrint ? new Blob([await createPrintPdf(event, wording, kind)], { type: 'application/pdf' }) : await createQrArtwork(event.eventLink, kind);
      if (attempt.current !== current) { target?.close(); return; }
      const filename = filePrefix + '-' + action + (isPrint ? '.pdf' : '.' + kind);
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      if (isPrint) {
        setReady({ url, filename });
        if (target && !target.closed) target.location.replace(url);
        setMessage(target && !target.closed ? 'Your PDF is open in a new tab. Print at Actual size (100%).' : 'Your PDF is ready. Open it to print at Actual size (100%).');
      } else {
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = filename; anchor.click();
        setMessage((kind === 'svg' ? 'SVG' : '2400 px PNG') + ' download prepared.');
      }
    } catch {
      target?.close();
      if (attempt.current === current) setError('The print file could not be prepared. Try again, or copy the event link above.');
    } finally {
      if (attempt.current === current) { working.current = false; setBusy(null); printWindow.current = null; }
    }
  }
  const printButton = (job: PrintJob, label: string) => <button type="button" className="button button--secondary print-pack__print-action" disabled={disabled} onClick={() => void prepare(job)}>
    <Printer aria-hidden="true" />{busy === job.kind ? 'Preparing PDF…' : label}
  </button>;

  return <section className="print-pack" aria-labelledby={id + '-title'}>
    <h3 id={id + '-title'}>Print and download</h3>
    <p className="print-pack__intro">Every piece carries this guest code. Put a sign at the entrance and a card wherever guests sit or wait.</p>
    <div className="print-pack__settings">
      <label className="print-pack__wording"><span>Wording</span><select value={wording} disabled={disabled} onChange={(e) => setWording(e.target.value as PrintWording)}>
        {Object.entries(PRINT_WORDING).map(([key, value]) => <option key={key} value={key}>{value.label} — {value.headline}</option>)}
      </select></label>
      <Choices<PrintPaper> label="Paper" name={id + '-paper'} visibleLegend value={paper} onChange={setPaper} disabled={disabled} options={[{ id: 'letter', label: 'Letter' }, { id: 'a4', label: 'A4' }]} />
    </div>
    <p className="print-pack__headline">{PRINT_WORDING[wording].headline}</p>
    <p className="print-pack__explainer">{PRINT_EXPLAINER}</p>

    <PrintRow id={id + '-cards'} title="Table cards" description="For tables, the bar and the photo display. Cut on the dashed lines." thumbnail={<Thumbnail kind={style} qr={qr} />}>
      <Choices<CardStyle> label="Card style" name={id + '-style'} value={style} onChange={(value) => { setStyle(value); setCardCount((count) => clampCardCount(count, value)); }} options={CARD_STYLES} disabled={disabled} />
      <div className="print-pack__actions">
        <Quantity value={cardCount} fewer={per === 1 ? 'One card fewer' : 'Two cards fewer'} more={per === 1 ? 'One card more' : 'Two cards more'} atMin={cardCount <= per} atMax={cardCount + per > MAX_CARDS} step={per} onChange={setCardCount} disabled={disabled} />
        <small>{counted(cardCount, 'card')} on {counted(cards.sheetCount, paperName + ' sheet')}</small>
        {printButton(cardJob, 'Print ' + counted(cards.sheetCount, 'sheet'))}
      </div>
    </PrintRow>
    <PrintRow id={id + '-stickers'} title="Stickers" description="Add the code to invitations, programs, favors and welcome bags. Avery US Letter sheets, no cut marks." thumbnail={<Thumbnail kind={stickerLayout} qr={qr} />}>
      <Choices<StickerLayout> label="Label sheet" name={id + '-labels'} value={stickerLayout} onChange={setStickerLayout} options={STICKER_LAYOUTS} disabled={disabled} />
      <div className="print-pack__actions">
        <Quantity value={stickerSheets} fewer="One sticker sheet fewer" more="One sticker sheet more" atMin={stickerSheets <= 1} atMax={stickerSheets >= MAX_STICKER_SHEETS} onChange={setStickerSheets} disabled={disabled} />
        <small>{counted(stickers.itemCount, 'sticker')}</small>
        {printButton({ kind: 'stickers', layout: stickerLayout, sheets: stickerSheets }, 'Print ' + counted(stickerSheets, 'sheet'))}
      </div>
    </PrintRow>
    <PrintRow id={id + '-sign'} title="Welcome sign" description="For the entrance, where guests first look for what to do. The poster is a finished PDF for a print shop." thumbnail={<Thumbnail kind="sign" qr={qr} />}>
      <Choices<'sheet' | 'poster'> label="Sign size" name={id + '-sign-size'} value={signSize} onChange={setSignSize} disabled={disabled} options={[{ id: 'sheet', label: paperName + ' sheet', spec: 'Print at home' }, { id: 'poster', label: 'Poster', spec: '18 × 24 in · for a print shop' }]} />
      <div className="print-pack__actions">{printButton({ kind: 'sign', size: signSize === 'poster' ? 'poster' : paper }, signSize === 'poster' ? 'Open 18 × 24 in poster' : 'Print 1 sheet')}</div>
    </PrintRow>
    <PrintRow id={id + '-art'} title="QR artwork" description="For a stationer or designer. Keep it dark on a light ground, square, with the border it comes with." thumbnail={<Thumbnail kind="art" qr={qr} />}>
      <div className="print-pack__actions print-pack__actions--art">
        <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void prepare('svg')}><Download aria-hidden="true" />{busy === 'svg' ? 'Preparing SVG…' : 'Download SVG'}</button>
        <button type="button" className="button button--secondary" disabled={disabled} onClick={() => void prepare('png')}><Download aria-hidden="true" />{busy === 'png' ? 'Preparing PNG…' : 'Download PNG · 2400 px'}</button>
      </div>
    </PrintRow>
    <div className="print-pack__result" aria-live="polite" aria-atomic="true">
      {error && <p className="print-pack__error">{error}</p>}
      {message && <p>{message}</p>}
      {ready && <div className="print-pack__result-links"><a href={ready.url} target="_blank" rel="noopener noreferrer">Open print PDF</a><a href={ready.url} download={ready.filename}>Download PDF</a></div>}
    </div>
    <p className="print-pack__note">Print opens a PDF. Choose Actual size (100%) and the matching paper. Print one piece and scan it with two phones before printing the batch. Only the guest link appears on paper.</p>
  </section>;
}

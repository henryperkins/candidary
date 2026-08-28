import { Copy, Eye, EyeOff } from 'lucide-react';
import { forwardRef, useId, useLayoutEffect, useRef, useState } from 'react';

interface CopyResult {
  value: string;
  state: 'copied' | 'unavailable';
}

interface CopyableLinkCardProps {
  label: string;
  value: string;
  sensitive?: boolean;
  /** Keeps a product proper noun intact in control names; defaults remain sentence-cased. */
  controlNoun?: string;
  /** Reports only the current copy attempt after Clipboard has settled. */
  onCopyOutcome?: (outcome: 'copied' | 'unavailable') => void;
}

const SENSITIVE_MASK = '••••••••••••';

export const CopyableLinkCard = forwardRef<HTMLButtonElement, CopyableLinkCardProps>(
  function CopyableLinkCard({
    label,
    value,
    sensitive = false,
    controlNoun,
    onCopyOutcome,
  }, copyButtonRef) {
    const [copyResult, setCopyResult] = useState<CopyResult | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [revealedValue, setRevealedValue] = useState<string | null>(null);
    const copyAttemptRef = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const codeRef = useRef<HTMLElement>(null);
    const linkId = useId();
    const name = controlNoun ?? label.toLowerCase();
    const revealed = sensitive ? revealedValue === value : expanded;
    const currentCopyState = !sensitive || copyResult?.value === value
      ? copyResult?.state ?? 'idle'
      : 'idle';

    useLayoutEffect(() => {
      if (sensitive) copyAttemptRef.current += 1;
    }, [sensitive, value]);

    useLayoutEffect(() => {
      if (!revealed || currentCopyState !== 'unavailable') return;
      if (sensitive) {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(0, value.length);
        return;
      }
      const code = codeRef.current;
      if (!code) return;
      code.focus();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    }, [copyResult, currentCopyState, revealed, sensitive, value]);

    async function copyLink() {
      const copiedValue = value;
      const copyAttempt = sensitive ? ++copyAttemptRef.current : null;
      setCopyResult(null);
      try {
        if (!navigator.clipboard) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(copiedValue);
        if (copyAttempt !== null && copyAttemptRef.current !== copyAttempt) return;
        setCopyResult({ value: copiedValue, state: 'copied' });
        onCopyOutcome?.('copied');
      } catch {
        if (copyAttempt !== null && copyAttemptRef.current !== copyAttempt) return;
        // Clipboard access is routinely refused on iOS Safari and in any non-secure context, so leave
        // the host a link they can read and select by hand rather than a truncated dead end.
        setCopyResult({ value: copiedValue, state: 'unavailable' });
        if (sensitive) setRevealedValue(copiedValue);
        else setExpanded(true);
        onCopyOutcome?.('unavailable');
      }
    }

    return <div className={revealed ? 'link-card link-card--expanded' : 'link-card'}>
      <span>{label}</span>
      <div>
        {sensitive
          ? revealed
            ? <input ref={inputRef} id={linkId} aria-label={label} readOnly value={value} />
            : <span id={linkId} className="link-card__mask" aria-hidden="true">{SENSITIVE_MASK}</span>
          : <code ref={codeRef} id={linkId} tabIndex={0}>{value}</code>}
        <button
          type="button"
          className="icon-button"
          aria-label={sensitive
            ? `${revealed ? 'Hide' : 'Reveal'} ${name}`
            : `${revealed ? 'Hide' : 'Show'} full ${name}`}
          aria-expanded={revealed}
          aria-controls={linkId}
          onClick={() => {
            if (sensitive) {
              if (revealed && currentCopyState === 'unavailable') setCopyResult(null);
              setRevealedValue(revealed ? null : value);
            } else {
              setExpanded((current) => !current);
            }
          }}
        >
          {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
        <button ref={copyButtonRef} type="button" className="icon-button" aria-label={`Copy ${name}`} onClick={() => void copyLink()}>
          <Copy aria-hidden="true" />
        </button>
      </div>
      {currentCopyState === 'copied' && <small role="status">Copied</small>}
      {currentCopyState === 'unavailable' && <small className="link-card__error" role="status">Copy unavailable. Select the link instead.</small>}
    </div>;
});

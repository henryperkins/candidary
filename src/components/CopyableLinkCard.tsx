import { Copy, Eye, EyeOff } from 'lucide-react';
import { useId, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'unavailable';

interface CopyableLinkCardProps {
  label: string;
  value: string;
}

export function CopyableLinkCard({ label, value }: CopyableLinkCardProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [expanded, setExpanded] = useState(false);
  const linkId = useId();
  const name = label.toLowerCase();

  async function copyLink() {
    setCopyState('idle');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      // Clipboard access is routinely refused on iOS Safari and in any non-secure context, so leave
      // the host a link they can read and select by hand rather than a truncated dead end.
      setCopyState('unavailable');
      setExpanded(true);
    }
  }

  return <div className={expanded ? 'link-card link-card--expanded' : 'link-card'}>
    <span>{label}</span>
    <div>
      <code id={linkId} tabIndex={0}>{value}</code>
      <button
        type="button"
        className="icon-button"
        aria-label={`${expanded ? 'Hide' : 'Show'} full ${name}`}
        aria-expanded={expanded}
        aria-controls={linkId}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
      <button type="button" className="icon-button" aria-label={`Copy ${name}`} onClick={() => void copyLink()}>
        <Copy aria-hidden="true" />
      </button>
    </div>
    {copyState === 'copied' && <small role="status">Copied</small>}
    {copyState === 'unavailable' && <small className="link-card__error" role="status">Copy unavailable. Select the link instead.</small>}
  </div>;
}

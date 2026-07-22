import { Copy } from 'lucide-react';
import { useState } from 'react';

type CopyState = 'idle' | 'copied' | 'unavailable';

interface CopyableLinkCardProps {
  label: string;
  value: string;
}

export function CopyableLinkCard({ label, value }: CopyableLinkCardProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  async function copyLink() {
    setCopyState('idle');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('unavailable');
    }
  }

  return <div className="link-card">
    <span>{label}</span>
    <div>
      <code>{value}</code>
      <button type="button" className="icon-button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copyLink()}>
        <Copy aria-hidden="true" />
      </button>
    </div>
    {copyState === 'copied' && <small role="status">Copied</small>}
    {copyState === 'unavailable' && <small className="link-card__error" role="status">Copy unavailable</small>}
  </div>;
}

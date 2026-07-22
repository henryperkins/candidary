import { Link } from 'react-router-dom';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className={`brand${compact ? ' brand--compact' : ''}`} to="/" aria-label="Candidary home">
      <span className="brand__mark" aria-hidden="true"><i /><i /><i /></span>
      <span>Candidary</span>
    </Link>
  );
}

export function PageHeader({ action }: { action?: React.ReactNode }) {
  return <header className="page-header"><Brand />{action}</header>;
}

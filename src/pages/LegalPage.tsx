import { Link } from 'react-router-dom';

import {
  LEGAL_PENDING_NOTE,
  PRIVACY_PAGE,
  TERMS_PAGE,
} from '../../shared/site-content';
import type { SiteLegalPage } from '../../shared/site-content';
import { PageHeader } from '../components/Brand';

/**
 * The two documents the site footer links to. Neither is written yet, and a placeholder that reads
 * like a policy is worse than none — a visitor cannot tell an unwritten clause from an agreed one.
 * So each page states only what the product already enforces and is already published elsewhere on
 * the site (the retention dates, the host-first delivery, the absence of guest accounts), and says
 * plainly that the full document is still to come. Replace the body, not the route: the footer link
 * is live from here on. The sentences themselves live in `shared/site-content.ts`, because the
 * Worker answers these same two URLs in markdown and both must say one thing.
 */
function LegalPage({ title, lede, facts }: SiteLegalPage) {
  return <div className="public-shell">
    <PageHeader action={<Link className="text-link" to="/">Back home</Link>} />
    <main className="legal-page">
      <section>
        <p className="section-label">Candidary</p>
        <h1>{title}</h1>
        <p>{lede}</p>
        <ul className="trust-list">
          {facts.map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
        <p className="legal-page__pending">{LEGAL_PENDING_NOTE}</p>
      </section>
    </main>
  </div>;
}

export function PrivacyPage() {
  return <LegalPage {...PRIVACY_PAGE} />;
}

export function TermsPage() {
  return <LegalPage {...TERMS_PAGE} />;
}

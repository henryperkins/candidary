import { Link } from 'react-router-dom';

import { PageHeader } from '../components/Brand';

/**
 * The two documents the site footer links to. Neither is written yet, and a placeholder that reads
 * like a policy is worse than none — a visitor cannot tell an unwritten clause from an agreed one.
 * So each page states only what the product already enforces and is already published elsewhere on
 * the site (the retention dates, the host-first delivery, the absence of guest accounts), and says
 * plainly that the full document is still to come. Replace the body, not the route: the footer link
 * is live from here on.
 */
function LegalPage({ title, lede, facts }: { title: string; lede: string; facts: string[] }) {
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
        <p className="legal-page__pending">
          The full document is being prepared. Until it is published, the points above are the
          commitments the product enforces today.
        </p>
      </section>
    </main>
  </div>;
}

export function PrivacyPage() {
  return <LegalPage
    title="Privacy"
    lede="What Candidary holds, who can see it, and how long it stays."
    facts={[
      'Guests never create an account. A guest gives one name with their photos, and nothing else is asked of them.',
      'Every photo is delivered privately to the host first. Only what the host publishes appears in the shared gallery.',
      'Guest access ends 30 days after the event, the management link works for 90 days, and files are deleted at 120.',
      'Event links are the keys. An email address is attached to an event only when a host chooses to save it to an account.',
    ]}
  />;
}

export function TermsPage() {
  return <LegalPage
    title="Terms"
    lede="What Candidary undertakes to do, and what an event may hold."
    facts={[
      'One event holds up to 10,000 photos or 100 GiB, with a 20 MB ceiling on any single image.',
      'Accepted formats are JPEG, PNG, WebP, HEIC and HEIF. Originals are stored at full resolution and are not re-encoded.',
      'A prepared download is built as a ZIP in 2 GiB parts, with a manifest of everything received.',
      'A management link cannot be recovered once lost unless the event has been saved to an account.',
    ]}
  />;
}

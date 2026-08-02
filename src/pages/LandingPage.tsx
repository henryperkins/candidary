import { ArrowRight, Check, ChevronDown, Eye, Image as ImageIcon, QrCode } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Brand, PageHeader } from '../components/Brand';

/**
 * The short answers, drawn from real product limits rather than marketing copy: the upload ceiling,
 * the per-event ceiling, the ZIP part size, and the three retention dates the event page already
 * shows. Everything stated here has to stay true of the worker, so each answer names a number the
 * product enforces rather than a promise it does not.
 */
const QUESTIONS = [
  {
    question: 'Do guests need an account?',
    answer: 'No. Guests never sign in. They scan the QR code or open the link, type one name, and send.',
  },
  {
    question: 'Who sees the photos first?',
    answer: 'You do. Every photo is delivered privately to you. The shared gallery only shows what you publish.',
  },
  {
    question: 'What can guests send?',
    answer: 'JPEG, PNG, WebP, HEIC and HEIF, up to 20 MB per image. One event holds up to 10,000 photos or 100 GiB.',
  },
  {
    question: 'How do I get the photos out?',
    answer: 'Prepare a download and Candidary builds a ZIP in 2 GiB parts, with a manifest of everything received.',
  },
  {
    question: 'How long do the photos stay?',
    answer: 'Guest access ends 30 days after the event, your management link works for 90, and files are deleted at 120. The dates are shown on your event.',
  },
  {
    question: 'Do I need an account to create an event?',
    answer: 'No. Your event links are the keys. Save an event to an email address only if you want a way back to it later.',
  },
];

export function LandingPage() {
  return <div className="public-shell public-shell--landing">
    {/* `.page-header` is `space-between`, so every exit past the brand travels as one right-aligned
        group. The row reads navigate | return | act: `How it works` is wayfinding, `Sign in` is the
        returning host's way back, and the create button is the act. `Sign in` holds its place at
        every width — a host coming back on a phone has no other route into their events — and
        `How it works` is the one thing that leaves below 761px, where the hero and the footer both
        still offer the same anchor. See `.site-nav` in `styles.css` and the exit matrix in
        `tests/e2e/accessibility.spec.ts`. */}
    <PageHeader action={<nav className="site-nav" aria-label="Primary">
      <a className="site-nav__link" href="#how-it-works">How it works</a>
      <span className="header-signin">
        <span className="header-signin__rule" aria-hidden="true" />
        <Link className="text-link" to="/host/login">Sign in</Link>
      </span>
      {/* The label shortens to `Create` below 761px to buy the row the width `Sign in` now takes.
          `aria-label` holds the full name so the accessible name does not change with the viewport;
          the visible label is contained by it, which is what SC 2.5.3 asks for. */}
      <Link className="button button--secondary header-cta" to="/create" aria-label="Create an event">
        <span className="header-cta__long">Create an event</span>
        <span className="header-cta__short">Create</span>
      </Link>
    </nav>} />
    <main>
      <section className="hero">
        <div className="hero__copy">
          {/* The page says what it *is* before the headline says what it *feels like*. */}
          <p className="section-label">Private event albums</p>
          <h1>Gather the moments <br />you didn’t see.</h1>
          <p>Create one private place for your guests to add photos, then choose what appears in the shared gallery.</p>
          <div className="button-row">
            <Link className="button button--primary" to="/create">Create your event <ArrowRight aria-hidden="true" /></Link>
            <a className="button button--quiet" href="#how-it-works">See how it works</a>
          </div>
          {/* Both account doors, under a hairline, as one answering sentence rather than a
              two-paragraph slab competing with the CTA for the same eye. The same three facts:
              a returning host signs in, a new one can register, and creating an event needs
              neither. The 44px floor survives as vertical padding on the inline links, which grows
              the hit box without breaking the line. The design system lists account copy as banned
              *above the fold* in the header chrome — this sits below the CTA, sized as answering
              copy, not navigation surface. */}
          <div className="hero__account">
            <p>
              Already have an account? <Link className="text-link" to="/host/login">Sign in to your events</Link>.
              {' '}New here? <Link className="text-link" to="/host/register">Create one</Link> to find them
              again — creating an event never needs one.
            </p>
          </div>
        </div>
        {/* The right column is a pile, not a picture. What the product actually returns to a host is
            the photographs other people took, so the arch — the brand's own shape, kept as the
            anchor — carries two guest prints overlapping it at the angles the brand mark uses. */}
        <figure className="hero__image">
          <img src="/assets/candidary-hero.png" alt="Friends celebrating together at a candlelit outdoor table" />
          <span className="hero__print hero__print--a">
            <img src="/assets/photos/sq-03.png" alt="A guest tossing petals, photographed by someone else at the same moment" />
          </span>
          <span className="hero__print hero__print--b">
            <img src="/assets/photos/sq-06.png" alt="A second guest’s photograph of the same celebration" />
          </span>
        </figure>
      </section>
      {/* Three capabilities rather than three chronological steps: what the product refuses to ask
          of a guest, what it refuses to do to a photograph, and who decides what becomes public. */}
      <section className="workflow" id="how-it-works" aria-labelledby="workflow-title">
        <div><p className="section-label">A shared point of view</p><h2 id="workflow-title">One place. Every perspective.</h2></div>
        <ol>
          <li><span><QrCode aria-hidden="true" /></span><div><strong>No app, no account</strong><p>Guests scan the QR code, type one name, and send. Nothing to install, nothing to sign up for.</p></div></li>
          <li><span><ImageIcon aria-hidden="true" /></span><div><strong>Untouched originals</strong><p>Photos arrive at full resolution, up to 20 MB each. Prepare a download whenever you want them all.</p></div></li>
          <li><span><Eye aria-hidden="true" /></span><div><strong>You choose what is shared</strong><p>Every photo is delivered privately to you first. Publish the ones you want in the shared gallery.</p></div></li>
        </ol>
        <p className="privacy-note"><Check aria-hidden="true" /> Private by design. No guest accounts required.</p>
      </section>
      {/* One column at every width: an accordion in two columns makes the reader track which panel
          moved. Native `<details>`, so the disclosures work before any script does. */}
      <section className="faq" id="questions" aria-labelledby="faq-title">
        <p className="section-label">Questions</p><h2 id="faq-title">The short answers.</h2>
        <div className="faq__list">
          {QUESTIONS.map(({ question, answer }) => <details className="faq__item" key={question}>
            <summary>{question}<ChevronDown aria-hidden="true" /></summary>
            <p>{answer}</p>
          </details>)}
        </div>
      </section>
    </main>
    <footer className="site-footer">
      <div className="site-footer__top">
        <div>
          <Brand />
          <p className="site-footer__blurb">A private photo drop for weddings and large events. Guests need no account, no app, and no sign-up.</p>
        </div>
        <nav className="site-footer__groups" aria-label="Footer">
          <div>
            <h3 className="section-label">Product</h3>
            <ul>
              <li><a href="#how-it-works">How it works</a></li>
              <li><a href="#questions">Questions</a></li>
              <li><Link to="/create">Create an event</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="section-label">Your events</h3>
            <ul>
              <li><Link to="/host/login">Sign in</Link></li>
              <li><Link to="/host/register">Create an account</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="section-label">About</h3>
            <ul>
              <li><Link to="/privacy">Privacy</Link></li>
              <li><Link to="/terms">Terms</Link></li>
            </ul>
          </div>
        </nav>
      </div>
      <div className="site-footer__bottom">
        <p>© 2026 Candidary</p>
        <p>Guest access ends 30 days after your event. Files delete at 120.</p>
      </div>
    </footer>
  </div>;
}

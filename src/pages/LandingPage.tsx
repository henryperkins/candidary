import { ArrowRight, Camera, Check, Share2, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../components/Brand';

export function LandingPage() {
  return <div className="public-shell">
    {/* `.page-header` is `space-between`, so a third direct child would strand `Sign in` in the
        middle of the row; both exits travel as one right-aligned group instead. Sign in drops out
        below 761px — see `.header-signin` in `styles.css` and the exit matrix in
        `tests/e2e/accessibility.spec.ts`. The hero block carries both routes on its own at every
        width, so a phone visitor is never stranded. */}
    <PageHeader action={<div className="page-header__actions">
      <Link className="text-link header-signin" to="/host/login">Sign in</Link>
      <Link className="text-link" to="/create">Create an event <ArrowRight aria-hidden="true" /></Link>
    </div>} />
    <main>
      <section className="hero">
        <div className="hero__copy">
          <h1>Gather the moments <br />you didn’t see.</h1>
          <p>Create one private place for your guests to add photos, then choose what appears in the shared gallery.</p>
          <div className="button-row">
            <Link className="button button--primary" to="/create">Create your event <ArrowRight aria-hidden="true" /></Link>
            <a className="button button--quiet" href="#how-it-works">See how it works</a>
          </div>
          {/* The two account doors sit under the primary CTA, behind a hairline divider. State both
              outcomes so a returning host can sign in and a first-time host can register without
              either path hiding the other; both links keep the 44px floor. The design system lists
              account copy as banned *above the fold* in the header chrome — these are below the CTA,
              sized as 0.95rem answering copy, not navigation surface. */}
          <div className="hero__account">
            <p>Already have an account?{' '}
              <Link className="text-link" to="/host/login">Sign in to your events</Link>
            </p>
            <p>No account yet?{' '}
              <Link className="text-link" to="/host/register">Create one</Link>
              {' '}to find your events again. Creating an event never needs one.
            </p>
          </div>
        </div>
        <figure className="hero__image"><img src="/assets/candidary-hero.png" alt="Friends celebrating together at a candlelit outdoor table" /></figure>
      </section>
      <section className="workflow" id="how-it-works" aria-labelledby="workflow-title">
        <div><p className="section-label">A shared point of view</p><h2 id="workflow-title">One place. Every perspective.</h2></div>
        <ol>
          <li><span><Camera aria-hidden="true" /></span><div><strong>Create</strong><p>Set the date and make a private space for your event.</p></div></li>
          <li><span><Share2 aria-hidden="true" /></span><div><strong>Share</strong><p>Send one guest link or place the QR code where everyone can find it.</p></div></li>
          <li><span><Upload aria-hidden="true" /></span><div><strong>Gather</strong><p>Approve the moments you love, then keep them together.</p></div></li>
        </ol>
        <p className="privacy-note"><Check aria-hidden="true" /> Private by design. No guest accounts required.</p>
      </section>
    </main>
  </div>;
}

import { ArrowRight, Camera, Check, Share2, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../components/Brand';

export function LandingPage() {
  return <div className="public-shell">
    <PageHeader action={<Link className="text-link" to="/create">Create an event <ArrowRight aria-hidden="true" /></Link>} />
    <main>
      <section className="hero">
        <div className="hero__copy">
          <h1>Gather the moments <br />you didn’t see.</h1>
          <p>Create one private place for your guests to add photos, then choose what appears in the shared gallery.</p>
          <div className="button-row">
            <Link className="button button--primary" to="/create">Create your event <ArrowRight aria-hidden="true" /></Link>
            <a className="button button--quiet" href="#how-it-works">See how it works</a>
          </div>
          {/* Until now the account system could only be entered from a manager card or a typed URL,
              so a returning host had no way back to their events from here. It sits below the primary
              CTA rather than in the header, where a third exit cannot hold its 44px beside the brand
              at 320 — see the header exit matrix in `accessibility.spec.ts`. */}
          <p className="hero__account">Already have an account?{' '}
            <Link className="text-link" to="/host/login">Sign in to your events</Link>
          </p>
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

import { ArrowRight, Check, CheckCheck, LockKeyhole, ScanLine } from 'lucide-react';
import { useId, useState } from 'react';

import { LANDING_DEMO } from '../../shared/site-content';
import './LandingJourneyDemo.css';

type JourneyMoment = (typeof LANDING_DEMO.stages)[number]['id'];

const PHOTOGRAPHS = [
  '/assets/photos/sq-03.webp',
  '/assets/photos/sq-06.webp',
  '/assets/candidary-hero.png',
] as const;

/** A deliberately local illustration: changing a moment never submits an RSVP or a photograph. */
export function LandingJourneyDemo() {
  const [moment, setMoment] = useState<JourneyMoment>('before');
  const demoId = useId();
  const selectedStage = LANDING_DEMO.stages.find((stage) => stage.id === moment)!;

  return <div className="journey-demo" data-moment={moment} role="group" aria-labelledby={`${demoId}-title`}>
    <div className="journey-demo__toolbar">
      <p className="journey-demo__example"><ScanLine aria-hidden="true" />{LANDING_DEMO.label}</p>
      <div className="journey-demo__controls" role="group" aria-label={LANDING_DEMO.controlsLabel}>
        <span className="journey-demo__selection" aria-hidden="true" />
        {LANDING_DEMO.stages.map((stage) => <button
          key={stage.id}
          type="button"
          aria-pressed={moment === stage.id}
          aria-controls={`${demoId}-scene-${stage.id}`}
          onClick={() => setMoment(stage.id)}
        >{stage.label}</button>)}
      </div>
    </div>

    <div className="journey-demo__caption" aria-live="polite" aria-atomic="true">
      <h3 id={`${demoId}-title`}>{selectedStage.title}</h3>
      <p>{selectedStage.caption}</p>
    </div>

    <div className="journey-demo__table">
      <div className="journey-demo__invitation-wrap">
        <div className="journey-demo__invitation">
          <div className="journey-demo__invitation-copy">
            <p className="journey-demo__invite-label">{LANDING_DEMO.invitation.label}</p>
            <p className="journey-demo__names">{LANDING_DEMO.invitation.names}</p>
            <p className="journey-demo__occasion">{LANDING_DEMO.invitation.occasion}</p>
          </div>
          <img
            className="journey-demo__qr"
            src="/assets/candidary-journey-qr.svg"
            alt={LANDING_DEMO.invitation.qrAlt}
            width="144"
            height="144"
            loading="lazy"
            decoding="async"
          />
        </div>
        <p className="journey-demo__qr-caption">{LANDING_DEMO.invitation.qrCaption}</p>
      </div>

      <div className="journey-demo__bridge" aria-hidden="true">
        <ArrowRight className="journey-demo__guest-connection" />
        <LockKeyhole className="journey-demo__host-boundary" />
      </div>

      <div className="journey-demo__scenes">
        <div
          className="journey-demo__sheet journey-demo__sheet--before"
          id={`${demoId}-scene-before`}
          aria-hidden={moment !== 'before'}
          inert={moment !== 'before'}
        >
          <p className="journey-demo__role"><ScanLine aria-hidden="true" />{LANDING_DEMO.before.role}</p>
          <h4>{LANDING_DEMO.before.heading}</h4>
          <div className="journey-demo__household">
            <p>{LANDING_DEMO.before.household}</p>
            {LANDING_DEMO.before.names.map((name) => <div className="journey-demo__person" key={name}>
              <span>{name}</span>
              <span><Check aria-hidden="true" />{LANDING_DEMO.before.status}</span>
            </div>)}
          </div>
          <p className="journey-demo__receipt"><CheckCheck aria-hidden="true" />{LANDING_DEMO.before.receipt}</p>
        </div>

        <div
          className="journey-demo__sheet journey-demo__sheet--during"
          id={`${demoId}-scene-during`}
          aria-hidden={moment !== 'during'}
          inert={moment !== 'during'}
        >
          <p className="journey-demo__role"><ScanLine aria-hidden="true" />{LANDING_DEMO.during.role}</p>
          <h4>{LANDING_DEMO.during.heading}</h4>
          <div className="journey-demo__delivered-prints" aria-hidden="true">
            {PHOTOGRAPHS.slice(0, 2).map((src) => <span key={src}>
              <img src={src} alt="" width="512" height="512" loading="lazy" decoding="async" />
            </span>)}
          </div>
          <p className="journey-demo__delivery-status"><CheckCheck aria-hidden="true" />{LANDING_DEMO.during.status}</p>
          <p className="journey-demo__receipt">{LANDING_DEMO.during.receipt}</p>
        </div>

        <div
          className="journey-demo__sheet journey-demo__sheet--after"
          id={`${demoId}-scene-after`}
          aria-hidden={moment !== 'after'}
          inert={moment !== 'after'}
        >
          <p className="journey-demo__role"><LockKeyhole aria-hidden="true" />{LANDING_DEMO.after.role}</p>
          <h4>{LANDING_DEMO.after.heading}</h4>
          <div className="journey-demo__contact-sheet" aria-hidden="true">
            {PHOTOGRAPHS.map((src) => <img
              key={src}
              src={src}
              alt=""
              width="512"
              height="512"
              loading="lazy"
              decoding="async"
            />)}
          </div>
          <p className="journey-demo__private-status"><LockKeyhole aria-hidden="true" />{LANDING_DEMO.after.status}</p>
          <p className="journey-demo__receipt">{LANDING_DEMO.after.receipt}</p>
        </div>
      </div>
    </div>
    <p className="journey-demo__footnote">{LANDING_DEMO.footnote}</p>
  </div>;
}

import { MAX_EVENT_MEDIA } from './constants';

/**
 * The four public pages' copy, in the one place both representations read.
 *
 * Every URL in `sitemap.xml` now answers twice: as the rendered page, and as the
 * `text/markdown` body the Worker returns under content negotiation. Copy that
 * lived only in JSX would drift the moment one of the two changed, and an agent
 * quoting a sentence the site no longer says is worse than an agent parsing the
 * HTML itself. So the strings live here and the pages render them.
 *
 * This file moves copy; it does not author any. The design system's above-the-fold
 * allow-list still governs what a surface may say, and nothing event-bound belongs
 * here — no private surface has a markdown form.
 */

export interface SiteFaqEntry {
  readonly question: string;
  readonly answer: string;
}

export interface SiteJourneyStep {
  readonly title: string;
  readonly body: string;
}

export interface SiteLegalPage {
  readonly title: string;
  readonly lede: string;
  readonly facts: readonly string[];
}

export const SITE_NAME = 'Candidary';
export const SITE_ORIGIN = 'https://candidary.app';
export const SITE_BLURB =
  'One private QR for guest RSVP and original photo delivery at weddings and large events—no app or guest account.';

export const LANDING_HERO = {
  label: 'For weddings & private events',
  // Two halves rather than one sentence: the page breaks the line between them,
  // and a markdown heading joins them back with a space.
  headline: ['Gather the moments', 'you didn’t see.'],
  lede: 'One private QR takes guests from RSVP to photo delivery—no app or guest account. Every original reaches you privately; you choose what gets shared.',
} as const;

export const LANDING_WORKFLOW = {
  label: 'How Candidary works',
  title: 'One QR. Three moments.',
} as const;

/** An illustrative event, kept separate from real guest or host state. */
export const LANDING_DEMO = {
  label: 'Interactive example',
  controlsLabel: 'Explore an example event',
  stages: [
    { id: 'before', label: 'Before', title: 'The invitation.', caption: 'Guests scan the invitation and reply for their household.' },
    { id: 'during', label: 'During', title: 'The celebration.', caption: 'The same QR opens photo delivery when your event begins.' },
    { id: 'after', label: 'After', title: 'Yours to keep.', caption: 'Originals arrive privately. You choose what gets shared.' },
  ],
  invitation: {
    label: 'You’re invited',
    names: 'Maya & Theo',
    occasion: 'A day with our favourite people.',
    qrAlt: 'Example QR linking to this public demonstration',
    qrCaption: 'One printed QR for your guests.',
  },
  before: {
    role: 'Guest view · RSVP',
    heading: 'Your household RSVP',
    household: 'The Morgan household',
    names: ['Alex Morgan', 'Sam Morgan'],
    status: 'Attending',
    receipt: 'RSVP saved',
  },
  during: {
    role: 'Guest view · Photo delivery',
    heading: 'The moments you caught.',
    status: 'Delivered privately',
    receipt: 'Your originals are with Maya & Theo.',
  },
  after: {
    role: 'Host view · Private originals',
    heading: 'Every perspective, together.',
    status: 'Only you can see these originals',
    receipt: 'Sharing is your choice.',
  },
  footnote: 'Illustrative event. No responses or photos are sent.',
} as const;

export const LANDING_JOURNEY = [
  {
    title: 'Invite and RSVP',
    body: 'Add one private QR to the invitation. Guests find their household by the name on the invitation and reply without an account.',
  },
  {
    title: 'Scan again and send',
    body: 'At the event, the same QR opens photo delivery. Guests choose their original photos and send.',
  },
  {
    title: 'Keep every perspective',
    body: 'Everything arrives privately. Download the complete set, then publish only the photos you want guests to see.',
  },
  // A tuple, not an array: the landing page pairs each journey moment with an icon by
  // position, and a bare array would make every one of those reads possibly undefined.
] as const satisfies readonly SiteJourneyStep[];

export const LANDING_RETENTION_NOTE =
  'Guest access ends 30 days after your event. Files delete at 120.';

export const LANDING_FAQ = {
  label: 'Questions',
  title: 'The short answers.',
} as const;

/**
 * The short answers, drawn from real product limits rather than marketing copy: the upload ceiling,
 * the per-event ceiling, the ZIP part size, and the three retention dates the event page already
 * shows. Everything stated here has to stay true of the worker, so each answer names a number the
 * product enforces rather than a promise it does not.
 */
export const LANDING_QUESTIONS: readonly SiteFaqEntry[] = [
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
    answer: 'JPEG, PNG, WebP, HEIC and HEIF, up to 20 MiB per image. Open your event link for current photo choices and limits. One event holds up to 10,000 photos or 100 GiB.',
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

export const CREATE_INTRO = {
  label: 'Create your event',
  title: 'A private home for every point of view.',
  lede: 'Start with the essentials. You can adjust sharing, moderation, and gallery visibility from your event manager.',
  facts: [
    `Up to ${MAX_EVENT_MEDIA.toLocaleString()} original photos`,
    'Guest access without accounts',
    'Fixed, clear retention dates',
  ],
} as const;

export const PRIVACY_PAGE: SiteLegalPage = {
  title: 'Privacy',
  lede: 'What Candidary holds, who can see it, and how long it stays.',
  facts: [
    'Guests never create an account. A guest gives one name with their photos, and nothing else is asked of them.',
    'Every photo is delivered privately to the host first. Only what the host publishes appears in the shared gallery.',
    'Guest access ends 30 days after the event, the management link works for 90 days, and files are deleted at 120.',
    'Event links are the keys. An email address is attached to an event only when a host chooses to save it to an account.',
  ],
};

export const TERMS_PAGE: SiteLegalPage = {
  title: 'Terms',
  lede: 'What Candidary undertakes to do, and what an event may hold.',
  facts: [
    'One event holds up to 10,000 photos or 100 GiB, with a baseline limit of 20 MiB per image. Your event shows its current photo choices and limits.',
    'Accepted formats are JPEG, PNG, WebP, HEIC and HEIF. Originals are stored at full resolution and are not re-encoded.',
    'A prepared download is built as a ZIP in 2 GiB parts, with a manifest of everything received.',
    'A management link cannot be recovered once lost unless the event has been saved to an account.',
  ],
};

export const LEGAL_PENDING_NOTE =
  'The full document is being prepared. Until it is published, the points above are the commitments the product enforces today.';

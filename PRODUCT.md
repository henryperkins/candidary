# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Private-event hosts, especially couples and organizers, who need to invite guests, collect attendance, run a private event-day photo drop, and retrieve the complete set of originals without operating technical infrastructure.
- Invited guests and households using their own phones. They need to respond to an invitation and contribute photos quickly, privately, and without installing an app or creating an account.

## Product Purpose

Candidary gives a host one durable event entry point for the full guest lifecycle: invite, RSVP, arrive, contribute, and retrieve. Before the host's deadline, the printed QR opens a private household RSVP. When the event begins, the same QR opens private photo delivery. The host can then review, optionally publish, and export what guests contributed.

Success means a first-time host can prepare and run a real event through final export without bespoke operator help, while guests can understand and finish their current task on a phone without support. The core journey must preserve privacy, durable access, recoverable progress, exact delivery receipts, and evidence that the release works on real devices.

## Positioning

Candidary is a private guest-lifecycle product, not a general event-planning suite. Its defining mechanism is one permanent printed QR that moves with the event from exact-name household RSVP to event-day photo delivery while remaining private, account-free for guests, and server-authoritative.

The product deliberately does not expand into seating, catering, vendors, budgets, ticketing, payments, or a general planning dashboard. Event appearance is bounded the same way: it is not a page builder, a brand kit, or a photo-editing suite. New work should strengthen at least one link in the existing guest lifecycle rather than create an unrelated planning domain.

## Operating Context

- A host creates an event, adds a guest list by hand or CSV, sets the schedule, saves or prints the durable QR, and places that same code on invitations and venue signs.
- A household scans the code before the RSVP deadline, finds its invitation by entering a full name exactly as printed, and records attendance for each named guest and approved plus-one slot.
- At event time, a guest scans the same code, gives one required name, chooses the camera or recent photos, reviews the selection, explicitly sends it, and receives a terminal delivered receipt.
- RSVP and photo contribution are independent. A guest is not required to RSVP before contributing photos when photo intake is open.
- Hosts manage live intake, RSVP, optional gallery publication, notes, event sharing, appearance, access, and exports. Event links are valid credentials; an optional host account provides recovery if a management link is lost.
- Event appearance is edited in Manager Settings against one live canvas rather than a separate preview farther down the page. Choosing a cover is a short guided path — choose, compose for uploads only, style, done — so the host sees the result where the choice is made.
- The product is primarily used on mobile browsers in time-sensitive settings: at home with an invitation, at an event with intermittent attention or connectivity, and after the event while the host reconciles and exports originals.

## Capabilities and Constraints

- Guests do not have accounts. Hosts can create and manage an event without an account, then optionally attach it to a verified host account for recovery.
- RSVP is attendance-only and per person. It supports named invitees and bounded explicit plus-one slots; it does not collect meals, dietary requirements, accessibility questionnaires, or anonymous party-size responses.
- Exact-name lookup must never expose, suggest, or make the guest list searchable. Guest phase and RSVP availability come from server-authoritative event state rather than the browser clock.
- Private delivery is primary. Originals are visible to the host; an optional shared gallery contains only previews the host chooses to publish and is disabled by default.
- Accepted originals are JPEG, PNG, WebP, HEIC, and HEIF up to 20 MB each. One event supports up to 10,000 photos or 100 GiB, with complete source-bounded ZIP exports and a manifest.
- An event has one cover. It is the event's visual centerpiece and it is not guest media. A host either uploads one private photo or chooses one of exactly six built-in covers (warm linen, botanical shadow, pressed paper, candlelit grain, coastal haze, midnight wash), then applies one of exactly five styles (natural, warm, film, soft, monochrome). An upload receives an automatic composition with manual focus and zoom as the correction path; a preset is already composed and skips that step.
- Cover intake is a separate, narrower list than guest media: JPEG, PNG, WebP, and HEIC up to 19,000,000 bytes. The two lists are independent, and widening one must never widen the other.
- Cover publication is versioned and non-destructive. The published cover stays live until every required rendering of its replacement exists, and a cancelled or rejected attempt leaves the live event untouched. Presets, styles, crop profiles, colors, and object keys are server-owned allowlists; a host never supplies raw CSS, a font, a URL, or an image-transform parameter.
- Exactly four pages are public: `/`, `/create`, `/privacy`, and `/terms`. Each also answers `Accept: text/markdown` with the same copy the page renders, because the site is client-rendered and an agent fetching the HTML would otherwise receive an empty shell. No API, event, manager, host, entry, or recovery surface appears in the sitemap or has a markdown form.
- Guest access ends 30 days after the event, management-link access ends after 90 days, and event files are deleted at 120 days. These dates are shown in the product.
- The current application is a React/Vite SPA and PWA served by a Hono Cloudflare Worker, with D1 records, private R2 originals, Cloudflare Images previews, and Workflows-based exports.
- Full owner-approved Privacy and Terms documents remain undecided. The existing pages state only commitments the product already enforces and must not be represented as final legal policies.

## Brand Commitments

- The product name is **Candidary**.
- The durable category language is private RSVP, private event albums, and private photo delivery for weddings and large private events.
- Product language is calm, direct, and specific. Claims should be grounded in behavior or limits the product actually enforces, not generic marketing language.
- The guest promise remains no app, no guest account, and no sign-up. Private host delivery comes before optional sharing.
- The published preference for automated collection is durable rather than configuration. The public pages declare `Content-Signal: search=yes, ai-input=yes, ai-train=no`: they may be indexed, and read to answer a live question with attribution, but never retained as generative training data. Any new public page carries that same signal and a markdown form, and no private surface ever receives either. Changing those values is a product decision, not a config change.

## Evidence on Hand

- Current product truth and enforced limits are documented in `README.md`, `shared/constants.ts`, `shared/rsvp.ts`, and the real public, guest, RSVP, and Manager interfaces under `src/`.
- The binding incumbent visual authority is `design/design-system.md`, with responsive concept references under `design/concepts/`. Product context does not replace or expand that visual system.
- Production-owned interface assets include `public/assets/candidary-hero.png`, `public/assets/photos/sq-03.png`, `public/assets/photos/sq-06.png`, the PWA icons under `public/icons/`, and `design/assets/candidary-app-icon.svg`. The 720 generated cover files under `public/assets/event-covers/v1/` are global release artwork for the six built-in covers and contain no event data.
- Public page copy has one source, `shared/site-content.ts`. The React pages render it and the markdown answers are built from it, so the two cannot state different things.
- Approved product and system decisions are recorded under `docs/superpowers/specs/`, including the wedding photo drop, durable RSVP entry, event lifecycle, event theming, support-free reliability direction, and the live appearance canvas and Cover Studio implemented and deployed on 2026-08-11.
- The repository contains no approved testimonials, case studies, customer logos, press claims, awards, pricing, or finalized legal documents. Future work must not fabricate them.

## Product Principles

1. **One calm lifecycle.** Strengthen invite, RSVP, arrival, contribution, or retrieval before adding a new domain.
2. **Private delivery first.** A stored original reaches the host independently of gallery publication, social features, or an RSVP response.
3. **Finish the guest's job.** Keep phone flows fast, explicit, recoverable, and complete; a successful receipt ends the journey instead of creating another task.
4. **Truth comes from the system.** Server state, durable credentials, idempotent operations, and exact receipts outrank browser inference or optimistic copy.
5. **Prove reliability before expansion.** Automated checks, production-like rehearsal, physical devices, assistive technology, and complete export evidence remain distinct gates.

## Accessibility & Inclusion

Candidary targets WCAG 2.2 AA for its web and PWA surfaces. Core journeys must also be verified on a current physical iPhone with Safari, a current physical Android phone with Chrome, VoiceOver on iOS, and TalkBack on Android; browser emulation does not substitute for that evidence.

Interfaces must remain usable at narrow phone widths, preserve visible and programmatic labels, maintain 44-by-44-pixel touch targets, expose state through text rather than color alone, support keyboard and screen-reader focus movement, and respect reduced-motion preferences. Privacy-preserving exact-name lookup and generic refusal states must remain equally understandable without revealing who is invited.

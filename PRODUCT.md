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

The product deliberately does not expand into seating, catering, vendors, budgets, ticketing, payments, or a general planning dashboard. New work should strengthen at least one link in the existing guest lifecycle rather than create an unrelated planning domain.

## Operating Context

- A host creates an event, adds a guest list by hand or CSV, sets the schedule, saves or prints the durable QR, and places that same code on invitations and venue signs.
- A household scans the code before the RSVP deadline, finds its invitation by entering a full name exactly as printed, and records attendance for each named guest and approved plus-one slot.
- At event time, a guest scans the same code, gives one required name, chooses the camera or recent photos, reviews the selection, explicitly sends it, and receives a terminal delivered receipt.
- RSVP and photo contribution are independent. A guest is not required to RSVP before contributing photos when photo intake is open.
- Hosts manage live intake, RSVP, optional gallery publication, notes, event sharing, appearance, access, and exports. Event links are valid credentials; an optional host account provides recovery if a management link is lost.
- The product is primarily used on mobile browsers in time-sensitive settings: at home with an invitation, at an event with intermittent attention or connectivity, and after the event while the host reconciles and exports originals.

## Capabilities and Constraints

- Guests do not have accounts. Hosts can create and manage an event without an account, then optionally attach it to a verified host account for recovery.
- RSVP is attendance-only and per person. It supports named invitees and bounded explicit plus-one slots; it does not collect meals, dietary requirements, accessibility questionnaires, or anonymous party-size responses.
- Exact-name lookup must never expose, suggest, or make the guest list searchable. Guest phase and RSVP availability come from server-authoritative event state rather than the browser clock.
- Private delivery is primary. Originals are visible to the host; an optional shared gallery contains only previews the host chooses to publish and is disabled by default.
- Accepted originals are JPEG, PNG, WebP, HEIC, and HEIF up to 20 MB each. One event supports up to 10,000 photos or 100 GiB, with complete source-bounded ZIP exports and a manifest.
- Guest access ends 30 days after the event, management-link access ends after 90 days, and event files are deleted at 120 days. These dates are shown in the product.
- The current application is a React/Vite SPA and PWA served by a Hono Cloudflare Worker, with D1 records, private R2 originals, Cloudflare Images previews, and Workflows-based exports.
- Full owner-approved Privacy and Terms documents remain undecided. The existing pages state only commitments the product already enforces and must not be represented as final legal policies.

## Brand Commitments

- The product name is **Candidary**.
- The durable category language is private RSVP, private event albums, and private photo delivery for weddings and large private events.
- Product language is calm, direct, and specific. Claims should be grounded in behavior or limits the product actually enforces, not generic marketing language.
- The guest promise remains no app, no guest account, and no sign-up. Private host delivery comes before optional sharing.

## Evidence on Hand

- Current product truth and enforced limits are documented in `README.md`, `shared/constants.ts`, `shared/rsvp.ts`, and the real public, guest, RSVP, and Manager interfaces under `src/`.
- The binding incumbent visual authority is `design/design-system.md`, with responsive concept references under `design/concepts/`. Product context does not replace or expand that visual system.
- Production-owned interface assets include `public/assets/candidary-hero.png`, `public/assets/photos/sq-03.png`, `public/assets/photos/sq-06.png`, the PWA icons under `public/icons/`, and `design/assets/candidary-app-icon.svg`.
- Approved product and system decisions are recorded under `docs/superpowers/specs/`, including the wedding photo drop, durable RSVP entry, event lifecycle, event theming, and support-free reliability direction.
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

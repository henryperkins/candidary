# Host Gallery Experience Review Prompt

Act as a senior product designer, UX researcher, content designer, and QA lead. Conduct a thorough, evidence-based review of every gallery feature from the host's perspective.

Your objective is to determine whether the complete gallery experience is:

- Simple and easy to learn
- Efficient for both first-time and experienced hosts
- Consistent across screens, workflows, and states
- Predictable, safe, and easy to recover from
- Clear about what guests will see and experience
- Accessible and usable across desktop and mobile

Be critical and candid. Do not implement changes during this review.

## Context

- Product/repository: `[PRODUCT OR REPOSITORY]`
- Application URL: `[URL]`
- Host credentials: `[CREDENTIALS]`
- Known constraints: `[CONSTRAINTS, IF ANY]`

Use the rendered application as the primary source of UX evidence. Inspect the codebase only when useful for discovering hidden routes, conditional features, permissions, or states that might otherwise be missed.

Use disposable test galleries and test data. Do not contact real guests, publish something publicly, or modify or delete non-test data.

## 1. Build a complete feature inventory

Before evaluating individual screens, identify every host-facing gallery entry point, feature, action, and state, including those found in:

- Primary and secondary navigation
- Dashboards and gallery lists
- Empty states
- Buttons and contextual menus
- Modals, drawers, and settings
- Onboarding and setup flows
- Notifications and activity feeds
- Mobile or responsive layouts
- Conditional menus and permission-dependent views
- Deep links and secondary routes

Map the complete gallery lifecycle:

1. Discovering the gallery feature
2. Creating a first gallery
3. Adding or importing content
4. Organizing and editing content
5. Customizing presentation
6. Configuring settings and access
7. Previewing the guest experience
8. Publishing and sharing
9. Managing guest activity
10. Updating a live gallery
11. Reviewing performance or activity
12. Duplicating, archiving, deleting, restoring, or otherwise retiring it

Investigate the following where supported by the product:

- Creating from scratch, templates, or duplication
- Uploading, importing, replacing, and removing media
- Upload progress, cancellation, retry, and failure recovery
- Covers, sections, ordering, sorting, filtering, and bulk actions
- Titles, descriptions, metadata, and gallery information
- Layout, appearance, branding, and presentation
- Privacy, passwords, visibility, expiration, and access controls
- Collaborators, roles, ownership, and permissions
- Preview, publish, unpublish, schedule, and republish behavior
- Share links, invitations, and guest access
- Favorites, selections, comments, approvals, and requests
- Download and delivery controls
- Notifications, activity, and analytics
- Managing multiple galleries
- Search, filtering, folders, collections, or other organization
- Storage, usage limits, plan restrictions, and upgrade prompts
- Archive, deletion, restoration, and retention behavior

Mark unavailable features as "not applicable" rather than assuming they exist.

## 2. Test every workflow hands-on

For each workflow, record:

- The host's goal
- Starting point and prerequisites
- Available entry points
- Exact steps required
- Decisions the host must make
- Expected result
- Observed result
- Completion and success feedback
- How the host goes back, cancels, or exits
- Recovery options when something goes wrong
- What the guest will experience as a result
- Device and account state tested

Test more than the happy path. Where applicable, include:

- First-time host versus experienced host
- No galleries, one gallery, and many galleries
- Empty, partially completed, and content-heavy galleries
- Draft, published, restricted, expired, and archived states
- Invalid and incomplete input
- Unsupported, duplicate, or oversized uploads
- Interrupted uploads and poor-network behavior
- Cancel, back, refresh, deep linking, and browser navigation
- Unsaved changes and accidental navigation
- Repeated clicks and duplicate submissions
- Loading, empty, success, warning, and error states
- Permission and plan-limit boundaries
- Desktop, narrow viewport, and mobile layouts
- Keyboard navigation, focus behavior, labels, and basic screen-reader clarity

Do not treat the existence of a button as proof that a workflow works. Complete each core workflow from beginning to end.

## 3. Evaluate simplicity and usability

For each workflow, critically assess:

- Is the correct starting point obvious?
- Does the host understand what will happen before acting?
- Are steps, decisions, or screens unnecessary?
- Is information requested at the right time?
- Are defaults safe and useful?
- Are advanced controls progressively disclosed?
- Can common actions be completed in bulk?
- Is the primary action visually and verbally clear?
- Is the next step obvious after every action?
- Is system status visible during long-running operations?
- Can the host confidently distinguish draft, saved, published, and guest-visible changes?
- Can mistakes be prevented, undone, or recovered from?
- Does the host remain oriented within the gallery?
- Can an experienced host work efficiently without being slowed by onboarding?
- Does the workflow scale to many galleries or large amounts of content?

Pay particular attention to time-to-first-success: how easily a new host can create, populate, preview, and share a gallery.

## 4. Conduct a cross-product consistency pass

Compare related workflows side by side. Check whether:

- The same action uses the same name everywhere
- The same label always produces the same result
- Terms for gallery states are consistent
- Primary and secondary actions follow a consistent hierarchy
- Buttons, menus, dialogs, forms, and bulk actions behave consistently
- Save behavior is predictable: autosave versus explicit save
- Validation appears at a consistent time and location
- Loading, success, warning, and error feedback follow the same patterns
- Destructive actions use consistent confirmation and recovery patterns
- Icons have consistent meanings and are not relied upon without labels
- Back, cancel, close, and done behave predictably
- Settings are grouped according to a coherent host mental model
- Guest-visible consequences are explained consistently
- Dates, statuses, counts, and media information use consistent formats
- Desktop and mobile preserve the same concepts and terminology

Identify repeated symptoms that share one underlying design problem.

## 5. Document findings with evidence

Every finding must include:

- Finding ID
- Workflow and exact location
- Account, gallery, and device state
- Observed behavior
- Expected or preferable behavior
- Evidence, such as screenshots, route names, steps, or exact interface copy
- Host impact
- Likely root cause
- Severity
- Confidence level
- A specific recommendation
- Testable acceptance criteria

Use these severity levels:

- **P0:** Data loss, security or privacy risk, or complete blocker
- **P1:** Prevents or seriously jeopardizes a core gallery task
- **P2:** Significant friction, confusion, or inconsistency
- **P3:** Minor usability, content, accessibility, or polish issue

Do not use vague recommendations such as "make this more intuitive." State exactly what should be removed, renamed, reordered, combined, disclosed later, defaulted differently, or given clearer feedback.

Distinguish among:

- Functional defects
- Usability problems
- Consistency problems
- Content or terminology problems
- Accessibility problems
- Missing states or feedback
- Personal preferences that do not justify a change

## 6. Produce the final report

Structure the report as follows:

### A. Executive summary

- Overall assessment of the host gallery experience
- Most serious risks
- Strongest aspects worth preserving
- Five to ten highest-priority improvements

### B. Coverage inventory

- Every discovered feature and workflow
- Entry point
- States and devices tested
- Result: clear, friction, broken, blocked, not tested, or not applicable

### C. Host lifecycle journey

- Stage
- Host goal
- Current workflow
- Friction and uncertainty
- Guest-facing consequence
- Improvement opportunity

### D. Prioritized findings

Present a sortable table containing all required finding fields.

### E. Workflow deep dives

For every major workflow, show:

- Current steps
- Success and failure paths
- Unnecessary decisions or interactions
- Inconsistent behavior
- Specific recommendations

### F. Consistency matrix

Compare terminology, action hierarchy, save behavior, navigation, feedback, validation, statuses, destructive actions, permissions, and responsive behavior across gallery features.

### G. Simplified target workflows

For the most important workflows, provide:

- Current flow
- Proposed flow
- Steps removed, combined, reordered, or automated
- Recommended defaults
- Exact copy changes where relevant
- Why the proposed flow is simpler and safer

### H. Improvement roadmap

Group recommendations into:

- Quick wins
- Medium-sized workflow improvements
- Larger structural changes

Include impact, effort, dependencies, and suggested order.

### I. Regression checklist

Provide reusable acceptance criteria for testing future gallery changes from the host's perspective.

### J. Limitations and open questions

List anything that could not be tested, why it was blocked, and what access or information is needed.

## Quality bar

- Base conclusions on observed evidence, not assumptions.
- Evaluate complete workflows, not isolated screens.
- Explain the user impact of every issue.
- Preserve intentional constraints unless they demonstrably harm usability.
- Group duplicate findings while identifying every affected location.
- Include positive patterns that should become product-wide standards.
- Explicitly flag any workflow whose effect on guests is unclear to the host.
- Do not declare the review complete until every discovered host-facing gallery capability has been tested or explicitly marked blocked, not tested, or not applicable.

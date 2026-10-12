---
target: "Mobile Gallery Library screenshots: Exports collapsed and expanded"
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
target_identity: "file:/home/ubuntu/candidary/src/features/gallery/ManagerPrivateGallery.tsx"
target_fingerprint: "sha256:7253a01ba0284e92cb1aa0b595ef87f2a5775d5d6747eb0c6f9cd5bf4ecbebd7"
target_path: /home/ubuntu/candidary/src/features/gallery/ManagerPrivateGallery.tsx
timestamp: 2026-10-12T02-02-23Z
slug: src-features-gallery-managerprivategallery-tsx
closed: true
---
Method: dual-agent (A: /root/critique_design · B: /root/critique_evidence)

Candidary’s visual identity works. The expanded Exports panel is the main UX problem: it covers browsing controls while leaving them keyboard reachable. Warm paper, Chestnut actions, Denim navigation and Moss completion feel authored for Candidary’s private-event workflow.

**Design health: 25/40 — Acceptable**, scoped to the two shown mobile states.

| Heuristic | Score | Main observation |
|---|---:|---|
| System status | 3 | Counts and album state are clear; export availability is ambiguous. |
| Familiar language | 2 | Download versus Save / Share needs destination and scope. |
| User control | 2 | The export overlay lacks predictable dismissal and hides focus. |
| Consistency | 3 | Cohesive visual system; ambiguous disclosure behavior. |
| Error prevention | 3 | Source provides mutation locks and Trash confirmation. |
| Recognition | 2 | Selection icon and album-removal action require guessing. |
| Efficiency | 3 | Search, sort, filters and bulk selection are available. |
| Minimalism | 3 | Restrained photo wall; expanded controls interrupt it. |
| Error recovery | 2 | Pause copy promises recovery without visible recovery controls. |
| Contextual help | 2 | Privacy explanation helps; export distinctions need guidance. |
| **Total** | **25/40** | **Acceptable** |

**What works:** The two-column grid, contributor names and immediate album controls support repeated curation. The check, text and green completion treatment communicate album membership together. Counted modes and the private-originals explanation help hosts understand the collection.

**Priority issues**

1. **P1 — Exports covers active browsing controls.** In Photo 2, the panel covers modes, privacy guidance, search and filters. A local WebKit check moved focus from Download all to the covered Library tab; Escape left the panel open. Chromium also confirmed outside clicks leave it open. The absolute positioning is in [library-photo-wall.css](/home/ubuntu/candidary/src/features/gallery/library-photo-wall.css:27). **Fix:** use an inline disclosure on phones, or a focused export sheet with visible Close, predictable dismissal and appropriate focus handling. Covered controls must not receive invisible focus. **Commands:** `/impeccable adapt`, `/impeccable harden`.

2. **P2 — The paused message does not explain what remains available.** Download all is enabled beside disabled Save / Share photos, while the message refers to an existing export without showing Resume or Cancel. Source renders this existing-export claim even when no job exists in [PhotoExportChooser.tsx](/home/ubuntu/candidary/src/features/gallery/PhotoExportChooser.tsx:52). **Fix:** distinguish the ZIP download from device saving/sharing, name exactly which method is paused, and show existing-job guidance only when a job exists. **Command:** `/impeccable clarify`.

3. **P2 — Bulk selection has no visible label.** The dashed-square/mouse-pointer icon requires interpretation on a phone, despite its correct accessible name in [ManagerPrivateGallery.tsx](/home/ubuntu/candidary/src/features/gallery/ManagerPrivateGallery.tsx:1287). **Fix:** show Select beside a simpler selection icon and Done while selecting; retain the 44px target. **Command:** `/impeccable clarify`.

4. **P2 — In album looks passive but removes membership when tapped.** The removal action is explicit only in the accessible name in [GalleryMoment.tsx](/home/ubuntu/candidary/src/features/gallery/GalleryMoment.tsx:74). **Fix:** expose Remove as an explicit secondary action while retaining confirmed membership and Undo. **Command:** `/impeccable clarify`.

**Cognitive load:** Moderate in the expanded state: it interrupts the browsing focus and hides useful context. Individual choice groups remain manageable, with no group exceeding four options. **Emotional journey:** browsing feels calm and reassuring; opening Exports introduces hesitation at the point the host tries to retrieve photos.

**Persona red flags:** Jordan must guess the selection icon and export destinations. Sam can reach a covered tab with the keyboard. Casey can mistake In album for a passive completion badge.

**Minor observations:** The first photo begins around y=460 in the local 390×844 viewport. Tighten upper controls where practical, preserving the deliberately reserved 44px arrival-notice space that prevents incoming photos from shifting the wall. Search supports contributor, caption and filename, but that hint is only available to screen readers.

**Evidence:** Both supplied iPhone screenshots, source inspection, and independent local mocked WebKit/Chromium pages. Ran `impeccable detect --json src/features/gallery` once: exit 0 with 10 advisories. Eight `design-system-font-size` records occur in album-organizer.css:4,5 and library-photo-wall.css:17,18,121,136,163,187. One `design-system-color` record is in guest-gallery.css:45, and one `design-system-radius` record in guest-gallery.css:60. These are mainly local typography/documentation mismatches and Guest gallery styling outside the screenshot scope. The calculated-radius subtraction operand is a false positive. Browser detection found one `cream-palette` warning collapsed, and that warning plus four `text-occlusion` records expanded at 390 and 320px. Preserve the approved warm-paper palette; the four occlusion records describe the single panel-overlap problem above. No persistent user-visible overlay tab was presented. Touch targets met the 44px floor and no horizontal overflow appeared at 390 or 320px. Physical Safari, VoiceOver, production downloads and native sharing were not verified. No application code changed; no repository-wide gates ran. Temporary browsers and servers were stopped.

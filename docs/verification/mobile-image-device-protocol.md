# Mobile image physical-device protocol

Status: **prepared, not executed.** No iPhone or Android phone has been used for this
lane. This protocol, `scripts/record-mobile-device-evidence.mjs` and its unit tests
contain no device result, and nothing here may be read as one. Every iOS Safari and
Android Chrome column in [the compatibility report](mobile-image-compatibility.md)
stays `missing` until a run under this protocol produces reviewed evidence.

## 1. What a run proves

For one required case and one pinned fixture, a run shows that iOS Safari or Android
Chrome on a named physical phone delivered the exact original to an authorized
Candidary preview. The same bytes must then survive delivery, private preview, Trash
and Restore, direct original download and the frozen ZIP after intake closes. Device
handoff must also preserve them, while privacy and deletion barriers hold.

A run covers one device model, one OS build, one browser version, one set of camera
settings and one deployment identity. An OS or browser update starts a new run. A run
does not prove native decoding (the local lane), deployed load, or other devices.

Only hardware held by the operator counts. Simulators, emulators, desktop WebKit or
Chromium, responsive device modes and API stubs never count. Every value in the
evidence is observed during the run; a behavior not observed is `missing`.

## 2. Prerequisites (external; none exist yet)

1. **Authorization.** Written release authorization for the preview deployment, the
   dedicated test event and its data. Changing the preview's per-case D1 admission
   switch needs its own explicit authorization.
2. **Deployment identity.** Record the bare https preview origin and the deployed main
   Worker version ID. Also record the private preview decoder's build fingerprint and
   registry reference `<registry image>@sha256:<digest>`. These must be the exact values
   in the release evidence for that build.
3. **Event.** Use a dedicated test event on that preview. Every case under test must
   be admitted there. Read `GET /api/event/<slug>/uploads/capabilities` as the guest and
   the page's `accept` attribute (section 6); a case the page does not offer cannot pass.
4. **Sessions.** The Manager uses the release workstation (host account or management
   link). Guest A is the owner on the test phone. Guest B, the other guest, uses a
   second browser profile or phone. The signed-out check uses a private window with no
   cookies. The Manager must also be signed in on the phone for device handoff.
5. **Tools.** For iOS, use a Mac with Safari's Develop menu and enable **Web Inspector**
   on the iPhone under Safari's Advanced settings. For Android, enable Developer options
   and USB debugging, then use desktop Chrome's `chrome://inspect/#devices`. Without an
   inspector the selected File cannot be observed, so no result can pass.
6. **Corpus.** Keep the pinned originals in `tests/fixtures/mobile-images/originals/`. A
   camera capture becomes a fixture only as a consented capture (section 10).
7. **Privacy.** Only the release owner or a delegate captures. Photograph non-personal
   scenes: no faces, documents, screens or recognizable places. Turn Camera location
   access off before capturing. Forms name roles, never people.

## 3. Evidence storage (ignored storage only)

Photos, device pulls, downloads, forms and raw notes never enter Git. Before copying
anything, confirm each directory is ignored with `git check-ignore -v <path>`.

```text
tests/fixtures/mobile-images/                 fixture root (originals/, references/, evidence/ are ignored)
  originals/consented/<run-id>-<fixtureId>.<ext>   consented captures promoted to fixtures
  evidence/<sha256>.json                           recorder output; the manifest pointer target
output/verification/mobile-device/<run-id>/   one run (output/ is ignored); <run-id> = YYYYMMDD-<ios|android>-<n>
  form.json                                    observation form (section 9)
  selection/<fixtureId>.json                   in-browser selection observations (section 6)
  selection/route-<caseId>-<n>.json            selections from route attempts
  device/<fixtureId>.<ext>                     originals pulled from the phone (paired movie: <fixtureId>.mov)
  download/<fixtureId>.<ext>                   direct original downloads after intake closed
  download/restored-<fixtureId>.<ext>          downloads after Trash and Restore
  download/paired-<fixtureId>.mov              a retained paired movie, if Candidary ever keeps one
  export/<zip part name>.zip                   frozen ZIP part(s)
  handoff/<fixtureId>.<ext>                    files saved from the device share sheet and pulled back
  notes/                                       optional settings screenshots (no account names, no people)
```

Never store management links, `/join` URLs or fragments, cookies, CSRF headers or
copied requests anywhere in a run directory.

## 4. Device and settings record

Record these once per run, reading each value from the device.

| Field | iOS Safari | Android Chrome |
| --- | --- | --- |
| `device.model` | Settings > General > About: model name **and** model number | Settings > About phone: model name and number |
| `device.osVersion` | iOS version and build (About) | Android version, security patch, build number |
| `device.browserName` / `browserVersion` | `Safari` / Safari version (the in-page `navigator.userAgent` is also recorded) | `Chrome` / chrome://version |
| Transfer setting | Photos > Transfer to Mac or PC: must be **Keep Originals** while pulling | n/a (pull with `adb pull` or a byte-exact USB copy) |

For a camera route (`path: camera`), `settings` must contain the keys below. Record
the exact label shown, including "not offered on this model". Labels vary by model and
OS version, so copy them rather than normalizing them.

- **iOS:** `cameraFormats` (Camera > Formats: High Efficiency / Most Compatible), `proRaw`
  (the ProRAW or "ProRAW & Resolution Control" toggle, Pro Default, and any ProRAW
  format choice such as "JPEG Lossless (Most Compatible)", "JPEG-XL Lossless" or
  "JPEG-XL Lossy"), `livePhoto` (on, off or not offered, as set in the Camera app),
  and `hdr` (every HDR-related label under Camera and Photos).
- **Android:** `cameraApp` (name and version), `ultraHdr`, `motionPhoto` (Motion Photo /
  Top Shot / Motion), `raw` (for example Pixel "RAW + JPEG", Samsung Pro mode RAW or
  Expert RAW), and `heif` (for example Samsung "High efficiency pictures").

For a library route, `settings.originTransfer` records how the original reached the
phone: AirDrop with Options > All Photos Data, a Files copy, `adb push`, a Camera app
capture on this phone, or a device screenshot. Add the capture settings above when the
original was captured on this phone.

## 5. Required-case routes

A case is classified from the file's encoded contents: local native inspection and the
fixture's `encoded` expectations. A setting label or extension never decides it. An
iPhone High Efficiency capture may be tiled (`heic-grid`) or carry auxiliary images
(`heic-auxiliary`), so classify it before assigning a case.

Route codes, all candidates until observed:

- **P**, page camera: Candidary's "Take a photo" control (`capture="environment"`,
  recorded as `path: camera`). What the browser delivers must be observed. It is often
  not what the Camera app would save.
- **C**, Camera-app capture with the listed setting, then "Choose recent photos" (recorded as
  `path: library`). The capture is a consented fixture.
- **L**, the pinned corpus original placed in Photos / Gallery, then "Choose recent photos".
- **F**, the pinned corpus original placed in Files / Downloads, then chosen through
  the picker's Files option.
- **—**: no capture route is expected. Record a route observation only if the device
  unexpectedly offers one.

A library import can itself change bytes. If the pulled library copy differs from the
fixture, record that and use **F** for the fixture instead.

| Case | iOS Safari | Android Chrome |
| --- | --- | --- |
| jpeg-baseline | P and C (Formats: Most Compatible); L | P and C (default camera JPEG); L |
| jpeg-progressive | — ; L/F | — ; L/F |
| jpeg-exif-orientation | P and C with the phone rotated; counts only if the delivered EXIF Orientation ≠ 1; L | P and C rotated (some apps rotate pixels and write Orientation 1, which is jpeg-baseline); L |
| jpeg-hdr | C with Most Compatible and HDR capture on (MPF gain map decides); L | — ; L/F |
| jpeg-ultra-hdr-gainmap | — ; L/F (Android-produced original) | C with Ultra HDR on; P (observe whether the gain map survives page capture); L |
| jpeg-motion-photo-still | — ; F (Files keeps the appended video) | C with Motion Photo / Top Shot on; P (observe); L via `adb push` |
| png | Device screenshot selected from Photos (`originTransfer: device screenshot`); L | Device screenshot; L |
| apng | — ; L/F | — ; L/F |
| webp-lossy | — ; L/F | — ; L/F |
| webp-lossless | — ; L/F | — ; L/F |
| webp-animated | — ; L/F | — ; L/F |
| heic-primary | P and C (Formats: High Efficiency; contents decide primary vs grid); L | C where the camera offers HEIF; L |
| heic-grid | P and C as heic-primary (tiled HEIC); L | C where offered; L |
| heic-auxiliary | C in Portrait mode (depth) or HDR with High Efficiency; L | C (HEIF with depth/portrait, if offered); L |
| heic-sequence | — ; L/F | — ; L/F |
| heif-generic | — ; L/F | — (a device HEIF with a generic brand is classified by contents); L/F |
| dng-bayer | — ; F | C with RAW (for example Pixel RAW + JPEG, Samsung Pro mode RAW); F |
| dng-linear | C with ProRAW only if contents classify as linear; F | C with Samsung Expert RAW; F |
| dng-proraw | C with Apple ProRAW on (models that offer it); F | — ; F |
| dng-jpeg | C with ProRAW format "JPEG Lossless (Most Compatible)" if offered (DNG compression decides); F | — ; F |
| dng-proraw-jxl | C with ProRAW format "JPEG-XL Lossless" or "JPEG-XL Lossy" if the model and OS offer it (DNG must be JXL-compressed); F | — ; F |
| avif-still | — ; L/F | C only if a setting observably produces AVIF; L/F |
| avif-sequence | — ; L/F | — ; L/F |
| gif-still | — ; L/F | — ; L/F |
| gif-animated | — ; L/F | — ; L/F |
| tiff | — ; F | — ; F |
| bmp | — ; F | — ; F |
| jp2 | — ; F | — ; F |
| jxl-still | — ; L/F | — ; L/F |
| jxl-animated | — ; L/F | — ; L/F |
| live-photo-camera | C with Live Photo on, then "Choose recent photos" (pull the still **and** movie). Also try P with Live on and record whether page capture produces a Live Photo at all | No Live Photo capture is expected. Record the camera's settings, and record `unavailable` (observed) only if none produces a paired still and movie. Motion Photo is jpeg-motion-photo-still |
| live-photo-library | L: an existing consented Live Photo, AirDropped with All Photos Data so the pair stays together | F: the iPhone still and movie copied to Files, both selected |

**Platform-limited is observed, never presumed.** The recorder accepts it for a
fixture only in two computed situations:

1. `chooser-conversion`: the pulled device original equals the fixture, the page's
   `accept` attribute offered its type, and the File the browser delivered differs.
2. `paired-resource-not-delivered`: the paired movie was pulled from the phone, and
   the picker's File list does not contain it.

When a camera route is simply unavailable, record it in `routes` as a route
observation, not a fixture result. It needs `observed: true`, the settings checked and
what was delivered instead. A model without the hardware or setting (for example
ProRAW on a non-Pro iPhone) is a model limitation for that route, not a platform one.
Keep the case open until a model that offers it has been tested.

These outcomes are never platform-limited:

- Candidary's `accept` list excluded the type.
- Candidary refused or altered a delivered File, or failed on privacy, deletion,
  export or receipts. That is `fail`.
- A step was not run. That is `missing`.

## 6. Selection observer

Observe the File before Candidary receives it. In the page's inspector console, run
this before tapping a photo control. It copies the chosen Files in the capture phase,
before the page clears the input, and hashes them in the browser.

```js
(() => {
  const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const files = Array.from(input.files ?? []);
    const source = input.dataset.photoSource ?? 'unknown';
    const accept = input.accept;
    Promise.all(files.map(async (file) => ({
      name: file.name, type: file.type, size: file.size, lastModified: file.lastModified,
      sha256: hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
    }))).then((entries) => console.log(JSON.stringify({
      kind: 'candidary.selection-observation', version: 1, source, accept,
      capturedAt: new Date().toISOString(), userAgent: navigator.userAgent, files: entries,
    })));
  }, true);
})();
```

Save the logged line as `selection/<fixtureId>.json`. Its `source` must be `camera` or
`library`, matching the control used. The recorder accepts the browser-computed hash
only when it equals the SHA-256 of the downloaded original, which the recorder computes
itself. It compares that hash with the pulled device original to decide whether the
chooser converted the file.

If a picker shows size or format options (for example "Actual Size" or "Most
Compatible"), record the default and every option shown in `chooser.notes`. Then choose
the option that keeps the original. Hashing a very large original can exhaust the tab;
a run whose selection cannot be hashed cannot pass that fixture.

## 7. Per-fixture procedure

Follow this order. Deletion comes last because it destroys what the earlier steps read.

1. **Settings and offer.** Record the settings (section 4). In the console, read the
   control's `accept` value. Confirm the case's extension or MIME type is offered.
2. **Chooser and conversion.** Install the observer and select through the planned
   route. Record the surface actually shown (Photos picker, Recents, Files, system
   camera, Android photo picker) in `chooser.surface`. For a Live Photo, record every
   File the picker delivers.
3. **Upload and receipt.** In the network panel, note the transport:
   `PUT .../uploads/<id>/content` is `direct`; `.../transfers/<id>/parts/<n>` is
   `resumable`. Watch for the confirming state. The delivered receipt must appear only
   after the server reports the photo delivered/stored; an earlier receipt is a failure.
4. **Private preview.** The owner (Guest A, My deliveries) and the Manager (Library)
   must see it. Copy the preview request URL from the network panel. It must be denied
   for Guest B's session, which also must not see the photo in any gallery, and for the
   signed-out window. Record the status codes. Check that the preview renders correctly:
   orientation applied exactly once, HDR/color plausible against the device original,
   and every animation frame and its timing present. Do not publish the photo.
5. **Pull the device original.** On iOS, use Keep Originals with Image Capture or
   Finder, or AirDrop with All Photos Data. On Android, use `adb pull` from the exact
   DCIM or Download path. For a page-camera capture that the platform did not save
   anywhere, record `chooser.deviceOriginal: not-saved-by-platform` after checking.
6. **Close intake.** In the Manager, choose "Pause guest uploads". If authorized, also
   close the case's preview admission switch and say so in `run.export.observation`.
7. **Direct original.** On the workstation, open the photo in the Manager and use
   "Download original". Save it as `download/<fixtureId>.<ext>`.
8. **Frozen ZIP.** Use "Prepare photo ZIP", then "Confirm photo ZIP", then "Get ZIP
   download links". Save every part, and record the member's name for each fixture.
9. **Device handoff.** On the phone, as Manager, use "Save / Share photos", then "Prepare
   for this device", then "Share N photos". This is the File-based `navigator.canShare`
   / `navigator.share` path.
   Choose "Save to Files" (iOS) or a Files/Downloads target (Android), then pull the
   saved copy back. Originals over the 40 MiB device batch, a `canShare` refusal or a
   share failure must lead to "Use ZIP instead". Record `outcome: fallback-zip`; the
   ZIP member already carries the byte check. A fallback is a limited handoff, not a
   case failure. A share that saves altered bytes is a failure.
10. **Trash and Restore.** In the Manager, move the photo to Trash. Record that guests,
    the Guest gallery and Album share no longer show it, that its preview is denied to
    guests, and that Recently deleted lists it with a restore deadline. Restore it and
    download the original again as `download/restored-<fixtureId>.<ext>`.
11. **Permanent deletion.** Guest A deletes the photo from My deliveries (a guest's own
    deletion is permanent). Record that the Manager's Library and Recently deleted no
    longer list it, and that its original and preview requests fail. If guest deletion
    is unavailable while intake is paused, record that, resume guest uploads, then
    delete.

**Transport resilience and late writes** are recorded once per run for each transport
used (`transportChecks`). Use a resumable fixture larger than 20 MiB and one direct
fixture. Throttle with the Chrome inspector or iOS's Network Link Conditioner if
transfers are too fast to interrupt.

- `background`: switch to another app for at least 60 seconds mid-transfer.
- `offline`: turn on Airplane Mode for at least 30 seconds mid-transfer.
- `reload`: reload mid-transfer, then reselect the same original when prompted
  ("Choose the same originals to resume").
- `retry`: stay offline until the item needs attention, reconnect, then tap Retry.

The outcome is `resumed` when accepted parts are kept, or `restarted` when a direct
transfer sends everything again. `deliveredOnce` is true only if exactly one delivered
photo exists afterwards.

- `lateWrite`: cancel or delete a photo mid-transfer, then replay its next part PUT or
  its complete/finalize POST in the page console with the inspector's "Copy as fetch".
  Expect a 4xx and no revived photo. Record only the status code; never save the
  copied request.

**Motion Photo.** Pull the file byte-exactly. The recorder requires an appended video
(`ftyp` box) in the delivered original at the same offset as in the device original.
**Live Photo.** Pull the still and its movie. The recorder calls the pair `retained`
only when the picker delivered the movie and a downloaded copy matches it. Candidary
currently admits no video, so expect `not-delivered-by-picker` (platform-limited when
observed) or `refused-by-app` (`fail`).

## 8. Status rules

| Status | When |
| --- | --- |
| `pass` | These hashes are all equal: fixture, pulled device original (library), selected File, direct download, ZIP member, restored download and handoff copy (when shared). The receipt, private preview, rendering, the three deletion steps and intake closure are observed as required. Resilience and late-write checks for the transport pass. A Motion Photo keeps its video; a Live Photo keeps its movie. |
| `platform-limited` | Only the two computed kinds in section 5, with `platformLimitation.observed: true` and a description. |
| `fail` | An observed Candidary defect or mismatch; `reason` is required. The recorder keeps computed discrepancies in `observations.computedIssues`. |
| `missing` | A step could not be run; `reason` is required. Leave the manifest lane `null` for it. The verifier would read a pointer to it as a failure. |

The recorder refuses, and writes nothing, whenever a claimed `pass` lacks any of the
above or any hash differs. It also refuses a `platform-limited` claim that its
computed files do not support. It never downgrades or upgrades a claim.

## 9. Observation form

`form.json` holds one device and one deployment. Paths are relative to the form's
directory and cannot leave it. Allowed values are shown after `|`.

```jsonc
{
  "kind": "candidary.mobile-device-observation-form", "formVersion": 1,
  "platform": "ios | android",
  "device": { "model": "…", "osVersion": "…", "browserName": "Safari | Chrome", "browserVersion": "…" },
  "deployment": { "origin": "https://<preview host>", "buildFingerprint": "<64 hex>",
    "imageRef": "<registry image>@sha256:<64 hex>", "workerVersionId": "…" },
  "operatorRole": "release-owner | release-delegate",
  "run": { "startedAt": "<ISO>", "finishedAt": "<ISO>",
    "export": { "intakeClosedBeforeExport": true, "kind": "photo-export-archive | event-export", "observation": "…" } },
  "transportChecks": [{ "transport": "direct | resumable", "fixtureId": "…",
    "background": { "outcome": "resumed | restarted | failed | not-exercised", "deliveredOnce": true, "observation": "…" },
    "offline": { … }, "reload": { … }, "retry": { … },
    "lateWrite": { "outcome": "refused | accepted | not-exercised", "observation": "…" } }],
  "routes": [{ "caseId": "…", "path": "camera | library | files", "outcome": "produced | unavailable", "observed": true,
    "observation": "…", "settings": { … }, "selection": "selection/route-….json", "producedFixtureId": "…" }],
  "results": [{
    "caseId": "…", "fixtureId": "…", "fixtureSha256": "<manifest sha256>",
    "claimedStatus": "pass | fail | platform-limited | missing", "reason": "… (non-pass)",
    "path": "camera | library", "settings": { … },
    "files": { "deviceOriginal": "device/….", "selection": "selection/….json", "downloadedOriginal": "download/….",
      "zip": "export/….zip", "restoredOriginal": "download/restored-….", "handoff": "handoff/….",
      "pairedDeviceResource": "device/….mov", "pairedDownloaded": "download/paired-….mov" },
    "zipMember": "<member name in the ZIP>",
    "chooser": { "surface": "…", "deviceOriginal": "pulled | not-saved-by-platform", "originalPull": "…", "notes": "…" },
    "transport": "direct | resumable",
    "receipt": { "confirming": "observed | not-observed", "delivered": "observed | not-observed", "prematureReceipt": false },
    "preview": { "owner": "visible", "manager": "visible", "otherGuest": "denied", "signedOut": "denied",
      "rendering": "as-expected | wrong", "renderingObservation": "…" },
    "deletion": { "trash": { "outcome": "pass | fail", "observation": "…" }, "restore": { … }, "permanent": { … } },
    "handoff": { "canShare": true, "outcome": "shared | fallback-zip", "destination": "…", "observation": "…" },
    "platformLimitation": { "observed": true, "kind": "chooser-conversion | paired-resource-not-delivered", "observation": "…" }
  }]
}
```

The document is always refused when any of the following fails:

- The device identity is incomplete, or the browser does not match the platform lane
  (iOS Safari, Android Chrome).
- The origin carries a path, query, fragment or credentials.
- `imageRef` is not digest-pinned.
- `operatorRole` is not a role.
- A fixture is not recorded under its case in the manifest with the same SHA-256.
- A camera result points at anything other than a consented capture.

## 10. Consented captures as fixtures

A camera capture, or a Camera-app capture used through the library, becomes a fixture
before its device evidence is recorded. The owner of `manifest.json` adds a record
under the case chosen by content classification. `scripts/verify-mobile-image-corpus.mjs`
requires the following for such a record:

- `provenance.kind` is `consented-capture`, with `consent: true` and
  `redistributable: false`.
- It has an explicit `license` statement and `attribution` set to `release-owner` or
  `release-delegate`.
- It has **no** `url`.
- Its path is under the ignored `originals/`.
- `capture.device`, `capture.os` and `capture.settings` are known, not `unknown`.

Hash pinning, encoded expectations, the four evidence lanes and the reference rendering
slot are unchanged. The capture still needs its own local native evidence and an
independent reference before the case can pass.

```json
{
  "id": "ios-<run-id>-heic-portrait", "path": "originals/consented/<run-id>-heic-portrait.heic",
  "sha256": "<computed>", "synthetic": false,
  "provenance": { "kind": "consented-capture", "consent": true, "redistributable": false,
    "license": "Private capture for Candidary release verification only; not licensed for redistribution.",
    "attribution": "release-owner" },
  "capture": { "device": "<model and number>", "os": "<OS build>", "settings": "<exact labels>" },
  "encoded": { "codec": "…", "container": "…", "width": 0, "height": 0, "frames": 1, "orientation": 1 },
  "reference": null, "evidence": { "local": null, "live": null, "android": null, "ios": null }
}
```

## 11. Recording

```powershell
node scripts/record-mobile-device-evidence.mjs --form output/verification/mobile-device/<run-id>/form.json --out tests/fixtures/mobile-images/evidence
```

The defaults are `--manifest tests/fixtures/mobile-images/manifest.json`,
`--evidence-root` as the manifest's directory, and `--inputs` as the form's directory.
The recorder reads only local files, has no network client, and computes every
SHA-256 from the files themselves. It writes exactly one file,
`<out>/<its own sha256>.json`, and only in these conditions:

- `--out` already exists, lies inside the evidence root, and Git ignores it (or it is
  outside any work tree).
- Re-recording identical observations reproduces the same file and name.

It prints `{ pointer: { path, sha256 }, lane, results[] }`. The manifest owner copies
`pointer` into `cases[<caseId>].fixtures[<fixtureId>].evidence.<ios|android>` for every
result whose `manifestField` is not `null`. Then run
`node scripts/verify-mobile-image-corpus.mjs --check-manifest` and review the evidence
itself. A syntactically valid pointer grants nothing without review. Refusals print
`{ refused: true, issues }` and exit 1.

## 12. Per-run checklist

| # | Step | Recorded in | Needed for `pass` |
| --- | --- | --- | --- |
| 1 | Authorization, preview origin, Worker version, decoder fingerprint and imageRef | `deployment` | yes (always required) |
| 2 | Model/number, OS build, browser/version, Keep Originals | `device`, `chooser.originalPull` | yes (always required) |
| 3 | Camera/transfer settings per fixture (section 4) | `results[].settings` | yes |
| 4 | Case classified from contents; consented capture added to the manifest | manifest (owner) | yes |
| 5 | Offered `accept` includes the type | selection `accept` | yes (platform-limited needs it) |
| 6 | Observer installed; selection saved; picker surface and options noted | `files.selection`, `chooser` | yes |
| 7 | Transport noted; confirming seen; receipt only after delivery | `transport`, `receipt` | yes |
| 8 | Owner/Manager visible; Guest B and signed-out denied; rendering checked | `preview` | yes |
| 9 | Device original pulled byte-exactly (or observed not saved) | `files.deviceOriginal`, `chooser.deviceOriginal` | library: yes |
| 10 | Guest intake paused before export | `run.export` | yes |
| 11 | Direct original downloaded | `files.downloadedOriginal` | yes |
| 12 | ZIP frozen, part saved, member named | `files.zip`, `zipMember` | yes |
| 13 | Device handoff: shared copy pulled, or ZIP fallback observed | `handoff`, `files.handoff` | yes |
| 14 | Trash, then Restore, then restored download | `deletion.trash/restore`, `files.restoredOriginal` | yes |
| 15 | Guest permanent deletion observed everywhere | `deletion.permanent` | yes |
| 16 | Background/offline/reload/retry per transport | `transportChecks` | yes |
| 17 | Late write refused per transport | `transportChecks[].lateWrite` | yes |
| 18 | Motion Photo video / Live Photo movie pulled and checked | `files.paired*` | those cases |
| 19 | Unavailable camera routes observed with settings | `routes` | route record only |
| 20 | Recorder run; pointer pasted by the manifest owner; corpus check; review | evidence file, manifest | yes |

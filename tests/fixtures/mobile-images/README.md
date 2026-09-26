# Mobile image corpus

The manifest separates native decoding evidence from live uploads and physical
Android/iOS observations. An upstream photograph with unknown capture settings
can prove a codec case locally; it cannot prove a phone's picker, camera, or share
behavior. Empty cases and absent evidence remain unqualified.

`originals/`, `references/`, and `evidence/` are ignored. Downloaded originals are
unchanged and SHA-256 pinned. Only reviewed source URLs, hashes, attribution,
licenses, and reproduction instructions belong in Git. Do not add private phone
photographs or unlicensed sample files.

From the repository root in Ubuntu 26.04, with `python3-pil` 12.1.1 and
`libheif-examples` 1.21.2 (including HEVC/AV1 decoder plugins), and
`libjxl-tools` 0.11.1 and `libraw-bin` 0.21.5b installed, configure the independent
Adobe converter for the JXL-DNG fixture as described below, then run:

```sh
python3 scripts/fetch-mobile-image-fixtures.py
node scripts/verify-mobile-image-corpus.mjs --check-manifest
```

The fetcher checks original and license hashes before use. It reproduces the
reference PNGs with a separate distribution decoder, checks their reviewed
hashes, and fails on any mismatch. It never makes references from candidate
service outputs or updates expected hashes automatically. JPEG XL references
use distribution `djxl` 0.11.1 at eight bits, then Pillow color conversion;
`djxl` already applies codestream orientation. Pillow references
apply EXIF orientation, convert an embedded color profile to sRGB, and fit within
1600 pixels without upscaling. The libheif reference method selects the primary
still using distribution `heif-dec`, bilinear chroma upsampling, and Pillow PNG
output. Candidate service decoding uses its separately pinned native build.

Pillow's Hopper encodings show the US Navy photograph by James S. Davis,
DN-SC-84-05971; the underlying photograph is public domain. Its source and rights
are documented by [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Commodore_Grace_M._Hopper,_USN_(covered).jpg).
Pillow's test collection uses the retained MIT-CMU license. JPEG XL testdata is
CC-BY-4.0; its flower photograph is credited to the JPEG XL project contributors.
Libheif's example images use the retained examples MIT license. Exact revisions
and license hashes are in `sources.json`; each original has its own provenance.
JPEG XL conformance photographs carry the project BSD license; Dominique
Toussaint's Newtons cradle animation is CC-BY-SA-3.0 with its upstream attribution
retained. The Open Preservation Foundation JPEG 2000 fixture is an unchanged
encoding of a public-domain 1786 balloon illustration. The animation and
archival scan are real encoded library assets, not phone capture evidence.

Run native qualification through `scripts/image-decoder-linux.ps1 -Action verify
-Group <group>`. Reports identify the actual local Docker image and baked build
fingerprint, inspect privacy/runtime restrictions, independently decode the
preview, compare reference pixels and frame timing, and verify source identity.
A local image ID is not a published registry digest. A passing local case does
not open production admission: release manifests remain empty until separately
authorized live qualification and release evidence exist.

RAW references use distribution `dcraw_emu` with camera white balance, no auto
brightness, AHD, eight-bit sRGB and the documented sRGB gamma, then Pillow
resizing. CC0 originals come from raw.pixls.us; individual publication/license
records are retained in `licenses/raw-pixls-phone-records.json`. The iPhone 12
Pro's orientation is applied exactly once. Those four original RAW fixtures do
not certify JPEG XL-compressed DNG or a physical chooser/upload path; the fifth
RAW fixture below covers the JXL-DNG codec separately.

The APNG icos4d animation is Jason Hise's CC0 asset, retained unchanged from the
JPEG XL conformance corpus. The animated GIF shares the retained Newtons cradle
attribution. The lossless transparent WebP is Jon Sullivan's public-domain
Yellow Rose from Google's WebP gallery; source credit is recorded alongside it.
The candidate native decoder is never used to generate any reference.

Two Apple HDR JPEG variants from Google libultrahdr use its test-data CC-BY-4.0
license. Their upstream resized iPhone 13 mini files have Display P3 primary
images plus auxiliary MPF gain maps. The explicit primary-JPEG reference method
renders the SDR primary and converts Display P3 to sRGB; it never mistakes the
gain map for a timed frame. Android Ultra HDR is a separate required case with
its own fixtures, described below.
Animated WebP reference generation loads each frame before reading its lazily
published duration. Finite animation repeats are not yet independently verified.

## Real phone and sequence fixtures (B8)

Fourteen further records use thirteen unchanged, SHA-256 pinned upstream files,
each re-verified from its own bytes and rights page before it was added:

- Android Ultra HDR JPEG: Pixel 8a (CC0) and Pixel 9 (CC BY-SA 4.0, C2PA
  `c2pa.created` by Pixel Camera; signature not validated) camera files with
  hdrgm 1.0 XMP, a GContainer directory and an MPF gain map.
- Motion Photo stills: a Pixel 6a Motion Photo v1 (CC0; MP4 at the declared
  offset plus a gain map) and a Pixel 2 legacy MicroVideo (CC BY-SA 4.0). Only
  the still primary is qualified; the video trailers are not decoded here.
- Animated WebP: Commons own-work footage (CC BY-SA 4.0, 24 frames) and a US
  Government public-domain satellite loop (98 frames, current file revision).
- HEIC grid/auxiliary: five CC BY 4.0 Zenodo camera originals (iPhone 11 Pro,
  14 Pro, 14 Pro Max, 16 and Galaxy A16 5G), covering grid primaries, irot 270,
  meta after mdat, Apple gain map, MPEG depth, Apple mattes and a tmap
  alternative. IMG_2622 is shared by one grid and one auxiliary record.
- AVIF sequences: Link-U Twinkle Star (artwork CC BY 4.0, repository CC BY-SA
  4.0; treated as CC BY-SA) and a CC0 conversion of Holger Will's public-domain
  beach ball. Both are synthetic content, not phone captures.

Rights are recorded in `licenses/wikimedia-commons-records.json` (page and file
revision, sha1, licence, author) and `licenses/zenodo-records.json` (record,
DOI, licence, creators, MD5), plus the pinned Link-U and lots-of-sample-files
licence/readme copies listed in `sources.json`. Reference renderings of CC BY-SA
originals are adaptations (resized, colour converted) and stay CC BY-SA 4.0
with the recorded attribution; like every original they stay in ignored storage.
Wikimedia may answer a burst of downloads with HTTP 429; rerun later.

Coded width/height are recorded before orientation. For HEIF, `orientation`
is the EXIF equivalent of the primary's `irot`; a duplicate EXIF Orientation
inside HEIF is never applied a second time. `primaryIndex` is the primary's
index among top-level images as listed by distribution `heif-info`, and 0 for
a sequence.

Two new versioned reference methods use Ubuntu `libheif-examples`
1.21.2-3ubuntu0.5 with the libde265 1.0.16 and libaom 3.13.1 plugins and
`python3-pil` 12.1.1-2ubuntu1.3. `heif-dec-1.21.2-bilinear-primary-srgb-v1`
reads `irot` and `colr` with a bounded box parser, refuses `imir`/`clap` and
non-sRGB nclx, requires exactly one decoded primary with the rotated display
size, converts an embedded ICC to sRGB and fits within 1600 pixels with a
per-channel float Lanczos rounded once. Pillow's 8-bit two-pass resampler
clamps between passes, which alone moved a few extreme edge samples by more
than the tolerance. `heif-dec-1.21.2-sequence-ignore-editlist-srgb-v1` decodes
with `-S --ignore-editlist` (plain `-S` can repeat a looping edit list forever),
takes each frame's milliseconds from an independent bounded mdhd/stts parse,
accepts one whole-media edit whose repeat flag sets the APNG loop, and writes
sRGB APNG frames. Existing methods and pins are unchanged.

`heic-sequence`, `live-photo-camera` and `live-photo-library` still lack qualifying
files or device observations. B10 closes the local JXL-DNG gap below.

## Phone JPEG XL-compressed DNG (B10)

The fifth RAW fixture is raw.pixls.us record 7783, a CC0 Samsung Galaxy S22
(SM-S901E) original published 2025-05-01. Its source SHA-256 is
`8f0ddc0a672503a840995a6901b16d3650f4c41b8c775e66a553b30222a69864`.
The original is 42,970,855 bytes, TIFF compression 52546, 16-bit linear RGB,
DNG 1.7, 4000×3000, orientation 6. Recorded firmware is S901EXXSAEXJ1; the
Android version is unknown. This proves the phone JXL-DNG codec locally,
not Apple's ProRAW capture settings or a physical chooser workflow.

Distribution LibRaw 0.21.5b cannot decode this compressed source directly. The
versioned reference method `adobe-dng-18.6-dcraw-0.21.5b-srgb-v1` uses Adobe DNG
Converter 18.6 to decompress a temporary copy, then the existing distribution
LibRaw/Pillow method. Neither stage reads candidate-service output. The original
and existing RAW tolerance of 16 are unchanged. The reviewed reference SHA-256 is
`5292d3b03cffd1bc54f63f26fb73ad22a7e53c39ba2b394efa3fa07667c567fa`.

For reproduction, obtain version 18.6 from the [official Adobe download](https://download.adobe.com/pub/adobe/dng/win/AdobeDNGConverter_x64_18_6.exe).
The installer SHA-256 is
`69802767ae2a22931871b0399aefb7a6ba9c0ddebc28da3ec9390cb6d4163ba3`;
the downloaded installer had a valid Adobe Inc. Authenticode signature. Do not
commit or redistribute Adobe binaries with the corpus. This run extracted the
converter and its runtime DLLs under ignored output without running the installer.
The converter executable SHA-256, checked before every invocation, is
`9a1b851707b13181c41f18eb50b7c9b0a211f1fa2a3896571bd14bb10598a13b`.
Set `CANDIDARY_ADOBE_DNG_CONVERTER` to the Windows executable's absolute WSL path
(under `/mnt/c/...`), with its runtime DLLs available beside it. WSL interoperability
and `wslpath` are required for this reference method; the production decoder itself
remains entirely in the Linux container.

```sh
export CANDIDARY_ADOBE_DNG_CONVERTER='/mnt/c/path/to/Adobe DNG Converter.exe'
python3 -m unittest discover -s tests/scripts -p test_mobile_image_references.py
python3 scripts/fetch-mobile-image-fixtures.py
```

The reference command uses `-u -p0 -dng1.4 -d <temporary-directory> -o reference.dng`,
as documented by [Adobe's command-line reference](https://helpx.adobe.com/content/dam/help/en/camera-raw/digital-negative/jcr_content/root/content/flex/items/position/position-par/download_section/download-1/dng_converter_commandline.pdf).
The temporary output is created on the Windows-backed checkout and removed after
rendering. Missing configuration or a different executable hash fails closed.
The extracted converter emitted optional GPU/model-resource warnings but produced
the checked output with exit 0. Acquisition/signature/conversion records are in
`output/verification/mobile-image-research/b9-load-inputs/`.

Focused B10 controls pass 3/3, including the opt-in real render (no skip), and
preserve the original hash. An incidental earlier fetch reproduced all 38 prior
originals/references; the new focused test separately reproduces the 39th. This is
not a fresh full-fetch pass for all 39 together.

## Current local evidence

B12h's final rendering union on local image `sha256:8d4ac6bec3609b0989b00c3cd9923ef9d696a5a199dee29f0c1c3e0e97d3c15c`
(fingerprint `a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651`) passes all 39 available
fixtures, qualifying 29/32 required cases locally. All `evidence.local` pointers use
`evidence/c72a2e2c91e400cc8f5ee4b4443d280d9b5c6092065da20a2d71405bd3e44600.json`.
The report keeps `complete:false` and exits 1 for the missing HEIC sequence; the two
Live Photo cases still need physical-device observations. The previous B8b/B10
reports remain available as historical evidence.

The owner approved a 20 MiB animated-preview cap on 2026-09-26 while preserving
existing fidelity. The previously failing 98-frame WebP now passes the unchanged
pixel/timing comparison. Still previews remain limited to 8 MiB. All 38 previously
passing previews keep their SHA-256, and original/reference hashes and tolerances
are unchanged. A local pass qualifies only the native lane: live, Android and iOS
lanes remain empty, so no case is complete end to end.

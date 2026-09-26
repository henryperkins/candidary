"""Fetch pinned licensed originals and reproduce independent Pillow references.

No service output is used to create a reference. A mismatch is an error, never an
automatic manifest/hash update. Run with Ubuntu's python3-pil installed.
"""
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

from PIL import Image, ImageCms, ImageOps

ROOT = Path(__file__).resolve().parents[1] / 'tests/fixtures/mobile-images'
MAX_FILE = 128 * 1024 * 1024
# Wikimedia rejects anonymous library agents; identify this fixed-purpose fetcher.
USER_AGENT = 'CandidaryFixtureFetcher/1.0 (pinned licensed test fixtures; SHA-256 verified)'
MAX_BOXES = 4096
MAX_SEQUENCE_FRAMES = 1024
ADOBE_DNG_CONVERTER_18_6_SHA256 = '9a1b851707b13181c41f18eb50b7c9b0a211f1fa2a3896571bd14bb10598a13b'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def target(relative):
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT.resolve()):
        raise RuntimeError('Fixture path leaves its root.')
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def fetch(entry):
    path = target(entry['path'])
    if path.exists():
        data = path.read_bytes()
    else:
        if not entry['url'].startswith('https://'):
            raise RuntimeError('Fixture source must use HTTPS.')
        request = urllib.request.Request(entry['url'], headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(MAX_FILE + 1)
    if len(data) > MAX_FILE or digest(data) != entry['sha256']:
        raise RuntimeError('Pinned source mismatch: ' + entry['path'])
    if not path.exists():
        path.write_bytes(data)
    return path


def pillow_reference(source, expected, *, jpeg_primary=False):
    """Versioned method: EXIF transpose, ICC to sRGB, fit, lossless PNG/APNG."""
    frames, durations = [], []
    # HDR JPEG's MPF gain map is an auxiliary image, not a timed second frame.
    # Calling this reader directly selects the backwards-compatible SDR primary.
    from PIL import JpegImagePlugin
    opener = JpegImagePlugin.JpegImageFile if jpeg_primary else Image.open
    with opener(source) as image:
        if (image.width, image.height, getattr(image, 'n_frames', 1), image.getexif().get(274, 1)) != \
                (expected['width'], expected['height'], expected['frames'], expected['orientation']):
            raise RuntimeError('Original dimensions/frame/orientation expectations differ.')
        for index in range(expected['frames']):
            image.seek(index)
            image.load()  # Animated WebP publishes this frame's duration at load.
            durations.append(image.info.get('duration', 0))
            frame = ImageOps.exif_transpose(image).convert('RGBA')
            icc = image.info.get('icc_profile')
            if icc:
                frame = ImageCms.profileToProfile(frame, ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                                 ImageCms.createProfile('sRGB'), outputMode='RGBA')
            frame.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            frame.info.clear()
            frames.append(frame)
    output = io.BytesIO()
    if len(frames) == 1:
        frames[0].save(output, format='PNG')
    else:
        frames[0].save(output, format='PNG', save_all=True, append_images=frames[1:],
                       duration=durations, loop=0, disposal=0, blend=0)
    return output.getvalue()


def heif_reference(source, expected):
    """Independent distribution libheif, never the candidate container's decoder."""
    version = subprocess.run(['heif-dec', '--version'], capture_output=True, text=True, check=True)
    if '1.21.2' not in version.stdout + version.stderr:
        raise RuntimeError('Reference method requires distribution heif-dec 1.21.2.')
    with tempfile.TemporaryDirectory(prefix='candidary-reference-') as directory:
        output = Path(directory) / 'reference.png'
        subprocess.run(['heif-dec', '--quiet', '-C', 'bilinear', str(source), str(output)],
                       capture_output=True, check=True, timeout=120)
        primary = output if output.exists() else output.with_name('reference-1.png')
        with Image.open(primary) as image:
            if image.size != (expected['width'], expected['height']) or expected['frames'] != 1:
                raise RuntimeError('Independent primary dimensions differ from the fixture.')
            frame = image.convert('RGBA')
            frame.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            frame.info.clear()
            data = io.BytesIO()
            frame.save(data, format='PNG')
            return data.getvalue()


def _boxes(data, start, end):
    """Bounded ISOBMFF walk of one box list: (type, payload start, box end)."""
    position, found = start, []
    while position < end:
        if len(found) >= MAX_BOXES or end - position < 8:
            raise RuntimeError('Malformed or oversized ISOBMFF box list.')
        size, kind, header = int.from_bytes(data[position:position + 4], 'big'), data[position + 4:position + 8], 8
        if size == 1:
            if end - position < 16:
                raise RuntimeError('Truncated ISOBMFF large-size box.')
            size, header = int.from_bytes(data[position + 8:position + 16], 'big'), 16
        elif size == 0:
            size = end - position
        if size < header or position + size > end:
            raise RuntimeError('ISOBMFF box exceeds its parent.')
        found.append((kind.decode('latin1'), position + header, position + size))
        position += size
    return found


def _only(boxes, kind, required=True):
    matches = [box for box in boxes if box[0] == kind]
    if len(matches) > 1 or (required and not matches):
        raise RuntimeError('Expected exactly one ISOBMFF ' + kind + ' box.')
    return matches[0] if matches else None


def _heif_primary_properties(data):
    """Primary item properties from pitm/ipco/ipma, in association order."""
    _, start, end = _only(_boxes(data, 0, len(data)), 'meta')
    meta = _boxes(data, start + 4, end)
    _, start, _ = _only(meta, 'pitm')
    primary = int.from_bytes(data[start + 4:start + (6 if data[start] == 0 else 8)], 'big')
    iprp = _boxes(data, *_only(meta, 'iprp')[1:])
    properties = _boxes(data, *_only(iprp, 'ipco')[1:])
    for _, start, end in [box for box in iprp if box[0] == 'ipma']:
        version, flags = data[start], data[start + 3]
        count, position = int.from_bytes(data[start + 4:start + 8], 'big'), start + 8
        if count > MAX_BOXES:
            raise RuntimeError('Oversized ipma.')
        for _ in range(count):
            width = 2 if version < 1 else 4
            item = int.from_bytes(data[position:position + width], 'big')
            associations = data[position + width]
            position += width + 1
            indexes = []
            for _ in range(associations):
                if flags & 1:
                    indexes.append(int.from_bytes(data[position:position + 2], 'big') & 0x7FFF)
                    position += 2
                else:
                    indexes.append(data[position] & 0x7F)
                    position += 1
            if position > end:
                raise RuntimeError('ipma exceeds its box.')
            if item == primary:
                if any(not 0 < index <= len(properties) for index in indexes):
                    raise RuntimeError('Primary property index is out of range.')
                return [properties[index - 1] for index in indexes]
    raise RuntimeError('Primary item has no property associations.')


def _nclx_is_srgb(data, start):
    """Only BT.709/unspecified primaries with sRGB/unspecified transfer are sRGB here."""
    primaries, transfer = int.from_bytes(data[start + 4:start + 6], 'big'), int.from_bytes(data[start + 6:start + 8], 'big')
    if primaries not in (1, 2) or transfer not in (2, 13):
        raise RuntimeError('This reference version cannot convert this nclx colour.')


def _round_aspect(number, key):
    return max(min(math.floor(number), math.ceil(number), key=key), 1)


def _fit(frame):
    """Fit within 1600 px without upscaling, sized exactly as Pillow's thumbnail.

    Resampling is a per-channel float Lanczos with one final rounding. Pillow's
    8-bit resampler clamps between its two passes, which alone moves extreme edge
    samples by more than the comparison tolerance; a reference must not add that.
    """
    width, height = frame.size
    if width <= 1600 and height <= 1600:
        return frame
    if frame.getchannel('A').getextrema() != (255, 255):
        raise RuntimeError('This reference version resamples opaque frames only.')
    aspect = width / height
    if aspect <= 1:
        size = (_round_aspect(1600 * aspect, key=lambda n: abs(aspect - n / 1600)), 1600)
    else:
        size = (1600, _round_aspect(1600 / aspect, key=lambda n: 0 if n == 0 else abs(aspect - 1600 / n)))
    bands = [band.convert('F').resize(size, Image.Resampling.LANCZOS).point(lambda value: value + 0.5).convert('L')
             for band in frame.convert('RGB').split()]
    return Image.merge('RGBA', [*bands, Image.new('L', size, 255)])


def _srgb_frame(image, embedded_colr):
    """RGBA sRGB frame: convert an embedded ICC (nclx was checked to be sRGB), then fit."""
    frame = image.convert('RGBA')
    icc = image.info.get('icc_profile')
    if icc:
        frame = ImageCms.profileToProfile(frame, ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                          ImageCms.createProfile('sRGB'), outputMode='RGBA')
    elif embedded_colr in ('prof', 'rICC'):
        raise RuntimeError('Decoded reference lost the embedded ICC profile.')
    frame = _fit(frame)
    frame.info.clear()
    return frame


def _heif_dec_version():
    version = subprocess.run(['heif-dec', '--version'], capture_output=True, text=True, check=True)
    if '1.21.2' not in version.stdout + version.stderr:
        raise RuntimeError('Reference method requires distribution heif-dec 1.21.2.')


def heif_srgb_reference(source, expected):
    """Versioned HEIF still method: distribution heif-dec applies irot once; ICC to sRGB.

    Orientation is the EXIF-equivalent of the primary's irot. EXIF Orientation
    inside HEIF describes the same transform and is never applied again.
    """
    _heif_dec_version()
    data = source.read_bytes()
    orientation, colr = 1, None
    for kind, start, _ in _heif_primary_properties(data):
        if kind == 'irot':
            orientation = {0: 1, 90: 8, 180: 3, 270: 6}[(data[start] & 3) * 90]
        elif kind in ('imir', 'clap'):
            raise RuntimeError('This reference version does not render ' + kind + '.')
        elif kind == 'colr':
            colr = data[start:start + 4].decode('latin1')
            if colr == 'nclx':
                _nclx_is_srgb(data, start)
    if orientation != expected['orientation'] or expected['frames'] != 1:
        raise RuntimeError('HEIF primary transform/frame expectations differ.')
    display = (expected['height'], expected['width']) if orientation in (5, 6, 7, 8) else (expected['width'], expected['height'])
    with tempfile.TemporaryDirectory(prefix='candidary-reference-') as directory:
        output = Path(directory) / 'reference.png'
        subprocess.run(['heif-dec', '--quiet', '-C', 'bilinear', str(source), str(output)],
                       capture_output=True, check=True, timeout=300)
        if sorted(path.name for path in Path(directory).iterdir()) != ['reference.png']:
            raise RuntimeError('Independent decoder did not select exactly one primary image.')
        with Image.open(output) as image:
            if image.size != display:
                raise RuntimeError('Independent primary display dimensions differ from the fixture.')
            frame = _srgb_frame(image, colr)
    result = io.BytesIO()
    frame.save(result, format='PNG')
    return result.getvalue()


def _sequence_timing(data, expected):
    """Independent mdhd/stts/elst parse of the one visual pict track, in milliseconds."""
    top = _boxes(data, 0, len(data))
    _, moov_start, moov_end = _only(top, 'moov')
    moov = _boxes(data, moov_start, moov_end)
    _, start, _ = _only(moov, 'mvhd')
    offset = start + (20 if data[start] == 1 else 12)
    movie_scale = int.from_bytes(data[offset:offset + 4], 'big')
    tracks = []
    for _, start, end in [box for box in moov if box[0] == 'trak']:
        trak = _boxes(data, start, end)
        mdia = _boxes(data, *_only(trak, 'mdia')[1:])
        _, start, _ = _only(mdia, 'hdlr')
        if data[start + 8:start + 12] == b'pict':
            tracks.append((trak, mdia))
    if len(tracks) != 1:
        raise RuntimeError('Expected exactly one visual pict track.')
    trak, mdia = tracks[0]
    _, start, _ = _only(mdia, 'mdhd')
    if data[start] == 1:
        scale, media = int.from_bytes(data[start + 20:start + 24], 'big'), int.from_bytes(data[start + 24:start + 32], 'big')
    else:
        scale, media = int.from_bytes(data[start + 12:start + 16], 'big'), int.from_bytes(data[start + 16:start + 20], 'big')
    stbl = _boxes(data, *_only(_boxes(data, *_only(mdia, 'minf')[1:]), 'stbl')[1:])
    _, start, end = _only(stbl, 'stts')
    entries, deltas = int.from_bytes(data[start + 4:start + 8], 'big'), []
    if not scale or not movie_scale or entries > MAX_SEQUENCE_FRAMES or start + 8 + 8 * entries > end:
        raise RuntimeError('Invalid sequence timescale or stts.')
    for index in range(entries):
        count = int.from_bytes(data[start + 8 + 8 * index:start + 12 + 8 * index], 'big')
        delta = int.from_bytes(data[start + 12 + 8 * index:start + 16 + 8 * index], 'big')
        if len(deltas) + count > MAX_SEQUENCE_FRAMES:
            raise RuntimeError('Sequence exceeds the reference frame bound.')
        deltas.extend([delta] * count)
    if len(deltas) != expected['frames'] or sum(deltas) != media or 0 in deltas:
        raise RuntimeError('Sequence sample timing differs from the fixture.')
    _, start, end = _only(stbl, 'stsd')
    entries = _boxes(data, start + 8, end)
    if int.from_bytes(data[start + 4:start + 8], 'big') != 1 or len(entries) != 1:
        raise RuntimeError('Expected exactly one sequence sample entry.')
    entry, entry_start, entry_end = entries[0]
    colr = None
    for kind, child, _ in _boxes(data, entry_start + 78, entry_end):
        if kind == 'colr':
            colr = data[child:child + 4].decode('latin1')
            if colr == 'nclx':
                _nclx_is_srgb(data, child)
    loop = 1
    edts = _only(trak, 'edts', required=False)
    if edts:
        _, start, _ = _only(_boxes(data, *edts[1:]), 'elst')
        version, flags, count = data[start], data[start + 3], int.from_bytes(data[start + 4:start + 8], 'big')
        width = 8 if version == 1 else 4
        segment = int.from_bytes(data[start + 8:start + 8 + width], 'big')
        media_time = int.from_bytes(data[start + 8 + width:start + 8 + 2 * width], 'big', signed=True)
        if count != 1 or media_time != 0 or segment * scale != media * movie_scale:
            raise RuntimeError('This reference version renders only one whole-media edit.')
        loop = 0 if flags & 1 else 1  # APNG num_plays: 0 repeats the whole edit indefinitely.
    return entry, colr, [(delta * 1000 + scale // 2) // scale for delta in deltas], loop


def heif_sequence_reference(source, expected):
    """Versioned HEIF/AVIS sequence method: heif-dec raw timeline, never plain -S.

    `--ignore-editlist` prevents a repeating edit list from decoding forever; the
    independent mdhd/stts parse supplies each frame's millisecond duration.
    """
    _heif_dec_version()
    data = source.read_bytes()
    entry, colr, durations, loop = _sequence_timing(data, expected)
    if entry not in ('av01', 'hvc1', 'hev1') or expected['orientation'] != 1:
        raise RuntimeError('Unsupported sequence sample entry or transform for this reference version.')
    frames = []
    with tempfile.TemporaryDirectory(prefix='candidary-reference-') as directory:
        output = Path(directory) / 'sequence.png'
        subprocess.run(['heif-dec', '--quiet', '-S', '--ignore-editlist', '-C', 'bilinear', str(source), str(output)],
                       capture_output=True, check=True, timeout=120)
        names = sorted(path.name for path in Path(directory).iterdir())
        if names != sorted(f'sequence-{index}.png' for index in range(1, expected['frames'] + 1)):
            raise RuntimeError('Independent decoder frame count differs from the fixture.')
        for index in range(1, expected['frames'] + 1):
            with Image.open(Path(directory) / f'sequence-{index}.png') as image:
                if image.size != (expected['width'], expected['height']):
                    raise RuntimeError('Independent sequence frame dimensions differ from the fixture.')
                frames.append(_srgb_frame(image, colr))
    result = io.BytesIO()
    frames[0].save(result, format='PNG', save_all=True, append_images=frames[1:],
                   duration=durations, loop=loop, disposal=0, blend=0)
    return result.getvalue()


def jxl_reference(source, expected):
    version = subprocess.run(['djxl', '--version'], capture_output=True, text=True, check=True)
    if 'v0.11.1' not in version.stdout + version.stderr:
        raise RuntimeError('Reference method requires distribution djxl 0.11.1.')
    with tempfile.TemporaryDirectory(prefix='candidary-reference-') as directory:
        output = Path(directory) / 'reference.png'
        subprocess.run(['djxl', str(source), str(output), '--bits_per_sample=8'],
                       capture_output=True, check=True, timeout=120)
        # djxl already applies the codestream orientation and clears the EXIF transform.
        rendered = dict(expected, orientation=1)
        if expected['orientation'] in (5, 6, 7, 8):
            rendered['width'], rendered['height'] = expected['height'], expected['width']
        return pillow_reference(output, rendered)


def raw_reference(source, expected):
    version = subprocess.run(['dpkg-query', '--showformat=${Version}', '--show', 'libraw-bin'],
                             capture_output=True, text=True, check=True)
    if not version.stdout.startswith('0.21.5b-'):
        raise RuntimeError('Reference method requires distribution libraw-bin 0.21.5b.')
    with tempfile.TemporaryDirectory(prefix='candidary-reference-') as directory:
        output = Path(directory) / 'reference.tiff'
        subprocess.run(['dcraw_emu', '-w', '-W', '-q', '3', '-o', '1', '-g', '2.4', '12.92',
                        '-T', '-Z', str(output), str(source)], capture_output=True, check=True, timeout=120)
        rendered = dict(expected, orientation=1)
        if expected['orientation'] in (5, 6, 7, 8):
            rendered['width'], rendered['height'] = expected['height'], expected['width']
        return pillow_reference(output, rendered)


def adobe_raw_reference(source, expected):
    """Independent Windows Adobe decompression in WSL, then distribution LibRaw rendering.

    The original is never rewritten. The vendor executable is separate from the
    candidate service and must match its reviewed binary pin before invocation.
    """
    configured = os.environ.get('CANDIDARY_ADOBE_DNG_CONVERTER')
    if not configured:
        raise RuntimeError('Set CANDIDARY_ADOBE_DNG_CONVERTER to the pinned Windows Adobe DNG Converter 18.6 executable in WSL.')
    converter = Path(configured).resolve()
    if not converter.is_file():
        raise RuntimeError('Independent Adobe converter file is missing.')
    with converter.open('rb') as file:
        actual = hashlib.file_digest(file, 'sha256').hexdigest()
    if actual != ADOBE_DNG_CONVERTER_18_6_SHA256:
        raise RuntimeError('Independent Adobe converter hash differs from the reviewed 18.6 executable.')

    def windows_path(path):
        return subprocess.run(['wslpath', '-w', str(path.resolve())], capture_output=True,
                              text=True, check=True, timeout=10).stdout.strip()

    # Keep the temporary output on the Windows-backed checkout so the Windows
    # converter and the WSL reference tools read the same ordinary file.
    temporary_root = ROOT.parents[2] / 'output/verification/mobile-image-adobe-references'
    temporary_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='reference-', dir=temporary_root) as directory:
        converted = Path(directory) / 'reference.dng'
        result = subprocess.run([str(converter), '-u', '-p0', '-dng1.4', '-d', windows_path(Path(directory)),
                                 '-o', converted.name, windows_path(source)], cwd=converter.parent,
                                capture_output=True, timeout=120)
        if result.returncode != 0 or not converted.is_file() or converted.stat().st_size == 0:
            # Converter diagnostics may contain local source paths; never print them.
            raise RuntimeError('Independent Adobe decompression did not produce an uncompressed reference.')
        return raw_reference(converted, expected)


def main():
    sources = json.loads((ROOT / 'sources.json').read_bytes())
    if sources['version'] != 1:
        raise RuntimeError('Unsupported fixture source catalog.')
    for entry in sources['licenses']:
        fetch(entry)
    manifest = json.loads((ROOT / 'manifest.json').read_bytes())
    count = 0
    for record in manifest['cases']:
        for fixture in record['fixtures']:
            source = fetch({'path': fixture['path'], 'sha256': fixture['sha256'], 'url': fixture['provenance']['url']})
            reference = fixture.get('reference')
            if reference:
                methods = {'pillow-srgb-v1': pillow_reference,
                           'pillow-jpeg-primary-srgb-v1': lambda path, encoded: pillow_reference(path, encoded, jpeg_primary=True),
                           'heif-dec-1.21.2-bilinear-primary': heif_reference,
                           'heif-dec-1.21.2-bilinear-primary-srgb-v1': heif_srgb_reference,
                           'heif-dec-1.21.2-sequence-ignore-editlist-srgb-v1': heif_sequence_reference,
                           'djxl-0.11.1-pillow-srgb-v1': jxl_reference,
                           'dcraw-emu-0.21.5b-srgb-v1': raw_reference,
                           'adobe-dng-18.6-dcraw-0.21.5b-srgb-v1': adobe_raw_reference}
                if reference.get('method') not in methods:
                    raise RuntimeError('Unknown independent reference method: ' + fixture['id'])
                data = methods[reference['method']](source, fixture['encoded'])
                if digest(data) != reference['sha256']:
                    raise RuntimeError('Independent reference differs from its reviewed pin: ' + fixture['id'])
                target(reference['path']).write_bytes(data)
            count += 1
    print(json.dumps({'originalsVerified': count, 'referencesVerified': count}))


if __name__ == '__main__':
    main()

"""Private raw-byte boundary. Codec availability never certifies a fixture/case."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import tempfile
import threading
import time

PROTOCOL = '1'
PROFILE = 'mobile-preview-v1'
MAX_SOURCE = 512 * 1024 * 1024
MAX_SCRATCH = 2 * 1024 * 1024 * 1024
MAX_FRAMES = 1024
JOB_SECONDS = 120
SCRATCH = Path('/tmp/candidary-decoder')
IDENTITY_PATH = Path('/srv/build-identity.json')
MAGICK = '/opt/decoder/bin/magick'
SRGB_PROFILE = '/opt/decoder/srgb.icc'
SLOT = threading.BoundedSemaphore(1)
JOB = threading.local()  # One active job per slot; native calls run on the handler thread.
METRICS_BYTES = 512
FAILURES = {'unsupported': 415, 'malformed': 422, 'resource_limit': 413, 'busy': 429, 'unavailable': 503}
# A failed child's stderr goes only to this fixed private file inside its job directory.
# It is read in two bounded windows solely to choose a closed code, then removed; it is
# never logged, returned or kept (the job directory is deleted with the job).
NATIVE_STDERR = 'native.stderr'
STDERR_WINDOW = 8 * 1024
# Closed lower-case ImageMagick 7.1.2 (english.xml cache/resource/image-limit messages) and
# libheif allocation/security-limit phrases: a configured resource or policy ceiling was hit,
# which is a resource_limit refusal rather than evidence that the bytes are corrupt.
RESOURCE_EXHAUSTION = (
    'cache resources exhausted', 'unable to extend cache', 'unable to extend pixel cache', 'unable to open pixel cache',
    'memory allocation failed', 'pixel cache allocation failed', 'unable to allocate image', 'unable to clone image',
    'width or height exceeds limit', 'image dimension exceeds maximum supported size', 'list length exceeds limit',
    'time limit exceeded', 'memory allocation error')
IDENTIFY_FORMAT = '%m|%w|%h|%[orientation]|%T|%W|%H|%X|%Y\n'
RASTER_FORMATS = {'JPEG': 'jpeg', 'PNG': 'png', 'APNG': 'png', 'WEBP': 'webp', 'GIF': 'gif',
                  'TIFF': 'tiff', 'BMP': 'bmp', 'BMP2': 'bmp', 'BMP3': 'bmp',
                  'JXL': 'jxl', 'JP2': 'jp2', 'J2K': 'jp2', 'JPC': 'jp2'}


class JobMetrics:
    """Private per-job resource measurements. Integers only; no request or file data."""
    def __init__(self):
        self.native_ns = 0
        self.peak_rss = 0
        self.peak_scratch = 0
        self.source_bytes = 0

    def native_ms(self):
        return (self.native_ns + 999_999) // 1_000_000

    def header(self):
        value = json.dumps({'nativeMs': self.native_ms(), 'peakRssBytes': self.peak_rss,
                            'peakScratchBytes': self.peak_scratch, 'sourceBytes': self.source_bytes}, separators=(',', ':'))
        return value if len(value.encode()) <= METRICS_BYTES else None


def current_metrics():
    return getattr(JOB, 'metrics', None)


def scratch_bytes(job):
    size = sum(path.stat().st_size for path in job.iterdir() if path.is_file())
    metrics = current_metrics()
    if metrics:
        metrics.peak_scratch = max(metrics.peak_scratch, size)
    return size


def reap(process, block):
    # wait4 (not Popen.poll) keeps the exited child's kernel rusage: ru_maxrss is KiB.
    pid, status, usage = os.wait4(process.pid, 0 if block else os.WNOHANG)
    if pid == 0:
        return False
    process.returncode = os.waitstatus_to_exitcode(status)
    metrics = current_metrics()
    if metrics:
        metrics.peak_rss = max(metrics.peak_rss, int(usage.ru_maxrss) * 1024)
    return True


class DecodeFailure(Exception):
    def __init__(self, code):
        self.code = code if code in FAILURES else 'unavailable'
        super().__init__(self.code)


def identity():
    value = json.loads(IDENTITY_PATH.read_bytes())
    if value.get('protocolVersion') != 1 or not re.fullmatch(r'[a-f0-9]{64}', value.get('buildFingerprint', '')):
        raise DecodeFailure('unavailable')
    return {key: value[key] for key in ('protocolVersion', 'buildFingerprint', 'decoderVersion')}


def integer(value, maximum):
    if not value or not re.fullmatch(r'[1-9][0-9]*', value):
        raise DecodeFailure('malformed')
    result = int(value)
    if result > maximum:
        raise DecodeFailure('resource_limit')
    return result


def read_source(stream, output, expected, chunked, deadline=None):
    digest = hashlib.sha256()
    total = 0

    def check_deadline():
        if deadline is not None and time.monotonic() >= deadline:
            raise DecodeFailure('resource_limit')

    def copy(length):
        nonlocal total
        if length > expected - total:
            raise DecodeFailure('malformed')
        while length:
            check_deadline()
            data = stream.read(min(length, 64 * 1024))
            check_deadline()
            if not data:
                raise DecodeFailure('malformed')
            total += len(data)
            length -= len(data)
            if (metrics := current_metrics()) is not None:
                metrics.source_bytes = total
            output.write(data)
            digest.update(data)

    if chunked:
        while True:
            check_deadline()
            line = stream.readline(128)
            if not re.fullmatch(rb'[0-9a-fA-F]{1,16}\r\n', line):
                raise DecodeFailure('malformed')
            length = int(line.strip(), 16)
            if length == 0:
                if stream.readline(8193) != b'\r\n':
                    raise DecodeFailure('malformed')
                break
            copy(length)
            if stream.read(2) != b'\r\n':
                raise DecodeFailure('malformed')
    else:
        copy(expected)
    if total != expected:
        raise DecodeFailure('malformed')
    check_deadline()
    return digest.hexdigest()


def native_failure(stderr_path):
    """Closed code for a child that exited with a positive status. Reads at most two bounded
    windows (the start and the end, where ImageMagick's final error is) of private stderr."""
    try:
        with stderr_path.open('rb') as stream:
            size = stream.seek(0, os.SEEK_END)
            stream.seek(0)
            text = stream.read(STDERR_WINDOW)
            if size > STDERR_WINDOW:
                stream.seek(max(STDERR_WINDOW, size - STDERR_WINDOW))
                text += b'\n' + stream.read(STDERR_WINDOW)
    except OSError:
        return 'malformed'
    text = ' '.join(text.decode('ascii', 'replace').lower().split())
    return 'resource_limit' if any(message in text for message in RESOURCE_EXHAUSTION) else 'malformed'


def run_native(argv, job, deadline, connection=None, stdout_path=None):
    # Direct argv, fixed executable/path policy, no shell or guest filename/recipe.
    started = time.monotonic_ns()
    stderr_path = job / NATIVE_STDERR
    try:
        with (stdout_path.open('wb') if stdout_path else open(os.devnull, 'wb')) as stdout, stderr_path.open('wb') as stderr:
            process = subprocess.Popen(['/usr/bin/prlimit', '--as=3221225472', '--fsize=2147483648', '--cpu=120', '--', *argv],
                                       cwd=job, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                       start_new_session=True, env={**os.environ, 'MAGICK_TEMPORARY_PATH': str(job)})
            try:
                while not reap(process, False):
                    if time.monotonic() >= deadline:
                        raise DecodeFailure('resource_limit')
                    if scratch_bytes(job) > MAX_SCRATCH:
                        raise DecodeFailure('resource_limit')
                    if connection and select.select([connection], [], [], 0)[0]:
                        if connection.recv(1, socket.MSG_PEEK) == b'':
                            raise DecodeFailure('unavailable')
                    time.sleep(0.02)
                if process.returncode:
                    raise DecodeFailure('resource_limit' if process.returncode < 0 else native_failure(stderr_path))
                if time.monotonic() >= deadline or scratch_bytes(job) > MAX_SCRATCH:
                    raise DecodeFailure('resource_limit')
            finally:
                if process.returncode is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    reap(process, True)
                if (metrics := current_metrics()) is not None:
                    metrics.native_ns += time.monotonic_ns() - started
    finally:
        stderr_path.unlink(missing_ok=True)


def render(job, declared_family, requires_sequence, digest, byte_size, deadline, connection=None):
    source = job / 'input.bin'
    metadata = job / 'inspection.txt'
    output = job / 'preview.webp'
    container = None
    raw = None
    png = None
    input_path = str(source)
    native_inputs = None
    native_options = []
    if declared_family == 'dng':
        if requires_sequence:
            raise DecodeFailure('unsupported')
        raw_path = job / 'raw.json'
        run_native(['/opt/decoder/bin/decode_raw', 'render'], job, deadline, connection, raw_path)
        if raw_path.stat().st_size > 2048:
            raise DecodeFailure('resource_limit')
        raw = json.loads(raw_path.read_bytes())
        if isinstance(raw, dict) and set(raw) == {'error'}:
            raise DecodeFailure(raw['error'])
        if not isinstance(raw, dict) or set(raw) != {'family', 'width', 'height', 'frameCount', 'primaryIndex', 'isSequence', 'sdkUsed'} \
                or raw['family'] != 'dng' or raw['frameCount'] != 1 or raw['primaryIndex'] != 0 \
                or raw['isSequence'] is not False or type(raw['sdkUsed']) is not bool \
                or any(type(raw[key]) is not int or raw[key] < 1 for key in ('width', 'height')):
            raise DecodeFailure('unavailable')
        if not raw['sdkUsed']:
            raise DecodeFailure('unsupported')
        input_path = str(job / 'raw.ppm')
    elif declared_family == 'png':
        png_path = job / 'png.json'
        run_native(['/usr/local/bin/python', '/srv/inspect_png.py'], job, deadline, connection, png_path)
        if png_path.stat().st_size > 256 * 1024:
            raise DecodeFailure('resource_limit')
        png = json.loads(png_path.read_bytes())
        if isinstance(png, dict) and set(png) == {'error'}:
            raise DecodeFailure(png['error'])
        if png == {'animated': False}:
            png = None
        elif not isinstance(png, dict) or set(png) != {'animated', 'width', 'height', 'loops', 'frames'} \
                or png['animated'] is not True or not isinstance(png['frames'], list) \
                or not 1 <= len(png['frames']) <= MAX_FRAMES \
                or any(type(png[key]) is not int or png[key] < 1 for key in ('width', 'height')) \
                or type(png['loops']) is not int or not 0 <= png['loops'] <= 65535:
            raise DecodeFailure('unsupported')
        if png:
            if png['width'] * png['height'] > 300_000_000 or png['width'] * png['height'] * len(png['frames']) > 1_000_000_000:
                raise DecodeFailure('resource_limit')
            native_inputs = []
            for index, frame in enumerate(png['frames']):
                if not isinstance(frame, dict) or set(frame) != {'width', 'height', 'x', 'y', 'numerator', 'denominator', 'dispose', 'blend'} \
                        or any(type(value) is not int for value in frame.values()) \
                        or min(frame['width'], frame['height'], frame['denominator']) < 1 \
                        or min(frame['x'], frame['y'], frame['numerator']) < 0 \
                        or max(frame['numerator'], frame['denominator']) > 65535 \
                        or frame['x'] + frame['width'] > png['width'] or frame['y'] + frame['height'] > png['height'] \
                        or frame['dispose'] not in (0, 1, 2) or frame['blend'] not in (0, 1):
                    raise DecodeFailure('unavailable')
                native_inputs += ['(', '-delay', f"{frame['numerator']}x{frame['denominator']}",
                                  '-dispose', ('None', 'Background', 'Previous')[frame['dispose']],
                                  '-page', f"{png['width']}x{png['height']}+{frame['x']}+{frame['y']}",
                                  str(job / f'png-frame-{index:04}.png'), '-set', 'webp:mux-blend',
                                  'AtopBackgroundAlphaBlend' if frame['blend'] else 'AtopPreviousAlphaBlend', ')']
    elif declared_family in ('heic', 'heif', 'avif'):
        container_path = job / 'container.json'
        run_native(['/usr/local/bin/python', '/srv/inspect_heif.py'], job, deadline, connection, container_path)
        if container_path.stat().st_size > 2048:
            raise DecodeFailure('resource_limit')
        container = json.loads(container_path.read_bytes())
        if set(container) == {'error'}:
            raise DecodeFailure(container['error'])
        if set(container) != {'family', 'isSequence', 'primaryIndex'} or container['family'] not in ('heic', 'avif') \
                or type(container['isSequence']) is not bool or type(container['primaryIndex']) is not int \
                or not 0 <= container['primaryIndex'] < 16384:
            raise DecodeFailure('unavailable')
        if container['family'] != declared_family and not (declared_family == 'heif' and container['family'] == 'heic'):
            raise DecodeFailure('malformed')
        if requires_sequence and not container['isSequence']:
            raise DecodeFailure('malformed')
        if not container['isSequence']:
            input_path += '[0]'  # Pinned libheif coder returns the primary first, before other still items.
        native_options = ['-define', 'heic:chroma-upsampling=bilinear', '-define', 'heic:preserve-orientation=false']
    native_inputs = native_inputs or [input_path]
    # identify's legacy command parser has no parentheses; frame options are
    # applied by the render command, while identification only reads fixed PNGs.
    inspect_inputs = [str(job / f'png-frame-{index:04}.png') for index in range(len(png['frames']))] if png else native_inputs
    run_native([MAGICK, 'identify', '-ping', *native_options, '-format', IDENTIFY_FORMAT, *inspect_inputs], job, deadline, connection, metadata)
    if metadata.stat().st_size > 128 * 1024:
        raise DecodeFailure('resource_limit')
    rows = [line.split('|') for line in metadata.read_text().splitlines()]
    # Fields 5-8 are the page (canvas width/height, signed x/y offset) of each frame.
    if not rows or len(rows) > MAX_FRAMES or any(len(row) != 9 or not re.fullmatch(r'[0-9]{1,9}', row[5]) or not re.fullmatch(r'[0-9]{1,9}', row[6])
                                                 or not re.fullmatch(r'[+-][0-9]{1,9}', row[7]) or not re.fullmatch(r'[+-][0-9]{1,9}', row[8]) for row in rows):
        raise DecodeFailure('malformed')
    def family_for(row):
        if raw:
            return 'dng' if row[0] == 'PPM' else None
        if container:
            return container['family'] if row[0] in ('HEIC', 'HEIF', 'AVIF') else None
        return RASTER_FORMATS.get(row[0])
    family = family_for(rows[0])
    if family is None or any(family_for(row) != family for row in rows):
        raise DecodeFailure('unsupported')
    if family != declared_family and not (container and declared_family == 'heif' and family == 'heic'):
        raise DecodeFailure('malformed')
    if len(rows) > 1 and family not in ('png', 'webp', 'gif', 'jxl') and not (container and container['isSequence']):
        raise DecodeFailure('unsupported')
    width, height = int(rows[0][1]), int(rows[0][2])
    if png:
        if len(rows) != len(png['frames']) or any((int(row[1]), int(row[2])) != (frame['width'], frame['height']) for row, frame in zip(rows, png['frames'])):
            raise DecodeFailure('malformed')
        width, height = png['width'], png['height']
    if raw and (width, height, len(rows)) != (raw['width'], raw['height'], 1):
        raise DecodeFailure('malformed')
    cumulative = sum(int(row[1]) * int(row[2]) for row in rows)
    if any(min(int(row[1]), int(row[2])) < 1 or int(row[1]) * int(row[2]) > 300_000_000 for row in rows) or cumulative > 1_000_000_000:
        raise DecodeFailure('resource_limit')
    if family in ('gif', 'webp'):
        canvas_path = job / 'canvas.txt'
        run_native([MAGICK, 'identify', '-ping', '-format', '%W|%H\n', input_path + '[0]'], job, deadline, connection, canvas_path)
        if canvas_path.stat().st_size > 128:
            raise DecodeFailure('resource_limit')
        canvas = canvas_path.read_text().strip().split('|')
        if len(canvas) != 2 or any(not value.isdecimal() for value in canvas):
            raise DecodeFailure('malformed')
        width, height = map(int, canvas)
        if min(width, height) < 1:
            raise DecodeFailure('malformed')
        # A small frame rectangle can still allocate a much larger full canvas
        # during coalescing. Account for that before the pixel decode/render.
        if width * height > 300_000_000 or width * height * len(rows) > 1_000_000_000:
            raise DecodeFailure('resource_limit')
    if rows[0][3] in ('LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'):
        width, height = height, width
    is_sequence = container['isSequence'] if container else bool(png) or len(rows) > 1
    if requires_sequence and not is_sequence:
        raise DecodeFailure('malformed')
    # Coalesce in the source canvas before orientation: rotating first leaves the
    # old page geometry and can crop a non-square image back to its original size.
    # Coalescing one frame whose page is exactly that frame at +0+0 is an identity that
    # still clones full-resolution pixel caches (a 50 MP still exhausts the policy), so
    # only that case resets the page instead. APNG canvases, every multi-frame input and
    # any other canvas size or offset keep their coalesced composition unchanged.
    single = not png and len(rows) == 1 and (int(rows[0][5]), int(rows[0][6]), int(rows[0][7]), int(rows[0][8])) \
        == (int(rows[0][1]), int(rows[0][2]), 0, 0)
    # HDRI keeps out-of-gamut values after the display transform: clip them before
    # resampling, then drop source metadata and embed the sRGB display profile once.
    run_native([MAGICK, *native_options, *native_inputs, '+repage' if single else '-coalesce', '-auto-orient',
                '-profile', SRGB_PROFILE, '-clamp', '-resize', '1600x1600>', '-strip', '-profile', SRGB_PROFILE,
                '-define', 'webp:lossless=true', '-define', 'webp:exact=true',
                *(['-loop', str(png['loops'])] if png else []), str(output)], job, deadline, connection)
    byte_limit = (20 if is_sequence else 8) * 1024 * 1024
    if not output.is_file() or not 0 < output.stat().st_size <= byte_limit:
        raise DecodeFailure('resource_limit')
    output_metadata = job / 'preview.txt'
    run_native([MAGICK, 'identify', '-format', '%w|%h\n', str(output)], job, deadline, connection, output_metadata)
    if output_metadata.stat().st_size > 64 * 1024:
        raise DecodeFailure('resource_limit')
    preview_frames = [tuple(int(value) for value in line.split('|')) for line in output_metadata.read_text().splitlines()]
    if len(preview_frames) != len(rows) or any(len(frame) != 2 for frame in preview_frames):
        raise DecodeFailure('unsupported')
    preview_width, preview_height = preview_frames[0]
    if any(not (0 < w <= min(width, 1600) and 0 < h <= min(height, 1600)) for w, h in preview_frames):
        raise DecodeFailure('malformed')
    build = identity()
    inspection = {'family': family, 'width': width, 'height': height, 'frameCount': len(rows), 'primaryIndex': container['primaryIndex'] if container else 0,
                  'isSequence': is_sequence, 'sourceSha256': digest, 'byteSize': byte_size,
                  'buildFingerprint': build['buildFingerprint'], 'decoderVersion': build['decoderVersion'], 'previewProfile': PROFILE}
    return inspection, output, preview_width, preview_height


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass  # Request headers/paths/native errors are never written to logs.

    def reply(self, status, value, metrics=None):
        data = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('X-Decoder-Protocol', PROTOCOL)
        if metrics and (header := metrics.header()):
            self.send_header('X-Decoder-Metrics', header)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        try:
            if self.path != '/health':
                raise DecodeFailure('unsupported')
            self.reply(200, identity())
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.reply(503, {'code': 'unavailable'})

    def do_POST(self):
        self.close_connection = True
        if not SLOT.acquire(blocking=False):
            self.reply(429, {'code': 'busy'})
            return
        # Socket timeouts are inactivity bounds. This independent timer also stops
        # a slow sender/receiver which keeps making progress past the job deadline.
        def close_expired_connection():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(JOB_SECONDS, close_expired_connection)
        timer.daemon = True
        timer.start()
        try:
            deadline = time.monotonic() + JOB_SECONDS
            self.connection.settimeout(JOB_SECONDS)
            if self.path not in ('/v1/inspect', '/v1/preview') or self.headers.get('X-Decoder-Protocol') != PROTOCOL:
                raise DecodeFailure('unsupported')
            for header in ('X-Decoder-Protocol', 'X-Image-Family', 'X-Image-Sequence', 'X-Source-Length', 'X-Decoder-Lane'):
                if len(self.headers.get_all(header, [])) != 1:
                    raise DecodeFailure('malformed')
            for header in ('Content-Length', 'Transfer-Encoding', 'Content-Type'):
                if len(self.headers.get_all(header, [])) > 1:
                    raise DecodeFailure('malformed')
            if self.headers.get('Content-Type') != 'application/octet-stream' or self.headers['X-Decoder-Lane'] not in ('upload', 'preview'):
                raise DecodeFailure('malformed')
            family = self.headers['X-Image-Family']
            if family not in (*RASTER_FORMATS.values(), 'heic', 'heif', 'avif', 'dng'):
                raise DecodeFailure('unsupported')
            if self.headers['X-Image-Sequence'] not in ('0', '1'):
                raise DecodeFailure('malformed')
            expected = integer(self.headers['X-Source-Length'], MAX_SOURCE)
            chunked = self.headers.get('Transfer-Encoding') == 'chunked'
            length = self.headers.get('Content-Length')
            if (self.headers.get('Transfer-Encoding') and not chunked) or (chunked and length is not None):
                raise DecodeFailure('malformed')
            if not chunked and integer(length, MAX_SOURCE) != expected:
                raise DecodeFailure('malformed')
            # A job has started: success and closed failures from here carry private metrics.
            JOB.metrics = JobMetrics()
            SCRATCH.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='job-', dir=SCRATCH) as directory:
                job = Path(directory)
                with (job / 'input.bin').open('wb') as source:
                    digest = read_source(self.rfile, source, expected, chunked, deadline)
                inspection, output, width, height = render(job, family, self.headers['X-Image-Sequence'] == '1', digest, expected, deadline, self.connection)
                if self.path == '/v1/inspect':
                    self.reply(200, inspection, current_metrics())
                    return
                proof = json.dumps(inspection, separators=(',', ':'))
                if len(proof.encode()) > 2048:
                    raise DecodeFailure('unavailable')
                self.send_response(200)
                for key, value in {'X-Decoder-Protocol': PROTOCOL, 'Content-Type': 'image/webp', 'Content-Length': str(output.stat().st_size),
                                   'X-Decoder-Inspection': proof, 'X-Preview-Width': str(width), 'X-Preview-Height': str(height),
                                   'X-Preview-Frames': str(inspection['frameCount']), 'Connection': 'close'}.items():
                    self.send_header(key, value)
                if header := current_metrics().header():
                    self.send_header('X-Decoder-Metrics', header)
                self.end_headers()
                with output.open('rb') as preview:
                    while chunk := preview.read(64 * 1024):
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            code = error.code if isinstance(error, DecodeFailure) else 'unavailable'
            try:
                self.reply(FAILURES[code], {'code': code}, current_metrics())
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
        finally:
            JOB.metrics = None
            timer.cancel()
            SLOT.release()


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()

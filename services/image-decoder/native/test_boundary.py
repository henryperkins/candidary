"""Host boundary checks; subprocess doubles do not qualify native codecs/Linux limits."""
import hashlib
import http.client
import io
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import time
import unittest
import zlib
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

import server


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(server, 'SCRATCH', self.root), patch.object(server, 'identity', return_value={
            'protocolVersion': 1, 'buildFingerprint': 'b' * 64, 'decoderVersion': 'boundary-double'})]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_original_stream_hash_and_bounded_reads(self):
        data = b'original' * 20000
        class Bounded(io.BytesIO):
            def read(self, size=-1):
                if not 0 < size <= 65536:
                    raise AssertionError('Unbounded source read')
                return super().read(size)
        output = io.BytesIO()
        self.assertEqual(server.read_source(Bounded(data), output, len(data), False), hashlib.sha256(data).hexdigest())
        self.assertEqual(output.getvalue(), data)

    def test_qualification_rejects_wrong_family_primary_and_sequence_proof(self):
        from verify_service import validate_inspection
        fixture = {'sha256': 'a' * 64, 'encoded': {'codec': 'heif', 'width': 20, 'height': 10,
                                                 'frames': 1, 'orientation': 1, 'primaryIndex': 2}}
        build = {'buildFingerprint': 'b' * 64, 'decoderVersion': 'candidate'}
        proof = {**build, 'family': 'heic', 'width': 20, 'height': 10, 'frameCount': 1,
                 'primaryIndex': 2, 'isSequence': False, 'sourceSha256': 'a' * 64,
                 'byteSize': 17, 'previewProfile': 'mobile-preview-v1'}
        validate_inspection(proof, fixture, build, 17)
        for field, value in [('family', 'avif'), ('primaryIndex', 0), ('isSequence', True),
                             ('width', True), ('sourceSha256', 'c' * 64), ('decoderVersion', 'unqualified')]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                validate_inspection({**proof, field: value}, fixture, build, 17)

    def test_qualification_records_bounded_private_job_metrics_without_gating_on_them(self):
        from verify_service import observed_metrics
        valid = '{"nativeMs":4613,"peakRssBytes":757071872,"peakScratchBytes":36864,"sourceBytes":66671237}'
        expected = {'nativeMs': 4613, 'peakRssBytes': 757071872, 'peakScratchBytes': 36864, 'sourceBytes': 66671237}
        self.assertEqual(observed_metrics({'X-Decoder-Metrics': valid, 'Content-Type': 'image/webp'}), expected)
        self.assertEqual(observed_metrics({'x-decoder-metrics': valid}), expected)
        # Absent, oversized, non-JSON, non-integer, negative or reshaped values record null.
        for headers in ({}, {'X-Decoder-Metrics': valid[:-1] + ' ' * 512 + '}'}, {'X-Decoder-Metrics': 'secret stderr'},
                        {'X-Decoder-Metrics': valid.replace('4613', '4613.5')}, {'X-Decoder-Metrics': valid.replace('4613', 'true')},
                        {'X-Decoder-Metrics': valid.replace('4613', '-1')}, {'X-Decoder-Metrics': valid.replace('"nativeMs":4613,', '')},
                        {'X-Decoder-Metrics': valid[:-1] + ',"path":1}'}, {'X-Decoder-Metrics': '[1,2,3,4]'},
                        {'X-Decoder-Metrics': valid, 'x-decoder-metrics': valid}):
            with self.subTest(headers=headers):
                self.assertIsNone(observed_metrics(headers))

    def test_reference_pixels_ignore_only_rgb_hidden_by_zero_alpha(self):
        from PIL import Image
        from verify_service import pixel_error
        reference = Image.new('RGBA', (1, 1), (255, 80, 20, 0))
        self.assertEqual(pixel_error(Image.new('RGBA', (1, 1), (0, 0, 0, 0)), reference), 0)
        self.assertEqual(pixel_error(Image.new('RGBA', (1, 1), (255, 80, 20, 255)), reference), 255)
        # Even nearly invisible pixels retain full RGB comparison, without
        # multiplying away mistakes at low alpha.
        reference.putpixel((0, 0), (255, 80, 20, 1))
        self.assertEqual(pixel_error(Image.new('RGBA', (1, 1), (0, 0, 0, 1)), reference), 255)

    def test_chunked_input_exact_length_and_no_trailers(self):
        self.assertEqual(server.read_source(io.BytesIO(b'3\r\nabc\r\n0\r\n\r\n'), io.BytesIO(), 3, True), hashlib.sha256(b'abc').hexdigest())
        for data, expected, chunked in [(b'ab', 3, False), (b'4\r\nabcd\r\n0\r\n\r\n', 3, True),
                                         (b'3\r\nabc\r\n0\r\nX: secret\r\n\r\n', 3, True)]:
            with self.assertRaisesRegex(server.DecodeFailure, 'malformed'):
                server.read_source(io.BytesIO(data), io.BytesIO(), expected, chunked)

    def test_upload_deadline_is_total_not_per_read(self):
        with patch.object(server.time, 'monotonic', return_value=11):
            with self.assertRaisesRegex(server.DecodeFailure, 'resource_limit'):
                server.read_source(io.BytesIO(b'abc'), io.BytesIO(), 3, False, deadline=10)

    @staticmethod
    def identified(argv, *frames):
        # Emit exactly the fields the render's identify -format requests. Page geometry
        # (canvas width/height and signed x/y offsets) defaults to the frame itself at +0+0.
        count = argv[argv.index('-format') + 1].count('|') + 1
        rows = []
        for magick, width, height, orientation, delay, *page in frames:
            page_width, page_height, x, y = page[0] if page else (width, height, 0, 0)
            values = [magick, width, height, orientation, delay, page_width, page_height, f'{x:+d}', f'{y:+d}']
            rows.append('|'.join(str(value) for value in values[:count]) + '\n')
        return ''.join(rows)

    def native_double(self, argv, job, _deadline, _connection=None, stdout_path=None):
        if stdout_path:
            stdout_path.write_text(self.identified(argv, ('JPEG', 20, 10, 'TopLeft', 0)) if stdout_path.name == 'inspection.txt' else '20|10\n')
        else:
            (job / 'preview.webp').write_bytes(b'encoded-output')

    def test_valid_render_and_empty_or_oversized_encoded_output(self):
        with patch.object(server, 'run_native', side_effect=self.native_double):
            proof, output, width, height = server.render(self.root, 'jpeg', False, 'a' * 64, 3, 100)
            self.assertEqual((proof['sourceSha256'], width, height, output.read_bytes()), ('a' * 64, 20, 10, b'encoded-output'))
        for length in [0, 8 * 1024 * 1024 + 1]:
            def invalid(argv, job, deadline, connection=None, stdout_path=None):
                self.native_double(argv, job, deadline, connection, stdout_path)
                if not stdout_path:
                    with (job / 'preview.webp').open('wb') as output:
                        output.truncate(length)
            with patch.object(server, 'run_native', side_effect=invalid):
                with self.assertRaisesRegex(server.DecodeFailure, 'resource_limit'):
                    server.render(self.root, 'jpeg', False, 'a' * 64, 3, 100)

    def test_preview_caps_allow_20_mib_animation_and_keep_8_mib_stills(self):
        for sequence, length, allowed in [(False, 8 * 1024 * 1024, True),
                                           (False, 8 * 1024 * 1024 + 1, False),
                                           (True, 20 * 1024 * 1024, True),
                                           (True, 20 * 1024 * 1024 + 1, False)]:
            with self.subTest(sequence=sequence, length=length):
                native = self.heif_double('heic', sequence, 2 if sequence else 1)
                def output_size(argv, job, deadline, connection=None, stdout_path=None):
                    native(argv, job, deadline, connection, stdout_path)
                    if stdout_path is None:
                        with (job / 'preview.webp').open('wb') as output:
                            output.truncate(length)
                with patch.object(server, 'run_native', side_effect=output_size):
                    if allowed:
                        proof, output, _, _ = server.render(self.root, 'heic', sequence, 'a' * 64, 3, 100)
                        self.assertEqual(output.stat().st_size, length)
                        self.assertEqual(proof['isSequence'], sequence)
                    else:
                        with self.assertRaisesRegex(server.DecodeFailure, 'resource_limit'):
                            server.render(self.root, 'heic', sequence, 'a' * 64, 3, 100)

    def test_every_frame_has_valid_dimensions(self):
        def invalid(argv, job, deadline, connection=None, stdout_path=None):
            self.native_double(argv, job, deadline, connection, stdout_path)
            if stdout_path and stdout_path.name == 'inspection.txt':
                stdout_path.write_text(self.identified(argv, ('GIF', 20, 10, 'TopLeft', 1), ('GIF', -1, 10, 'TopLeft', 1, (20, 10, 0, 0))))
        with patch.object(server, 'run_native', side_effect=invalid):
            with self.assertRaisesRegex(server.DecodeFailure, 'resource_limit'):
                    server.render(self.root, 'gif', True, 'a' * 64, 3, 100)

    def test_animation_uses_logical_canvas_and_budgets_full_composited_frames(self):
        for family in ('gif', 'webp'):
            def native(argv, job, deadline, connection=None, stdout_path=None):
                if stdout_path:
                    stdout_path.write_text(self.identified(argv, *[(family.upper(), 480, 360, 'TopLeft', 5, (640, 480, 0, 0))] * 36)
                                           if stdout_path.name == 'inspection.txt'
                                           else '640|480\n' if stdout_path.name == 'canvas.txt' else '640|480\n' * 36)
                else:
                    (job / 'preview.webp').write_bytes(b'composited-canvas')
            with self.subTest(family=family), patch.object(server, 'run_native', side_effect=native):
                proof, _output, width, height = server.render(self.root, family, True, 'a' * 64, 3, 100)
                self.assertEqual((proof['width'], proof['height'], width, height), (640, 480, 640, 480))
        def enormous_canvas(argv, job, deadline, connection=None, stdout_path=None):
            native(argv, job, deadline, connection, stdout_path)
            if stdout_path and stdout_path.name == 'canvas.txt':
                stdout_path.write_text('20000|10000\n')
        with patch.object(server, 'run_native', side_effect=enormous_canvas):
            with self.assertRaisesRegex(server.DecodeFailure, 'resource_limit'):
                server.render(self.root, 'webp', True, 'a' * 64, 3, 100)

    def test_jxl_and_jp2_dispatch_preserve_family_and_jxl_animation(self):
        for codec, family, frames in [('JXL', 'jxl', 1), ('JXL', 'jxl', 3), ('JP2', 'jp2', 1), ('J2K', 'jp2', 1)]:
            def native(argv, job, deadline, connection=None, stdout_path=None):
                self.native_double(argv, job, deadline, connection, stdout_path)
                if stdout_path:
                    stdout_path.write_text(self.identified(argv, *[(codec, 20, 10, 'TopLeft', 10)] * frames)
                                           if stdout_path.name == 'inspection.txt' else '20|10\n' * frames)
            with self.subTest(codec=codec, frames=frames), patch.object(server, 'run_native', side_effect=native):
                proof, _output, width, height = server.render(self.root, family, frames > 1, 'a' * 64, 3, 100)
                self.assertEqual((proof['family'], proof['frameCount'], proof['isSequence'], width, height),
                                 (family, frames, frames > 1, 20, 10))

    def raw_native_double(self, proof):
        def native(argv, job, deadline, connection=None, stdout_path=None):
            if stdout_path and stdout_path.name == 'raw.json':
                self.assertEqual(argv, ['/opt/decoder/bin/decode_raw', 'render'])
                stdout_path.write_text(json.dumps(proof))
                (job / 'raw.ppm').write_bytes(b'internal-raster')
            elif stdout_path and stdout_path.name == 'inspection.txt':
                self.assertEqual(argv[-1], str(job / 'raw.ppm'))
                stdout_path.write_text(self.identified(argv, ('PPM', 20, 10, 'TopLeft', 0)))
            else:
                self.native_double(argv, job, deadline, connection, stdout_path)
        return native

    def test_raw_requires_sdk_backed_pixels_and_preserves_source_identity(self):
        proof = {'family': 'dng', 'width': 20, 'height': 10, 'frameCount': 1,
                 'primaryIndex': 0, 'isSequence': False, 'sdkUsed': True}
        with patch.object(server, 'run_native', side_effect=self.raw_native_double(proof)):
            inspection, _output, width, height = server.render(self.root, 'dng', False, 'a' * 64, 31, 100)
            self.assertEqual((inspection['family'], inspection['sourceSha256'], inspection['byteSize'], width, height),
                             ('dng', 'a' * 64, 31, 20, 10))
        with patch.object(server, 'run_native', side_effect=self.raw_native_double({**proof, 'sdkUsed': False})):
            with self.assertRaisesRegex(server.DecodeFailure, 'unsupported'):
                server.render(self.root, 'dng', False, 'a' * 64, 31, 100)

    def test_raw_helper_refusals_stay_closed(self):
        for code in ['resource_limit', 'unsupported', 'malformed']:
            with self.subTest(code=code), patch.object(server, 'run_native', side_effect=self.raw_native_double({'error': code})):
                with self.assertRaisesRegex(server.DecodeFailure, code):
                    server.render(self.root, 'dng', False, 'a' * 64, 31, 100)

    def test_windows_bitmap_versions_keep_the_bmp_family(self):
        # ImageMagick reports a normal 40-byte Windows DIB header as BMP3.
        for format_name in ('BMP', 'BMP2', 'BMP3'):
            with self.subTest(format_name=format_name):
                def bitmap(argv, job, deadline, connection=None, stdout_path=None):
                    self.native_double(argv, job, deadline, connection, stdout_path)
                    if stdout_path and stdout_path.name == 'inspection.txt':
                        stdout_path.write_text(self.identified(argv, (format_name, 20, 10, 'Undefined', 0)))
                with patch.object(server, 'run_native', side_effect=bitmap):
                    proof, _output, width, height = server.render(self.root, 'bmp', False, 'a' * 64, 3, 100)
                self.assertEqual((proof['family'], width, height), ('bmp', 20, 10))

    def heif_double(self, family, sequence=False, frames=1):
        def native(argv, job, deadline, connection=None, stdout_path=None):
            if stdout_path and stdout_path.name == 'container.json':
                stdout_path.write_text(json.dumps({'family': family, 'isSequence': sequence, 'primaryIndex': 2}))
            elif stdout_path and stdout_path.name == 'inspection.txt':
                stdout_path.write_text(self.identified(argv, *[('HEIC', 20, 10, 'TopLeft', 10)] * frames))
            elif stdout_path:
                stdout_path.write_text('20|10\n' * frames)
            else:
                (job / 'preview.webp').write_bytes(b'encoded-output')
        return native

    def test_heif_primary_selection_preserves_the_actual_family_and_primary_index(self):
        for declared in ('heic', 'heif'):
            with self.subTest(declared=declared), patch.object(server, 'run_native', side_effect=self.heif_double('heic')) as native:
                proof, _output, width, height = server.render(self.root, declared, False, 'a' * 64, 3, 100)
                self.assertEqual((proof['family'], proof['primaryIndex'], width, height), ('heic', 2, 20, 10))
                self.assertFalse(proof['isSequence'])
                self.assertTrue(any(str(self.root / 'input.bin') + '[0]' in call.args[0] for call in native.call_args_list))

    def test_heif_timed_sequences_keep_all_frames(self):
        with patch.object(server, 'run_native', side_effect=self.heif_double('avif', True, 3)) as native:
            proof, *_rest = server.render(self.root, 'avif', True, 'a' * 64, 3, 100)
            self.assertEqual((proof['family'], proof['frameCount'], proof['isSequence']), ('avif', 3, True))
            self.assertFalse(any(str(self.root / 'input.bin') + '[0]' in call.args[0] for call in native.call_args_list))

    def test_heif_declarations_cannot_accept_av1_or_claim_a_still_as_a_sequence(self):
        for declared, actual, sequence_claim in [('heic', 'avif', False), ('heif', 'avif', False), ('heic', 'heic', True)]:
            with self.subTest(declared=declared, actual=actual, sequence_claim=sequence_claim), \
                    patch.object(server, 'run_native', side_effect=self.heif_double(actual)):
                with self.assertRaisesRegex(server.DecodeFailure, 'malformed'):
                    server.render(self.root, declared, sequence_claim, 'a' * 64, 3, 100)

    def render_argv(self, family, frames, sequence=False, canvas=None, raw_rows=None):
        """Render through doubles and return the one final ImageMagick render argv."""
        renders = []
        def native(argv, job, deadline, connection=None, stdout_path=None):
            if stdout_path is None:
                renders.append(argv)
                (job / 'preview.webp').write_bytes(b'encoded-output')
            elif stdout_path.name == 'raw.json':
                stdout_path.write_text(json.dumps({'family': 'dng', 'width': frames[0][1], 'height': frames[0][2], 'frameCount': 1,
                                                   'primaryIndex': 0, 'isSequence': False, 'sdkUsed': True}))
            elif stdout_path.name == 'png.json':
                stdout_path.write_text(json.dumps({'animated': False}))
            elif stdout_path.name == 'container.json':
                stdout_path.write_text(json.dumps({'family': family, 'isSequence': sequence, 'primaryIndex': 0}))
            elif stdout_path.name == 'inspection.txt':
                stdout_path.write_text(raw_rows if raw_rows is not None else self.identified(argv, *frames))
            elif stdout_path.name == 'canvas.txt':
                stdout_path.write_text('%d|%d\n' % (canvas or frames[0][1:3]))
            else:
                stdout_path.write_text('1|1\n' * len(frames))
        with patch.object(server, 'run_native', side_effect=native):
            server.render(self.root, family, sequence, 'a' * 64, 3, 100)
        self.assertEqual(len(renders), 1)
        return renders[0]

    def test_only_single_frames_whose_page_is_the_frame_skip_coalescing(self):
        # Coalescing one frame allocates extra full-resolution pixel caches (a 50 MP still
        # exhausted the policy). When the page equals the frame at +0+0 it is an identity,
        # so +repage is exact. Anything else keeps the previous coalesced semantics.
        cases = [('jpeg still', 'jpeg', [('JPEG', 20, 10, 'TopLeft', 0)], False, None, '+repage'),
                 ('oriented jpeg still', 'jpeg', [('JPEG', 20, 10, 'RightTop', 0)], False, None, '+repage'),
                 ('heic primary', 'heic', [('HEIC', 20, 10, 'TopLeft', 0)], False, None, '+repage'),
                 ('raw', 'dng', [('PPM', 20, 10, 'Undefined', 0)], False, None, '+repage'),
                 ('png still', 'png', [('PNG', 20, 10, 'Undefined', 0)], False, None, '+repage'),
                 ('gif still', 'gif', [('GIF', 20, 10, 'Undefined', 0)], False, (20, 10), '+repage'),
                 ('webp still', 'webp', [('WEBP', 20, 10, 'Undefined', 0)], False, (20, 10), '+repage'),
                 ('gif larger logical screen', 'gif', [('GIF', 20, 10, 'Undefined', 0, (40, 30, 0, 0))], False, (40, 30), '-coalesce'),
                 ('gif still offset', 'gif', [('GIF', 20, 10, 'Undefined', 0, (40, 30, 5, 7))], False, (40, 30), '-coalesce'),
                 ('webp negative offset', 'webp', [('WEBP', 20, 10, 'Undefined', 0, (20, 10, -1, 0))], False, (20, 10), '-coalesce'),
                 ('png oFFs offset', 'png', [('PNG', 20, 10, 'Undefined', 0, (20, 10, 6, 4))], False, None, '-coalesce'),
                 ('tiff position offset', 'tiff', [('TIFF', 20, 10, 'TopLeft', 0, (20, 10, 3, 2))], False, None, '-coalesce'),
                 ('unset page canvas', 'jpeg', [('JPEG', 20, 10, 'TopLeft', 0, (0, 0, 0, 0))], False, None, '-coalesce'),
                 ('gif animation', 'gif', [('GIF', 20, 10, 'Undefined', 5)] * 3, True, (20, 10), '-coalesce'),
                 ('webp animation', 'webp', [('WEBP', 20, 10, 'Undefined', 5)] * 3, True, (20, 10), '-coalesce'),
                 ('jxl animation', 'jxl', [('JXL', 20, 10, 'TopLeft', 5)] * 3, True, None, '-coalesce'),
                 ('avif sequence', 'avif', [('AVIF', 20, 10, 'Undefined', 1024)] * 3, True, None, '-coalesce')]
        for label, family, frames, sequence, canvas, expected in cases:
            with self.subTest(label):
                argv = self.render_argv(family, frames, sequence, canvas)
                other = '-coalesce' if expected == '+repage' else '+repage'
                self.assertEqual((argv.count(expected), argv.count(other)), (1, 0))
                # Page handling happens once, before orientation and any pixel operation.
                self.assertEqual(argv[argv.index(expected) + 1], '-auto-orient')

    def test_unparseable_page_geometry_is_malformed(self):
        for row in ('JPEG|20|10|TopLeft|0|20|10|0|+0\n', 'JPEG|20|10|TopLeft|0|20|ten|+0|+0\n',
                    'JPEG|20|10|TopLeft|0|20|10|+0\n', 'JPEG|20|10|TopLeft|0|20|10|+0|+0|+0\n'):
            with self.subTest(row=row), self.assertRaisesRegex(server.DecodeFailure, 'malformed'):
                self.render_argv('jpeg', [('JPEG', 20, 10, 'TopLeft', 0)], raw_rows=row)

    def test_display_conversion_and_clip_precede_resampling(self):
        # HDRI keeps out-of-gamut values after a wide-gamut -> sRGB transform. Clip them
        # before -resize filters them, then strip metadata and embed sRGB exactly once.
        profile = server.SRGB_PROFILE
        for label, family, frames, sequence, canvas in [
                ('still', 'heic', [('HEIC', 20, 10, 'TopLeft', 0)], False, None),
                ('animation', 'gif', [('GIF', 20, 10, 'Undefined', 5)] * 3, True, (20, 10))]:
            with self.subTest(label):
                argv = self.render_argv(family, frames, sequence, canvas)
                start = argv.index('-auto-orient')
                self.assertEqual(argv[start:start + 9], ['-auto-orient', '-profile', profile, '-clamp', '-resize', '1600x1600>',
                                                         '-strip', '-profile', profile])
                self.assertEqual((argv.count('-profile'), argv.count('-clamp'), argv.count('-resize'), argv.count('-strip')), (2, 1, 1, 1))

    def serve(self, render):
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        http.daemon_threads = True
        thread = threading.Thread(target=http.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        mock = patch.object(server, 'render', side_effect=render)
        mock.start()
        self.addCleanup(mock.stop)
        return http.server_address[1]

    def request(self, port, extra=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        headers = {'X-Decoder-Protocol': '1', 'X-Decoder-Lane': 'upload', 'X-Image-Family': 'jpeg',
                   'X-Image-Sequence': '0', 'X-Source-Length': '3', 'Content-Type': 'application/octet-stream'}
        headers.update(extra or {})
        connection.request('POST', '/v1/inspect', b'abc', headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_one_job_busy_and_success_cleanup(self):
        entered, release = threading.Event(), threading.Event()
        def render(job, *args):
            entered.set()
            if not release.wait(2):
                raise AssertionError('Test barrier timed out')
            return {'sourceSha256': args[2]}, job / 'unused', 1, 1
        port = self.serve(render)
        results = []
        thread = threading.Thread(target=lambda: results.append(self.request(port)))
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.request(port), (429, {'code': 'busy'}))
        finally:
            release.set()
            thread.join(3)
        self.assertEqual(results, [(200, {'sourceSha256': hashlib.sha256(b'abc').hexdigest()})])
        # Receiving the response can precede the handler's finally block.
        self.assertTrue(server.SLOT.acquire(timeout=2))
        try:
            self.assertEqual(list(self.root.iterdir()), [])
        finally:
            server.SLOT.release()

    def test_failure_sanitization_cleanup_and_slot_release(self):
        port = self.serve(lambda *_args: (_ for _ in ()).throw(RuntimeError('SECRET /private/file native stderr')))
        for _ in range(2):
            self.assertEqual(self.request(port), (503, {'code': 'unavailable'}))
            self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.request(port, {'X-Source-Length': '4'}), (422, {'code': 'malformed'}))

    def test_duplicate_http_framing_is_rejected_before_native_work(self):
        render = Mock(return_value=({}, self.root / 'unused', 1, 1))
        port = self.serve(render)
        request = b'POST /v1/inspect HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nX-Decoder-Protocol: 1\r\nX-Decoder-Lane: upload\r\nX-Image-Family: jpeg\r\nX-Image-Sequence: 0\r\nX-Source-Length: 3\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc'
        with socket.create_connection(('127.0.0.1', port), timeout=3) as client:
            client.sendall(request)
            response = client.makefile('rb').read()
        self.assertIn(b'422', response.split(b'\r\n')[0])
        render.assert_not_called()

    @staticmethod
    def reaper(pid, maxrss_kib=0):
        # Running until the blocking reap after SIGKILL; rusage is reported in KiB.
        return lambda _pid, options: (0, 0, None) if options else (pid, 9, Mock(ru_maxrss=maxrss_kib))

    def test_timeout_and_cancel_kill_the_process_group(self):
        for cancel in [False, True]:
            process = Mock(pid=123, returncode=None)
            process.poll.return_value = None
            connection = Mock()
            connection.recv.return_value = b''
            with patch.object(server.subprocess, 'Popen', return_value=process) as popen, \
                 patch.object(server.os, 'killpg', create=True) as kill, \
                 patch.object(server.os, 'wait4', side_effect=self.reaper(123), create=True) as wait4, \
                 patch.object(server.os, 'WNOHANG', 1, create=True), \
                 patch.object(server.os, 'waitstatus_to_exitcode', side_effect=lambda status: -status, create=True), \
                 patch.object(server.signal, 'SIGKILL', 9, create=True), \
                 patch.object(server.select, 'select', return_value=([connection], [], [])):
                with self.assertRaisesRegex(server.DecodeFailure, 'unavailable' if cancel else 'resource_limit'):
                    server.run_native([server.MAGICK, 'input.bin'], self.root, time.monotonic() + (1 if cancel else -1), connection if cancel else None)
                kill.assert_called_once_with(123, 9)
                # The killed child is reaped with wait4 so its rusage is still accounted.
                self.assertEqual(wait4.call_args_list[-1].args, (123, 0))
                self.assertTrue(popen.call_args.kwargs['start_new_session'])
                self.assertNotIn('shell', popen.call_args.kwargs)
                # Native stderr is never inherited by the server (whose own output must stay
                # empty): it goes only to a private file inside this job, removed afterwards.
                stderr = Path(popen.call_args.kwargs['stderr'].name)
                self.assertEqual(stderr.parent, self.root)
                self.assertFalse(stderr.exists())

    def test_short_lived_process_cannot_skip_scratch_limit(self):
        (self.root / 'output').write_bytes(b'12345')
        process = Mock(pid=321, returncode=None)
        process.poll.return_value = 0
        with patch.object(server, 'MAX_SCRATCH', 4), patch.object(server.subprocess, 'Popen', return_value=process), \
             patch.object(server.os, 'wait4', return_value=(321, 0, Mock(ru_maxrss=1)), create=True), \
             patch.object(server.os, 'WNOHANG', 1, create=True), \
             patch.object(server.os, 'waitstatus_to_exitcode', return_value=0, create=True):
            with self.assertRaisesRegex(server.DecodeFailure, 'resource_limit'):
                server.run_native([server.MAGICK], self.root, time.monotonic() + 1)

    def failed_native(self, stderr, before=0, after=0):
        # A real prlimit-wrapped Linux child that writes `before` bytes of warnings, the
        # message, `after` bytes of warnings to stderr and exits 1, like ImageMagick does.
        import sys
        child = ('import sys; w = b"magick: warning `input.bin\' @ warning/tiff.c/TIFFWarnings/1.\\n"; '
                 f'sys.stderr.buffer.write(w * ({before} // len(w)) + bytes.fromhex("{stderr.encode().hex()}") + w * ({after} // len(w))); '
                 'sys.stderr.flush(); sys.exit(1)')
        (self.root / 'input.bin').write_bytes(b'private-source')
        with self.assertRaises(server.DecodeFailure) as caught:
            server.run_native([sys.executable, '-c', child], self.root, time.monotonic() + 60)
        # Only the closed code escapes; native text never enters the exception, response
        # or logs, and the private stderr file is gone with nothing else added to the job.
        self.assertEqual(caught.exception.args, (caught.exception.code,))
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ['input.bin'])
        return caught.exception.code

    def test_native_resource_exhaustion_is_a_resource_limit_not_a_malformed_file(self):
        for message in ["magick: cache resources exhausted `input.bin' @ error/cache.c/OpenPixelCache/4036.\n",
                        "magick: memory allocation failed `input.bin' @ error/heic.c/ReadHEICImage/512.\n",
                        "magick: Memory allocation failed `input.bin' @ fatal/string.c/AcquireString/140.\n",
                        "magick: pixel cache allocation failed `input.bin' @ error/cache.c/OpenPixelCache/3900.\n",
                        "magick: unable to extend cache `input.bin': No space left on device @ error/cache.c/OpenPixelCache/4100.\n",
                        "magick: width or height exceeds limit `input.bin' @ error/cache.c/OpenPixelCache/3923.\n",
                        "magick: Image dimension exceeds maximum supported size `input.bin' @ error/image.c/SetImageExtent/2700.\n",
                        "magick: list length exceeds limit `input.bin' @ error/list.c/AppendImageToList/100.\n",
                        "magick: time limit exceeded `input.bin' @ fatal/cache.c/GetImagePixelCache/1714.\n",
                        "magick: Memory allocation error: Security limit exceeded: Image size 70000x70000 exceeds the maximum image size 32768x32768 `input.bin' @ error/heic.c/IsHEIFSuccess/140.\n"]:
            with self.subTest(message=message):
                self.assertEqual(self.failed_native(message), 'resource_limit')

    def test_corrupt_or_silent_native_failures_stay_malformed(self):
        for message in ["magick: improper image header `input.bin' @ error/png.c/ReadPNGImage/4214.\n",
                        "magick: insufficient image data in file `input.bin' @ error/jpeg.c/ReadJPEGImage/1200.\n",
                        "magick: Invalid input: Unsupported feature: Unsupported codec `input.bin' @ error/heic.c/IsHEIFSuccess/140.\n",
                        "magick: too many exceptions (exceeds 200 frames) `input.bin' @ error/tiff.c/TIFFErrors/650.\n", '']:
            with self.subTest(message=message):
                self.assertEqual(self.failed_native(message), 'malformed')

    def test_native_failure_classification_reads_only_a_bounded_window(self):
        exhausted = "magick: cache resources exhausted `input.bin' @ error/cache.c/OpenPixelCache/4036.\n"
        corrupt = "magick: improper image header `input.bin' @ error/png.c/ReadPNGImage/4214.\n"
        # A warning flood cannot hide the final error, nor turn corrupt input into a limit.
        self.assertEqual(self.failed_native(exhausted, before=4 * 1024 * 1024), 'resource_limit')
        self.assertEqual(self.failed_native(corrupt, before=4 * 1024 * 1024), 'malformed')
        # Text beyond both bounded windows is never read.
        self.assertEqual(self.failed_native(exhausted, before=1024 * 1024, after=1024 * 1024), 'malformed')

    def test_successful_native_runs_leave_no_private_stderr(self):
        import sys
        output = self.root / 'out.txt'
        server.run_native([sys.executable, '-c', 'import sys; sys.stderr.write("warning only\\n"); print("ok")'],
                          self.root, time.monotonic() + 60, stdout_path=output)
        self.assertEqual(output.read_text(), 'ok\n')
        self.assertEqual([path.name for path in self.root.iterdir()], ['out.txt'])

    def test_native_job_measures_actual_child_peak_rss_scratch_and_wall_time(self):
        # Real prlimit-executed children on Linux; the largest native invocation wins.
        import sys
        child = ('import time; b = bytearray({size}); b[::4096] = b"\\x01" * len(range(0, len(b), 4096)); '
                 'open("scratch-{size}.bin", "wb").write(b"s" * {scratch}); time.sleep(0.05)')
        metrics = server.JobMetrics()
        with patch.object(server.JOB, 'metrics', metrics, create=True):
            server.run_native([sys.executable, '-c', child.format(size=96 * 1024 * 1024, scratch=1024 * 1024)], self.root, time.monotonic() + 60)
            first = metrics.peak_rss
            server.run_native([sys.executable, '-c', child.format(size=8 * 1024 * 1024, scratch=1024)], self.root, time.monotonic() + 60)
        self.assertGreaterEqual(first, 96 * 1024 * 1024)
        self.assertLess(first, 3 * 1024 ** 3)
        self.assertEqual(metrics.peak_rss, first)
        self.assertGreaterEqual(metrics.peak_scratch, 1024 * 1024 + 1024)
        self.assertGreaterEqual(metrics.native_ms(), 100)
        values = json.loads(metrics.header())
        self.assertEqual(set(values), {'nativeMs', 'peakRssBytes', 'peakScratchBytes', 'sourceBytes'})
        self.assertTrue(all(type(value) is int and value >= 0 for value in values.values()))

    def test_metrics_header_is_compact_bounded_integers(self):
        metrics = server.JobMetrics()
        metrics.native_ns, metrics.peak_rss, metrics.peak_scratch, metrics.source_bytes = (2 ** 63,) * 4
        header = metrics.header()
        self.assertLessEqual(len(header.encode()), 512)
        self.assertNotIn(' ', header)
        self.assertEqual(json.loads(header)['sourceBytes'], 2 ** 63)

    def response(self, port, extra=None, path='/v1/inspect'):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        headers = {'X-Decoder-Protocol': '1', 'X-Decoder-Lane': 'upload', 'X-Image-Family': 'jpeg',
                   'X-Image-Sequence': '0', 'X-Source-Length': '3', 'Content-Type': 'application/octet-stream'}
        headers.update(extra or {})
        connection.request('POST', path, b'abc', headers)
        response = connection.getresponse()
        result = response.status, response.getheader('X-Decoder-Metrics'), response.read()
        connection.close()
        self.assertTrue(server.SLOT.acquire(timeout=2))
        server.SLOT.release()
        return result

    def measured_render(self, failure=None):
        def render(job, *args):
            metrics = server.current_metrics()
            metrics.native_ns, metrics.peak_rss, metrics.peak_scratch = 12_300_000, 7 * 1024 ** 2, 4096
            if failure:
                raise server.DecodeFailure(failure)
            (job / 'preview.webp').write_bytes(b'webp')
            return {'sourceSha256': args[2], 'frameCount': 1}, job / 'preview.webp', 1, 1
        return render

    def test_success_and_closed_failures_after_a_job_carry_one_private_metrics_header(self):
        port = self.serve(self.measured_render())
        for path in ('/v1/inspect', '/v1/preview'):
            status, header, _body = self.response(port, path=path)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(header), {'nativeMs': 13, 'peakRssBytes': 7 * 1024 ** 2, 'peakScratchBytes': 4096, 'sourceBytes': 3})
        failing = self.serve(self.measured_render('malformed'))
        status, header, body = self.response(failing)
        self.assertEqual((status, json.loads(body)), (422, {'code': 'malformed'}))
        self.assertEqual(json.loads(header)['nativeMs'], 13)
        self.assertLessEqual(len(header), 512)

    def test_no_metrics_header_without_a_job(self):
        port = self.serve(self.measured_render())
        status, header, _body = self.response(port, {'X-Decoder-Lane': 'guest'})
        self.assertEqual((status, header), (422, None))
        entered, release = threading.Event(), threading.Event()
        def held(job, *args):
            entered.set()
            release.wait(2)
            return {'sourceSha256': args[2]}, job / 'unused', 1, 1
        busy = self.serve(held)
        worker = threading.Thread(target=lambda: self.request(busy))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            connection = http.client.HTTPConnection('127.0.0.1', busy, timeout=3)
            connection.request('POST', '/v1/inspect', b'abc', {'X-Decoder-Protocol': '1'})
            response = connection.getresponse()
            self.assertEqual((response.status, response.getheader('X-Decoder-Metrics')), (429, None))
            response.read()
            connection.close()
        finally:
            release.set()
            worker.join(3)

    def test_policy_disables_arbitrary_delegates_documents_and_urls(self):
        policies = [node.attrib for node in ET.parse(Path(server.__file__).with_name('policy.xml')).getroot()]
        for domain in ['delegate', 'filter', 'coder']:
            self.assertIn({'domain': domain, 'rights': 'none', 'pattern': '*'}, policies)
        allowed = ','.join(item['pattern'] for item in policies if item.get('domain') == 'coder' and item.get('rights') != 'none')
        for coder in ['URL', 'HTTP', 'HTTPS', 'PDF', 'PS', 'MVG', 'MSL', 'SVG']:
            self.assertNotIn(coder, allowed)

    def png_chunk(self, kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    def apng(self, *, poster=False, count=2, sequence=1, x=0, dispose=2, blend=0):
        chunk = self.png_chunk
        control = lambda seq, d, b: chunk(b'fcTL', struct.pack('>IIIIIHHBB', seq, 2, 1, x, 0, 1, 20, d, b))
        pixels = zlib.compress(b'\0' + bytes([255, 0, 0, 255]) * 2)
        header = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 1, 8, 6, 0, 0, 0))
        header += chunk(b'acTL', struct.pack('>II', count, 3))
        if poster:
            header += chunk(b'IDAT', pixels) + control(0, 0, 0) + chunk(b'fdAT', struct.pack('>I', 1) + pixels)
            sequence += 1
        else:
            header += control(0, 0, 0) + chunk(b'IDAT', pixels)
        return header + control(sequence, dispose, blend) + chunk(b'fdAT', struct.pack('>I', sequence + 1) + pixels) + chunk(b'IEND', b'')

    def test_apng_demux_keeps_timing_blend_disposal_and_excludes_poster(self):
        from inspect_png import inspect
        for poster in (False, True):
            with self.subTest(poster=poster), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / 'input.bin'
                data = self.apng(poster=poster)
                source.write_bytes(data)
                proof = inspect(source, root)
                self.assertEqual((proof['width'], proof['height'], proof['loops']), (2, 1, 3))
                self.assertEqual(len(proof['frames']), 2)
                self.assertEqual(proof['frames'][1], {'width': 2, 'height': 1, 'x': 0, 'y': 0,
                                  'numerator': 1, 'denominator': 20, 'dispose': 2, 'blend': 0})
                self.assertEqual(len(list(root.glob('png-frame-*.png'))), 2)
                self.assertEqual(source.read_bytes(), data)
                with (root / 'png-frame-0001.png').open('rb') as frame:
                    self.assertTrue(frame.read().endswith(self.png_chunk(b'IEND', b'')))

    def test_apng_render_uses_canvas_and_preserves_native_frame_controls(self):
        def native(argv, job, deadline, connection=None, stdout_path=None):
            if stdout_path and stdout_path.name == 'png.json':
                stdout_path.write_text(json.dumps({'animated': True, 'width': 20, 'height': 10, 'loops': 3,
                    'frames': [{'width': 20, 'height': 10, 'x': 0, 'y': 0, 'numerator': 1, 'denominator': 20, 'dispose': 0, 'blend': 0},
                               {'width': 2, 'height': 2, 'x': 3, 'y': 2, 'numerator': 3, 'denominator': 100, 'dispose': 2, 'blend': 1}]}))
            elif stdout_path:
                stdout_path.write_text(self.identified(argv, ('PNG', 20, 10, 'TopLeft', 5), ('PNG', 2, 2, 'TopLeft', 3))
                                       if stdout_path.name == 'inspection.txt' else '20|10\n20|10\n')
            else:
                # The composited APNG canvas always coalesces its placed frames.
                self.assertIn('-coalesce', argv)
                self.assertNotIn('+repage', argv)
                self.assertIn('1x20', argv)
                self.assertIn('3x100', argv)
                self.assertIn('20x10+3+2', argv)
                self.assertIn('Previous', argv)
                self.assertIn('AtopBackgroundAlphaBlend', argv)
                self.assertIn('webp:exact=true', argv)
                (job / 'preview.webp').write_bytes(b'frames')
        # Sequence detection comes from bytes even when the caller claims a still.
        with patch.object(server, 'run_native', side_effect=native):
            proof, *_ = server.render(self.root, 'png', False, 'a' * 64, 3, 100)
        self.assertEqual((proof['width'], proof['height'], proof['frameCount'], proof['isSequence']), (20, 10, 2, True))

    def test_apng_rejects_bad_crc_sequence_bounds_controls_and_frame_count(self):
        from inspect_png import inspect, PngFailure
        valid = self.apng()
        corrupt = valid[:-1] + bytes([valid[-1] ^ 1])
        for data in (corrupt, valid[:-1], valid + b'junk', self.apng(sequence=7), self.apng(x=1),
                     self.apng(dispose=3), self.apng(blend=2), self.apng(count=1), self.apng(count=0)):
            with self.subTest(data=data[-20:]), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'input.bin').write_bytes(data)
                with self.assertRaisesRegex(PngFailure, 'malformed'):
                    inspect(root / 'input.bin', root)

    def test_apng_checks_canvas_frame_budget_before_native_allocation(self):
        from inspect_png import inspect, PngFailure
        for count in (1025, 1000):
            chunk = self.png_chunk
            data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2000, 2000, 8, 6, 0, 0, 0))
            data += chunk(b'acTL', struct.pack('>II', count, 0)) + chunk(b'IEND', b'')
            (self.root / 'input.bin').write_bytes(data)
            with self.assertRaisesRegex(PngFailure, 'resource_limit'):
                inspect(self.root / 'input.bin', self.root)


if __name__ == '__main__':
    unittest.main()

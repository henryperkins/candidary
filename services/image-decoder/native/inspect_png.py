"""Bounded PNG/APNG demux; pixels remain decoded by the pinned native PNG coder.

The fixed-path subprocess validates chunk CRCs and APNG ordering, then writes
standalone PNG frame rectangles. No guest text becomes a filename or recipe.
"""
import json
from pathlib import Path
import struct
import zlib

SIGNATURE = b'\x89PNG\r\n\x1a\n'
SHARED = {b'PLTE', b'tRNS', b'gAMA', b'cHRM', b'iCCP', b'sRGB', b'sBIT', b'eXIf'}


class PngFailure(Exception):
    pass


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def inspect(source, directory):
    frames, segments, shared = [], [], []
    width = height = count = loops = header = None
    sequence = shared_size = 0
    seen_idat = idat_ended = frame_uses_idat = False
    current = None
    with source.open('rb') as stream:
        def read(length):
            data = stream.read(length)
            if len(data) != length:
                raise PngFailure('malformed')
            return data

        if read(8) != SIGNATURE:
            raise PngFailure('malformed')
        for number in range(65536):
            length, kind = struct.unpack('>I4s', read(8))
            if length > 512 * 1024**2:
                raise PngFailure('resource_limit')
            if not all(65 <= char <= 90 or 97 <= char <= 122 for char in kind):
                raise PngFailure('malformed')
            if not kind[0] & 32 and kind not in (b'IHDR', b'PLTE', b'IDAT', b'IEND'):
                raise PngFailure('unsupported')
            limits = {b'IHDR': 13, b'acTL': 8, b'fcTL': 26, b'IEND': 0}
            if kind in limits and length != limits[kind]:
                raise PngFailure('malformed')
            if kind in SHARED:
                shared_size += length + 12
                if shared_size > 4 * 1024**2:
                    raise PngFailure('resource_limit')
                if seen_idat and kind != b'eXIf':
                    raise PngFailure('malformed')
            capture = kind in SHARED or kind in limits
            start = stream.tell()
            crc, remaining, data, first = zlib.crc32(kind), length, bytearray(), b''
            while remaining:
                part = read(min(remaining, 65536))
                if not first:
                    first = part[:4]
                crc = zlib.crc32(part, crc)
                if capture:
                    data.extend(part)
                remaining -= len(part)
            if struct.unpack('>I', read(4))[0] != crc:
                raise PngFailure('malformed')
            if number == 0 and kind != b'IHDR':
                raise PngFailure('malformed')
            if kind == b'IHDR':
                if header is not None:
                    raise PngFailure('malformed')
                header = bytes(data)
                width, height = struct.unpack('>II', header[:8])
                if not width or not height:
                    raise PngFailure('malformed')
                if width * height > 300_000_000:
                    raise PngFailure('resource_limit')
            if seen_idat and kind != b'IDAT':
                idat_ended = True
            if kind == b'acTL':
                if count is not None or seen_idat:
                    raise PngFailure('malformed')
                count, loops = struct.unpack('>II', data)
                if count == 0:
                    raise PngFailure('malformed')
                if count > 1024 or width * height * count > 1_000_000_000:
                    raise PngFailure('resource_limit')
            elif kind == b'fcTL':
                if count is None or len(frames) >= count or (current is not None and not segments[-1]):
                    raise PngFailure('malformed')
                seq, w, h, x, y, numerator, denominator, dispose, blend = struct.unpack('>IIIIIHHBB', data)
                if seq != sequence or not w or not h or x + w > width or y + h > height or dispose > 2 or blend > 1:
                    raise PngFailure('malformed')
                if not seen_idat and (frames or (w, h, x, y) != (width, height, 0, 0)):
                    raise PngFailure('malformed')
                sequence += 1
                frame_uses_idat = not seen_idat
                current = {'width': w, 'height': h, 'x': x, 'y': y, 'numerator': numerator,
                           'denominator': denominator or 100, 'dispose': dispose, 'blend': blend}
                frames.append(current)
                segments.append([])
            elif kind == b'IDAT':
                if idat_ended:
                    raise PngFailure('malformed')
                seen_idat = True
                if current is not None:
                    segments[-1].append((start, length))
            elif kind == b'fdAT':
                if not seen_idat or current is None or frame_uses_idat or length < 4 or struct.unpack('>I', first)[0] != sequence:
                    raise PngFailure('malformed')
                sequence += 1
                segments[-1].append((start + 4, length - 4))
            elif kind in SHARED:
                shared.append(chunk(kind, bytes(data)))
            elif kind == b'IEND':
                if not seen_idat or stream.read(1):
                    raise PngFailure('malformed')
                break
        else:
            raise PngFailure('resource_limit')
        if count is None:
            return {'animated': False}
        if len(frames) != count or any(not parts for parts in segments):
            raise PngFailure('malformed')
        # Only bounded offsets into the unchanged original are used in pass two.
        for index, (frame, parts) in enumerate(zip(frames, segments)):
            with (directory / f'png-frame-{index:04}.png').open('wb') as output:
                output.write(SIGNATURE)
                output.write(chunk(b'IHDR', struct.pack('>II', frame['width'], frame['height']) + header[8:]))
                for item in shared:
                    output.write(item)
                for offset, length in parts:
                    stream.seek(offset)
                    output.write(struct.pack('>I4s', length, b'IDAT'))
                    crc = zlib.crc32(b'IDAT')
                    while length:
                        data = read(min(length, 65536))
                        output.write(data)
                        crc = zlib.crc32(data, crc)
                        length -= len(data)
                    output.write(struct.pack('>I', crc))
                output.write(chunk(b'IEND', b''))
    return {'animated': True, 'width': width, 'height': height, 'loops': loops, 'frames': frames}


if __name__ == '__main__':
    try:
        result = inspect(Path('input.bin'), Path('.'))
    except PngFailure as error:
        result = {'error': str(error)}
    except (MemoryError, OSError):
        result = {'error': 'resource_limit'}
    except Exception:
        result = {'error': 'malformed'}
    print(json.dumps(result, separators=(',', ':')))

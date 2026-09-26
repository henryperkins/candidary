"""Fixed-path HEIF container inspection, run only inside the bounded child process.

Use actual item/track codecs and the primary item, not an extension or ftyp brand
as codec proof. Pixel decoding remains the separate ImageMagick/libheif step.
"""
import ctypes as c
import json
from pathlib import Path

LIMIT = 16384


class HeifError(c.Structure):
    _fields_ = [('code', c.c_int), ('subcode', c.c_int), ('message', c.c_char_p)]


class Refusal(Exception):
    pass


def fourcc(value):
    return int.from_bytes(value.encode('ascii'), 'big')


def inspect():
    lib = c.CDLL('/opt/decoder/lib/libheif.so')
    ptr, u32 = c.c_void_p, c.c_uint32
    signatures = {
        'heif_init': (HeifError, [ptr]), 'heif_deinit': (None, []),
        'heif_has_compatible_filetype': (HeifError, [ptr, c.c_int]),
        'heif_context_alloc': (ptr, []), 'heif_context_free': (None, [ptr]),
        'heif_context_read_from_file': (HeifError, [ptr, c.c_char_p, ptr]),
        'heif_context_has_sequence': (c.c_int, [ptr]),
        'heif_context_get_primary_image_ID': (HeifError, [ptr, c.POINTER(u32)]),
        'heif_context_get_number_of_top_level_images': (c.c_int, [ptr]),
        'heif_context_get_list_of_top_level_image_IDs': (c.c_int, [ptr, c.POINTER(u32), c.c_int]),
        'heif_item_get_item_type': (u32, [ptr, u32]),
        'heif_context_get_item_references': (c.c_size_t, [ptr, u32, c.c_int, c.POINTER(u32), c.POINTER(c.POINTER(u32))]),
        'heif_release_item_references': (None, [ptr, c.POINTER(c.POINTER(u32))]),
        'heif_context_get_track': (ptr, [ptr, u32]),
        'heif_track_release': (None, [ptr]),
        'heif_track_get_sample_entry_type_of_first_cluster': (u32, [ptr]),
    }
    for name, (result, arguments) in signatures.items():
        function = getattr(lib, name)
        function.restype, function.argtypes = result, arguments

    def check(error):
        if error.code:
            raise Refusal('resource_limit' if error.code == 6 else 'malformed')

    check(lib.heif_init(None))
    context = None
    try:
        with Path('input.bin').open('rb') as source:
            header = source.read(65536)
        if lib.heif_has_compatible_filetype(header, len(header)).code:
            raise Refusal('unsupported')
        context = lib.heif_context_alloc()
        if not context:
            raise Refusal('resource_limit')
        check(lib.heif_context_read_from_file(context, b'input.bin', None))
        codecs = {fourcc('hvc1'): 'heic', fourcc('hev1'): 'heic', fourcc('av01'): 'avif'}
        if lib.heif_context_has_sequence(context):
            track = lib.heif_context_get_track(context, 0)
            if not track:
                raise Refusal('malformed')
            try:
                family = codecs.get(lib.heif_track_get_sample_entry_type_of_first_cluster(track))
            finally:
                lib.heif_track_release(track)
            if family is None:
                raise Refusal('unsupported')
            return {'family': family, 'isSequence': True, 'primaryIndex': 0}

        primary = u32()
        check(lib.heif_context_get_primary_image_ID(context, c.byref(primary)))
        count = lib.heif_context_get_number_of_top_level_images(context)
        if not 0 < count <= LIMIT:
            raise Refusal('resource_limit')
        visible = (u32 * count)()
        if lib.heif_context_get_list_of_top_level_image_IDs(context, visible, count) != count:
            raise Refusal('malformed')
        if primary.value not in visible:
            raise Refusal('malformed')

        seen, cached = set(), {}
        work = 0

        def item_family(item, depth=0):
            nonlocal work
            work += 1
            if work > LIMIT or depth > 16:
                raise Refusal('resource_limit')
            if item in seen:
                raise Refusal('malformed')
            if item in cached:
                return cached[item]
            kind = lib.heif_item_get_item_type(context, item)
            if kind in codecs:
                return codecs[kind]
            if kind not in (fourcc('grid'), fourcc('iden'), fourcc('iovl')):
                raise Refusal('unsupported')
            seen.add(item)
            families = set()
            for index in range(LIMIT):
                reference_type, references = u32(), c.POINTER(u32)()
                length = lib.heif_context_get_item_references(context, item, index, c.byref(reference_type), c.byref(references))
                try:
                    if length == 0:
                        break
                    if length > LIMIT - work:
                        raise Refusal('resource_limit')
                    if reference_type.value == fourcc('dimg'):
                        families.update(item_family(references[n], depth + 1) for n in range(length))
                finally:
                    lib.heif_release_item_references(context, c.byref(references))
            else:
                raise Refusal('resource_limit')
            seen.remove(item)
            if len(families) != 1:
                raise Refusal('unsupported')
            cached[item] = families.pop()
            return cached[item]

        return {'family': item_family(primary.value), 'isSequence': False,
                'primaryIndex': list(visible).index(primary.value)}
    finally:
        if context:
            lib.heif_context_free(context)
        lib.heif_deinit()


if __name__ == '__main__':
    try:
        result = inspect()
    except Refusal as error:
        result = {'error': str(error)}
    except Exception:
        result = {'error': 'unavailable'}
    print(json.dumps(result, separators=(',', ':')))

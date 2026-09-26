"""Focused reference-tool refusal checks plus an opt-in real-file reproduction."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPOSITORY = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('mobile_references', REPOSITORY / 'scripts/fetch-mobile-image-fixtures.py')
references = importlib.util.module_from_spec(spec)
spec.loader.exec_module(references)
SOURCE = REPOSITORY / 'tests/fixtures/mobile-images/originals/galaxy-s22-jxl.dng'
EXPECTED = {'width': 4000, 'height': 3000, 'frames': 1, 'orientation': 6}


class IndependentAdobeReferenceTests(unittest.TestCase):
    def test_missing_independent_tool_fails_closed(self):
        with patch.dict(os.environ, {'CANDIDARY_ADOBE_DNG_CONVERTER': ''}):
            with self.assertRaisesRegex(RuntimeError, 'CANDIDARY_ADOBE_DNG_CONVERTER'):
                references.adobe_raw_reference(SOURCE, EXPECTED)

    def test_unpinned_tool_is_never_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'converter.exe'
            binary.write_bytes(b'unreviewed executable')
            with patch.dict(os.environ, {'CANDIDARY_ADOBE_DNG_CONVERTER': str(binary)}):
                with patch.object(references.subprocess, 'run') as launch:
                    with self.assertRaisesRegex(RuntimeError, 'hash'):
                        references.adobe_raw_reference(SOURCE, EXPECTED)
                    launch.assert_not_called()

    @unittest.skipUnless(os.environ.get('CANDIDARY_ADOBE_DNG_CONVERTER') and SOURCE.is_file(),
                         'Requires the pinned independent Windows converter in WSL and the downloaded original')
    def test_real_phone_reference_matches_pin_and_preserves_original(self):
        original = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        actual = references.adobe_raw_reference(SOURCE, EXPECTED)
        self.assertEqual(hashlib.sha256(actual).hexdigest(),
                         '5292d3b03cffd1bc54f63f26fb73ad22a7e53c39ba2b394efa3fa07667c567fa')
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(), original)


if __name__ == '__main__':
    unittest.main()

"""File-integrity and encoder-boundary tests; no model or prompt simulation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageCms, PngImagePlugin

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare-images.py"
SPEC = importlib.util.spec_from_file_location("prepare_images", SCRIPT)
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.output = self.root / "inputs"
        self.source = self.root / "source.png"
        Image.new("RGB", (320, 240), "#dbe9f8").save(self.source, compress_level=0)
        self.original = self.source.read_bytes()

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, source=None, **kwargs):
        result = PREPARE.prepare(source or self.source, self.output, **kwargs)
        self.assertEqual(self.source.read_bytes(), self.original)
        return result

    @unittest.skipUnless(shutil.which("cwebp"), "cwebp is required for real encoder verification")
    def test_compressed_copy_preserves_dimensions_icc_and_source(self):
        icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        Image.new("RGB", (320, 240), "#dbe9f8").save(self.source, compress_level=0, icc_profile=icc)
        self.original = self.source.read_bytes()
        result = self.prepare()
        self.assertEqual(result["decision"], "compressed")
        target = Path(result["input"]["path"])
        encoded = target.read_bytes()
        self.assertLess(len(encoded), len(self.original))
        self.assertNotEqual(target, self.source)
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(self.original).hexdigest())
        self.assertEqual(result["input"]["sha256"], hashlib.sha256(encoded).hexdigest())
        with Image.open(target) as decoded:
            decoded.load()
            self.assertEqual(decoded.size, (320, 240))
            self.assertEqual(decoded.info.get("icc_profile"), icc)
        self.assertEqual(list(self.output.glob(".image-reading-*")), [])
        self.assertEqual(self.prepare()["input"], result["input"])

    @unittest.skipUnless(shutil.which("cwebp"), "cwebp is required")
    def test_existing_file_and_symlink_are_never_replaced(self):
        self.output.mkdir()
        destination = self.output / (hashlib.sha256(self.original).hexdigest() + ".q95.webp")
        destination.write_bytes(b"owned by another task")
        self.assertEqual(self.prepare()["reason"], "output_conflict")
        self.assertEqual(destination.read_bytes(), b"owned by another task")
        destination.unlink()
        try:
            destination.symlink_to(self.source)
        except OSError:
            self.skipTest("symlinks unavailable")
        self.assertEqual(self.prepare()["reason"], "output_conflict")
        self.assertTrue(destination.is_symlink())

    def test_unsupported_images_remain_original(self):
        cases = []
        transparent = self.root / "alpha.png"
        Image.new("RGBA", (20, 20), (0, 0, 0, 128)).save(transparent)
        cases.append((transparent, "transparency"))
        deep = self.root / "deep.png"
        Image.new("I;16", (20, 20), 30000).save(deep)
        cases.append((deep, "unsupported_bit_depth"))
        animated = self.root / "animated.png"
        Image.new("RGB", (20, 20), "red").save(animated, save_all=True,
            append_images=[Image.new("RGB", (20, 20), "blue")], duration=100)
        cases.append((animated, "animated_or_multiframe"))
        rotated = self.root / "rotated.jpg"
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (20, 30)).save(rotated, exif=exif)
        cases.append((rotated, "exif_orientation"))
        gamma = self.root / "gamma.png"
        chunks = PngImagePlugin.PngInfo()
        chunks.add(b"gAMA", (100000).to_bytes(4, "big"))
        Image.new("RGB", (20, 30)).save(gamma, pnginfo=chunks)
        cases.append((gamma, "unsupported_color_metadata"))
        for source, reason in cases:
            with self.subTest(reason=reason):
                before = source.read_bytes()
                result = self.prepare(source)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(result["decision"], "original")
                self.assertEqual(Path(result["input"]["path"]), source.resolve())
                self.assertEqual(source.read_bytes(), before)
        self.assertFalse(self.output.exists())

    def test_original_requested_and_missing_dependencies(self):
        self.assertEqual(self.prepare(original=True)["reason"], "original_requested")
        self.assertEqual(self.prepare(cwebp="missing-image-reading-encoder")["reason"], "encoder_unavailable")
        with patch.object(PREPARE, "Image", None):
            result = self.prepare()
        self.assertEqual(result["reason"], "pillow_unavailable")
        self.assertFalse(result["verified"])
        self.assertFalse(self.output.exists())

    def test_source_change_during_encoding_is_rejected(self):
        def changed(*args, **kwargs):
            self.source.write_bytes(b"source changed by producer")
            return subprocess.CompletedProcess(args[0], 1)
        with patch.object(PREPARE.shutil, "which", return_value="encoder"), \
                patch.object(PREPARE.subprocess, "run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "source_changed_during_preparation"):
                PREPARE.prepare(self.source, self.output)
        self.assertEqual(self.source.read_bytes(), b"source changed by producer")
        self.assertEqual(list(self.output.glob("*.webp")), [])

    def test_invalid_or_wrong_size_encoder_output_is_not_published(self):
        for wrong_size in (False, True):
            def bad_output(command, **kwargs):
                if wrong_size:
                    Image.new("RGB", (10, 10)).save(command[-1], format="WEBP")
                else:
                    Path(command[-1]).write_bytes(b"broken encoder output")
                return subprocess.CompletedProcess(command, 0)
            with patch.object(PREPARE.shutil, "which", return_value="encoder"), \
                    patch.object(PREPARE.subprocess, "run", side_effect=bad_output):
                result = self.prepare()
            self.assertEqual(result["decision"], "original")
            self.assertEqual(result["reason"], "output_metadata_mismatch" if wrong_size else "output_decode_failed")
            self.assertEqual(list(self.output.glob("*.webp")), [])

    @unittest.skipUnless(shutil.which("cwebp"), "cwebp is required")
    def test_larger_encoding_keeps_original(self):
        # Carrying this legitimate metadata makes WebP larger than a tiny input.
        with patch.object(PREPARE.subprocess, "run") as run:
            def larger(command, **kwargs):
                candidate = Path(command[-1])
                Image.new("RGB", (320, 240), "#dbe9f8").save(candidate, format="WEBP",
                    quality=95, xmp=b"x" * (len(self.original) + 100))
                return subprocess.CompletedProcess(command, 0)
            run.side_effect = larger
            result = self.prepare()
        self.assertEqual(result["reason"], "not_smaller")
        self.assertEqual(result["decision"], "original")

    def test_cli_rejects_invalid_input_without_pixel_payload(self):
        invalid = self.root / "invalid.png"
        invalid.write_bytes(b"not an image")
        run = subprocess.run([sys.executable, "-B", str(SCRIPT), "--output-dir", str(self.output),
                              "--", str(invalid), str(self.source)], capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        manifest = json.loads(run.stdout)
        self.assertEqual(manifest["images"][0]["decision"], "rejected")
        self.assertIsNone(manifest["images"][0]["input"])
        self.assertNotEqual(manifest["images"][1]["decision"], "rejected")
        self.assertNotIn("data:image", run.stdout)
        self.assertNotIn("base64", run.stdout)


if __name__ == "__main__":
    unittest.main()

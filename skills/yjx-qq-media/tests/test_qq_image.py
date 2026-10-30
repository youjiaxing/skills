"""Protocol, source-association and credential-boundary tests; no live QQ access."""
import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

SPEC = importlib.util.spec_from_file_location(
    "qq_image", Path(__file__).resolve().parents[1] / "scripts" / "qq_image.py")
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6"
    "wWQAAAAASUVORK5CYII=")
KEY = "synthetic_download_key_1234567890"
URL = "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=synthetic_file_12345&spec=0"


def varint(value):
    data = bytearray()
    while value >= 128:
        data.append((value & 127) | 128)
        value >>= 7
    return bytes(data + bytes([value]))


def field(number, data):
    return varint((number << 3) | 2) + varint(len(data)) + data


def picture(digest, file_id):
    name = (digest + ".jpg").encode()
    path = ("/download?appid=1407&fileid=" + file_id + "&spec=0").encode()
    thumb = path.replace(b"spec=0", b"spec=720")
    return field(12, name) + field(42, thumb) + field(43, path)


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.resource = {"md5": hashlib.md5(PNG).hexdigest(), "url": URL}

    def test_two_pictures_remain_associated_with_their_own_urls(self):
        a, b = "1" * 32, "2" * 32
        blob = field(1, picture(a, "synthetic_file_a")) + field(1, picture(b, "synthetic_file_b"))
        resources = {r["md5"]: r["url"] for r in media.resources_from_blob(blob)}
        self.assertIn("fileid=synthetic_file_a", resources[a])
        self.assertIn("fileid=synthetic_file_b", resources[b])

    def test_truncated_message_does_not_invent_a_resource(self):
        blob = field(1, picture("1" * 32, "synthetic_file_a"))
        self.assertEqual(media.resources_from_blob(blob[:-1]), [])

    def test_download_rejects_changed_host_scheme_duplicate_and_extra_parameters(self):
        for url in (URL.replace("https:", "http:"), URL.replace(media.HOST, "example.invalid"),
                    URL + "&spec=0", URL + "&redirect=https://example.invalid"):
            with self.subTest(url=url), self.assertRaises(media.ImageError):
                media.validated_url(url)

    def test_download_checks_original_md5_before_creating_a_file(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(PNG)
        bad = dict(self.resource, md5="0" * 32)
        with patch.object(media.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(media.ImageError, "MD5"):
                media.fetch(bad, self.directory, lambda: [KEY])
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_success_is_cached_and_never_reloads_runtime_keys(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(PNG)
        with patch.object(media.urllib.request, "build_opener", return_value=opener):
            result = media.fetch(self.resource, self.directory, lambda: [KEY])
        loader = Mock(side_effect=AssertionError("No token read for a valid cache"))
        cached = media.fetch(self.resource, self.directory, loader)
        self.assertFalse(result["cached"])
        self.assertTrue(cached["cached"])
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertNotIn(KEY, str(result))

    def test_explicit_rkey_and_appid_mismatches_try_the_next_saved_key(self):
        opener = Mock()
        for retcode in (-5503010, -5503023, -5503007):
            error = urllib.error.HTTPError(URL, 400, "bad key", {},
                                           io.BytesIO(b'{"retcode": %d}' % retcode))
            opener.open.side_effect = [error, io.BytesIO(PNG)]
            with self.subTest(retcode=retcode), patch.object(
                    media.urllib.request, "build_opener", return_value=opener):
                media.fetch(self.resource, self.directory, lambda: [KEY + "a", KEY + "b"])
            self.assertEqual(opener.open.call_count, 2)
        self.assertTrue(any(self.directory.iterdir()))

    def test_timeout_does_not_retry_or_expose_the_authenticated_url(self):
        opener = Mock()
        opener.open.side_effect = TimeoutError(URL + "&rkey=" + KEY)
        with patch.object(media.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(media.ImageError) as raised:
                media.fetch(self.resource, self.directory, lambda: [KEY + "a", KEY + "b"])
        self.assertNotIn(KEY, str(raised.exception))
        self.assertEqual(opener.open.call_count, 1)

    def test_redirect_is_not_followed(self):
        self.assertIsNone(media._NoRedirect().redirect_request(
            None, None, 302, "redirect", {}, "https://example.invalid"))

    def test_nonimage_and_oversized_responses_never_reach_cache(self):
        for body in (b'{"error":"not an image"}', b"x" * (media.MAX_IMAGE_BYTES + 1)):
            opener = Mock()
            opener.open.return_value = io.BytesIO(body)
            with self.subTest(length=len(body)):
                with patch.object(media.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaises(media.ImageError):
                        media.fetch(self.resource, self.directory, lambda: [KEY])
                self.assertEqual(list(self.directory.iterdir()), [])


if __name__ == "__main__":
    unittest.main()

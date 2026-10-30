"""Download QQNT image resources extracted from an explicitly selected message.

No QQ database access, message sending, client injection, or persistent tokens.
The caller owns message selection and the private output directory.
"""
import ctypes
import hashlib
import io
import csv
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_NAME = re.compile(rb"\$?([0-9a-fA-F]{32})\.(jpg|jpeg|png|gif|webp|bmp)")
RKEY = re.compile(rb'(?:[?&]rkey=|"rkey"\s*:\s*")([A-Za-z0-9_%\-]{20,500})')
HOST = "multimedia.nt.qq.com.cn"


class ImageError(Exception):
    pass


def _varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            break
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("Invalid protobuf varint")


def _fields(data):
    """Return length-delimited fields only, validating the complete message."""
    offset = 0
    fields = []
    while offset < len(data):
        tag, offset = _varint(data, offset)
        if tag >> 3 == 0:
            raise ValueError("Invalid protobuf field")
        wire = tag & 7
        if wire == 0:
            _, offset = _varint(data, offset)
        elif wire in (1, 5):
            offset += 8 if wire == 1 else 4
        elif wire == 2:
            length, offset = _varint(data, offset)
            fields.append(data[offset:offset + length])
            offset += length
        else:
            raise ValueError("Unsupported protobuf wire type")
        if offset > len(data):
            raise ValueError("Truncated protobuf field")
    return fields


def validated_url(value):
    """Download parameters may only be sent back to the official image host."""
    url = "https://" + HOST + value if value.startswith("/download?") else value
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme != "https" or parsed.netloc != HOST
            or parsed.path != "/download" or parsed.fragment
            or query.get("appid") != ["1407"] or query.get("spec") != ["0"]
            or len(query.get("fileid", [])) != 1
            or not re.fullmatch(r"[A-Za-z0-9_-]{10,1024}", query["fileid"][0])
            or set(query) - {"appid", "fileid", "spec", "rkey"}
            or ("rkey" in query and (len(query["rkey"]) != 1
                or not re.fullmatch(r"[A-Za-z0-9_%-]{20,500}", query["rkey"][0])))):
        raise ImageError("Unsupported QQ original-image URL")
    return url


def resources_from_blob(blob):
    """Keep each image's MD5 and URL in the same protobuf element.

    Searching all filenames/URLs and zipping them can silently associate the
    wrong image when a message contains several pictures or an emoji.
    """
    if not isinstance(blob, bytes) or len(blob) > 4 * 1024 * 1024:
        raise ImageError("Invalid QQ message image data")
    resources = {}

    def walk(data, depth):
        if depth > 8:
            return
        try:
            fields = _fields(data)
        except ValueError:
            return
        names = [IMAGE_NAME.fullmatch(value) for value in fields]
        names = [match for match in names if match]
        urls = []
        for value in fields:
            if value.startswith((b"/download?", b"https://")):
                try:
                    urls.append(validated_url(value.decode("ascii")))
                except (ImageError, UnicodeDecodeError):
                    pass
        if len(names) == 1 and len(urls) == 1:
            match = names[0]
            digest = match.group(1).decode("ascii").lower()
            resources[digest] = {"md5": digest,
                                 "name": digest + "." + match.group(2).decode("ascii"),
                                 "url": urls[0]}
        for value in fields:
            walk(value, depth + 1)

    walk(blob, 0)
    return list(resources.values())


def _extension(data):
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith(b"BM"):
        return ".bmp"
    raise ImageError("QQ response is not a supported image")


def checked_image(path, digest):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
        return False
    data = path.read_bytes()
    try:
        _extension(data)
    except ImageError:
        return False
    return hashlib.md5(data).hexdigest() == digest.lower()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # rkeys must not be forwarded to a redirect destination.
        return None


def fetch(resource, directory, key_loader=None):
    digest = resource.get("md5", "").lower()
    if not re.fullmatch(r"[0-9a-f]{32}", digest):
        raise ImageError("Invalid image MD5")
    url = validated_url(resource["url"])
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    for suffix in (".jpg", ".png", ".gif", ".webp", ".bmp"):
        path = directory / (digest + suffix)
        if checked_image(path, digest):
            return {"path": str(path), "md5": digest, "cached": True}
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    if "rkey" in query:
        urls = [url]
    else:
        keys = (key_loader or runtime_rkeys)()
        if not keys:
            raise ImageError("QQ image URL found; no runtime download rkey available")
        # QQ's own appid/rkey pairs are not tied to the order in memory. Try
        # every saved credential, including the final candidate, before giving
        # up; this exact request is why a fixed first-three limit was wrong.
        urls = [url + "&rkey=" + key for key in sorted(set(keys))
                if re.fullmatch(r"[A-Za-z0-9_%-]{20,500}", key)]
    opener = urllib.request.build_opener(_NoRedirect())
    for candidate in urls:
        try:
            request = urllib.request.Request(candidate, headers={"User-Agent": "Mozilla/5.0"})
            with opener.open(request, timeout=10) as response:
                data = response.read(MAX_IMAGE_BYTES + 1)
        except urllib.error.HTTPError as error:
            # Only explicit credential mismatches permit another saved key.
            body = error.read(512)
            normalized = body.replace(b" ", b"")
            if error.code == 400 and any(marker in normalized for marker in (
                    b'"retcode":-5503010', b'"retcode":-5503023',
                    b'"retcode":-5503007')):
                continue
            raise ImageError("QQ image download failed (HTTP %d)" % error.code) from None
        except (OSError, ValueError):
            # Do not include the exception URL, which could expose the rkey.
            raise ImageError("QQ image download failed; no automatic retry") from None
        if len(data) > MAX_IMAGE_BYTES:
            raise ImageError("QQ image exceeds the 10 MB limit")
        suffix = _extension(data)
        if hashlib.md5(data).hexdigest() != digest:
            raise ImageError("Downloaded image does not match the selected message MD5")
        target = directory / (digest + suffix)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
        return {"path": str(target), "md5": digest, "cached": False}
    raise ImageError("QQ rejected the saved download keys")


def runtime_rkeys():
    """Read only image-download keys from already-running Windows QQ processes.

    Stop after the first QQ process with keys; keep bounded time/bytes and never
    persist process memory, raw URLs, download keys, or other credentials.
    """
    if os.name != "nt" or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise ImageError("QQ runtime image-key extraction requires 64-bit Windows")
    from ctypes import wintypes

    class MemoryInfo(ctypes.Structure):
        _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                    ("AllocationProtect", wintypes.DWORD), ("alignment", wintypes.DWORD),
                    ("RegionSize", ctypes.c_size_t), ("State", wintypes.DWORD),
                    ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD),
                    ("alignment2", wintypes.DWORD)]

    try:
        output = subprocess.check_output(
            ["tasklist", "/fi", "IMAGENAME eq QQ.exe", "/fo", "csv", "/nh"], timeout=10)
        pids = [int(row[1]) for row in csv.reader(io.StringIO(output.decode("utf8", "replace")))
                if len(row) > 1 and row[0].lower() == "qq.exe"]
    except (OSError, subprocess.SubprocessError, ValueError):
        raise ImageError("Unable to identify running QQ processes") from None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                     ctypes.POINTER(MemoryInfo), ctypes.c_size_t]
    kernel.VirtualQueryEx.restype = ctypes.c_size_t
    kernel.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                        ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    kernel.ReadProcessMemory.restype = wintypes.BOOL
    deadline = time.monotonic() + 15
    keys = set()
    total_bytes = 0
    for pid in pids:
        handle = kernel.OpenProcess(0x410, False, pid)  # query and read only
        if not handle:
            continue
        try:
            address = 0
            while time.monotonic() < deadline and total_bytes < 1200 * 1024 * 1024:
                info = MemoryInfo()
                if not kernel.VirtualQueryEx(handle, ctypes.c_void_p(address),
                                             ctypes.byref(info), ctypes.sizeof(info)):
                    break
                base = info.BaseAddress or 0
                size = info.RegionSize
                if not size:
                    break
                address = base + size
                if info.State != 0x1000 or info.Protect not in (2, 4, 8, 0x20, 0x40, 0x80):
                    continue
                if size > 512 * 1024 * 1024:
                    continue
                offset, carry = 0, b""
                while (offset < size and time.monotonic() < deadline
                       and total_bytes < 1200 * 1024 * 1024):
                    length = min(2 * 1024 * 1024, size - offset)
                    buffer = ctypes.create_string_buffer(length)
                    count = ctypes.c_size_t(0)
                    if kernel.ReadProcessMemory(handle, ctypes.c_void_p(base + offset),
                                                buffer, length, ctypes.byref(count)) and count.value:
                        data = carry + buffer.raw[:count.value]
                        total_bytes += count.value
                        keys.update(match.group(1).decode("ascii") for match in RKEY.finditer(data))
                        if b"r\x00k\x00e\x00y" in data:
                            keys.update(match.group(1).decode("ascii")
                                        for match in RKEY.finditer(data.replace(b"\x00", b"")))
                        carry = data[-2048:]
                    offset += length
        finally:
            kernel.CloseHandle(handle)
        if keys:
            break
    return sorted(keys)

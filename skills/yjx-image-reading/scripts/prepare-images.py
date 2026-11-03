#!/usr/bin/env python3
"""Prepare local model inputs without overwriting source images or calling a model."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

try:
    from PIL import Image
except ImportError:
    Image = None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def describe(data):
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        return {
            "format": image.format,
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "frames": getattr(image, "n_frames", 1),
            "orientation": image.getexif().get(274, 1),
            "icc": image.info.get("icc_profile"),
            "gamma": image.info.get("gamma"),
            "chromaticity": image.info.get("chromaticity"),
            "srgb": image.info.get("srgb"),
            "opaque": image.convert("RGBA").getextrema()[3] == (255, 255),
            "bits": getattr(image, "bits", None),
        }


def ineligible(data, info):
    if info["frames"] != 1:
        return "animated_or_multiframe"
    if info["format"] not in ("PNG", "JPEG"):
        return "unsupported_format"
    if not info["opaque"]:
        return "transparency"
    if info["format"] == "PNG" and data[24] != 8:
        return "unsupported_bit_depth"
    if info["format"] == "JPEG" and info["bits"] != 8:
        return "unsupported_bit_depth"
    if info["mode"] not in ("RGB", "RGBA", "L", "LA", "P"):
        return "unsupported_color_mode"
    if info["orientation"] not in (None, 1):
        return "exif_orientation"
    # WebP carries ICC but not arbitrary PNG gamma/chromaticity chunks.
    if not info["icc"] and info["srgb"] is None and (
        info["gamma"] is not None or info["chromaticity"] is not None
    ):
        return "unsupported_color_metadata"
    return None


def prepare(source_path, output_dir, *, original=False, cwebp="cwebp", timeout=60):
    source = Path(source_path).expanduser().resolve()
    if not stat.S_ISREG(source.stat().st_mode):
        raise ValueError("source_not_regular_file")
    data = source.read_bytes()
    if not data:
        raise ValueError("empty_source")
    source_info = {"path": str(source), "sha256": digest(data), "bytes": len(data)}
    result = {"source": source_info, "input": dict(source_info),
              "decision": "original", "reason": None, "verified": False}
    if Image is None:
        result["reason"] = "pillow_unavailable"
        return result
    try:
        info = describe(data)
    except Exception as error:
        raise ValueError("image_decode_failed") from error
    source_info.update({key: info[key] for key in ("format", "width", "height")})
    result["input"] = dict(source_info)
    result["verified"] = True

    def unchanged():
        if digest(source.read_bytes()) != source_info["sha256"]:
            raise ValueError("source_changed_during_preparation")

    def keep(reason):
        unchanged()
        result["reason"] = reason
        return result

    reason = "original_requested" if original else ineligible(data, info)
    if reason:
        return keep(reason)
    encoder = shutil.which(cwebp)
    if not encoder:
        return keep("encoder_unavailable")
    directory = Path(output_dir).expanduser().resolve()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".image-reading-", dir=directory) as work:
            # Encode a private snapshot rather than letting the encoder race a live source.
            snapshot = Path(work) / ("source.png" if info["format"] == "PNG" else "source.jpg")
            snapshot.write_bytes(data)
            candidate = Path(work) / "input.webp"
            command = [encoder, "-quiet", "-q", "95", "-m", "4", "-sharp_yuv",
                       "-metadata", "all", str(snapshot), "-o", str(candidate)]
            try:
                completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                return keep("encoder_timeout")
            if completed.returncode != 0 or not candidate.is_file():
                return keep("encoder_failed")
            encoded = candidate.read_bytes()
            try:
                output_info = describe(encoded)
            except Exception:
                return keep("output_decode_failed")
            if (output_info["format"] != "WEBP" or output_info["frames"] != 1
                    or not output_info["opaque"]
                    or (output_info["width"], output_info["height"]) != (info["width"], info["height"])
                    or output_info["orientation"] not in (None, 1)
                    or output_info["icc"] != info["icc"]):
                return keep("output_metadata_mismatch")
            if not encoded or len(encoded) >= len(data):
                return keep("not_smaller")
            unchanged()
            destination = directory / (source_info["sha256"] + ".q95.webp")
            if destination == source:
                return keep("output_conflict")
            candidate.chmod(0o600)
            try:
                # Exclusive publication: never replace an existing file, symlink or source.
                os.link(candidate, destination)
            except FileExistsError:
                if (destination.is_symlink() or not destination.is_file()
                        or destination.read_bytes() != encoded):
                    return keep("output_conflict")
            unchanged()
            result.update({"decision": "compressed", "reason": "smaller_verified_webp",
                           "input": {"path": str(destination), "sha256": digest(encoded),
                                     "bytes": len(encoded), "format": "WEBP",
                                     "width": output_info["width"], "height": output_info["height"]}})
            return result
    except OSError:
        return keep("output_or_encoder_unavailable")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, help="Caller-owned private runtime directory")
    parser.add_argument("--original", action="store_true", help="Task explicitly requires original bytes")
    parser.add_argument("--cwebp", default="cwebp", help="Encoder executable on PATH or absolute path")
    parser.add_argument("--timeout", type=float, default=60, help="Per-image encoder timeout in seconds")
    parser.add_argument("images", nargs="+")
    args = parser.parse_args()
    if not 0 < args.timeout < float("inf"):
        parser.error("--timeout must be finite and positive")
    results = []
    for image in args.images:
        try:
            results.append(prepare(image, args.output_dir, original=args.original,
                                   cwebp=args.cwebp, timeout=args.timeout))
        except (OSError, ValueError) as error:
            # No image payload, EXIF, encoder log or source contents in stdout.
            reason = str(error) if isinstance(error, ValueError) else "source_unavailable"
            results.append({"source": {"path": str(Path(image).expanduser().absolute())},
                            "input": None, "decision": "rejected", "reason": reason,
                            "verified": False})
    print(json.dumps({"schema_version": 1, "images": results}, ensure_ascii=False))
    return 1 if any(item["decision"] == "rejected" for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())

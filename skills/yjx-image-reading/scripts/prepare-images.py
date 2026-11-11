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

DEFAULT_LONG_HEIGHT = 3000
DEFAULT_LONG_ASPECT = 2.5
DEFAULT_TILE_HEIGHT = 1800
DEFAULT_TILE_OVERLAP = 100


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


def validate_tile_args(tile_height, tile_overlap):
    if not isinstance(tile_height, int) or isinstance(tile_height, bool) or tile_height <= 0:
        raise ValueError("invalid_tile_height")
    if (
        not isinstance(tile_overlap, int)
        or isinstance(tile_overlap, bool)
        or tile_overlap < 0
        or tile_overlap >= tile_height
    ):
        raise ValueError("invalid_tile_overlap")


def should_tile_image(info, *, tile_height=DEFAULT_TILE_HEIGHT, no_tile=False):
    if no_tile or info["frames"] != 1 or info["orientation"] not in (None, 1):
        return False
    width, height = info["width"], info["height"]
    return (
        width > 0
        and height > max(DEFAULT_LONG_HEIGHT, tile_height)
        and (height / width) > DEFAULT_LONG_ASPECT
    )


def verify_tile_ranges(ranges, height):
    if not ranges or ranges[0][0] != 0 or ranges[-1][1] != height:
        raise ValueError("tile_coverage_incomplete")
    for idx, (y_start, y_end, _) in enumerate(ranges):
        if not (0 <= y_start < y_end <= height):
            raise ValueError("tile_range_invalid")
        if idx > 0:
            prev_start, prev_end, _ = ranges[idx - 1]
            if y_start <= prev_start or y_end <= prev_end or y_start > prev_end:
                raise ValueError("tile_sequence_invalid")


def compute_tile_ranges(image, *, tile_height=DEFAULT_TILE_HEIGHT, tile_overlap=DEFAULT_TILE_OVERLAP):
    validate_tile_args(tile_height, tile_overlap)
    width, height = image.size
    if height <= tile_height:
        return [(0, height, "full")]
    raw = image.convert("L").tobytes()
    row_range = []
    row_mean = []
    for y in range(height):
        row = raw[y * width : (y + 1) * width]
        row_range.append(max(row) - min(row))
        row_mean.append(sum(row) / width)

    ranges = []
    y_start = 0
    while y_start < height:
        if y_start + tile_height + tile_overlap >= height:
            ranges.append((y_start, height, "end"))
            break
        target_end = y_start + tile_height
        prev_end = ranges[-1][1] if ranges else 0
        half_band = min(250, max(tile_overlap + 20, tile_height // 5))
        search_min = max(y_start + tile_overlap + 1, prev_end + 1, target_end - half_band)
        search_max = min(height - 1, target_end + half_band)

        best_cut = None
        best_score = None
        if search_min < search_max:
            runs = []
            run_start = None
            for y in range(search_min, search_max + 1):
                if row_range[y] <= 12:
                    if run_start is None:
                        run_start = y
                elif run_start is not None:
                    runs.append((run_start, y))
                    run_start = None
            if run_start is not None:
                runs.append((run_start, search_max + 1))

            for r0, r1 in runs:
                band_len = r1 - r0
                if band_len < 3:
                    continue
                band_mean = sum(row_mean[r0:r1]) / band_len
                ctx_start = max(y_start, r0 - 80)
                ctx_end = min(height, r1 + 80)
                has_before = any(
                    row_range[y] > 16 or abs(row_mean[y] - band_mean) > 16
                    for y in range(ctx_start, r0)
                )
                has_after = any(
                    row_range[y] > 16 or abs(row_mean[y] - band_mean) > 16
                    for y in range(r1, ctx_end)
                )
                if not (has_before and has_after):
                    continue
                center = (r0 + r1) // 2
                if center <= max(y_start, prev_end) or center >= height:
                    continue
                score = (min(band_len, 40) * 8) - abs(center - target_end)
                if best_score is None or score > best_score:
                    best_score = score
                    best_cut = center

        if best_cut is not None:
            ranges.append((y_start, best_cut, "whitespace"))
            y_start = best_cut
        else:
            y_end = min(height, target_end)
            ranges.append((y_start, y_end, "overlap"))
            next_start = y_end - tile_overlap
            if next_start <= y_start:
                next_start = y_end
            y_start = next_start

    verify_tile_ranges(ranges, height)
    return ranges


def publish_exclusive(candidate, destination, expected_bytes, source):
    if destination == source:
        return False
    candidate.chmod(0o600)
    try:
        # Exclusive publication: never replace an existing file, symlink or source.
        os.link(candidate, destination)
    except FileExistsError:
        if (
            destination.is_symlink()
            or not destination.is_file()
            or destination.read_bytes() != expected_bytes
        ):
            return False
    return True


def prepare(
    source_path,
    output_dir,
    *,
    original=False,
    cwebp="cwebp",
    timeout=60,
    tile_height=DEFAULT_TILE_HEIGHT,
    tile_overlap=DEFAULT_TILE_OVERLAP,
    no_tile=False,
):
    validate_tile_args(tile_height, tile_overlap)
    source = Path(source_path).expanduser().resolve()
    if not stat.S_ISREG(source.stat().st_mode):
        raise ValueError("source_not_regular_file")
    data = source.read_bytes()
    if not data:
        raise ValueError("empty_source")
    source_info = {"path": str(source), "sha256": digest(data), "bytes": len(data)}
    result = {
        "source": source_info,
        "input": dict(source_info),
        "tiles": [],
        "decision": "original",
        "reason": None,
        "verified": False,
    }
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

    directory = Path(output_dir).expanduser().resolve()

    def build_tiles(work_dir):
        if not should_tile_image(info, tile_height=tile_height, no_tile=no_tile):
            return []
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            ranges = compute_tile_ranges(
                image, tile_height=tile_height, tile_overlap=tile_overlap
            )
            published = []
            for idx, (y_start, y_end, cut_mode) in enumerate(ranges):
                tile_img = image.crop((0, y_start, info["width"], y_end))
                buf = io.BytesIO()
                tile_img.save(buf, format="PNG")
                tile_bytes = buf.getvalue()
                tile_candidate = Path(work_dir) / f"tile-{idx:02d}.png"
                tile_candidate.write_bytes(tile_bytes)
                tile_name = f"{source_info['sha256']}.tile-{idx:02d}-{y_start}-{y_end}.png"
                tile_dest = directory / tile_name
                if not publish_exclusive(tile_candidate, tile_dest, tile_bytes, source):
                    return None
                published.append(
                    {
                        "index": idx,
                        "path": str(tile_dest),
                        "sha256": digest(tile_bytes),
                        "bytes": len(tile_bytes),
                        "format": "PNG",
                        "width": info["width"],
                        "height": y_end - y_start,
                        "y_start": y_start,
                        "y_end": y_end,
                        "cut": cut_mode,
                    }
                )
            verify_tile_ranges(
                [(item["y_start"], item["y_end"], item["cut"]) for item in published],
                info["height"],
            )
            return published

    def finalize_with_tiles(reason, work_dir=None):
        unchanged()
        if should_tile_image(info, tile_height=tile_height, no_tile=no_tile):
            try:
                directory.mkdir(parents=True, exist_ok=True)
                if work_dir is not None:
                    tiles = build_tiles(work_dir)
                else:
                    with tempfile.TemporaryDirectory(prefix=".image-reading-", dir=directory) as tmp:
                        tiles = build_tiles(tmp)
            except OSError:
                result["reason"] = "output_or_encoder_unavailable"
                return result
            if tiles is None:
                result["reason"] = "output_conflict"
                return result
            unchanged()
            result["tiles"] = tiles
        result["reason"] = reason
        return result

    reason = "original_requested" if original else ineligible(data, info)
    if reason:
        return finalize_with_tiles(reason)
    encoder = shutil.which(cwebp)
    if not encoder:
        return finalize_with_tiles("encoder_unavailable")
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
                return finalize_with_tiles("encoder_timeout", work)
            if completed.returncode != 0 or not candidate.is_file():
                return finalize_with_tiles("encoder_failed", work)
            encoded = candidate.read_bytes()
            try:
                output_info = describe(encoded)
            except Exception:
                return finalize_with_tiles("output_decode_failed", work)
            if (output_info["format"] != "WEBP" or output_info["frames"] != 1
                    or not output_info["opaque"]
                    or (output_info["width"], output_info["height"]) != (info["width"], info["height"])
                    or output_info["orientation"] not in (None, 1)
                    or output_info["icc"] != info["icc"]):
                return finalize_with_tiles("output_metadata_mismatch", work)
            if not encoded or len(encoded) >= len(data):
                return finalize_with_tiles("not_smaller", work)
            unchanged()
            destination = directory / (source_info["sha256"] + ".q95.webp")
            if not publish_exclusive(candidate, destination, encoded, source):
                result["reason"] = "output_conflict"
                return result
            tiles = build_tiles(work)
            if tiles is None:
                result["reason"] = "output_conflict"
                return result
            unchanged()
            result.update(
                {
                    "decision": "compressed",
                    "reason": "smaller_verified_webp",
                    "input": {
                        "path": str(destination),
                        "sha256": digest(encoded),
                        "bytes": len(encoded),
                        "format": "WEBP",
                        "width": output_info["width"],
                        "height": output_info["height"],
                    },
                    "tiles": tiles,
                }
            )
            return result
    except OSError:
        unchanged()
        result["reason"] = "output_or_encoder_unavailable"
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, help="Caller-owned private runtime directory")
    parser.add_argument("--original", action="store_true", help="Task explicitly requires original bytes")
    parser.add_argument("--cwebp", default="cwebp", help="Encoder executable on PATH or absolute path")
    parser.add_argument("--timeout", type=float, default=60, help="Per-image encoder timeout in seconds")
    parser.add_argument("--tile-height", type=int, default=DEFAULT_TILE_HEIGHT, help="Target vertical tile height in pixels")
    parser.add_argument("--tile-overlap", type=int, default=DEFAULT_TILE_OVERLAP, help="Fallback overlap between vertical tiles in pixels")
    parser.add_argument("--no-tile", action="store_true", help="Disable automatic tiling for ultra-long images")
    parser.add_argument("images", nargs="+")
    args = parser.parse_args()
    if not 0 < args.timeout < float("inf"):
        parser.error("--timeout must be finite and positive")
    try:
        validate_tile_args(args.tile_height, args.tile_overlap)
    except ValueError as error:
        parser.error(str(error))
    results = []
    for image in args.images:
        try:
            results.append(
                prepare(
                    image,
                    args.output_dir,
                    original=args.original,
                    cwebp=args.cwebp,
                    timeout=args.timeout,
                    tile_height=args.tile_height,
                    tile_overlap=args.tile_overlap,
                    no_tile=args.no_tile,
                )
            )
        except (OSError, ValueError) as error:
            # No image payload, EXIF, encoder log or source contents in stdout.
            reason = str(error) if isinstance(error, ValueError) else "source_unavailable"
            results.append({"source": {"path": str(Path(image).expanduser().absolute())},
                            "input": None, "tiles": [], "decision": "rejected", "reason": reason,
                            "verified": False})
    print(json.dumps({"schema_version": 1, "images": results}, ensure_ascii=False))
    return 1 if any(item["decision"] == "rejected" for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Flask application for adaptive video processing workflow."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from flask import (
    Flask,
    abort,
    flash,
    redirect,
    render_template,
    request,
    session,
    send_from_directory,
    url_for,
)
from werkzeug.utils import secure_filename


class ProcessingError(Exception):
    """Raised when FFmpeg or related processing fails."""


app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024 * 1024  # 20 GB
app.config["UPLOAD_ROOT"] = Path(app.root_path) / "media"
app.config["UPLOAD_ROOT"].mkdir(parents=True, exist_ok=True)

RESOLUTION_PRESETS = [2160, 1440, 1080, 720, 480, 360,240,144]
ALLOWED_EXTENSIONS = {"mp4", "mov", "mkv", "webm"}


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def run_command(command: List[str]) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as exc:
        raise ProcessingError(
            "FFmpeg binaries not found. Ensure ffmpeg and ffprobe are installed and on your PATH."
        ) from exc
    except subprocess.CalledProcessError as exc:
        stderr_tail = "\n".join(exc.stderr.splitlines()[-12:]) if exc.stderr else "(no stderr output)"
        raise ProcessingError(f"Command failed: {' '.join(command)}\n{stderr_tail}") from exc
    return result


def to_relative(path: Path) -> str:
    return path.relative_to(app.config["UPLOAD_ROOT"]).as_posix()


def probe_video(path: Path) -> Dict[str, float]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    result = run_command(command)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProcessingError("Unable to parse video metadata from ffprobe.") from exc

    stream = (payload.get("streams") or [{}])[0]
    format_info = payload.get("format", {})
    width = int(stream.get("width", 0))
    height = int(stream.get("height", 0))
    duration_value = format_info.get("duration", 0)

    try:
        duration = float(duration_value)
    except (TypeError, ValueError):
        duration = 0.0

    if not width or not height:
        raise ProcessingError("Unable to determine source video resolution.")

    return {"width": width, "height": height, "duration": duration}


def crf_for_height(height: int) -> int:
    if height >= 2160:
        return 20
    if height >= 1440:
        return 21
    if height >= 1080:
        return 22
    if height >= 720:
        return 23
    if height >= 480:
        return 24
    if height >= 360:
        return 25
    if height >= 240:
        return 26
    return 27


def transcode_variant(
    source_path: Path,
    output_path: Path,
    target_height: int,
    segment_duration: int,
) -> Dict[str, float]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    filters = f"scale=-2:{target_height}"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        filters,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(crf_for_height(target_height)),
        "-force_key_frames",
        f"expr:gte(t,n_forced*{segment_duration})",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-dn",
        "-sn",
        str(output_path),
    ]
    run_command(command)
    return probe_video(output_path)


def segment_video(
    source_path: Path,
    destination_dir: Path,
    segment_duration: int,
) -> List[Dict[str, object]]:
    destination_dir.mkdir(parents=True, exist_ok=True)
    pattern = destination_dir / f"{source_path.stem}_part_%03d.mp4"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-map_metadata",
        "-1",
        "-dn",
        "-sn",
        "-f",
        "segment",
        "-segment_time",
        str(segment_duration),
        "-reset_timestamps",
        "1",
        "-segment_format",
        "mp4",
        str(pattern),
    ]
    run_command(command)
    segment_entries: List[Dict[str, object]] = []
    for index, item in enumerate(sorted(destination_dir.glob("*.mp4")), start=1):
        segment_entries.append(
            {
                "index": index,
                "path": to_relative(item),
                "size_bytes": item.stat().st_size,
                "duration": segment_duration,
                "label": f"Segment {index}",
            }
        )
    return segment_entries


def sanitize_basename(filename: str) -> str:
    stem = Path(filename).stem
    slug = re.sub(r"[^A-Za-z0-9-]+", "-", stem).strip("-").lower()
    return slug or "playlist"


def cleanup_playlist(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def load_manifest(playlist_id: str) -> Optional[Dict]:
    manifest_path = app.config["UPLOAD_ROOT"] / playlist_id / "manifest.json"
    if manifest_path.exists():
        with manifest_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    return None


def list_manifests() -> List[Dict]:
    manifests: List[Dict] = []
    root = app.config["UPLOAD_ROOT"]
    if not root.exists():
        return manifests

    for manifest_path in sorted(root.glob("*/manifest.json")):
        try:
            with manifest_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue

        playlist_id = data.get("playlist_id") or manifest_path.parent.name
        source = data.get("source", {})
        filename = source.get("filename") or playlist_id
        created_at = data.get("created_at")
        numeric_created_at = data.get("created_at_ts")
        if numeric_created_at is None:
            try:
                numeric_created_at = manifest_path.stat().st_mtime
            except OSError:
                numeric_created_at = 0.0
        variants = data.get("variants", [])
        resolutions = []
        for variant in variants:
            height = variant.get("height")
            if height:
                label = f"{height}p"
                if label not in resolutions:
                    resolutions.append(label)

        manifests.append(
            {
                "id": playlist_id,
                "title": filename,
                "created_at": created_at,
                "resolutions": resolutions,
                "created_at_ts": numeric_created_at,
            }
        )

    def sort_key(item: Dict) -> float:
        return float(item.get("created_at_ts") or 0.0)

    manifests.sort(key=sort_key, reverse=True)
    return manifests


def summarise_manifest(manifest: Dict) -> Dict:
    source = manifest.get("source", {})
    variants_data = manifest.get("variants", [])
    master_variant = None
    other_variants: List[Dict] = []

    for variant in variants_data:
        enriched = {
            "label": variant.get("label", ""),
            "height": variant.get("height"),
            "width": variant.get("width"),
            "duration": variant.get("duration"),
            "file": variant.get("file"),
            "segments": variant.get("segments", []),
            "segment_count": len(variant.get("segments", [])),
            "is_master": variant.get("is_master", False),
            "bitrate_kbps": variant.get("bitrate_kbps"),
        }
        if enriched["is_master"] and master_variant is None:
            master_variant = enriched
        else:
            other_variants.append(enriched)

    if master_variant is None and variants_data:
        fallback = variants_data[0]
        master_variant = {
            "label": fallback.get("label", "Master"),
            "height": fallback.get("height"),
            "width": fallback.get("width"),
            "duration": fallback.get("duration"),
            "file": fallback.get("file"),
            "segments": fallback.get("segments", []),
            "segment_count": len(fallback.get("segments", [])),
            "is_master": True,
            "bitrate_kbps": fallback.get("bitrate_kbps"),
        }

    other_variants.sort(key=lambda item: item.get("height") or 0, reverse=True)

    if master_variant:
        master_variant = {
            **master_variant,
            "filename": source.get("filename", master_variant.get("file")),
            "bitrate_kbps": master_variant.get("bitrate_kbps"),
        }

    return {
        "playlist_id": manifest.get("playlist_id"),
        "created_at": manifest.get("created_at"),
        "segment_duration": manifest.get("segment_duration"),
        "skipped_resolutions": manifest.get("skipped_resolutions", []),
        "master": master_variant,
        "variants": other_variants,
        "source": {
            "filename": source.get("filename"),
            "height": source.get("height"),
            "width": source.get("width"),
            "duration": source.get("duration"),
        },
    }


def build_player_payload(manifest: Dict) -> Dict:
    variants_payload: List[Dict] = []
    for variant_index, variant in enumerate(manifest.get("variants", []), start=1):
        segments_payload = []
        for segment_index, segment in enumerate(variant.get("segments", []), start=1):
            if isinstance(segment, dict):
                segment_path = segment.get("path")
                segment_label = segment.get("label") or f"Segment {segment.get('index', segment_index)}"
                segment_size = segment.get("size_bytes")
                segment_duration = segment.get("duration")
                segment_idx_value = segment.get("index", segment_index)
            else:
                segment_path = segment
                segment_label = f"Segment {segment_index}"
                segment_size = None
                segment_duration = manifest.get("segment_duration")
                segment_idx_value = segment_index

            if not segment_path:
                continue

            segments_payload.append(
                {
                    "index": segment_idx_value,
                    "label": segment_label,
                    "url": url_for("media", filename=segment_path),
                    "sizeBytes": segment_size,
                    "duration": segment_duration,
                }
            )

        variant_file = variant.get("file")
        if not variant_file:
            continue

        variants_payload.append(
            {
                "label": variant.get("label", ""),
                "height": variant.get("height"),
                "duration": variant.get("duration"),
                "file": url_for("media", filename=variant_file),
                "segments": segments_payload,
                "isMaster": variant.get("is_master", False),
                "key": str(variant.get("height") or variant.get("label") or variant_index),
                "bitrateKbps": variant.get("bitrate_kbps"),
                "sizeBytes": variant.get("size_bytes"),
            }
        )

    variants_payload.sort(key=lambda item: item.get("height") or 0, reverse=True)

    return {
        "playlistId": manifest.get("playlist_id"),
        "segmentDuration": manifest.get("segment_duration"),
        "variants": variants_payload,
    }


@app.route("/")
def home() -> str:
    upload_summary: Optional[Dict] = None
    player_payload_json: Optional[str] = None
    available_playlists = list_manifests()

    last_upload_id = session.pop("last_upload_id", None)
    requested_playlist = request.args.get("playlist")
    selected_playlist_id = requested_playlist or last_upload_id

    if not selected_playlist_id and available_playlists:
        selected_playlist_id = available_playlists[0]["id"]

    active_playlist_id = None
    if selected_playlist_id:
        manifest = load_manifest(selected_playlist_id)
        if manifest:
            active_playlist_id = manifest.get("playlist_id", selected_playlist_id)
            upload_summary = summarise_manifest(manifest)
            player_payload = build_player_payload(manifest)
            player_payload_json = json.dumps(player_payload)
    return render_template(
        "index.html",
        upload_summary=upload_summary,
        player_payload_json=player_payload_json,
        available_playlists=available_playlists,
        active_playlist_id=active_playlist_id,
    )


@app.route("/upload", methods=["POST"])
def upload() -> str:
    uploaded_file = request.files.get("video_file")
    if uploaded_file is None or uploaded_file.filename == "":
        flash("Choose a video file to upload.", "error")
        return redirect(url_for("home"))

    if not allowed_file(uploaded_file.filename):
        flash("Unsupported file type. Please upload MP4, MOV, MKV, or WEBM.", "error")
        return redirect(url_for("home"))

    requested_resolutions: List[int] = []
    for value in request.form.getlist("resolutions"):
        try:
            resolution = int(value)
        except (TypeError, ValueError):
            continue
        if resolution in RESOLUTION_PRESETS:
            requested_resolutions.append(resolution)

    if not requested_resolutions:
        flash("Select at least one target resolution.", "error")
        return redirect(url_for("home"))

    try:
        segment_duration = int(request.form.get("segment_duration", 30))
    except (TypeError, ValueError):
        flash("Provide a valid segment duration in seconds.", "error")
        return redirect(url_for("home"))

    segment_duration = max(5, min(segment_duration, 600))

    safe_filename = secure_filename(uploaded_file.filename)
    if not safe_filename:
        flash("Could not determine a safe filename for the upload.", "error")
        return redirect(url_for("home"))

    playlist_id = f"{sanitize_basename(safe_filename)}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    playlist_dir = app.config["UPLOAD_ROOT"] / playlist_id
    source_dir = playlist_dir / "source"
    variants_dir = playlist_dir / "variants"
    segments_dir = playlist_dir / "segments"
    manifest_path = playlist_dir / "manifest.json"

    try:
        source_dir.mkdir(parents=True, exist_ok=False)
        variants_dir.mkdir(parents=True, exist_ok=False)
        segments_dir.mkdir(parents=True, exist_ok=False)

        original_path = source_dir / safe_filename
        uploaded_file.save(original_path)

        source_info = probe_video(original_path)
        source_height = source_info["height"]

        requested_resolutions = sorted(set(requested_resolutions), reverse=True)
        eligible_resolutions = [res for res in requested_resolutions if res <= source_height]
        skipped_resolutions = [res for res in requested_resolutions if res > source_height]

        targets = [source_height] + [res for res in eligible_resolutions if res < source_height]

        manifest_variants: List[Dict] = []
        base_stem = Path(safe_filename).stem

        for target in targets:
            variant_dir = variants_dir / f"{target}p"
            variant_dir.mkdir(parents=True, exist_ok=True)
            variant_filename = f"{base_stem}_{target}p.mp4"
            variant_path = variant_dir / variant_filename

            variant_info = transcode_variant(
                source_path=original_path,
                output_path=variant_path,
                target_height=target,
                segment_duration=segment_duration,
            )

            variant_segments = segment_video(
                source_path=variant_path,
                destination_dir=segments_dir / f"{target}p",
                segment_duration=segment_duration,
            )

            variant_size_bytes = variant_path.stat().st_size
            variant_duration = variant_info.get("duration") or segment_duration * max(len(variant_segments), 1)
            bitrate_kbps = 0.0
            if variant_duration:
                bitrate_kbps = (variant_size_bytes * 8) / 1000 / variant_duration

            manifest_variants.append(
                {
                    "label": f"{target}p" + (" (master)" if target == source_height else ""),
                    "height": variant_info["height"],
                    "width": variant_info["width"],
                    "duration": variant_info["duration"],
                    "file": to_relative(variant_path),
                    "segments": variant_segments,
                    "is_master": target == source_height,
                    "size_bytes": variant_size_bytes,
                    "bitrate_kbps": round(bitrate_kbps, 2),
                }
            )

        now = datetime.utcnow()
        manifest_payload = {
            "playlist_id": playlist_id,
            "created_at": now.isoformat(timespec="seconds") + "Z",
            "created_at_ts": now.timestamp(),
            "segment_duration": segment_duration,
            "requested_resolutions": requested_resolutions,
            "skipped_resolutions": skipped_resolutions,
            "source": {
                "filename": safe_filename,
                "path": to_relative(original_path),
                "width": source_info["width"],
                "height": source_info["height"],
                "duration": source_info["duration"],
            },
            "variants": manifest_variants,
        }

        with manifest_path.open("w", encoding="utf-8") as handle:
            json.dump(manifest_payload, handle, indent=2)

        flash(f"Processed '{safe_filename}' and generated {len(manifest_variants)} renditions.", "success")
        if skipped_resolutions:
            skipped_list = ", ".join(f"{res}p" for res in skipped_resolutions)
            flash(f"Skipped {skipped_list} to avoid upscaling.", "info")

        session["last_upload_id"] = playlist_id
        return redirect(url_for("home"))

    except ProcessingError as exc:
        cleanup_playlist(playlist_dir)
        flash(str(exc), "error")
        return redirect(url_for("home"))
    except Exception as exc:  # pylint: disable=broad-except
        cleanup_playlist(playlist_dir)
        flash(f"Unexpected error: {exc}", "error")
        return redirect(url_for("home"))


@app.route("/media/<path:filename>")
def media(filename: str):
    # Serve processed assets. Further authorization can be added later.
    target = app.config["UPLOAD_ROOT"] / filename
    if not target.exists():
        abort(404)
    return send_from_directory(app.config["UPLOAD_ROOT"], filename)


if __name__ == "__main__":
    app.run(debug=True)

"""Application routes and request handlers."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from flask import (
    Blueprint,
    abort,
    flash,
    redirect,
    render_template,
    request,
    session,
    send_from_directory,
    url_for,
    current_app,
)
from werkzeug.utils import secure_filename

from .services import (
    ProcessingError,
    RESOLUTION_PRESETS,
    allowed_file,
    build_player_payload,
    cleanup_playlist,
    list_manifests,
    load_manifest,
    probe_video,
    sanitize_basename,
    segment_video,
    summarise_manifest,
    to_relative,
    transcode_variant,
)


bp = Blueprint("main", __name__)


@bp.route("/")
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


@bp.route("/upload", methods=["POST"])
def upload() -> str:
    uploaded_file = request.files.get("video_file")
    if uploaded_file is None or uploaded_file.filename == "":
        flash("Choose a video file to upload.", "error")
        return redirect(url_for("main.home"))

    if not allowed_file(uploaded_file.filename):
        flash("Unsupported file type. Please upload MP4, MOV, MKV, or WEBM.", "error")
        return redirect(url_for("main.home"))

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
        return redirect(url_for("main.home"))

    try:
        segment_duration = int(request.form.get("segment_duration", 30))
    except (TypeError, ValueError):
        flash("Provide a valid segment duration in seconds.", "error")
        return redirect(url_for("main.home"))

    segment_duration = max(5, min(segment_duration, 600))

    safe_filename = secure_filename(uploaded_file.filename)
    if not safe_filename:
        flash("Could not determine a safe filename for the upload.", "error")
        return redirect(url_for("main.home"))

    playlist_id = f"{sanitize_basename(safe_filename)}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    playlist_dir = Path(current_app.config["UPLOAD_ROOT"]) / playlist_id
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
        return redirect(url_for("main.home"))

    except ProcessingError as exc:
        cleanup_playlist(playlist_dir)
        flash(str(exc), "error")
        return redirect(url_for("main.home"))
    except Exception as exc:  # pylint: disable=broad-except
        cleanup_playlist(playlist_dir)
        flash(f"Unexpected error: {exc}", "error")
        return redirect(url_for("main.home"))


@bp.route("/media/<path:filename>")
def media(filename: str):
    target = Path(current_app.config["UPLOAD_ROOT"]) / filename
    if not target.exists():
        abort(404)
    return send_from_directory(current_app.config["UPLOAD_ROOT"], filename)


@bp.route("/delete/<playlist_id>", methods=["POST"])
def delete_playlist(playlist_id: str):
    if not re.match(r"^[A-Za-z0-9._-]+$", playlist_id):
        flash("Invalid playlist identifier.", "error")
        return redirect(url_for("main.home"))

    playlist_dir = Path(current_app.config["UPLOAD_ROOT"]) / playlist_id
    try:
        if not playlist_dir.exists() or not playlist_dir.is_dir():
            flash("Playlist not found.", "error")
            return redirect(url_for("main.home"))

        cleanup_playlist(playlist_dir)
        flash(f"Deleted playlist '{playlist_id}'.", "success")
    except Exception as exc:  # pylint: disable=broad-except
        flash(f"Error deleting playlist: {exc}", "error")

    return redirect(url_for("main.home"))

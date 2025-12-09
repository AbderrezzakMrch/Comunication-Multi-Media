# CMM_streaming — Technical Guide

This document explains the project layout, every module, and each function so that a new contributor can understand, modify, or extend the codebase without reading the source first.

## Quick Start

1. Install dependencies:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install flask
   ```
2. Ensure `ffmpeg` and `ffprobe` are installed and on your `PATH`.
3. Start the development server:
   ```powershell
   python main.py
   ```
4. Visit `http://127.0.0.1:5000` in a browser to use the UI.

## Project Structure

```
CMM_streaming/
├── app.py                  # Legacy Flask entry point (for `flask --app app run`)
├── main.py                 # Primary entry point and application factory
├── streaming_app/
│   ├── __init__.py         # Package-level factory delegating to `main.py`
│   ├── routes.py           # HTTP routes (Flask blueprint)
│   └── services.py         # Shared helpers and FFmpeg orchestration
├── templates/
│   └── index.html          # Single-page UI template
├── static/
│   ├── css/style.css       # Styling for the UI
│   └── js/main.js          # Client-side logic and adaptive streaming controls
└── media/                  # Generated assets (playlists, manifests, variants, segments)
```

## Runtime Flow Overview

1. `main.py` constructs the Flask application, applies configuration, registers the blueprint, and runs the server.
2. `streaming_app.routes` exposes endpoints for uploading, listing, deleting, and serving media. It relies on `streaming_app.services` for all heavy lifting (FFmpeg execution, manifest work, helpers).
3. The server renders `templates/index.html`, which includes `static/js/main.js`. That script handles UI interactions, playback control, and simple client-side adaptation using the data emitted by the server.
4. Processed media and metadata are stored under `media/<playlist-id>/`.

## Module Reference — Python

### `main.py`

This is the authoritative entry point. All other factories delegate here.

| Function | Description |
| --- | --- |
| `create_flask_app()` | Builds a `Flask` instance located at the project root, pointing `template_folder` to `templates/` and `static_folder` to `static/`. No routing or configuration happens here. |
| `apply_configuration(app)` | Applies core configuration to the app: sets `SECRET_KEY`, `MAX_CONTENT_LENGTH` (20 GB), assigns `UPLOAD_ROOT` (`<project>/media`), and ensures the folder exists. |
| `register_blueprints(app)` | Attaches the application blueprint defined in `streaming_app.routes`. Keeps registration centralized. |
| `create_app()` | Orchestrates `create_flask_app`, `apply_configuration`, and `register_blueprints`; returns a fully configured `Flask` app. Use this in tests or WSGI servers. |
| `main()` | Convenience launcher used by `if __name__ == "__main__"`. Calls `create_app()` and runs `app.run(debug=True)`. |

### `app.py`

Legacy shim kept for compatibility with Flask’s CLI.

| Symbol | Description |
| --- | --- |
| `app = create_app()` | Imports `create_app` from `main.py` so `flask --app app run` works. |
| `if __name__ == "__main__": app.run(debug=True)` | Allows `python app.py` to behave identically to `python main.py`. |

### `streaming_app/__init__.py`

| Function | Description |
| --- | --- |
| `create_app()` | Re-exports `main.create_app()` so legacy imports (`from streaming_app import create_app`) continue to work. |

### `streaming_app/services.py`

Holds helpers shared by all routes. The module is import-safe, pulls configuration from `current_app`, and avoids circular dependency issues.

| Constant / Class | Description |
| --- | --- |
| `ProcessingError` | Custom exception raised when FFmpeg/FFprobe operations fail. Routes treat it as a user-visible error. |
| `RESOLUTION_PRESETS` | Allowed output heights (2160 through 144). UI checkboxes correspond to this list. |
| `ALLOWED_EXTENSIONS` | Set of accepted upload file extensions. |

| Function | Description |
| --- | --- |
| `allowed_file(filename)` | Returns `True` if the filename has an allowed extension. Used during upload validation. |
| `run_command(command)` | Wraps `subprocess.run` with error handling: raises `ProcessingError` for missing binaries or non-zero exits and includes the last lines of stderr in the message. |
| `upload_root()` | Resolves the current upload directory from Flask config (`UPLOAD_ROOT`). |
| `to_relative(path)` | Converts an absolute `Path` under the upload root to a POSIX-style string for JSON manifests and `url_for`. |
| `probe_video(path)` | Calls `ffprobe` to extract `width`, `height`, and `duration`. Raises `ProcessingError` if metadata cannot be read. |
| `crf_for_height(height)` | Chooses a sensible H.264 CRF value based on video height. Higher resolutions get lower (better) CRF values. |
| `transcode_variant(source_path, output_path, target_height, segment_duration)` | Runs `ffmpeg` to scale the source video to the requested height using `libx264`, syncs keyframes to `segment_duration`, saves to `output_path`, and returns the probed metadata of the result. |
| `segment_video(source_path, destination_dir, segment_duration)` | Segments a video using `ffmpeg -f segment`, writing part files to `destination_dir` and returning a list of dictionaries with metadata (`index`, `path`, `size_bytes`, etc.). |
| `sanitize_basename(filename)` | Creates a slug used in playlist IDs (lowercase, alphanumeric and hyphen). |
| `cleanup_playlist(path)` | Deletes a playlist directory tree if it exists. |
| `load_manifest(playlist_id)` | Loads `manifest.json` for a playlist, returning a Python dictionary or `None`. |
| `list_manifests()` | Scans `media/*/manifest.json`, returning summaries (`id`, `title`, `created_at`, `resolutions`). Sorts newest first. Used to populate the sidebar. |
| `summarise_manifest(manifest)` | Produces the server-side summary injected into the template: chooses a master variant, orders others, and returns friendly metadata for display. |
| `build_player_payload(manifest)` | Converts a manifest into the JSON fed to the browser player. Filters out missing files, constructs URLs with `url_for('main.media', ...)`, and sorts variants by resolution. |

### `streaming_app/routes.py`

Defines the Flask blueprint `bp` (name `main`). All endpoints are registered on this blueprint.

| Function | Description |
| --- | --- |
| `home()` (`GET /`) | Renders `index.html` with `available_playlists`, `upload_summary` (if a playlist is selected), and `player_payload_json` for the client. Uses `session['last_upload_id']` to automatically select the last processed playlist. |
| `upload()` (`POST /upload`) | Receives uploads. Steps: validates file and form data, creates playlist directories, saves the source video, probes resolution, filters requested resolutions (prevents upscaling), transcodes each eligible target, segments them, computes bitrate stats, writes `manifest.json`, flashes messages, and stores the playlist ID in the session. Cleans up the playlist directory if any error occurs. |
| `media(filename)` (`GET /media/<path:filename>`) | Serves processed media under `UPLOAD_ROOT`. Returns 404 if the file does not exist. |
| `delete_playlist(playlist_id)` (`POST /delete/<playlist_id>`) | Validates playlist ID (regex), deletes the entire playlist directory, flashes success/error messages, and redirects home. |

Support imports at top handle Flask utilities, and the module relies on services from `streaming_app.services` for all processing tasks.

## Front-End Reference — HTML and CSS

### `templates/index.html`

Single-page template rendered by `home()`. Key sections:

- **Sidebar**: Lists playlists using `available_playlists`. Links call `/` with `?playlist=<id>`.
- **Stage**: Contains headline, upload CTA button, flash message container, and the adaptive player card when `upload_summary` is available.
- **Player Card**: Video tag, resolution controls, bandwidth simulator, and segment list. Populated by `static/js/main.js` using the embedded `#playerData` JSON.
- **Summary Card**: Shows metadata about the selected playlist and contains the delete form (`POST /delete/<playlist_id>`).
- **Upload Modal**: Form that posts to `main.upload`. Fields allow selecting resolutions and segment duration.

### `static/css/style.css`

Styles the responsive layout, sidebar, cards, chips, modal, and theme elements. Modifying visuals usually only requires edits here; no logic lives in this stylesheet.

## Front-End Reference — `static/js/main.js`

This script wires up UI interactions and implements the adaptive playback logic. Below is a catalogue of the top-level functions and their responsibilities.

| Function / Handler | Description |
| --- | --- |
| `openUploadModal()` / `closeUploadModal()` | Show or hide the upload modal, also toggling document scroll lock. |
| `closeSidebarOnMobile()` | Collapses the sidebar when the viewport is narrow. |
| `initialiseAdaptivePlayer(playerData)` | Entrypoint after parsing `#playerData`. Sets up variant state, renders controls, and registers numerous inner helpers listed below. |
| `renderResolutionButtons()` | (Inner) Builds resolution buttons for each variant, attaches click handlers, and updates active styling. |
| `setVariant(nextVariant, playbackContext)` | (Inner) Switches the active variant, refreshes UI, and resumes playback (full video or segment) based on the captured context. |
| `populateSegments(variant)` | (Inner) Renders the segment list for the current variant, including the full-video option. |
| `createSegmentItem(segmentIndex, label, sourceUrl)` | (Inner) Creates a list item button that loads the appropriate segment or full video. |
| `capturePlaybackContext()` | (Inner) Captures the playback position, active segment, and whether full-video mode is active to allow seamless switching. |
| `playFullVideo(resumeTime, segmentIndexHint)` | (Inner) Loads the variant’s full MP4, seeking if needed. |
| `playSegmentByIndex(segmentIndex, resumeTime)` | (Inner) Loads a specific segment by index. |
| `setVideoSource(sourceUrl, readableLabel, resumeTime)` | (Inner) Central method for updating the `<video>` element source, handling resume, scheduling adaptation, and updating labels. |
| `updateActiveResolution()` | (Inner) Refreshes button highlights and bitrate hints, noting whether auto-adapt is active. |
| `updateActiveSegment()` | (Inner) Highlights the current segment button according to playback progress. |
| `deriveSegmentIndex(segmentIndexHint, resumeTime)` | (Inner) Computes segment index based on resume time and `segmentDuration`. |
| `handleTimeUpdate()` | (Inner) Syncs active segment highlight while playing the full video. |
| `handleEnded()` | (Inner) Automatically plays the next segment when a segment stream finishes. |
| `scheduleAutoAdaptCheck(sourceUrl)` | (Inner) Sets a timer to measure throughput for the current resource. |
| `maybeAutoAdapt(resourceUrl)` | (Inner) Core adaptation algorithm. Collects throughput samples (or simulated bandwidth) and decides whether to switch variants up or down. |
| `measureThroughputKbps(resourceUrl)` | (Inner) Uses the Resource Timing API to measure transfer speed. |
| `updateSimBandwidthLabel(kbpsValue)` | (Inner) Updates the on-screen readout for the bandwidth simulator. |
| `selectVariantForThroughput(throughputKbps)` | (Inner) Picks the highest variant whose bitrate fits within the measured throughput headroom. |
| `findLowerVariant(referenceVariant)` | (Inner) Locates the next lower variant for downgrades. |
| `trimResourceTimings()` | (Inner) Keeps the browser performance buffer small by clearing old entries. |
| `normaliseUrl(url)` | (Inner) Resolves relative URLs against the current location. |
| `rescheduleAutoAdapt()` | (Inner) Continues the periodic adaptation checks if auto mode is enabled. |
| `getVariantBitrate(variant)` | (Inner) Returns an explicit or inferred bitrate for a variant. |
| `inferHeightFromVariant(variant)` | (Inner) Derives a height from explicit metadata or the label text. |
| `isAutoAdaptEnabled()` / `disableAutoAdapt()` | (Inner) Helpers for reading or toggling the auto-adapt checkbox. |
| `formatBitrateHint(bitrateKbps)` | (Inner) Formats bitrate numbers for display on resolution chips. |
| `updateCurrentResolutionLabel()` | (Inner) Sets the display text above the resolution controls, noting auto mode when applicable. |
| Event listeners at top-level | Handle sidebar toggle, modal open/close, Escape key, upload validation, parsing `playerData`, bandwidth control syncing, auto-adapt checkbox changes, and delete confirmations. |

All inner functions are defined within `initialiseAdaptivePlayer`, giving them access to shared state (variants, timers, history).

## Media Directory Layout

Each upload produces `media/<playlist-id>/` with the following shape:

```
media/<playlist-id>/
├── manifest.json        # Metadata written after processing completes
├── source/              # Original uploaded file
├── variants/<height>p/  # Full-length MP4 per target resolution
└── segments/<height>p/  # Segmented MP4 chunks aligned by segment duration
```

`manifest.json` mirrors the payload assembled in `streaming_app.routes.upload` using helpers from `streaming_app.services` and drives both the UI and client payload.

## Extending the Project

- To add new routes, create them in `streaming_app.routes`, sprinkle helpers in `streaming_app.services`, and register any additional blueprints from `register_blueprints` in `main.py`.
- To modify encoding behavior, adjust `RESOLUTION_PRESETS`, `crf_for_height`, or the `ffmpeg` command composition in `transcode_variant`.
- Front-end changes belong in `templates/index.html` (markup), `static/js/main.js` (logic), or `static/css/style.css` (visuals).
- For automated tests, import `create_app()` from `main.py` to build a configured app instance.

With this guide, a new contributor can trace every functionality, understand how data flows through the system, and confidently modify any component.


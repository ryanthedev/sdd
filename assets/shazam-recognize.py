# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["shazamio>=0.8.1"]
# ///
"""
Acoustic fingerprint -> track identity, for the sdd `shazam` adapter.

Run by `uv run` (PEP 723 inline metadata above, so uv provisions the
interpreter and shazamio itself — nothing to pip install by hand).

    uv run --quiet --no-project shazam-recognize.py <audio-in> <json-out>

CONTRACT (parsed by src/adapters/shazam.ts — keep these markers in sync):
  SDD_SHAZAM_RESULT:<absolute path to the JSON written>   (always, on success)
  SDD_SHAZAM_TITLE:<title>                                (match only)
  SDD_SHAZAM_ARTIST:<artist>                              (match only)
  SDD_SHAZAM_NOMATCH:1                                    (no match only)

A NO MATCH IS NOT A FAILURE. "This audio is not in Shazam's catalog" is a real
answer to the question asked, so the script still writes its JSON, still emits
the RESULT marker, and still exits 0 — with `matched: false`. Only a genuine
breakdown (unreadable audio, network/API failure) exits non-zero.

WHY IT TRANSCODES FIRST: shazamio hands non-wav containers to pydub, which
sniffs an .mp4/.m4a as raw mpeg audio and emits a stream of "invalid mpeg audio
header" / "skipping junk at N bytes" before returning a garbage fingerprint that
silently fails to match. Observed directly: the same 8s clip returned NO MATCH
as .mp4 and matched on the first try as .wav. Normalizing through ffmpeg to
16 kHz mono PCM up front removes that whole failure mode, and ffmpeg is already
a hard dependency of this pipeline, so it costs no new tooling.

Markers are written with newlines stripped from interpolated values: a track
title containing a newline would otherwise forge a second marker line.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from typing import Any

from shazamio import Shazam


def die(msg: str) -> None:
    print(f"shazam-recognize: {msg}", file=sys.stderr)
    raise SystemExit(1)


def one_line(value: Any) -> str:
    """Collapse a value to a single marker-safe line. A missing field (None)
    becomes "" rather than the literal "None", which would read as a title."""
    if value is None:
        return ""
    return " ".join(str(value).split())


def to_wav(src: str, dest: str) -> None:
    """Normalize any input container to 16 kHz mono PCM — see module docstring."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", src, "-ac", "1", "-ar", "16000", "-f", "wav", dest],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        die(f"ffmpeg could not decode {src!r}: {proc.stderr.strip()[-400:]}")


def pick(track: dict[str, Any]) -> dict[str, Any]:
    """Flatten Shazam's nested payload into the fields a caller actually wants."""
    meta: dict[str, str] = {}
    for section in track.get("sections") or []:
        for item in section.get("metadata") or []:
            title = item.get("title")
            text = item.get("text")
            if isinstance(title, str) and isinstance(text, str):
                meta[title.lower()] = text

    apple_url = None
    for option in (track.get("hub") or {}).get("options") or []:
        for action in option.get("actions") or []:
            uri = action.get("uri")
            if isinstance(uri, str) and uri.startswith("https://music.apple.com"):
                apple_url = uri
                break
        if apple_url:
            break

    genres = track.get("genres") or {}
    return {
        "title": track.get("title"),
        "artist": track.get("subtitle"),
        "album": meta.get("album"),
        "label": meta.get("label"),
        "released": meta.get("released"),
        "genre": genres.get("primary") if isinstance(genres, dict) else None,
        "shazam_key": track.get("key"),
        "shazam_url": track.get("url"),
        "apple_music_url": apple_url,
        "isrc": track.get("isrc"),
    }


async def recognize(audio: str) -> dict[str, Any]:
    return await Shazam().recognize(audio)


def main() -> None:
    if len(sys.argv) != 3:
        die(f"usage: {os.path.basename(sys.argv[0])} <audio-in> <json-out>")

    audio_in = os.path.abspath(sys.argv[1])
    json_out = os.path.abspath(sys.argv[2])
    if not os.path.isfile(audio_in):
        die(f"audio file does not exist: {audio_in}")

    os.makedirs(os.path.dirname(json_out) or ".", exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="sdd-shazam-") as tmp:
        wav = os.path.join(tmp, "probe.wav")
        to_wav(audio_in, wav)
        try:
            payload = asyncio.run(recognize(wav))
        except Exception as exc:  # network/API/decode failure — a real failure
            die(f"recognition call failed: {type(exc).__name__}: {exc}")

    track = payload.get("track") if isinstance(payload, dict) else None
    if not track:
        result = {"matched": False, "audio": audio_in, "raw": payload}
    else:
        result = {"matched": True, "audio": audio_in, **pick(track), "raw": payload}

    with open(json_out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)

    # Markers last, so a partially-written file can never look like a success.
    if result["matched"]:
        print(f"SDD_SHAZAM_TITLE:{one_line(result.get('title'))}")
        print(f"SDD_SHAZAM_ARTIST:{one_line(result.get('artist'))}")
    else:
        print("SDD_SHAZAM_NOMATCH:1")
    print(f"SDD_SHAZAM_RESULT:{json_out}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
GTA III Web (re3 WASM) — Asset Packager
=======================================
Packages retail Grand Theft Auto 3 assets + re3 overlay files into:
  1. Core VFS pack (`public/chunks/core.part00`, `core.part01`, ...) in GTA3PK01 format
     (gzip-compressed, split at <=18 MiB for Cloudflare Workers Free Plan <25 MiB limit).
  2. Optional cutscene archive pack (`public/chunks/cuts.part00`, ...) for `anim/cuts.img`.
  3. Generated `audio/sound.cache` inside the core pack matching `StreamedNameTable`
     (`TOTAL_STREAMED_SOUNDS` little-endian uint32 durations in ms).
  4. Lazy-streamed radio & mission audio (`public/audio/<stem>.mp3`), each <18 MiB.
  5. Asset manifest (`public/chunks/manifest.json`).
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import glob
import gzip
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
ROOT_DIR = os.path.abspath(os.path.join(PROJECT_DIR, ".."))

DEFAULT_RETAIL_DIR = os.path.join(ROOT_DIR, "Grand Theft Auto 3")
OVERLAY_DIR = os.path.join(PROJECT_DIR, "engine", "gamefiles")
SAMPMAN_H = os.path.join(PROJECT_DIR, "engine", "src", "audio", "sampman.h")
AUDIO_ENUMS_H = os.path.join(PROJECT_DIR, "engine", "src", "audio", "audio_enums.h")

PUBLIC_DIR = os.path.join(PROJECT_DIR, "public")
CHUNKS_DIR = os.path.join(PUBLIC_DIR, "chunks")
AUDIO_OUT_DIR = os.path.join(PUBLIC_DIR, "audio")

ARCHIVE_MAGIC = b"GTA3PK01"
CHUNK_SIZE_LIMIT = 18 * 1024 * 1024      # 18 MiB split threshold
VERIFY_MAX_FILE_SIZE = 19 * 1024 * 1024  # Strict < 19 MiB verification (< 25 MiB CF limit)
MP3_TARGET_MAX_BYTES = int(17.2 * 1024 * 1024)
BITRATE_LADDER_KBPS = [96, 80, 64, 56, 48, 40, 32]


def parse_streamed_name_table(sampman_path: str) -> list[str]:
    """Extract the PC StreamedNameTable entries (lines 474-672) from re3's sampman.h."""
    with open(sampman_path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()

    # Locate the PC StreamedNameTable block (starts after PS2_AUDIO_PATHS #else, around line 474)
    start_idx = None
    for idx in range(len(lines) - 1, -1, -1):
        if "StreamedNameTable" in lines[idx] and "static char" in lines[idx]:
            start_idx = idx
            break

    if start_idx is None:
        raise RuntimeError(f"Could not find PC StreamedNameTable in {sampman_path}")

    entries: list[str] = []
    for line in lines[start_idx:]:
        for match in re.finditer(r'"(AUDIO\\\\[^"]+)"', line):
            entries.append(match.group(1).replace("\\\\", "\\"))
        if "};" in line:
            break

    if not entries:
        raise RuntimeError(f"Parsed 0 entries from StreamedNameTable in {sampman_path}")
    return entries


def read_wav_duration_ms(wav_path: str) -> int | None:
    """Compute exact WAV duration in ms matching re3's CWavFile::GetLength()."""
    try:
        with open(wav_path, "rb") as f:
            riff = f.read(12)
            if len(riff) < 12 or riff[0:4] != b"RIFF" or riff[8:12] != b"WAVE":
                return None

            fmt_tag = channels = sample_rate = block_align = 0
            while True:
                chunk_hdr = f.read(8)
                if len(chunk_hdr) < 8:
                    break
                chunk_id, chunk_size = struct.unpack("<4sI", chunk_hdr)
                if chunk_id == b"fmt ":
                    fmt_data = f.read(chunk_size)
                    if chunk_size & 1:
                        f.seek(1, os.SEEK_CUR)
                    if len(fmt_data) < 16:
                        return None
                    fmt_tag, channels, sample_rate, _, block_align, _ = struct.unpack_from(
                        "<HHIIHH", fmt_data, 0
                    )
                elif chunk_id == b"data":
                    if sample_rate == 0 or block_align == 0 or channels == 0:
                        return None
                    if fmt_tag == 1:  # PCM
                        samples_per_block = 1
                    elif fmt_tag in (0x11, 0x69):  # IMA ADPCM / Xbox ADPCM
                        samples_per_block = (block_align // channels - 4) * 2 + 1
                    else:
                        return None
                    sample_count = (chunk_size // block_align) * samples_per_block
                    return int(sample_count * 1000.0 / sample_rate)
                else:
                    f.seek(chunk_size + (chunk_size & 1), os.SEEK_CUR)
    except OSError:
        return None
    return None


def probe_duration_ms(file_path: str) -> int:
    """Return audio track duration in milliseconds via WAV RIFF header or ffprobe."""
    if file_path.lower().endswith(".wav"):
        ms = read_wav_duration_ms(file_path)
        if ms is not None and ms > 0:
            return ms

    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0 or not res.stdout.strip():
        raise RuntimeError(f"ffprobe failed for {file_path}: {res.stderr.strip()}")
    seconds = float(res.stdout.strip())
    return max(1, int(round(seconds * 1000.0)))


def build_audio_lookup(retail_dir: str) -> dict[str, str]:
    """Map lowercase filename -> actual path in retail audio directory."""
    audio_dir = os.path.join(retail_dir, "audio")
    if not os.path.isdir(audio_dir):
        raise FileNotFoundError(f"Missing retail audio directory: {audio_dir}")
    lookup: dict[str, str] = {}
    for entry in os.listdir(audio_dir):
        full = os.path.join(audio_dir, entry)
        if os.path.isfile(full):
            lookup[entry.lower()] = full
    return lookup


def choose_mp3_bitrate(duration_ms: int) -> int:
    """Choose highest bitrate in BITRATE_LADDER_KBPS predicted to stay under MP3_TARGET_MAX_BYTES."""
    dur_sec = max(duration_ms / 1000.0, 0.1)
    max_kbps = (MP3_TARGET_MAX_BYTES * 8.0) / dur_sec / 1000.0
    for kbps in BITRATE_LADDER_KBPS:
        if kbps <= max_kbps:
            return kbps
    return BITRATE_LADDER_KBPS[-1]


def transcode_or_copy_track(
    orig_lower_name: str,
    src_path: str,
    duration_ms: int,
    force: bool = False,
) -> tuple[str, dict]:
    """Transcode WAV/large MP3 to compact <18 MiB MP3, or copy small MP3 directly."""
    stem, ext = os.path.splitext(orig_lower_name)
    out_name = f"{stem}.mp3"
    out_path = os.path.join(AUDIO_OUT_DIR, out_name)
    src_size = os.path.getsize(src_path)

    needs_transcode = ext.lower() != ".mp3" or src_size > 17 * 1024 * 1024

    if not force and os.path.isfile(out_path):
        out_size = os.path.getsize(out_path)
        if 0 < out_size < CHUNK_SIZE_LIMIT and os.path.getmtime(out_path) >= os.path.getmtime(src_path):
            return orig_lower_name, {
                "url": f"/audio/{out_name}",
                "durationMs": duration_ms,
                "size": out_size,
                "cached": True,
            }

    if not needs_transcode:
        shutil.copy2(src_path, out_path)
    else:
        start_kbps = choose_mp3_bitrate(duration_ms)
        start_idx = BITRATE_LADDER_KBPS.index(start_kbps)
        tmp_path = out_path + ".tmp.mp3"

        encoded_ok = False
        for kbps in BITRATE_LADDER_KBPS[start_idx:]:
            cmd = [
                "ffmpeg",
                "-y",
                "-v", "error",
                "-i", src_path,
                "-vn",
                "-c:a", "libmp3lame",
                "-b:a", f"{kbps}k",
            ]
            if kbps <= 48:
                cmd.extend(["-ac", "1"])
            cmd.append(tmp_path)

            res = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if res.returncode != 0:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                raise RuntimeError(f"ffmpeg failed for {src_path} @ {kbps}k: {res.stderr.strip()}")

            if os.path.getsize(tmp_path) < CHUNK_SIZE_LIMIT:
                os.replace(tmp_path, out_path)
                encoded_ok = True
                break

        if not encoded_ok:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise RuntimeError(f"Could not fit {out_name} below {CHUNK_SIZE_LIMIT} bytes even at 32k")

    out_size = os.path.getsize(out_path)
    return orig_lower_name, {
        "url": f"/audio/{out_name}",
        "durationMs": duration_ms,
        "size": out_size,
        "cached": False,
    }


def collect_vfs_files(
    retail_dir: str,
    overlay_dir: str,
    sound_cache_bytes: bytes,
    audio_lookup: dict[str, str],
) -> tuple[list[tuple[str, bytes]], list[tuple[str, bytes]]]:
    """Collect core VFS entries and optional cutscene pack entries."""
    core_map: dict[str, tuple[str, bytes]] = {}
    cuts_entries: list[tuple[str, bytes]] = []

    def put_core(rel_path: str, raw_bytes: bytes) -> None:
        norm = rel_path.replace("\\", "/").lstrip("/")
        core_map[norm.lower()] = (norm, raw_bytes)

    def add_retail_tree(sub_dir: str, skip_lower: set[str] | None = None) -> None:
        base = os.path.join(retail_dir, sub_dir)
        if not os.path.isdir(base):
            raise FileNotFoundError(f"Missing required retail folder: {base}")
        for dp, _, filenames in os.walk(base):
            for fn in filenames:
                full = os.path.join(dp, fn)
                rel = os.path.relpath(full, retail_dir).replace("\\", "/")
                if skip_lower and rel.lower() in skip_lower:
                    continue
                with open(full, "rb") as f:
                    put_core(rel, f.read())

    # Retail core directories
    add_retail_tree("data")
    add_retail_tree("models", skip_lower={"models/txd.img", "models/txd.dir"})
    add_retail_tree("TEXT")
    add_retail_tree("txd")
    add_retail_tree("skins")

    # Retail anim/: core gets ped.ifp, cuts.dir, gta3.ini; optional cuts pack gets cuts.img
    anim_dir = os.path.join(retail_dir, "anim")
    if not os.path.isdir(anim_dir):
        raise FileNotFoundError(f"Missing retail anim folder: {anim_dir}")
    anim_files = {fn.lower(): fn for fn in os.listdir(anim_dir) if os.path.isfile(os.path.join(anim_dir, fn))}
    for req in ("ped.ifp", "cuts.dir", "gta3.ini"):
        if req not in anim_files:
            raise FileNotFoundError(f"Missing required anim/{req} in {anim_dir}")
        actual_name = anim_files[req]
        with open(os.path.join(anim_dir, actual_name), "rb") as f:
            put_core(f"anim/{actual_name}", f.read())

    if "cuts.img" in anim_files:
        actual_cuts = anim_files["cuts.img"]
        with open(os.path.join(anim_dir, actual_cuts), "rb") as f:
            cuts_entries.append((f"anim/{actual_cuts}", f.read()))

    # Retail SFX bank + index + generated sound.cache
    for req_audio in ("sfx.sdt", "sfx.raw"):
        if req_audio not in audio_lookup:
            raise FileNotFoundError(f"Missing required audio/{req_audio} in {retail_dir}/audio")
        src = audio_lookup[req_audio]
        with open(src, "rb") as f:
            put_core(f"audio/{os.path.basename(src)}", f.read())

    put_core("audio/sound.cache", sound_cache_bytes)

    # Overlay re3 gamefiles ON TOP of retail files where paths collide (case-insensitive)
    if not os.path.isdir(overlay_dir):
        raise FileNotFoundError(f"Missing re3 overlay gamefiles directory: {overlay_dir}")
    overlay_count = 0
    for dp, _, filenames in os.walk(overlay_dir):
        for fn in filenames:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, overlay_dir).replace("\\", "/")
            with open(full, "rb") as f:
                put_core(rel, f.read())
            overlay_count += 1

    print(f"[VFS] Core files: {len(core_map)} (after applying {overlay_count} re3 overlay files)")
    core_entries = [core_map[k] for k in sorted(core_map.keys())]
    return core_entries, cuts_entries


def write_packed_chunks(prefix: str, entries: list[tuple[str, bytes]]) -> dict:
    """Serialize entries into GTA3PK01, gzip, split into <=18 MiB chunks, and return manifest metadata."""
    # Remove any stale chunks with this prefix
    for stale in glob.glob(os.path.join(CHUNKS_DIR, f"{prefix}.part*")):
        os.remove(stale)

    parts = [ARCHIVE_MAGIC, struct.pack("<I", len(entries))]
    for rel_path, raw_bytes in entries:
        path_bytes = rel_path.encode("utf-8")
        if len(path_bytes) > 0xFFFF:
            raise ValueError(f"Path too long: {rel_path}")
        parts.append(struct.pack("<H", len(path_bytes)))
        parts.append(path_bytes)
        parts.append(struct.pack("<I", len(raw_bytes)))
        parts.append(raw_bytes)

    uncompressed = b"".join(parts)
    compressed = gzip.compress(uncompressed, compresslevel=6, mtime=0)
    sha256_hex = hashlib.sha256(compressed).hexdigest()

    chunks: list[str] = []
    total_len = len(compressed)
    for idx, offset in enumerate(range(0, total_len, CHUNK_SIZE_LIMIT)):
        part_name = f"{prefix}.part{idx:02d}"
        part_path = os.path.join(CHUNKS_DIR, part_name)
        chunk_bytes = compressed[offset : offset + CHUNK_SIZE_LIMIT]
        with open(part_path, "wb") as f:
            f.write(chunk_bytes)
        chunks.append(f"/chunks/{part_name}")
        print(
            f"  [CHUNK] {part_name}: {len(chunk_bytes):>10,} bytes "
            f"({len(chunk_bytes) / (1024 * 1024):.2f} MiB)"
        )

    print(
        f"[PACK:{prefix}] files={len(entries)} raw={len(uncompressed):,} B "
        f"({len(uncompressed)/(1024*1024):.2f} MiB) -> "
        f"gz={total_len:,} B ({total_len/(1024*1024):.2f} MiB) in {len(chunks)} chunks"
    )
    return {
        "compressedSize": total_len,
        "uncompressedSize": len(uncompressed),
        "sha256": sha256_hex,
        "chunkSizeLimit": CHUNK_SIZE_LIMIT,
        "chunks": chunks,
        "fileCount": len(entries),
    }


def verify_output_sizes() -> tuple[int, int]:
    """Ensure every generated file in public/chunks/ and public/audio/ is strictly < 19 MiB."""
    checked = 0
    max_seen = 0
    for folder in (CHUNKS_DIR, AUDIO_OUT_DIR):
        for dp, _, filenames in os.walk(folder):
            for fn in filenames:
                full = os.path.join(dp, fn)
                sz = os.path.getsize(full)
                checked += 1
                if sz > max_seen:
                    max_seen = sz
                if sz >= VERIFY_MAX_FILE_SIZE:
                    raise RuntimeError(
                        f"File {full} is {sz:,} bytes (>= 19 MiB limit)!"
                    )
    return checked, max_seen


def main() -> int:
    parser = argparse.ArgumentParser(description="Package GTA III Web assets and lazy audio.")
    parser.add_argument("--retail-dir", default=DEFAULT_RETAIL_DIR, help="Path to retail Grand Theft Auto 3")
    parser.add_argument("--force-audio", action="store_true", help="Re-transcode all streamed audio tracks")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 4), help="FFmpeg worker threads")
    args = parser.parse_args()

    os.makedirs(CHUNKS_DIR, exist_ok=True)
    os.makedirs(AUDIO_OUT_DIR, exist_ok=True)

    print("[1/5] Parsing StreamedNameTable from re3 sampman.h...")
    streamed_entries = parse_streamed_name_table(SAMPMAN_H)
    print(f"  Found {len(streamed_entries)} streamed sound table entries.")

    audio_lookup = build_audio_lookup(args.retail_dir)

    print("[2/5] Computing durations and generating audio/sound.cache...")
    unique_tracks: dict[str, tuple[str, int]] = {}
    ordered_filenames: list[str] = []
    durations_ms: list[int] = []

    # Probe unique files first (preserve deterministic order)
    missing_tracks = []
    for entry in streamed_entries:
        fn_lower = entry.split("\\")[-1].lower()
        ordered_filenames.append(fn_lower)
        if fn_lower not in audio_lookup:
            missing_tracks.append(entry)
    if missing_tracks:
        raise FileNotFoundError(f"Missing retail audio tracks: {missing_tracks}")

    unique_names = sorted(set(ordered_filenames))
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        future_map = {
            pool.submit(probe_duration_ms, audio_lookup[fn_lower]): fn_lower
            for fn_lower in unique_names
        }
        for fut in as_completed(future_map):
            fn_lower = future_map[fut]
            dur_ms = fut.result()
            unique_tracks[fn_lower] = (audio_lookup[fn_lower], dur_ms)

    for fn_lower in ordered_filenames:
        durations_ms.append(unique_tracks[fn_lower][1])

    sound_cache_bytes = struct.pack(f"<{len(durations_ms)}I", *durations_ms)
    print(f"  Generated audio/sound.cache: {len(sound_cache_bytes)} bytes ({len(durations_ms)} uint32 entries)")

    print("[3/5] Transcoding/copying lazy-streamed radio & mission audio...")
    expected_mp3s: set[str] = set()
    audio_streams_manifest: dict[str, dict] = {}
    for fn_lower in unique_names:
        stem, _ = os.path.splitext(fn_lower)
        mp3_name = f"{stem}.mp3"
        if mp3_name in expected_mp3s:
            raise RuntimeError(f"Audio stem collision for {mp3_name}")
        expected_mp3s.add(mp3_name)

    # Remove any orphan files in public/audio/
    for existing in os.listdir(AUDIO_OUT_DIR):
        if existing not in expected_mp3s:
            os.remove(os.path.join(AUDIO_OUT_DIR, existing))

    transcoded_count = 0
    cached_count = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [
            pool.submit(
                transcode_or_copy_track,
                fn_lower,
                unique_tracks[fn_lower][0],
                unique_tracks[fn_lower][1],
                args.force_audio,
            )
            for fn_lower in unique_names
        ]
        for fut in as_completed(futures):
            orig_name, info = fut.result()
            if info.pop("cached", False):
                cached_count += 1
            else:
                transcoded_count += 1
            audio_streams_manifest[orig_name] = info

    audio_streams_manifest = {k: audio_streams_manifest[k] for k in sorted(audio_streams_manifest.keys())}
    print(
        f"  Audio streams ready: {len(audio_streams_manifest)} tracks "
        f"({transcoded_count} written, {cached_count} up-to-date)"
    )

    print("[4/5] Collecting and packing core VFS + optional cuts pack...")
    core_entries, cuts_entries = collect_vfs_files(
        args.retail_dir, OVERLAY_DIR, sound_cache_bytes, audio_lookup
    )
    core_meta = write_packed_chunks("core", core_entries)
    cuts_meta = write_packed_chunks("cuts", cuts_entries) if cuts_entries else None

    manifest = {
        "version": 1,
        "format": "GTA3PK01",
        "core": core_meta,
        "cuts": cuts_meta,
        "streamedSoundCount": len(durations_ms),
        "soundTable": ordered_filenames,
        "audioStreams": {
            k: {"url": v["url"], "durationMs": v["durationMs"], "size": v["size"]}
            for k, v in audio_streams_manifest.items()
        },
    }
    manifest_path = os.path.join(CHUNKS_DIR, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)
    print(f"  Wrote manifest: {manifest_path}")

    print("[5/5] Verifying all generated files in public/chunks/ and public/audio/ are < 19 MiB...")
    checked, max_seen = verify_output_sizes()
    print(
        f"  Verified {checked} files. Largest file: {max_seen:,} bytes "
        f"({max_seen / (1024 * 1024):.2f} MiB) < 19.00 MiB [OK]"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

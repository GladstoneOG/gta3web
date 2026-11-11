#!/usr/bin/env python3
"""
GTA III Web Asset Optimization & Packaging Script
Prepares Cloudflare Workers-ready chunks (strictly < 18.5 MiB each)
for minimal memory browser decompression and fast streaming.
"""

import os
import sys
import gzip
import json
import struct
import shutil
import subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

MAX_FILE_BYTES = int(18.5 * 1024 * 1024)  # 19,398,656 bytes
ROOT_GTA3 = Path(r"F:\PROJECT\BROTATO WEB\Grand Theft Auto 3")
OUT_PUBLIC = Path(r"F:\PROJECT\BROTATO WEB\gta3web\public")
OUT_CHUNKS = OUT_PUBLIC / "chunks"
OUT_AUDIO = OUT_PUBLIC / "audio"
FFMPEG_BIN = r"C:\Users\isjohans\scoop\shims\ffmpeg.exe"

def ensure_dirs():
    OUT_CHUNKS.mkdir(parents=True, exist_ok=True)
    OUT_AUDIO.mkdir(parents=True, exist_ok=True)

def build_base_pack():
    print("\n[1/5] Building gta3_base.pack.gz...")
    files_to_pack = []

    # 1. All files recursively under data/
    data_dir = ROOT_GTA3 / "data"
    for p in data_dir.rglob("*"):
        if p.is_file():
            rel = p.relative_to(ROOT_GTA3).as_posix()
            files_to_pack.append(rel)

    # 2. TEXT/american.gxt and TEXT/english.gxt
    for text_file in ["TEXT/american.gxt", "TEXT/english.gxt"]:
        if (ROOT_GTA3 / text_file).is_file():
            files_to_pack.append(text_file)

    # 3. models/gta3.dir
    if (ROOT_GTA3 / "models/gta3.dir").is_file():
        files_to_pack.append("models/gta3.dir")

    # 4. models/ specific TXD files
    for m in ["fonts.txd", "frontend.txd", "generic.txd", "hud.txd", "menu.txd", "MISC.TXD", "particle.txd"]:
        p = ROOT_GTA3 / "models" / m
        if p.is_file():
            files_to_pack.append(f"models/{m}")
        elif (ROOT_GTA3 / "models" / m.lower()).is_file():
            files_to_pack.append(f"models/{m.lower()}")

    # 5. models/Coll/, models/Generic/, txd/, skins/
    for sub in ["models/Coll", "models/Generic", "txd", "skins"]:
        p = ROOT_GTA3 / sub
        if p.is_dir():
            for f in p.rglob("*"):
                if f.is_file():
                    files_to_pack.append(f.relative_to(ROOT_GTA3).as_posix())

    # 6. anim/ped.ifp and anim/gta3.ini
    for anim_file in ["anim/ped.ifp", "anim/gta3.ini"]:
        if (ROOT_GTA3 / anim_file).is_file():
            files_to_pack.append(anim_file)

    # 7. audio/sfx.SDT and gta3.ini
    for misc in ["audio/sfx.SDT", "gta3.ini"]:
        if (ROOT_GTA3 / misc).is_file():
            files_to_pack.append(misc)

    # Deduplicate while preserving order
    seen = set()
    unique_files = []
    for f in files_to_pack:
        fl = f.lower()
        if fl not in seen:
            seen.add(fl)
            unique_files.append(f)

    print(f"  Collected {len(unique_files)} files for base pack.")
    entries = []
    raw_chunks = []
    cur_offset = 0

    for rel_path in unique_files:
        full_path = ROOT_GTA3 / rel_path
        with open(full_path, "rb") as fp:
            data = fp.read()
        entries.append({
            "path": rel_path,
            "offset": cur_offset,
            "size": len(data)
        })
        raw_chunks.append(data)
        cur_offset += len(data)

    json_header = json.dumps(entries, separators=(',', ':')).encode("utf-8")
    magic = b"GTA3"
    hdr_len = struct.pack("<I", len(json_header))
    raw_pack = magic + hdr_len + json_header + b"".join(raw_chunks)
    raw_size = len(raw_pack)

    gz_data = gzip.compress(raw_pack, compresslevel=6)
    gz_size = len(gz_data)

    out_file = OUT_CHUNKS / "gta3_base.pack.gz"
    with open(out_file, "wb") as fp:
        fp.write(gz_data)

    print(f"  -> {out_file.name}: raw={raw_size:,} bytes, gz={gz_size:,} bytes ({gz_size/(1024*1024):.2f} MiB)")
    assert gz_size < MAX_FILE_BYTES, f"File {out_file} exceeds limit: {gz_size} >= {MAX_FILE_BYTES}"
    return {
        "file": out_file.name,
        "rawSize": raw_size,
        "gzSize": gz_size,
        "fileCount": len(unique_files)
    }

def slice_and_gzip_file(src_path: Path, chunk_size: int, prefix: str):
    total_size = src_path.stat().st_size
    parts = []
    idx = 0

    with open(src_path, "rb") as fp:
        while True:
            raw_offset = fp.tell()
            chunk = fp.read(chunk_size)
            if not chunk:
                break
            raw_len = len(chunk)
            gz_data = gzip.compress(chunk, compresslevel=6)
            part_name = f"{prefix}.part{idx:02d}.gz"
            part_path = OUT_CHUNKS / part_name
            with open(part_path, "wb") as out_fp:
                out_fp.write(gz_data)
            gz_len = len(gz_data)
            print(f"  -> {part_name}: rawOffset={raw_offset:,}, rawSize={raw_len:,}, gzSize={gz_len:,} ({gz_len/(1024*1024):.2f} MiB)")
            assert gz_len < MAX_FILE_BYTES, f"Slice {part_name} exceeds limit: {gz_len} >= {MAX_FILE_BYTES}"
            parts.append({
                "file": part_name,
                "rawOffset": raw_offset,
                "rawSize": raw_len,
                "gzSize": gz_len
            })
            idx += 1

    return {
        "totalRawSize": total_size,
        "sliceCount": len(parts),
        "slices": parts
    }

def build_gta3_img_slices():
    print("\n[2/5] Slicing & Gzipping models/gta3.img...")
    img_path = ROOT_GTA3 / "models/gta3.img"
    chunk_size = 36 * 1024 * 1024
    return slice_and_gzip_file(img_path, chunk_size, "gta3_img")

def build_sfx_raw_slices():
    print("\n[3/5] Slicing & Gzipping audio/sfx.RAW...")
    sfx_path = ROOT_GTA3 / "audio/sfx.RAW"
    chunk_size = 17 * 1024 * 1024
    return slice_and_gzip_file(sfx_path, chunk_size, "sfx_raw")

def transcode_audio_file(wav_name: str, bitrate: str):
    src_wav = ROOT_GTA3 / "audio" / wav_name
    dst_mp3 = OUT_AUDIO / (src_wav.stem + ".mp3")
    cmd = [
        FFMPEG_BIN, "-y",
        "-i", str(src_wav),
        "-c:a", "libmp3lame",
        "-ar", "32000",
        "-ac", "2",
        "-b:a", bitrate,
        str(dst_mp3)
    ]
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"FFmpeg error on {wav_name}: {res.stderr}")
    out_size = dst_mp3.stat().st_size
    print(f"  -> {dst_mp3.name} ({bitrate}): {out_size:,} bytes ({out_size/(1024*1024):.2f} MiB)")
    assert out_size < MAX_FILE_BYTES, f"Audio file {dst_mp3.name} exceeds limit: {out_size} >= {MAX_FILE_BYTES}"
    return {
        "name": src_wav.stem,
        "wavFile": wav_name,
        "file": dst_mp3.name,
        "size": out_size,
        "bitrate": bitrate
    }

def transcode_audio():
    print("\n[4/5] Transcoding Radio & Ambient Audio...")
    tasks = [
        ("CHAT.wav", "40k"), # Talk radio (58 min) -> ~17.4 MB (< 18.5 MiB)
        ("RISE.wav", "80k"),
        ("MSX.wav", "80k"),
        ("HEAD.wav", "80k"),
        ("GAME.wav", "80k"),
        ("CLASS.wav", "80k"),
        ("LIPS.wav", "80k"),
        ("KJAH.wav", "80k"),
        ("FLASH.wav", "80k"),
        ("police.wav", "80k"),
        ("Water.wav", "80k"),
        ("City.wav", "80k")
    ]
    results = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        future_map = {executor.submit(transcode_audio_file, wav, br): wav for wav, br in tasks}
        for fut in as_completed(future_map):
            results.append(fut.result())
    results.sort(key=lambda x: x["name"].lower())
    return results

def write_manifest(base_pack_info, img_info, sfx_info, audio_info):
    print("\n[5/5] Writing public/chunks/manifest.json...")
    manifest = {
        "version": 1,
        "maxChunkBytes": MAX_FILE_BYTES,
        "basePack": base_pack_info,
        "gta3Img": img_info,
        "sfxRaw": sfx_info,
        "audioStreams": audio_info
    }
    manifest_path = OUT_CHUNKS / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as fp:
        json.dump(manifest, fp, indent=2)
    print(f"  -> Wrote manifest to {manifest_path} ({manifest_path.stat().st_size:,} bytes)")
    return manifest

def verify_all_files():
    print("\n=== VERIFICATION: Checking all generated files in public/ ===")
    all_files = []
    for p in OUT_PUBLIC.rglob("*"):
        if p.is_file():
            size = p.stat().st_size
            rel = p.relative_to(OUT_PUBLIC).as_posix()
            all_files.append((rel, size))
            status = "OK" if size < MAX_FILE_BYTES else "FAIL (EXCEEDS LIMIT!)"
            print(f"  {rel:<35} : {size:>10,} bytes ({size/(1024*1024):>6.2f} MiB) [{status}]")
            assert size < MAX_FILE_BYTES, f"File {rel} is over limit!"
    print(f"\nAll {len(all_files)} files verified strictly under 18.5 MiB (19,398,656 bytes) limit!")

def main():
    print("==========================================================")
    print("  Grand Theft Auto III Web Asset Optimizer & Packager")
    print("==========================================================")
    ensure_dirs()
    base_info = build_base_pack()
    img_info = build_gta3_img_slices()
    sfx_info = build_sfx_raw_slices()
    audio_info = transcode_audio()
    write_manifest(base_info, img_info, sfx_info, audio_info)
    verify_all_files()
    print("\n=== ASSET PACKAGING COMPLETED SUCCESSFULLY ===")

if __name__ == "__main__":
    main()

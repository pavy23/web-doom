#!/usr/bin/env python3
"""Extract an embedded IWAD image from a larger binary (the existing silent WASM).

The currently deployed Diekmann LinuxDOOM WASM contains the shareware doom1.wad
as raw bytes. This script finds structurally valid IWAD candidates and writes the
largest valid candidate to disk.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path


def candidate(data: bytes, start: int):
    if start + 12 > len(data):
        return None

    ident = data[start:start + 4]
    if ident not in (b"IWAD", b"PWAD"):
        return None

    num_lumps, dir_ofs = struct.unpack_from("<II", data, start + 4)
    if not (10 <= num_lumps <= 10000):
        return None
    if not (12 <= dir_ofs <= 64 * 1024 * 1024):
        return None

    dir_start = start + dir_ofs
    dir_end = dir_start + num_lumps * 16
    if dir_end > len(data):
        return None

    max_end = dir_ofs + num_lumps * 16
    printable_names = 0

    for i in range(num_lumps):
        pos = dir_start + i * 16
        file_pos, size = struct.unpack_from("<II", data, pos)
        name = data[pos + 8:pos + 16].rstrip(b"\0")

        if file_pos > 64 * 1024 * 1024 or size > 64 * 1024 * 1024:
            return None
        max_end = max(max_end, file_pos + size)

        if name and all(32 <= c <= 126 for c in name):
            printable_names += 1

    if printable_names < max(8, num_lumps // 3):
        return None
    if start + max_end > len(data):
        return None

    return max_end, num_lumps, dir_ofs


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} INPUT_BINARY OUTPUT_WAD", file=sys.stderr)
        return 2

    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    data = source.read_bytes()

    hits = []
    offset = 0
    while True:
        start = data.find(b"IWAD", offset)
        if start < 0:
            break
        info = candidate(data, start)
        if info:
            length, num_lumps, dir_ofs = info
            hits.append((length, start, num_lumps, dir_ofs))
        offset = start + 1

    if not hits:
        raise SystemExit("no structurally valid embedded IWAD found")

    length, start, num_lumps, dir_ofs = max(hits)
    wad = data[start:start + length]
    output.write_bytes(wad)

    print(f"IWAD start={start} bytes={length} lumps={num_lumps} directory={dir_ofs}")
    print(f"wrote {output}")

    # Shareware doom1.wad is ~4 MB; reject suspicious tiny/huge results.
    if not (3_000_000 <= len(wad) <= 8_000_000):
        raise SystemExit(f"extracted IWAD has suspicious size: {len(wad)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
process-gtfs.py

Reads a GTFS stop_times.txt file and splits it into per-stop JSON files
under data/stop_times/{stop_id}.json.

Also writes data/feed_info.json with update metadata.

Usage:
    python scripts/process-gtfs.py [path-to-stop_times.txt]

Example:
    python scripts/process-gtfs.py google_transit/stop_times.txt
    python scripts/process-gtfs.py /tmp/gtfs_extract/stop_times.txt
"""

import csv
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

STOP_TIMES_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.join("google_transit", "stop_times.txt")
OUTPUT_DIR      = os.path.join("data", "stop_times")
FEED_INFO_FILE  = os.path.join("data", "feed_info.json")

# ── Validate input ────────────────────────────────────────────────────────────

if not os.path.exists(STOP_TIMES_FILE):
    print(f"Error: File not found: {STOP_TIMES_FILE}", file=sys.stderr)
    print("Usage: python scripts/process-gtfs.py <path-to-stop_times.txt>", file=sys.stderr)
    sys.exit(1)

file_size_mb = os.path.getsize(STOP_TIMES_FILE) / 1_048_576
print(f"Processing: {STOP_TIMES_FILE} ({file_size_mb:.1f} MB)")
print(f"Output:     {OUTPUT_DIR}/")
print()

# ── Ensure output directory ───────────────────────────────────────────────────

Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
Path("data").mkdir(parents=True, exist_ok=True)

# ── Parse stop_times.txt ──────────────────────────────────────────────────────

stop_times_map = defaultdict(list)  # stop_id -> [{tripId, time}, ...]
line_count = 0
start_time = time.time()

print("Parsing stop_times.txt...")

with open(STOP_TIMES_FILE, encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)

    # Validate required columns exist
    required = {"trip_id", "departure_time", "stop_id"}
    if not required.issubset(set(reader.fieldnames or [])):
        missing = required - set(reader.fieldnames or [])
        print(f"Error: Missing required columns: {missing}", file=sys.stderr)
        sys.exit(1)

    for row in reader:
        line_count += 1

        stop_id = row["stop_id"].strip()
        trip_id = row["trip_id"].strip()
        time_   = row["departure_time"].strip()

        if not stop_id or not trip_id or not time_:
            continue

        stop_times_map[stop_id].append({"tripId": trip_id, "time": time_})

        if line_count % 500_000 == 0:
            elapsed = time.time() - start_time
            print(f"  Parsed {line_count / 1_000_000:.1f}M lines · "
                  f"{len(stop_times_map):,} stops found · {elapsed:.1f}s elapsed")

parse_time = time.time() - start_time
print(f"\nParsed {line_count:,} lines in {parse_time:.1f}s")
print(f"Found {len(stop_times_map):,} unique stops")

# ── Write per-stop JSON files ─────────────────────────────────────────────────

print("Writing JSON files...")
written     = 0
total_deps  = 0
write_start = time.time()

for stop_id, entries in stop_times_map.items():
    out_file = os.path.join(OUTPUT_DIR, f"{stop_id}.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(entries, f, separators=(",", ":"))  # compact JSON

    total_deps += len(entries)
    written += 1

    if written % 2_000 == 0:
        print(f"  {written:,} / {len(stop_times_map):,} files written")

write_time = time.time() - write_start
total_time = time.time() - start_time

print(f"\nDone: Wrote {written:,} stop files in {write_time:.1f}s")
print(f"  Total departures: {total_deps:,}")

# ── Write feed_info.json ──────────────────────────────────────────────────────

feed_info = {
    "updatedAt":       datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "stopCount":       len(stop_times_map),
    "totalDepartures": total_deps,
}

with open(FEED_INFO_FILE, "w", encoding="utf-8") as f:
    json.dump(feed_info, f, indent=2)

print(f"Done: Wrote {FEED_INFO_FILE}")
print(f"\nTotal time: {total_time:.1f}s")

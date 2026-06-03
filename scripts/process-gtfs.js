#!/usr/bin/env node
/**
 * process-gtfs.js
 *
 * Reads a GTFS stop_times.txt file and splits it into per-stop JSON files
 * under data/stop_times/{stop_id}.json.
 *
 * Also writes data/feed_info.json with update metadata.
 *
 * Usage:
 *   node scripts/process-gtfs.js <path-to-stop_times.txt>
 *
 * Example:
 *   node scripts/process-gtfs.js google_transit/stop_times.txt
 *   node scripts/process-gtfs.js /tmp/gtfs_extract/stop_times.txt
 */

'use strict';

const fs        = require('fs');
const path      = require('path');
const readline  = require('readline');

// ── Config ───────────────────────────────────────────────────────────────────

const STOP_TIMES_FILE = process.argv[2] || path.join('google_transit', 'stop_times.txt');
const OUTPUT_DIR      = path.join('data', 'stop_times');
const FEED_INFO_FILE  = path.join('data', 'feed_info.json');

// ── Validate input ────────────────────────────────────────────────────────────

if (!fs.existsSync(STOP_TIMES_FILE)) {
  console.error(`Error: File not found: ${STOP_TIMES_FILE}`);
  console.error('Usage: node scripts/process-gtfs.js <path-to-stop_times.txt>');
  process.exit(1);
}

const fileSizeMB = (fs.statSync(STOP_TIMES_FILE).size / 1_048_576).toFixed(1);
console.log(`Processing: ${STOP_TIMES_FILE} (${fileSizeMB} MB)`);
console.log(`Output:     ${OUTPUT_DIR}/`);
console.log('');

// ── Ensure output directory ───────────────────────────────────────────────────

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Parse stop_times.txt ──────────────────────────────────────────────────────

const stopTimesMap = new Map(); // Map<stop_id, Array<{tripId, time}>>

const fileStream = fs.createReadStream(STOP_TIMES_FILE, { encoding: 'utf8' });
const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

let headerParsed = false;
let colTripId    = 0;
let colDep       = 2;
let colStopId    = 3;
let lineCount    = 0;
const startTime  = Date.now();

rl.on('line', (line) => {
  if (!line) return;
  lineCount++;

  if (!headerParsed) {
    // Parse the header row to find column indices
    const cols = line.split(',');
    colTripId = cols.indexOf('trip_id');
    colDep    = cols.indexOf('departure_time');
    colStopId = cols.indexOf('stop_id');

    if (colTripId === -1 || colDep === -1 || colStopId === -1) {
      console.error('Error: Could not find required columns in header:', line);
      process.exit(1);
    }

    headerParsed = true;
    return;
  }

  // Fast split — GTFS stop_times fields don't contain quoted commas
  const parts = line.split(',');
  const stopId = parts[colStopId]?.trim();
  const tripId = parts[colTripId]?.trim();
  const time   = parts[colDep]?.trim();

  if (!stopId || !tripId || !time) return;

  if (!stopTimesMap.has(stopId)) stopTimesMap.set(stopId, []);
  stopTimesMap.get(stopId).push({ tripId, time });

  // Log progress every 500k lines
  if (lineCount % 500_000 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const mb = (lineCount * 60 / 1_048_576).toFixed(0); // rough estimate
    process.stdout.write(
      `  Parsed ${(lineCount / 1_000_000).toFixed(1)}M lines · ` +
      `${stopTimesMap.size.toLocaleString()} stops found · ${elapsed}s elapsed\n`
    );
  }
});

rl.on('close', () => {
  const parseTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nParsed ${lineCount.toLocaleString()} lines in ${parseTime}s`);
  console.log(`Found ${stopTimesMap.size.toLocaleString()} unique stops`);
  console.log(`Writing JSON files...`);

  // ── Write per-stop JSON files ─────────────────────────────────────────────

  let written    = 0;
  let totalDeps  = 0;
  const writeStart = Date.now();

  for (const [stopId, entries] of stopTimesMap) {
    const outFile = path.join(OUTPUT_DIR, `${stopId}.json`);
    fs.writeFileSync(outFile, JSON.stringify(entries));
    totalDeps += entries.length;
    written++;

    if (written % 2_000 === 0) {
      process.stdout.write(
        `  ${written.toLocaleString()} / ${stopTimesMap.size.toLocaleString()} files written\n`
      );
    }
  }

  const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n✓ Wrote ${written.toLocaleString()} stop files in ${writeTime}s`);
  console.log(`  Total departures: ${totalDeps.toLocaleString()}`);

  // ── Write feed_info.json ──────────────────────────────────────────────────

  const feedInfo = {
    updatedAt:       new Date().toISOString(),
    stopCount:       stopTimesMap.size,
    totalDepartures: totalDeps,
  };
  fs.writeFileSync(FEED_INFO_FILE, JSON.stringify(feedInfo, null, 2));

  console.log(`✓ Wrote ${FEED_INFO_FILE}`);
  console.log(`\nTotal time: ${totalTime}s`);
});

rl.on('error', (err) => {
  console.error('Error reading file:', err);
  process.exit(1);
});

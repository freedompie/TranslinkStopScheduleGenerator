/**
 * TransLink Stop Schedule Generator
 * Produces hour-by-hour bus schedules from pre-processed GTFS data.
 *
 * Static GTFS files are loaded from ./google_transit/ (relative path).
 * Per-stop departure data is loaded from ./data/stop_times/{stop_id}.json
 * (pre-built by scripts/process-gtfs.py, refreshed weekly via GitHub Actions).
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const GTFS_BASE       = 'google_transit/';
const STOP_TIMES_BASE = 'data/stop_times/';

// Day-of-week index (JS: 0=Sun, 1=Mon, ..., 6=Sat)
const DOW_KEYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// Route type labels for styling
const ROUTE_TYPE_CLASS = {
  0: 'skytrain',  // Tram / Light Rail
  1: 'skytrain',  // Subway / Metro
  2: 'skytrain',  // Rail
  3: 'bus',       // Bus
  4: 'seabus',    // Ferry
};

// Detect RapidBus by short name prefix (R1, R2, …)
function isRapidBus(shortName) {
  return /^R\d/.test(shortName || '');
}

// ── In-memory caches ─────────────────────────────────────────────────────────

const cache = {
  stops: null,         // Map<stop_code, {stop_id, stop_name, wheelchair}>
  stopById: null,      // Map<stop_id, stop_code>  — reverse lookup
  trips: null,         // Map<trip_id, {route_id, headsign, service_id}>
  routes: null,        // Map<route_id, {short_name, route_type, color, text_color}>
  calendar: null,      // Map<service_id, Set<'weekday'|'saturday'|'sunday'>>
  calDates: null,      // Map<service_id, Map<date_str, exception_type>>
  stopTimes: new Map(),// Map<stop_id, [{tripId, time}]>  — keyed by GTFS stop_id
};

// ── UI Element References ────────────────────────────────────────────────────

const ui = {
  input:         () => document.getElementById('stopInput'),
  searchBtn:     () => document.getElementById('searchBtn'),
  pdfBtn:        () => document.getElementById('pdfBtn'),
  dayBtns:       () => document.querySelectorAll('.day-btn'),
  progressCard:  () => document.getElementById('progressCard'),
  progressLabel: () => document.getElementById('progressLabel'),
  progressPct:   () => document.getElementById('progressPct'),
  progressFill:  () => document.getElementById('progressFill'),
  progressDetail:() => document.getElementById('progressDetail'),
  errorCard:     () => document.getElementById('errorCard'),
  errorMsg:      () => document.getElementById('errorMsg'),
  stopBanner:    () => document.getElementById('stopBanner'),
  stopCodeBadge: () => document.getElementById('stopCodeBadge'),
  stopNameText:  () => document.getElementById('stopNameText'),
  stopMetaText:  () => document.getElementById('stopMetaText'),
  resultCount:   () => document.getElementById('resultCountBadge'),
  scheduleOut:   () => document.getElementById('scheduleOutput'),
  emptyState:    () => document.getElementById('emptyState'),
  routeFilter:   () => document.getElementById('routeFilter'),
};

// ── State ────────────────────────────────────────────────────────────────────

let selectedDay = 'today';
let isLoading = false;

// Route filter state — null means "all routes"
// Set<string> of routeShort names that are currently active
let activeRouteFilter = null;

// Last rendered data (so we can re-filter without re-fetching)
let lastRenderData = null; // { byHour, enriched, stopCode, stop_name }

// ── Utility: CSV line parser ─────────────────────────────────────────────────
// Handles simple CSV (no quoted commas in GTFS fields we care about)
function splitCSV(line) {
  return line.split(',');
}

// ── Utility: fetch full text file ────────────────────────────────────────────
async function fetchText(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Failed to fetch ${path}: ${resp.status}`);
  return resp.text();
}

// ── Parse stops.txt ──────────────────────────────────────────────────────────
// Columns: stop_lat,wheelchair_boarding,stop_code,stop_lon,stop_id,stop_url,parent_station,stop_desc,stop_name,location_type,zone_id
async function loadStops() {
  if (cache.stops) return;
  setProgress('Loading stop database…', 5);

  const text = await fetchText(GTFS_BASE + 'stops.txt');
  const lines = text.split('\n');
  const header = splitCSV(lines[0].trim());

  const iCode  = header.indexOf('stop_code');
  const iId    = header.indexOf('stop_id');
  const iName  = header.indexOf('stop_name');
  const iWC    = header.indexOf('wheelchair_boarding');

  cache.stops   = new Map();
  cache.stopById = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCSV(line);
    const code = f[iCode]?.trim();
    const id   = f[iId]?.trim();
    if (!code || !id) continue;

    const entry = {
      stop_id:   id,
      stop_name: f[iName]?.trim() || '',
      wheelchair: f[iWC]?.trim(),
    };
    cache.stops.set(code, entry);
    cache.stopById.set(id, code);
  }
}

// ── Parse routes.txt ─────────────────────────────────────────────────────────
// Columns: route_long_name,route_type,route_text_color,route_color,agency_id,route_id,...,route_short_name
async function loadRoutes() {
  if (cache.routes) return;
  setProgress('Loading route data…', 10);

  const text = await fetchText(GTFS_BASE + 'routes.txt');
  const lines = text.split('\n');
  const header = splitCSV(lines[0].trim());

  const iId         = header.indexOf('route_id');
  const iShort      = header.indexOf('route_short_name');
  const iType       = header.indexOf('route_type');
  const iColor      = header.indexOf('route_color');
  const iTextColor  = header.indexOf('route_text_color');

  cache.routes = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCSV(line);
    const id = f[iId]?.trim();
    if (!id) continue;
    cache.routes.set(id, {
      short_name: f[iShort]?.trim() || id,
      route_type: parseInt(f[iType]?.trim()) || 3,
      color:      f[iColor]?.trim() || '',
      text_color: f[iTextColor]?.trim() || '',
    });
  }
}

// ── Parse trips.txt ──────────────────────────────────────────────────────────
// Columns: block_id,bikes_allowed,route_id,wheelchair_accessible,direction_id,trip_headsign,shape_id,service_id,trip_id,trip_short_name
async function loadTrips() {
  if (cache.trips) return;
  setProgress('Loading trip data…', 20);

  const text = await fetchText(GTFS_BASE + 'trips.txt');
  const lines = text.split('\n');
  const header = splitCSV(lines[0].trim());

  const iTripId   = header.indexOf('trip_id');
  const iRouteId  = header.indexOf('route_id');
  const iHead     = header.indexOf('trip_headsign');
  const iSvcId    = header.indexOf('service_id');

  cache.trips = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCSV(line);
    const tripId = f[iTripId]?.trim();
    if (!tripId) continue;
    cache.trips.set(tripId, {
      route_id:   f[iRouteId]?.trim() || '',
      headsign:   f[iHead]?.trim()   || '',
      service_id: f[iSvcId]?.trim()  || '',
    });
  }
}

// ── Parse calendar.txt ───────────────────────────────────────────────────────
// Columns: service_id,start_date,end_date,monday,tuesday,wednesday,thursday,friday,saturday,sunday
async function loadCalendar() {
  if (cache.calendar) return;
  setProgress('Loading calendar data…', 30);

  const text = await fetchText(GTFS_BASE + 'calendar.txt');
  const lines = text.split('\n');
  const header = splitCSV(lines[0].trim());

  const iSvcId = header.indexOf('service_id');
  const iMon   = header.indexOf('monday');
  const iSat   = header.indexOf('saturday');
  const iSun   = header.indexOf('sunday');
  // Weekday = any of Mon-Fri is 1
  const iWkdays = ['monday','tuesday','wednesday','thursday','friday'].map(d => header.indexOf(d));

  cache.calendar = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCSV(line);
    const svcId = f[iSvcId]?.trim();
    if (!svcId) continue;

    const days = new Set();
    if (iWkdays.some(idx => f[idx]?.trim() === '1')) days.add('weekday');
    if (f[iSat]?.trim() === '1') days.add('saturday');
    if (f[iSun]?.trim() === '1') days.add('sunday');

    cache.calendar.set(svcId, days);
  }
}

// ── Parse calendar_dates.txt ─────────────────────────────────────────────────
// Columns: service_id,date,exception_type
// exception_type: 1=added, 2=removed
async function loadCalendarDates() {
  if (cache.calDates) return;

  const text = await fetchText(GTFS_BASE + 'calendar_dates.txt');
  const lines = text.split('\n');
  const header = splitCSV(lines[0].trim());

  const iSvcId = header.indexOf('service_id');
  const iDate  = header.indexOf('date');
  const iType  = header.indexOf('exception_type');

  cache.calDates = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCSV(line);
    const svcId = f[iSvcId]?.trim();
    const date  = f[iDate]?.trim();
    const type  = f[iType]?.trim();
    if (!svcId || !date) continue;

    if (!cache.calDates.has(svcId)) cache.calDates.set(svcId, new Map());
    cache.calDates.get(svcId).set(date, type);
  }
}

// ── Get day type ─────────────────────────────────────────────────────────────
function getDayType(selection) {
  if (selection !== 'today') return selection;
  const d = new Date().getDay(); // 0=Sun ... 6=Sat
  if (d === 0) return 'sunday';
  if (d === 6) return 'saturday';
  return 'weekday';
}

// ── Get active service IDs for a day type ────────────────────────────────────
function getActiveServiceIds(dayType) {
  const active = new Set();
  for (const [svcId, days] of cache.calendar.entries()) {
    if (days.has(dayType)) active.add(svcId);
  }
  return active;
}

// ── Fetch per-stop departure JSON ────────────────────────────────────────────
// Loads data/stop_times/{stop_id}.json — pre-built by scripts/process-gtfs.py
// and refreshed weekly via GitHub Actions.
async function loadStopTimes(targetStopId) {
  // Return cached result if available
  if (cache.stopTimes.has(targetStopId)) {
    return cache.stopTimes.get(targetStopId);
  }

  setProgress('Loading stop departures…', 50);

  const resp = await fetch(`${STOP_TIMES_BASE}${targetStopId}.json`);
  if (!resp.ok) {
    if (resp.status === 404) {
      // No JSON file means no scheduled service at this stop
      cache.stopTimes.set(targetStopId, []);
      return [];
    }
    throw new Error(`Could not load departure data for stop ${targetStopId}: ${resp.status}`);
  }

  const data = await resp.json();
  cache.stopTimes.set(targetStopId, data);
  return data;
}

// ── Convert GTFS time to display time ────────────────────────────────────────
// GTFS allows hours >= 24 for post-midnight service that continues from previous day
function parseGtfsTime(timeStr) {
  const [hStr, mStr, sStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  return { hour: h, minute: m, overMidnight: h >= 24 };
}

function formatTime(timeStr) {
  const { hour, minute, overMidnight } = parseGtfsTime(timeStr);
  const displayHour = overMidnight ? hour - 24 : hour;
  const period = displayHour < 12 ? 'AM' : 'PM';
  const h12 = displayHour % 12 || 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
}

// ── Build and render schedule ─────────────────────────────────────────────────
function buildSchedule(rawDepartures, activeServiceIds) {
  // Enrich with route/headsign info and filter by service
  const enriched = [];

  for (const { tripId, time } of rawDepartures) {
    const trip = cache.trips.get(tripId);
    if (!trip) continue;
    if (!activeServiceIds.has(trip.service_id)) continue;

    const route = cache.routes.get(trip.route_id);
    enriched.push({
      time,
      tripId,
      routeShort: route?.short_name || trip.route_id,
      headsign:   trip.headsign,
      routeType:  route?.route_type ?? 3,
      color:      route?.color || '',
      textColor:  route?.text_color || '',
    });
  }

  // Sort by time (handling >=24h GTFS times)
  enriched.sort((a, b) => {
    const [ah, am] = a.time.split(':').map(Number);
    const [bh, bm] = b.time.split(':').map(Number);
    return (ah * 60 + am) - (bh * 60 + bm);
  });

  // Deduplicate on display-level signature: same route + exact raw time + same headsign.
  // Two GTFS trips that appear identical to the passenger are collapsed to one chip.
  const deduped = [];
  const seenDisplay = new Set();
  for (const dep of enriched) {
    const key = `${dep.routeShort}|${dep.time}|${dep.headsign}`;
    if (!seenDisplay.has(key)) {
      seenDisplay.add(key);
      deduped.push(dep);
    }
  }

  // Group by hour bucket
  const byHour = new Map();
  for (const dep of deduped) {
    const { hour } = parseGtfsTime(dep.time);
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(dep);
  }

  return { enriched: deduped, byHour };
}


// ── Apply active route filter to enriched departures ─────────────────────────
function applyRouteFilter(enriched, filter) {
  // filter = null → show all; Set → show only matching routes
  const filtered = filter ? enriched.filter(d => filter.has(d.routeShort)) : enriched;

  const byHour = new Map();
  for (const dep of filtered) {
    const { hour } = parseGtfsTime(dep.time);
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(dep);
  }

  return { filtered, byHour };
}

// ── Collect unique routes from enriched departures ────────────────────────────
function collectRoutes(enriched) {
  const seen = new Map(); // routeShort → dep metadata
  for (const dep of enriched) {
    if (!seen.has(dep.routeShort)) {
      seen.set(dep.routeShort, dep);
    }
  }
  // Sort alphabetically (numeric-aware)
  return Array.from(seen.entries()).sort(([a], [b]) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  }).map(([, dep]) => dep);
}

// ── Render route filter bar ───────────────────────────────────────────────────
function renderRouteFilter(allRoutes, currentFilter, onFilterChange) {
  const container = ui.routeFilter();
  if (!container) return;

  // Hide filter bar if only one route
  if (allRoutes.length <= 1) {
    container.classList.remove('visible');
    container.innerHTML = '';
    return;
  }

  container.classList.add('visible');
  container.innerHTML = '';

  // Label
  const label = document.createElement('span');
  label.className = 'route-filter-label';
  label.textContent = 'Route:';
  container.appendChild(label);

  // "All" chip
  const allChip = document.createElement('button');
  allChip.className = 'route-filter-chip' + (currentFilter === null ? ' active' : '');
  allChip.textContent = 'All';
  allChip.setAttribute('aria-pressed', currentFilter === null ? 'true' : 'false');
  allChip.addEventListener('click', () => onFilterChange(null));
  container.appendChild(allChip);

  // One chip per route
  for (const dep of allRoutes) {
    const isActive = currentFilter === null || currentFilter.has(dep.routeShort);
    const chip = document.createElement('button');
    chip.className = 'route-filter-chip route-chip-route' + (isActive && currentFilter !== null ? ' active' : '');
    chip.setAttribute('aria-pressed', isActive && currentFilter !== null ? 'true' : 'false');

    // Style matching route pill
    let pillClass = ROUTE_TYPE_CLASS[dep.routeType] || 'bus';
    if (dep.routeType === 3 && isRapidBus(dep.routeShort)) pillClass = 'rapidbus';
    chip.classList.add(`route-type-${pillClass}`);

    if (dep.color && dep.textColor) {
      chip.style.setProperty('--chip-bg', `rgba(${hexToRgb(dep.color)},0.25)`);
      chip.style.setProperty('--chip-border', `rgba(${hexToRgb(dep.color)},0.5)`);
      chip.style.setProperty('--chip-text', `#${dep.textColor}`);
    }

    chip.textContent = dep.routeShort;
    chip.addEventListener('click', () => {
      // Toggle this route in/out of the filter set
      let next;
      if (currentFilter === null) {
        // Was showing all — switch to showing only this route
        next = new Set([dep.routeShort]);
      } else {
        next = new Set(currentFilter);
        if (next.has(dep.routeShort)) {
          next.delete(dep.routeShort);
          if (next.size === 0) next = null; // deselecting last → reset to All
        } else {
          next.add(dep.routeShort);
          // If all routes selected, collapse back to null (All)
          if (next.size === allRoutes.length) next = null;
        }
      }
      onFilterChange(next);
    });
    container.appendChild(chip);
  }
}

function renderSchedule(byHour, stopCode, stopName, totalCount, dayLabel) {
  const out = ui.scheduleOut();

  // Clear previous content except empty state
  const emptyState = ui.emptyState();
  out.innerHTML = '';
  out.appendChild(emptyState);
  emptyState.classList.remove('visible');

  // Update stop banner
  ui.stopBanner().classList.add('visible');
  ui.stopCodeBadge().textContent = stopCode;
  ui.stopNameText().textContent = stopName;
  ui.stopMetaText().textContent = `${dayLabel} schedule`;
  ui.resultCount().textContent = `${totalCount} departure${totalCount !== 1 ? 's' : ''}`;

  if (byHour.size === 0) {
    emptyState.classList.add('visible');
    emptyState.querySelector('h3').textContent = activeRouteFilter ? 'No service for selected route(s)' : 'No service found';
    emptyState.querySelector('p').textContent = activeRouteFilter
      ? 'Try selecting a different route or click "All" to see every departure.'
      : `No scheduled departures at stop ${stopCode} on ${dayLabel}. Try a different day.`;
    return;
  }

  const hours = Array.from(byHour.keys()).sort((a, b) => a - b);
  let animDelay = 0;

  for (const hour of hours) {
    const deps = byHour.get(hour);
    const overMidnight = hour >= 24;
    const displayHour = overMidnight ? hour - 24 : hour;
    const period = displayHour < 12 ? 'AM' : 'PM';
    const h12 = displayHour % 12 || 12;
    const hourLabel = `${String(h12).padStart(2,'0')}:00`;

    const block = document.createElement('div');
    block.className = 'hour-block';
    block.style.animationDelay = `${animDelay}ms`;
    animDelay += 40;

    // Hour header
    const header = document.createElement('div');
    header.className = 'hour-header';
    header.innerHTML = `
      <span class="hour-label">${hourLabel}</span>
      <span class="hour-period">${period}</span>
      <span class="hour-trip-count">${deps.length} bus${deps.length !== 1 ? 'es' : ''}</span>
    `;
    block.appendChild(header);

    // Post-midnight note
    if (overMidnight) {
      const note = document.createElement('div');
      note.className = 'midnight-note';
      note.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
        After-midnight service (next calendar day)
      `;
      block.appendChild(note);
    }

    // Departure chips
    const grid = document.createElement('div');
    grid.className = 'departures-grid';

    for (const dep of deps) {
      const chip = document.createElement('div');
      chip.className = 'dep-chip';
      chip.setAttribute('role', 'listitem');

      // Route pill styling
      let pillClass = ROUTE_TYPE_CLASS[dep.routeType] || 'bus';
      if (dep.routeType === 3 && isRapidBus(dep.routeShort)) pillClass = 'rapidbus';

      let pillStyle = '';
      if (dep.color && dep.textColor) {
        pillStyle = `style="background:rgba(${hexToRgb(dep.color)},0.25);color:#${dep.textColor};border-color:rgba(${hexToRgb(dep.color)},0.5);"`;
      }

      chip.innerHTML = `
        <span class="route-pill ${pillClass}" ${pillStyle}>${escHtml(dep.routeShort)}</span>
        <div class="dep-info">
          <div class="dep-time">${formatTime(dep.time)}</div>
          <div class="dep-headsign">${escHtml(cleanHeadsign(dep.headsign))}</div>
        </div>
      `;
      grid.appendChild(chip);
    }

    block.appendChild(grid);
    out.appendChild(block);
  }
}

// ── Full re-render with current filter ────────────────────────────────────────
function reRenderWithFilter(filter) {
  if (!lastRenderData) return;
  activeRouteFilter = filter;

  const { enriched, allRoutes, stopCode, stop_name, dayLabelStr } = lastRenderData;

  // Re-render filter bar with updated state
  renderRouteFilter(allRoutes, activeRouteFilter, reRenderWithFilter);

  // Apply filter and re-render schedule
  const { filtered, byHour } = applyRouteFilter(enriched, activeRouteFilter);
  renderSchedule(byHour, stopCode, stop_name, filtered.length, dayLabelStr);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#',''), 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

function cleanHeadsign(hs) {
  // Remove redundant route number prefix if present (e.g. "49 49TH Avenue" → "49TH Avenue")
  return (hs || '').replace(/^\d+\s+/, '').replace(/^[A-Z]\d+\s+/, '');
}

// ── Progress & Error UI ───────────────────────────────────────────────────────

function setProgress(label, pct, detail = '') {
  ui.progressCard().classList.add('visible');
  ui.errorCard().classList.remove('visible');
  ui.progressLabel().textContent = label;
  ui.progressPct().textContent = `${Math.round(pct)}%`;
  ui.progressFill().style.width = `${pct}%`;
  ui.progressDetail().textContent = detail;
}

function hideProgress() {
  ui.progressCard().classList.remove('visible');
}

function showError(msg) {
  hideProgress();
  ui.errorCard().classList.add('visible');
  ui.errorMsg().textContent = msg;
}

function clearError() {
  ui.errorCard().classList.remove('visible');
}

// ── Day label helper ──────────────────────────────────────────────────────────

function dayLabel(day) {
  const today = getDayType('today');
  if (day === 'today' || day === today) {
    const labels = { weekday: 'Weekdays', saturday: 'Saturday', sunday: 'Sunday' };
    return `Today (${labels[today] || today})`;
  }
  const labels = { weekday: 'Weekdays', saturday: 'Saturday', sunday: 'Sunday' };
  return labels[day] || day;
}

// ── PDF Export ────────────────────────────────────────────────────────────────

function generatePdf() {
  if (!lastRenderData) return;

  // Stamp a print timestamp onto the banner so the CSS ::after can read it
  const banner = ui.stopBanner();
  if (banner) {
    const now = new Date();
    const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    banner.dataset.printDate = now.toLocaleString(undefined, opts);
  }

  window.print();
}

// ── Main search handler ───────────────────────────────────────────────────────

async function handleSearch() {
  if (isLoading) return;

  clearError();

  const raw = ui.input().value.trim();
  if (!raw) {
    showError('Please enter a stop number.');
    return;
  }

  // Strip any leading zeros but keep the string form
  const stopCode = raw.replace(/^0+/, '') || '0';

  isLoading = true;
  ui.searchBtn().disabled = true;
  ui.searchBtn().innerHTML = `<span class="spinner"></span> Loading…`;
  ui.stopBanner().classList.remove('visible');

  // Hide route filter from previous search
  const routeFilterEl = ui.routeFilter();
  if (routeFilterEl) {
    routeFilterEl.classList.remove('visible');
    routeFilterEl.innerHTML = '';
  }

  // Clear previous results
  const out = ui.scheduleOut();
  const emptyState = ui.emptyState();
  out.innerHTML = '';
  out.appendChild(emptyState);
  emptyState.classList.remove('visible');

  try {
    // 1. Load all small data files (cached after first load)
    await loadStops();
    await loadRoutes();
    await loadTrips();
    await loadCalendar();
    await loadCalendarDates();

    // 2. Resolve stop_code → stop_id
    const stopEntry = cache.stops.get(stopCode);
    if (!stopEntry) {
      showError(`Stop number "${stopCode}" not found. Please check the number and try again.`);
      return;
    }

    const { stop_id, stop_name } = stopEntry;

    // 3. Determine active service IDs
    const dayType = getDayType(selectedDay);
    const activeServices = getActiveServiceIds(dayType);

    // 4. Fetch pre-built per-stop departure JSON
    const rawDepartures = await loadStopTimes(stop_id);

    setProgress('Building schedule…', 97);

    // 5. Filter and group
    const { enriched, byHour } = buildSchedule(rawDepartures, activeServices);

    hideProgress();

    // 6. Collect routes and reset filter on new stop search
    const allRoutes = collectRoutes(enriched);
    activeRouteFilter = null; // Reset filter on fresh search

    console.log(`[RouteFilter] Stop ${stopCode}: ${enriched.length} departures, ${allRoutes.length} unique routes:`, allRoutes.map(d => d.routeShort));

    // 7. Save render data for re-filtering
    lastRenderData = { enriched, allRoutes, stopCode, stop_name, dayLabelStr: dayLabel(selectedDay) };

    // 8. Render filter bar
    renderRouteFilter(allRoutes, activeRouteFilter, reRenderWithFilter);

    // 9. Render schedule using byHour from buildSchedule (filter is always null here)
    renderSchedule(byHour, stopCode, stop_name, enriched.length, dayLabel(selectedDay));

  } catch (err) {
    console.error(err);
    showError(`Error: ${err.message}`);
  } finally {
    isLoading = false;
    ui.searchBtn().disabled = false;
    ui.searchBtn().innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Look Up
    `;
  }
}

// ── Re-render when day changes (without re-fetching) ─────────────────────────

async function handleDayChange(newDay) {
  selectedDay = newDay;

  // Update button states
  ui.dayBtns().forEach(btn => {
    btn.classList.toggle('active', btn.dataset.day === newDay);
  });

  // If we have cached results for current stop, re-render immediately
  const raw = ui.input().value.trim().replace(/^0+/, '') || '0';
  if (!raw || !cache.stops) return;

  const stopEntry = cache.stops.get(raw);
  if (!stopEntry) return;

  const { stop_id, stop_name } = stopEntry;
  if (!cache.stopTimes.has(stop_id)) return;

  const rawDepartures = cache.stopTimes.get(stop_id);
  const dayType = getDayType(newDay);
  const activeServices = getActiveServiceIds(dayType);
  const { enriched, byHour } = buildSchedule(rawDepartures, activeServices);

  // Collect routes and preserve/update filter
  const allRoutes = collectRoutes(enriched);
  // Reset filter if it references a route not present on new day
  if (activeRouteFilter !== null) {
    const availableRoutes = new Set(allRoutes.map(d => d.routeShort));
    const stillValid = new Set([...activeRouteFilter].filter(r => availableRoutes.has(r)));
    activeRouteFilter = stillValid.size > 0 ? stillValid : null;
  }

  lastRenderData = { enriched, allRoutes, stopCode: raw, stop_name, dayLabelStr: dayLabel(newDay) };

  renderRouteFilter(allRoutes, activeRouteFilter, reRenderWithFilter);

  // Only apply filter if one is active; otherwise use byHour from buildSchedule directly
  if (activeRouteFilter !== null) {
    const { filtered, byHour: filteredByHour } = applyRouteFilter(enriched, activeRouteFilter);
    renderSchedule(filteredByHour, raw, stop_name, filtered.length, dayLabel(newDay));
  } else {
    renderSchedule(byHour, raw, stop_name, enriched.length, dayLabel(newDay));
  }
}

// ── Feed freshness ───────────────────────────────────────────────────────────
// Loads data/feed_info.json and displays the data date in the footer.
async function loadFeedInfo() {
  try {
    const resp = await fetch('data/feed_info.json');
    if (!resp.ok) return;
    const info = await resp.json();
    const el = document.getElementById('feedUpdatedAt');
    if (!el || !info.updatedAt) return;
    const date = new Date(info.updatedAt);
    const label = date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    el.textContent = `Schedule data as of ${label}`;
    el.classList.add('visible');
  } catch {
    // Non-critical — silently ignore if file doesn't exist yet
  }
}

// ── Event Listeners ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Search button
  ui.searchBtn().addEventListener('click', handleSearch);

  // PDF export button
  const pdfBtn = ui.pdfBtn();
  if (pdfBtn) pdfBtn.addEventListener('click', generatePdf);

  // Enter key in input
  ui.input().addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSearch();
  });

  // Numeric-only input filter
  ui.input().addEventListener('input', () => {
    ui.input().value = ui.input().value.replace(/[^0-9]/g, '');
  });

  // Day buttons
  ui.dayBtns().forEach(btn => {
    btn.addEventListener('click', () => handleDayChange(btn.dataset.day));
  });

  // Show empty state on first load
  ui.emptyState().classList.add('visible');

  // Load and display data freshness date
  loadFeedInfo();

  // Highlight "today" button label with actual day
  const todayDay = getDayType('today');
  const todayBtn = document.getElementById('dayToday');
  if (todayBtn) {
    const labels = { weekday: 'Today (Wkday)', saturday: 'Today (Sat)', sunday: 'Today (Sun)' };
    todayBtn.textContent = labels[todayDay] || 'Today';
  }
});

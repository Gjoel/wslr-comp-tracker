import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import fs from 'fs';

// ---------- Config ----------

const TEST_MODE    = !!process.env.TEST;
const DAYS_AHEAD   = TEST_MODE ? 10 : 365;
const CONCURRENCY  = parseInt(process.env.CONCURRENCY || (TEST_MODE ? '4' : '6'), 10);
const DELAY_MIN_MS = 1500;
const DELAY_MAX_MS = 3500;
const START_DATE   = process.env.START_DATE;
const END_DATE     = process.env.END_DATE;
const FLUSH_EVERY  = 50;   // flush to Supabase every N rows per worker
const PROBE_MAX    = parseInt(process.env.PROBE_MAX || '3', 10);  // longest stay we'll probe when a date rejects shorter ones

// ---------- Supabase ----------

const SUPABASE_URL = (process.env.SUPABASE_URL || '')
  .trim()
  .replace(/^\uFEFF/, '')
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim().replace(/^\uFEFF/, '');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const SCRAPE_RUN_ID = randomUUID();

// ---------- Load properties from Supabase ----------

async function loadProperties() {
  const { data, error } = await supabase
    .from('competitor_properties')
    .select('name, slug')
    .eq('active', true)
    .order('display_order', { ascending: true });
  if (error) {
    console.error('Failed to load competitor_properties:', error);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.error('No active rows in competitor_properties. Add at least one row before running the scraper.');
    process.exit(1);
  }
  return data;
}

// ---------- Date sampling ----------

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function generateDateList() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let startDate, endDate;
  if (START_DATE) {
    startDate = new Date(START_DATE + 'T00:00:00');
    if (END_DATE) {
      endDate = new Date(END_DATE + 'T00:00:00');
    } else {
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + DAYS_AHEAD - 1);
    }
  } else if (END_DATE) {
    startDate = new Date(today);
    startDate.setDate(today.getDate() + 1);
    endDate = new Date(END_DATE + 'T00:00:00');
  } else {
    startDate = new Date(today);
    startDate.setDate(today.getDate() + 1);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + DAYS_AHEAD - 1);
  }

  if (endDate < startDate) {
    console.error(`End date ${fmt(endDate)} is before start date ${fmt(startDate)}.`);
    process.exit(1);
  }

  // We no longer pre-decide how many nights to scrape. For every check-in date we
  // probe 1 night first and let Booking.com tell us the real minimum stay (which
  // can differ per property). See scrapeOne().
  const dates = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    dates.push({ checkIn: fmt(new Date(cursor)) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// Day-of-week label only — used for the notes field, NOT to decide nights.
function dowStayType(checkIn) {
  const dow = new Date(checkIn + 'T00:00:00').getDay(); // 0=Sun, 5=Fri, 6=Sat
  return (dow === 5 || dow === 6 || dow === 0) ? 'weekend' : 'midweek';
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmt(d);
}

// Text signals that a date is rejecting a stay because it's shorter than the
// property's minimum — i.e. a reason to probe a longer stay rather than record sold-out.
const MIN_STAY_HINT_RE = /minimum (?:stay|length of stay)|night minimum|minimum number of nights|need to stay \d|stay \d+\+? nights?/i;

// ---------- Scrape ----------

function buildUrl(slug, checkIn, checkOut) {
  const params = new URLSearchParams({
    checkin: checkIn,
    checkout: checkOut,
    group_adults: '2',
    group_children: '0',
    no_rooms: '1',
    selected_currency: 'AUD',
  });
  return `https://www.booking.com/hotel/au/${slug}.en-gb.html?${params.toString()}`;
}

// PRIMARY price extractor. Booking.com labels every room's headline nightly
// rate as "AUD 182 per night" (with AUD / AU$ / A$ / $ and per night / nightly
// variants). That figure is exactly the per-night rate we want, so we grab it
// directly — no dividing, no window-scanning.
//
// This replaces an older approach that tried to find a stay TOTAL and divide by
// nights. That approach broke badly: the phrase "Free cancellation before <date>"
// (present on almost every row) tripped a "before/was" strike-through filter and
// discarded the real price, leaving only the "select N rooms" multi-room totals.
// Math.min then picked the 2-rooms total, doubling the stored rate
// (e.g. storing AU$363 = 2×$182, or AU$315 ≈ 2×$157 for Corrimal).
function perNightFromText(text) {
  const re = /(?:AUD|AU\$|A\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:per\s*night|\/\s*night|each\s*night|nightly|a\s*night)/gi;
  const vals = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v >= 50 && v < 10000) vals.push(v);
  }
  return vals.length ? Math.min(...vals) : null;
}

// FALLBACK extractor: every in-range price in the text, no filtering.
// Used only when no explicit "per night" figure is present. The genuine
// single-night rate is the smallest real number in a room row — struck-through
// originals are higher, multi-room "select N rooms" totals are higher, and
// taxes/fees fall below the 50 floor — so callers take the minimum.
function pricesFromText(text) {
  const re = /(?:AUD|AU\$|A\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (value >= 50 && value < 10000) out.push(value);
  }
  return out;
}

// "Only 2 left at this price!", "Only 1 left on our site", "We have 5 left"
function extractRoomsLeft(text) {
  if (!text) return null;
  const patterns = [
    /only\s+(\d+)\s+(?:rooms?\s+)?left/i,
    /we have\s+(\d+)\s+(?:rooms?\s+)?left/i,
    /(\d+)\s+rooms?\s+left\s+at\s+this\s+price/i,
  ];
  for (const re of patterns) {
    const mm = text.match(re);
    if (mm) {
      const n = parseInt(mm[1], 10);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

// Real room names always include one of these descriptors. Promo labels, price strings,
// guest-count callouts, and discount banners don't.
const ROOM_KEYWORD_RE = /\b(?:room|suite|apartment|cabin|studio|bungalow|bedroom|loft|villa|cottage|penthouse|chalet|townhouse|residence|dorm)\b/i;

function looksLikeRoomName(line) {
  if (!line || line.length <= 3 || line.length >= 120) return false;
  // POSITIVE filter: must contain a recognised room-type word
  if (!ROOM_KEYWORD_RE.test(line)) return false;
  // Anything containing a currency amount anywhere (e.g. "Original price AUD 391 Current price AUD 313")
  if (/(?:AUD|AU\$|A\$)\s*\d/i.test(line)) return false;
  if (/\$\s*\d{2,}/.test(line)) return false;
  // Promo / restriction / availability labels (start-of-line)
  if (/^(?:price|from|now|was|total|today|cheapest|select|book|original|only|excluded|sleeps|max)\b/i.test(line)) return false;
  // "8% off" and similar
  if (/^\s*\d+\s*%/i.test(line)) return false;
  // Currency-prefixed
  if (/^(?:AUD|AU\$|A\$|\$)/i.test(line)) return false;
  // Guest/bed counts
  if (/^\d+\s*(?:guests?|adults?|children?|beds?|nights?)/i.test(line)) return false;
  if (/^(only \d+ left|free cancellation|breakfast included|no prepayment)/i.test(line)) return false;
  if (!/[a-z]/i.test(line)) return false;
  return true;
}

async function getRoomRates(page, nights) {
  const tableSelectors = [
    '#hprt-table',
    'table.hprt-table',
    '[data-testid="property-most-relevant-units"]',
  ];
  let table = null;
  for (const sel of tableSelectors) {
    table = await page.$(sel);
    if (table) break;
  }
  if (!table) return { rooms: [], source: 'no-table' };

  let rows = await table.$$('tr.hprt-table-row, tr[data-block-id], tr.js-rt-block-row');
  if (rows.length === 0) rows = await table.$$('tr');

  const byName = {};
  for (const row of rows) {
    const text = (await row.innerText().catch(() => '')).trim();
    if (!text || text.length < 15) continue;
    if (/^(room type|sleeps|today.?s price|select|your choices)/i.test(text)) continue;

    // Prefer Booking's explicit "per night" figure — it's already per-night,
    // so no division. Only if no per-night label exists do we fall back to the
    // cheapest in-range price (and divide for multi-night, since that figure is
    // then likely a stay total).
    let perNight = perNightFromText(text);
    if (perNight == null) {
      const prices = pricesFromText(text);
      if (prices.length === 0) continue;
      perNight = nights > 1 ? Math.min(...prices) / nights : Math.min(...prices);
    }

    const lines = text.split('\n').map(l => l.trim()).filter(looksLikeRoomName);
    const roomName = lines[0];
    if (!roomName) continue;

    const roomsLeft = extractRoomsLeft(text);
    if (!byName[roomName] || perNight < byName[roomName].rate) {
      byName[roomName] = { roomName, rate: perNight, roomsLeft };
    } else if (roomsLeft != null && byName[roomName].roomsLeft == null) {
      // Keep cheapest rate but still record a roomsLeft signal if we see it later
      byName[roomName].roomsLeft = roomsLeft;
    }
  }

  return { rooms: Object.values(byName), source: 'hprt-table' };
}

async function scrapeOne(browser, property, checkIn, workerId) {
  const tag = `[W${workerId}]`;
  const stayType = dowStayType(checkIn);
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-AU',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Build the row template for a given check-out / stay length.
  const baseFor = (checkOut) => ({
    scrape_run_id: SCRAPE_RUN_ID,
    property: property.name,
    property_slug: property.slug,
    check_in: checkIn,
    check_out: checkOut,
    currency: 'AUD',
    source: 'booking.com',
  });

  try {
    const recorded = new Map();   // room_name -> row, kept at the SHORTEST length it appears
    let explicitMin = null;       // a minimum Booking states in words, if any
    let lastSource = '';
    let len = 1;                  // start by asking for a single night

    while (len <= PROBE_MAX) {
      const checkOut = addDays(checkIn, len);
      const base = baseFor(checkOut);
      const url = buildUrl(property.slug, checkIn, checkOut);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector(
        '#hprt-table, [data-testid="property-most-relevant-units"], [data-component="availability"], [id*="hprt"]',
        { timeout: 8000 }
      ).catch(() => {});
      await page.waitForTimeout(1200);

      for (const sel of [
        '[aria-label="Dismiss sign-in info."]',
        '[aria-label="Dismiss sign in information."]',
        'button[aria-label*="Dismiss"]',
      ]) {
        try { await page.click(sel, { timeout: 500 }); break; } catch {}
      }

      const bodyText = await page.locator('body').innerText();
      const isNotFound   = /page not found/i.test(bodyText);
      const isSoldOut    = /sold out|no rooms available/i.test(bodyText);
      const notAvailable = /not available on our site for your dates/i.test(bodyText);
      const notBookable  = /(?:isn.t|is not|not currently|not)\s+(?:taking|accepting)\s+(?:reservations|bookings)|currently\s+(?:not bookable|unavailable)|temporarily\s+(?:closed|unavailable)/i.test(bodyText);

      const mm = bodyText.match(/you need to stay (\d+)\+? nights?/i)
              || bodyText.match(/minimum (?:stay|length of stay)[^\d]{0,24}(\d+)/i)
              || bodyText.match(/(\d+)\s*[- ]?night minimum/i);
      if (mm) explicitMin = Math.max(explicitMin || 0, parseInt(mm[1], 10));

      // 404 and "not taking bookings" don't depend on stay length — bail immediately.
      if (isNotFound) {
        console.log(`${tag} ✗ 404           ${property.name} ${checkIn}`);
        return [];
      }
      if (notBookable) {
        console.log(`${tag} ⊘ NOT BOOKABLE  ${property.name}  ${checkIn}`);
        return [{ ...base, room_name: '(property not bookable)', rate: null, available: false, min_nights: null, notes: `stay_type=${stayType}; nights=${len}; not taking bookings on booking.com` }];
      }

      const { rooms, source } = await getRoomRates(page, len);
      lastSource = source;

      // Record any NEW room at this length. Because we probe shortest-first, the
      // first time we see a room is at its own minimum stay — so min_nights and the
      // per-night rate are correct per room, even when rooms have different minimums.
      for (const r of rooms) {
        if (!recorded.has(r.roomName)) {
          recorded.set(r.roomName, {
            ...base,
            room_name: r.roomName,
            rate: r.rate,                 // per night (Booking's averaged per-night for the stay)
            available: true,
            min_nights: len,              // 1 == bookable as a single night; >1 == this room's real minimum
            rooms_left: r.roomsLeft,
            notes: `stay_type=${stayType}; nights=${len}; min_nights=${len}; source=hprt-table; probe`,
          });
        }
      }

      // Body-text fallback only if we've found nothing structured anywhere yet.
      if (rooms.length === 0 && recorded.size === 0 && !isSoldOut && !notAvailable) {
        let lowest = perNightFromText(bodyText);
        if (lowest == null) {
          const prices = pricesFromText(bodyText).filter(n => n >= 150);
          if (prices.length) lowest = Math.min(...prices) / len;
        }
        if (lowest != null) {
          recorded.set('(unknown)', { ...base, room_name: '(unknown)', rate: lowest, available: true, min_nights: len, notes: `stay_type=${stayType}; nights=${len}; min_nights=${len}; fallback to body-text lowest; source=${source}` });
        }
      }

      // Decide whether to probe a longer stay.
      const minStayHint = !!explicitMin || MIN_STAY_HINT_RE.test(bodyText) || stayType === 'weekend';
      if (explicitMin && explicitMin > len) { len = explicitMin; continue; }              // jump to a stated minimum
      if (len === 1 && stayType === 'weekend' && len < PROBE_MAX) { len = 2; continue; }   // weekend: also check 2 nights for rooms with a 2-night minimum, even if a 1-night room was found
      if (recorded.size === 0 && minStayHint && len < PROBE_MAX) { len += 1; continue; }   // still nothing — keep looking
      break;                                                                               // captured what's available
    }

    if (recorded.size === 0) {
      const checkOut = addDays(checkIn, Math.min(len, PROBE_MAX));
      console.log(`${tag} • ${explicitMin ? `MIN ${explicitMin} NIGHTS` : 'SOLD OUT'}  ${property.name}  ${checkIn}`);
      return [{ ...baseFor(checkOut), room_name: explicitMin ? `(min ${explicitMin} nights required)` : '(sold out)', rate: null, available: false, min_nights: explicitMin || null, notes: `stay_type=${stayType}; no availability; min=${explicitMin || '?'}; source=${lastSource}` }];
    }

    const rows = [...recorded.values()];
    const priced = rows.filter(r => r.rate != null);
    const cheapest = priced.length ? Math.min(...priced.map(r => r.rate)) : null;
    const minsSeen = [...new Set(rows.map(r => r.min_nights))].sort().join('/');
    console.log(`${tag} ✓ ${property.name.padEnd(36)} ${checkIn} ${stayType.padEnd(7)} ${rows.length}rm  min-nights ${minsSeen}  cheapest ${cheapest != null ? 'AU$' + cheapest.toFixed(0) + '/n' : 'n/a'}`);
    return rows;
  } catch (err) {
    console.log(`${tag} ✗ ERROR         ${property.name} ${checkIn}: ${err.message}`);
    return [];
  } finally {
    await context.close();
  }
}

// ---------- Main ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a, b) => a + Math.floor(Math.random() * (b - a));

(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    process.exit(1);
  }

  console.log(`Mode: ${TEST_MODE ? 'TEST' : 'FULL'}   Days ahead: ${DAYS_AHEAD}   Concurrency: ${CONCURRENCY}   Flush every: ${FLUSH_EVERY}`);
  console.log(`Per check-in: probe 1 night first, then up to ${PROBE_MAX} nights if a minimum-stay rule blocks shorter stays. Real per-property minimum is stored in min_nights.`);
  if (START_DATE || END_DATE) console.log(`Custom range from workflow inputs — START_DATE=${START_DATE || '(default)'}  END_DATE=${END_DATE || '(default)'}`);
  console.log(`Scrape run id: ${SCRAPE_RUN_ID}`);
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  console.log('Pinging Supabase...');
  const { error: pingError } = await supabase.from('competitor_room_rates').select('id').limit(1);
  if (pingError) {
    console.error('Supabase ping failed:', pingError);
    process.exit(1);
  }
  console.log('Supabase OK.');

  console.log('Loading active properties from competitor_properties table...');
  const PROPERTIES = await loadProperties();
  console.log(`Loaded ${PROPERTIES.length} properties: ${PROPERTIES.map(p => p.name).join(', ')}\n`);

  const dates = generateDateList();
  console.log(`Date range: ${dates[0].checkIn} → ${dates[dates.length - 1].checkIn}  (${dates.length} dates)\n`);
  const jobs = [];
  for (const d of dates) {
    for (const prop of PROPERTIES) {
      jobs.push({ property: prop, checkIn: d.checkIn });
    }
  }

  const startedAt = Date.now();
  console.log(`Scraping ${jobs.length} jobs with ${CONCURRENCY} parallel workers. Inserting incrementally every ${FLUSH_EVERY} rows per worker.\n`);
  const browser = await chromium.launch({ headless: true });

  const queues = Array.from({ length: CONCURRENCY }, () => []);
  jobs.forEach((job, i) => queues[i % CONCURRENCY].push(job));

  let totalInserted = 0;
  let totalFailed = 0;

  const workerResults = await Promise.all(queues.map(async (queue, workerId) => {
    await sleep(workerId * 1500);
    const allRowsForWorker = [];
    const buffer = [];

    const flushBuffer = async () => {
      if (buffer.length === 0) return;
      const toInsert = buffer.splice(0, buffer.length);
      const { error } = await supabase.from('competitor_room_rates').insert(toInsert);
      if (error) {
        totalFailed += toInsert.length;
        console.error(`[W${workerId}] ✗ Insert error (${toInsert.length} rows): ${error.message}`);
      } else {
        totalInserted += toInsert.length;
        console.log(`[W${workerId}] ✓ Flushed ${toInsert.length} rows (worker so far: ${allRowsForWorker.length}, run total inserted: ${totalInserted})`);
      }
    };

    for (const job of queue) {
      const rows = await scrapeOne(browser, job.property, job.checkIn, workerId);
      allRowsForWorker.push(...rows);
      buffer.push(...rows);

      if (buffer.length >= FLUSH_EVERY) {
        await flushBuffer();
      }

      await sleep(rand(DELAY_MIN_MS, DELAY_MAX_MS));
    }

    // Final flush for any remainder
    await flushBuffer();

    return allRowsForWorker;
  }));

  const records = workerResults.flat();
  await browser.close();

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  const dumpPath = `dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(dumpPath, JSON.stringify(records, null, 2));
  console.log(`\nScraping done in ${elapsedMin} min.`);
  console.log(`Records scraped: ${records.length}`);
  console.log(`Records inserted to Supabase: ${totalInserted}`);
  if (totalFailed > 0) {
    console.log(`Records that failed to insert: ${totalFailed} — see error logs above. Backup dump: ${dumpPath}`);
  } else {
    console.log(`Backup dump: ${dumpPath}`);
  }
  console.log('Done.');
})();
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

  const dates = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const inDate = new Date(cursor);
    const dow = inDate.getDay();  // 0=Sun, 5=Fri, 6=Sat
    // WSLR (and similar) don't allow 1-night stays touching the weekend.
    // Scrape 2 nights for Fri/Sat/Sun check-ins so we capture real availability.
    const isWeekendCheckin = (dow === 5 || dow === 6 || dow === 0);
    const nights = isWeekendCheckin ? 2 : 1;
    const outDate = new Date(inDate);
    outDate.setDate(inDate.getDate() + nights);
    const stayType = isWeekendCheckin ? 'weekend' : 'midweek';
    dates.push({ checkIn: fmt(inDate), checkOut: fmt(outDate), stayType, nights });
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

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

function pricesFromText(text) {
  // Match a price AND look at the surrounding 80 chars on each side
  // to skip ones that are Genius/loyalty/strikethrough/before-price labels.
  const re = /(?:AUD|AU\$|A\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (!(value >= 50 && value < 10000)) continue;
    const windowStart = Math.max(0, m.index - 80);
    const windowEnd = Math.min(text.length, m.index + m[0].length + 80);
    const windowText = text.substring(windowStart, windowEnd).toLowerCase();
    // Skip prices that look like Genius/loyalty/member preview rates,
    // strikethrough originals, or "save AUD …" deltas.
    if (/\b(?:genius|loyalty|member[\s-]?only|app[\s-]?only|mobile[\s-]?only|signed\s*in|sign\s*in|book\s+direct|earn\s+\d|reward(?:\s+nights?)?)\b/.test(windowText)) continue;
    if (/\b(?:was|before|originally|original\s+price|rrp|crossed[\s-]?out|reduced\s+from|save\s+(?:au\$|aud|a\$|\$))\b/.test(windowText)) continue;
    out.push(value);
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

    const prices = pricesFromText(text);
    if (prices.length === 0) continue;
    const stayTotal = Math.min(...prices);

    const lines = text.split('\n').map(l => l.trim()).filter(looksLikeRoomName);
    const roomName = lines[0];
    if (!roomName) continue;

    const roomsLeft = extractRoomsLeft(text);
    const perNight = stayTotal / nights;
    if (!byName[roomName] || perNight < byName[roomName].rate) {
      byName[roomName] = { roomName, rate: perNight, roomsLeft };
    } else if (roomsLeft != null && byName[roomName].roomsLeft == null) {
      // Keep cheapest rate but still record a roomsLeft signal if we see it later
      byName[roomName].roomsLeft = roomsLeft;
    }
  }

  return { rooms: Object.values(byName), source: 'hprt-table' };
}

async function scrapeOne(browser, property, checkIn, checkOut, stayType, workerId) {
  const nights = (new Date(checkOut) - new Date(checkIn)) / 86400000;
  const url = buildUrl(property.slug, checkIn, checkOut);
  const tag = `[W${workerId}]`;
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-AU',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const base = {
    scrape_run_id: SCRAPE_RUN_ID,
    property: property.name,
    property_slug: property.slug,
    check_in: checkIn,
    check_out: checkOut,
    currency: 'AUD',
    source: 'booking.com',
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(
      '#hprt-table, [data-testid="property-most-relevant-units"], [data-component="availability"], [id*="hprt"]',
      { timeout: 8000 }
    ).catch(() => {});
    await page.waitForTimeout(1500);

    for (const sel of [
      '[aria-label="Dismiss sign-in info."]',
      '[aria-label="Dismiss sign in information."]',
      'button[aria-label*="Dismiss"]',
    ]) {
      try { await page.click(sel, { timeout: 500 }); break; } catch {}
    }

    const bodyText = await page.locator('body').innerText();
    const isNotFound      = /page not found/i.test(bodyText);
    const isSoldOut       = /sold out|no rooms available/i.test(bodyText);
    const showsAlternates = /similar properties available for your dates|alternative dates/i.test(bodyText);
    const notAvailable    = /not available on our site for your dates/i.test(bodyText);
    const notBookable     = /(?:isn.t|is not|not currently|not)\s+(?:taking|accepting)\s+(?:reservations|bookings)|currently\s+(?:not bookable|unavailable)|temporarily\s+(?:closed|unavailable)/i.test(bodyText);
    const minStayMatch    = bodyText.match(/you need to stay (\d+)\+? nights?/i);
    const minNights       = minStayMatch ? parseInt(minStayMatch[1], 10) : null;

    if (isNotFound) {
      console.log(`${tag} ✗ 404           ${property.name} ${checkIn} (${nights}n)`);
      return [];
    }
    if (notBookable) {
      console.log(`${tag} ⊘ NOT BOOKABLE  ${property.name}  ${checkIn} (${nights}n)`);
      return [{ ...base, room_name: '(property not bookable)', rate: null, available: false, min_nights: null, notes: `stay_type=${stayType}; nights=${nights}; not taking bookings on booking.com` }];
    }
    if (isSoldOut || (showsAlternates && notAvailable)) {
      console.log(`${tag} • SOLD OUT      ${property.name}  ${checkIn} (${nights}n)`);
      return [{ ...base, room_name: '(sold out)', rate: null, available: false, min_nights: minNights, notes: `stay_type=${stayType}; nights=${nights}; no availability` }];
    }

    const { rooms, source } = await getRoomRates(page, nights);

    if (minNights && minNights > nights && rooms.length === 0) {
      console.log(`${tag} ⊝ MIN ${minNights} NIGHTS  ${property.name}  ${checkIn} (${nights}n)`);
      return [{ ...base, room_name: `(min ${minNights} nights required)`, rate: null, available: false, min_nights: minNights, notes: `stay_type=${stayType}; nights=${nights}; MNS=${minNights}` }];
    }

    if (rooms.length === 0) {
      const prices = pricesFromText(bodyText).filter(n => n >= 150);
      if (prices.length === 0) {
        console.log(`${tag} ⚠ NO MATCH      ${property.name}  ${checkIn} (${nights}n)  source=${source}`);
        try { await page.screenshot({ path: `debug-${property.slug}-${checkIn}.png`, fullPage: true }); } catch {}
        return [{ ...base, room_name: '(extraction failed)', rate: null, available: false, min_nights: minNights, notes: `stay_type=${stayType}; nights=${nights}; no rooms parsed; source=${source}` }];
      }
      const lowest = Math.min(...prices) / nights;
      console.log(`${tag} ⚠ FALLBACK      ${property.name}  ${checkIn} (${nights}n)  AU$${lowest.toFixed(0)}/n`);
      return [{ ...base, room_name: '(unknown)', rate: lowest, available: true, min_nights: minNights, notes: `stay_type=${stayType}; nights=${nights}; fallback to body-text lowest; source=${source}` }];
    }

    const cheapest = Math.min(...rooms.map(r => r.rate));
    const badgesSeen = rooms.filter(r => r.roomsLeft != null).length;
    console.log(`${tag} ✓ ${property.name.padEnd(36)} ${checkIn} ${stayType.padEnd(7)} ${nights}n  ${rooms.length}rm  cheapest AU$${cheapest.toFixed(0)}/n${badgesSeen > 0 ? `  (${badgesSeen} low-stock badge${badgesSeen > 1 ? 's' : ''})` : ''}`);

    return rooms.map(r => ({
      ...base,
      room_name: r.roomName,
      rate: r.rate,
      available: true,
      min_nights: minNights,
      rooms_left: r.roomsLeft,
      notes: `stay_type=${stayType}; nights=${nights}; source=hprt-table`,
    }));
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
  console.log(`Weekend check-ins (Fri/Sat/Sun) → 2-night stays. Other check-ins → 1-night.`);
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
      jobs.push({ property: prop, checkIn: d.checkIn, checkOut: d.checkOut, stayType: d.stayType });
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
      const rows = await scrapeOne(browser, job.property, job.checkIn, job.checkOut, job.stayType, workerId);
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
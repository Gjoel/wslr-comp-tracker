import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import fs from 'fs';

// ---------- Config ----------

const PROPERTIES = [
  { name: 'WSLR (us)',                    slug: 'wollongong-surf-leisure-resort' },
  { name: 'Novotel Wollongong',           slug: 'test-novotel-northbeach' },
  { name: 'Quality Suites Pioneer Sands', slug: 'quality-suites-pioneer-sands' },
  { name: 'Sage Hotel Wollongong',        slug: 'chifley-wollongong' },
  { name: 'Corrimal Beach Tourist Park',  slug: 'corrimal-beach-tourist-park' },
];

const TEST_MODE     = !!process.env.TEST;
const WEEKEND_COUNT = TEST_MODE ? 2  : 12;
const MIDWEEK_COUNT = TEST_MODE ? 1  : 4;
const CONCURRENCY   = parseInt(process.env.CONCURRENCY || '4', 10);
const DELAY_MIN_MS  = 1500;
const DELAY_MAX_MS  = 3500;

// ---------- Supabase ----------

const SUPABASE_URL = (process.env.SUPABASE_URL || '')
  .trim()
  .replace(/^\uFEFF/, '')
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim().replace(/^\uFEFF/, '');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const SCRAPE_RUN_ID = randomUUID();

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
  const dates = [];

  let cur = new Date(today);
  while (cur.getDay() !== 5) cur.setDate(cur.getDate() + 1);
  for (let i = 0; i < WEEKEND_COUNT; i++) {
    const inDate  = new Date(cur);
    const outDate = new Date(cur); outDate.setDate(outDate.getDate() + 2);
    dates.push({ checkIn: fmt(inDate), checkOut: fmt(outDate), stayType: 'weekend' });
    cur.setDate(cur.getDate() + 7);
  }

  let mid = new Date(today);
  while (mid.getDay() !== 2) mid.setDate(mid.getDate() + 1);
  mid.setDate(mid.getDate() + 7);
  for (let i = 0; i < MIDWEEK_COUNT; i++) {
    const inDate  = new Date(mid);
    const outDate = new Date(mid); outDate.setDate(outDate.getDate() + 2);
    dates.push({ checkIn: fmt(inDate), checkOut: fmt(outDate), stayType: 'midweek' });
    mid.setDate(mid.getDate() + 21);
  }

  return dates.sort((a, b) => a.checkIn.localeCompare(b.checkIn));
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
  const matches = text.match(/(?:AUD|AU\$|A\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/g) || [];
  return matches
    .map(m => parseFloat(m.replace(/[^\d.]/g, '')))
    .filter(n => n >= 50 && n < 10000);
}

// Extract one rate per room type. Returns array of { roomName, rate }.
async function getRoomRates(page, nights) {
  // First locate the rate table
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

  // Then iterate the room rows
  let rows = await table.$$('tr.hprt-table-row, tr[data-block-id], tr.js-rt-block-row');
  if (rows.length === 0) rows = await table.$$('tr'); // fallback

  const byName = {}; // dedupe by room name, keep cheapest
  for (const row of rows) {
    const text = (await row.innerText().catch(() => '')).trim();
    if (!text || text.length < 15) continue;
    if (/^(room type|sleeps|today['']?s price|select|your choices)/i.test(text)) continue;

    const prices = pricesFromText(text);
    if (prices.length === 0) continue;
    const stayTotal = Math.min(...prices);

    // Find room name: first line that isn't a price, occupancy, or duration string
    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l =>
        l && l.length > 3 && l.length < 120 &&
        !/^(?:AUD|AU\$|A\$|\$)/i.test(l) &&
        !/^\d+\s*(?:guests?|adults?|children?|beds?|nights?)/i.test(l) &&
        !/^(only \d+ left|free cancellation|breakfast included|no prepayment)/i.test(l)
      );
    const roomName = lines[0];
    if (!roomName) continue;

    // Store per-night rate (the rate shown is the total for the LOS)
    const perNight = stayTotal / nights;
    if (!byName[roomName] || perNight < byName[roomName].rate) {
      byName[roomName] = { roomName, rate: perNight };
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
    const notBookable     = /(?:isn['']?t|is not|not currently|not) (?:taking|accepting) (?:reservations|bookings)|currently (?:not bookable|unavailable)|temporarily (?:closed|unavailable)/i.test(bodyText);
    const minStayMatch    = bodyText.match(/you need to stay (\d+)\+? nights?/i);
    const minNights       = minStayMatch ? parseInt(minStayMatch[1], 10) : null;

    if (isNotFound) {
      console.log(`${tag} ✗ 404           ${property.name} ${checkIn}`);
      return [];
    }
    if (notBookable) {
      console.log(`${tag} ⊘ NOT BOOKABLE  ${property.name}  ${checkIn} (${stayType})`);
      return [{ ...base, room_name: '(property not bookable)', rate: null, available: false, min_nights: null, notes: 'not taking bookings on booking.com' }];
    }
    if (isSoldOut || (showsAlternates && notAvailable)) {
      console.log(`${tag} • UNAVAILABLE   ${property.name}  ${checkIn} (${stayType})`);
      return [{ ...base, room_name: '(sold out)', rate: null, available: false, min_nights: minNights, notes: 'no availability for these dates' }];
    }

    const { rooms, source } = await getRoomRates(page, nights);

    // Fallback if we couldn't parse rooms — record one row with whatever we can find
    if (rooms.length === 0) {
      const prices = pricesFromText(bodyText).filter(n => n >= 150);
      if (prices.length === 0) {
        console.log(`${tag} ⚠ NO MATCH      ${property.name}  ${checkIn} (${stayType})  source=${source}`);
        try { await page.screenshot({ path: `debug-${property.slug}-${checkIn}.png`, fullPage: true }); } catch {}
        return [{ ...base, room_name: '(extraction failed)', rate: null, available: false, min_nights: minNights, notes: `no rooms parsed; source=${source}` }];
      }
      const lowest = Math.min(...prices) / nights;
      console.log(`${tag} ⚠ FALLBACK      ${property.name}  ${checkIn} (${stayType})  AU$${lowest.toFixed(0)}/n`);
      return [{ ...base, room_name: '(unknown)', rate: lowest, available: true, min_nights: minNights, notes: `fallback to body-text lowest; source=${source}` }];
    }

    const cheapest = Math.min(...rooms.map(r => r.rate));
    console.log(`${tag} ✓ ${property.name.padEnd(36)} ${checkIn} (${stayType})  ${rooms.length} rooms, cheapest AU$${cheapest.toFixed(0)}/n`);

    return rooms.map(r => ({
      ...base,
      room_name: r.roomName,
      rate: r.rate,
      available: true,
      min_nights: minNights,
      notes: `stay_type=${stayType}; source=hprt-table`,
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

  console.log(`Mode: ${TEST_MODE ? 'TEST' : 'FULL'}   Concurrency: ${CONCURRENCY}`);
  console.log(`Scrape run id: ${SCRAPE_RUN_ID}`);
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  console.log('Pinging Supabase...');
  const { error: pingError } = await supabase.from('competitor_room_rates').select('id').limit(1);
  if (pingError) {
    console.error('Supabase ping failed:', pingError);
    console.error('\nMake sure the competitor_room_rates table was created in Supabase.');
    process.exit(1);
  }
  console.log('Supabase OK.\n');

  const dates = generateDateList();
  const jobs = [];
  for (const d of dates) {
    for (const prop of PROPERTIES) {
      jobs.push({ property: prop, checkIn: d.checkIn, checkOut: d.checkOut, stayType: d.stayType });
    }
  }

  console.log(`Scraping ${jobs.length} jobs with ${CONCURRENCY} parallel workers\n`);
  const browser = await chromium.launch({ headless: true });

  const queues = Array.from({ length: CONCURRENCY }, () => []);
  jobs.forEach((job, i) => queues[i % CONCURRENCY].push(job));

  const workerResults = await Promise.all(queues.map(async (queue, workerId) => {
    await sleep(workerId * 1500);
    const out = [];
    for (const job of queue) {
      const rows = await scrapeOne(browser, job.property, job.checkIn, job.checkOut, job.stayType, workerId);
      out.push(...rows);
      await sleep(rand(DELAY_MIN_MS, DELAY_MAX_MS));
    }
    return out;
  }));

  const records = workerResults.flat();
  await browser.close();

  const dumpPath = `dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(dumpPath, JSON.stringify(records, null, 2));
  console.log(`\nLocal dump written: ${dumpPath}`);

  console.log(`Inserting ${records.length} records into Supabase...`);
  if (records.length) {
    const { error } = await supabase.from('competitor_room_rates').insert(records);
    if (error) {
      console.error('Supabase insert error:', error);
      console.error(`Records are safe in ${dumpPath} — re-import after fixing.`);
      process.exit(1);
    }
  }
  console.log('Done.');
})();
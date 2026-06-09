// ============================================================================
//  debug-rates.js  —  one-shot diagnostic for the "prices don't match Booking"
//                     / "prices vary between runs" problem.
//
//  For a single Booking.com URL it loads the page in a HARDENED COOKIELESS
//  context (fresh cookie jar, AU locale + Sydney timezone, consent + sign-in
//  dismissed — i.e. exactly what a logged-out AU visitor sees) and prints, for
//  every rate-plan row in the room table:
//      - the room name (and whether this row carries one, since Booking
//        rowspans the room-name cell across a room's rate plans)
//      - every price on the row, where it came from (text vs the
//        data-hotel-rounded-price attribute vs the price-display element)
//      - the cancellation policy (free cancellation / non-refundable / etc.)
//      - the "Price for N nights" label, if present
//      - whether a Genius / member price is on the row
//      - what the PRODUCTION scraper (getRoomRates, copied verbatim below)
//        would extract for that row, and whether it KEEPS or SKIPS it
//
//  Then it summarises, per room: the production pick vs the cheapest price
//  actually visible — the mismatch is the smoking gun.
//
//  It also re-fetches the SAME check-in for 1 night, so you can see which
//  rooms are hidden by a 2-night minimum (they appear at 2 nights but not 1).
//
//  USAGE (any one of these):
//    node debug-rates.js "https://www.booking.com/hotel/au/SLUG.en-gb.html?checkin=2026-06-19&checkout=2026-06-21&group_adults=2&group_children=0&no_rooms=1&selected_currency=AUD"
//    DEBUG_URL="https://www.booking.com/hotel/au/SLUG..." node debug-rates.js
//    node debug-rates.js SLUG 2026-06-19 2026-06-21
//
//  Set DEBUG_ONE_NIGHT=0 to skip the extra 1-night comparison pass.
//
//  TIP: the easiest URL is a "Verify on Booking.com ↗" link from the dashboard
//  — it already has the right slug + dates + AUD currency.
// ============================================================================

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

// ---------- Config mirrored from scrape.js ----------
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DO_ONE_NIGHT = process.env.DEBUG_ONE_NIGHT !== '0';

// ---------- Production extractors, copied VERBATIM from scrape.js ----------
// (so the diagnosis is faithful to what really gets stored)

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

// Copied verbatim from scrape.js (Option B): detect an EXCLUDED percentage tax
// so we can show the GST-inclusive price a local AU guest would actually see.
function detectExcludedTaxRate(text) {
  const patterns = [
    /exclud\w*[^%\d]{0,24}(\d{1,2}(?:\.\d+)?)\s*%\s*(?:vat|gst|sales\s*tax|tax)/i,
    /(\d{1,2}(?:\.\d+)?)\s*%\s*(?:vat|gst|sales\s*tax|tax)[^%]{0,24}(?:not\s+included|exclud\w*)/i,
    /\+\s*(\d{1,2}(?:\.\d+)?)\s*%\s*(?:vat|gst|sales\s*tax|tax)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) { const pct = parseFloat(m[1]); if (pct > 0 && pct <= 30) return pct / 100; }
  }
  return 0;
}

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

const ROOM_KEYWORD_RE = /\b(?:room|suite|apartment|cabin|studio|bungalow|bedroom|loft|villa|cottage|penthouse|chalet|townhouse|residence|dorm)\b/i;

function looksLikeRoomName(line) {
  if (!line || line.length <= 3 || line.length >= 120) return false;
  if (!ROOM_KEYWORD_RE.test(line)) return false;
  if (/(?:AUD|AU\$|A\$)\s*\d/i.test(line)) return false;
  if (/\$\s*\d{2,}/.test(line)) return false;
  if (/^(?:price|from|now|was|total|today|cheapest|select|book|original|only|excluded|sleeps|max)\b/i.test(line)) return false;
  if (/^\s*\d+\s*%/i.test(line)) return false;
  if (/^(?:AUD|AU\$|A\$|\$)/i.test(line)) return false;
  if (/^\d+\s*(?:guests?|adults?|children?|beds?|nights?)/i.test(line)) return false;
  if (/^(only \d+ left|free cancellation|breakfast included|no prepayment)/i.test(line)) return false;
  if (!/[a-z]/i.test(line)) return false;
  return true;
}

// Production room-rate extractor, copied verbatim from scrape.js.
async function getRoomRates(page, nights) {
  const tableSelectors = ['#hprt-table', 'table.hprt-table', '[data-testid="property-most-relevant-units"]'];
  let table = null;
  for (const sel of tableSelectors) { table = await page.$(sel); if (table) break; }
  if (!table) return { rooms: [], source: 'no-table' };

  let rows = await table.$$('tr.hprt-table-row, tr[data-block-id], tr.js-rt-block-row');
  if (rows.length === 0) rows = await table.$$('tr');

  const byName = {};
  for (const row of rows) {
    const text = (await row.innerText().catch(() => '')).trim();
    if (!text || text.length < 15) continue;
    if (/^(room type|sleeps|today.?s price|select|your choices)/i.test(text)) continue;
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
      byName[roomName].roomsLeft = roomsLeft;
    }
  }
  return { rooms: Object.values(byName), source: 'hprt-table' };
}

// ---------- Helpers ----------
function parseInput() {
  const arg = process.argv[2];
  let url = process.env.DEBUG_URL || (arg && arg.startsWith('http') ? arg : null);
  if (!url && arg && process.argv[3] && process.argv[4]) {
    url = buildUrl(arg, process.argv[3], process.argv[4]);
  }
  if (!url) {
    console.error('No URL provided. Pass a full Booking.com URL, or DEBUG_URL=..., or "SLUG CHECKIN CHECKOUT".');
    process.exit(1);
  }
  const u = new URL(url);
  const slug = (u.pathname.match(/\/hotel\/au\/([^.]+)/) || [])[1] || 'unknown';
  const checkIn = u.searchParams.get('checkin');
  const checkOut = u.searchParams.get('checkout');
  const nights = checkIn && checkOut ? Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000) : null;
  return { url, slug, checkIn, checkOut, nights };
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function openCookielessPage(browser) {
  // HARDENED COOKIELESS CONTEXT: fresh, isolated cookie jar (Playwright default),
  // pinned to AU locale + Sydney timezone so Booking serves a consistent AU view,
  // and cookies cleared explicitly for good measure.
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    viewport: { width: 1280, height: 900 },
  });
  await context.clearCookies();
  return { context, page: await context.newPage() };
}

async function dismissOverlays(page) {
  for (const sel of [
    '#onetrust-accept-btn-handler',
    '[aria-label="Accept"]',
    '[aria-label="Dismiss sign-in info."]',
    '[aria-label="Dismiss sign in information."]',
    'button[aria-label*="Dismiss"]',
  ]) {
    try { await page.click(sel, { timeout: 600 }); } catch {}
  }
}

// Pull the structured rate-plan detail straight from the DOM of one row.
async function rowDetail(row) {
  return row.evaluate((el) => {
    const txtAll = (sel) => Array.from(el.querySelectorAll(sel)).map(n => (n.textContent || '').trim()).filter(Boolean);
    const attrAll = (sel, a) => Array.from(el.querySelectorAll(sel)).map(n => n.getAttribute(a)).filter(Boolean);
    const body = (el.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      priceDisplayText: txtAll('.bui-price-display__value, .prco-valign-middle-helper, [data-testid="price-and-discounted-price"]'),
      roundedPriceAttr: el.hasAttribute('data-hotel-rounded-price') ? el.getAttribute('data-hotel-rounded-price') : (attrAll('[data-hotel-rounded-price]', 'data-hotel-rounded-price')[0] || null),
      blockId: el.getAttribute('data-block-id') || null,
      fltrs: el.getAttribute('data-fltrs') || null,
      forNights: (body.match(/price for \d+ nights?/i) || [])[0] || null,
      policy: [...new Set((body.match(/free cancellation|non-refundable|no prepayment needed|no prepayment|partially refundable|breakfast included|breakfast \$?[\d.]+/gi) || []).map(s => s.toLowerCase()))],
      genius: /genius/i.test(body),
      mobileRate: /mobile[- ]only|getaway deal|late escape|black friday|limited[- ]time deal/i.test(body),
    };
  });
}

// Full verbose dump for one fetched page.
async function inspect(page, label, slug, checkIn, checkOut, nights) {
  const url = buildUrl(slug, checkIn, checkOut);
  console.log(`\n${'='.repeat(78)}\n${label}: ${slug}  ${checkIn} → ${checkOut}  (${nights} night${nights === 1 ? '' : 's'})\n${url}\n${'='.repeat(78)}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForSelector('#hprt-table, table.hprt-table, [data-testid="property-most-relevant-units"], [id*="hprt"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await dismissOverlays(page);
  await page.waitForTimeout(500);

  const body = await page.locator('body').innerText().catch(() => '');
  const currencyAUD = /AUD|AU\$|A\$/.test(body);
  const minStay = (body.match(/you need to stay (\d+)\+? nights?/i) || body.match(/minimum (?:stay|length of stay)[^\d]{0,24}(\d+)/i) || body.match(/(\d+)\s*[- ]?night minimum/i));
  const soldOut = /sold out|no rooms available/i.test(body);
  const geniusOnPage = /genius/i.test(body);
  const taxRate = detectExcludedTaxRate(body);

  console.log(`Page signals → currency shows AUD: ${currencyAUD} | sold out: ${soldOut} | min-stay msg: ${minStay ? minStay[1] + ' nights' : 'none'} | "Genius" anywhere on page: ${geniusOnPage}`);
  console.log(`Tax → excluded tax detected: ${taxRate > 0 ? Math.round(taxRate * 100) + '% (Option B would add this back)' : 'none (page looks tax-inclusive — nothing added)'}`);

  // Locate the table and rate-plan rows exactly as production does.
  let table = null;
  for (const sel of ['#hprt-table', 'table.hprt-table', '[data-testid="property-most-relevant-units"]']) {
    table = await page.$(sel); if (table) break;
  }

  const rowDump = [];
  if (!table) {
    console.log('⚠ No room table found.');
  } else {
    let rows = await table.$$('tr.hprt-table-row, tr[data-block-id], tr.js-rt-block-row');
    if (rows.length === 0) rows = await table.$$('tr');
    console.log(`Found ${rows.length} rate-plan row(s):\n`);

    let lastRoomName = '(carried from row above ↑)';
    let idx = 0;
    for (const row of rows) {
      const text = (await row.innerText().catch(() => '')).trim();
      if (!text || text.length < 15) continue;
      if (/^(room type|sleeps|today.?s price|select|your choices)/i.test(text)) continue;
      idx++;

      const detail = await rowDetail(row);
      const allPrices = pricesFromText(text);
      const perNightLabelled = perNightFromText(text);
      const nameLines = text.split('\n').map(l => l.trim()).filter(looksLikeRoomName);
      const roomNameOnRow = nameLines[0] || null;
      if (roomNameOnRow) lastRoomName = roomNameOnRow;

      // What production would extract from THIS row, in isolation.
      let prodPerNight = perNightLabelled;
      if (prodPerNight == null && allPrices.length) prodPerNight = nights > 1 ? Math.min(...allPrices) / nights : Math.min(...allPrices);
      const prodKept = !!roomNameOnRow && prodPerNight != null;

      console.log(`  [row ${idx}]  room: ${roomNameOnRow || lastRoomName}`);
      console.log(`      policy: ${detail.policy.length ? detail.policy.join(', ') : '(none seen)'}${detail.genius ? '  ⚑ GENIUS' : ''}${detail.mobileRate ? '  ⚑ MOBILE/DEAL' : ''}`);
      console.log(`      "${detail.forNights || 'no per-stay label'}" | price-display: [${detail.priceDisplayText.join(' | ') || '—'}] | data-rounded-price: ${detail.roundedPriceAttr || '—'} | data-fltrs: ${detail.fltrs || '—'}`);
      console.log(`      prices matched in row text (≥50): [${allPrices.join(', ') || 'none'}]  | "per night" labelled: ${perNightLabelled != null ? 'AU$' + perNightLabelled : 'none'}`);
      console.log(`      → production from this row: ${prodPerNight != null ? 'AU$' + Math.round(prodPerNight) + '/n' : 'n/a'}  ·  ${prodKept ? 'KEPT' : 'SKIPPED (no room name on this row)'}`);
      console.log('');

      rowDump.push({ idx, roomNameOnRow, effectiveRoom: roomNameOnRow || lastRoomName, ...detail, allPrices, perNightLabelled, prodPerNight: prodPerNight != null ? Math.round(prodPerNight) : null, prodKept });
    }
  }

  // What production getRoomRates returns overall, vs cheapest price on the page.
  const prod = await getRoomRates(page, nights);
  const allPagePrices = pricesFromText(body);
  const cheapestVisible = allPagePrices.length ? Math.min(...allPagePrices) : null;

  console.log('  ── PRODUCTION RESULT (getRoomRates) ──');
  if (prod.rooms.length === 0) {
    console.log(`     no rooms (source=${prod.source})`);
  } else {
    for (const r of prod.rooms) {
      const inc = taxRate > 0 ? Math.round(r.rate * (1 + taxRate)) : Math.round(r.rate);
      const incNote = taxRate > 0 ? `  →  with +${Math.round(taxRate * 100)}% GST: AU$${inc}/n (total AU$${inc * nights})` : '';
      console.log(`     • ${r.roomName}  →  raw AU$${Math.round(r.rate)}/n (total AU$${Math.round(r.rate * nights)})${r.roomsLeft != null ? `  · ${r.roomsLeft} left` : ''}${incNote}`);
    }
  }
  console.log(`  cheapest price anywhere on page (≥50): ${cheapestVisible != null ? 'AU$' + cheapestVisible : 'none'}  ·  ÷${nights} = ${cheapestVisible != null ? 'AU$' + Math.round(cheapestVisible / nights) + '/n' : '—'}`);

  // Save artifacts.
  const stem = `debug-rates-${slug}-${checkIn}-${nights}n`;
  try { await page.screenshot({ path: `${stem}.png`, fullPage: true }); console.log(`  saved ${stem}.png`); } catch {}
  if (table) {
    try { const html = await table.evaluate(el => el.outerHTML); writeFileSync(`${stem}.html`, html); console.log(`  saved ${stem}.html`); } catch {}
  }

  return { label, slug, checkIn, checkOut, nights, url, currencyAUD, soldOut, minStay: minStay ? parseInt(minStay[1], 10) : null, geniusOnPage, production: prod.rooms, cheapestVisible, rows: rowDump };
}

// ---------- Main ----------
(async () => {
  const { slug, checkIn, checkOut, nights } = parseInput();
  if (!checkIn || !checkOut) {
    console.error('URL is missing checkin/checkout query params.');
    process.exit(1);
  }

  console.log(`\nDebug rates — cookieless AU context (fresh cookie jar, en-AU, Australia/Sydney).`);
  const browser = await chromium.launch({ headless: true });
  const dump = { generated_at: new Date().toISOString(), slug, checkIn, passes: [] };

  try {
    // Pass 1: the requested stay length.
    {
      const { context, page } = await openCookielessPage(browser);
      try { dump.passes.push(await inspect(page, `PASS 1 (as requested)`, slug, checkIn, checkOut, nights)); }
      finally { await context.close(); }
    }

    // Pass 2: same check-in, 1 night — reveals rooms hidden behind a 2-night minimum.
    if (DO_ONE_NIGHT && nights !== 1) {
      const oneNightOut = addDays(checkIn, 1);
      const { context, page } = await openCookielessPage(browser);
      try { dump.passes.push(await inspect(page, `PASS 2 (same check-in, 1 night)`, slug, checkIn, oneNightOut, 1)); }
      finally { await context.close(); }
    }

    // Cross-pass summary: which rooms appear at each length, and at what stored rate.
    if (dump.passes.length > 1) {
      console.log(`\n${'='.repeat(78)}\nSUMMARY — rooms by stay length (per-night stored rate)\n${'='.repeat(78)}`);
      const names = new Set();
      dump.passes.forEach(p => p.production.forEach(r => names.add(r.roomName)));
      for (const name of names) {
        const cells = dump.passes.map(p => {
          const hit = p.production.find(r => r.roomName === name);
          return `${p.nights}n: ${hit ? 'AU$' + Math.round(hit.rate) + '/n' : '—'}`;
        });
        console.log(`  ${name.padEnd(52)} ${cells.join('   ')}`);
      }
      console.log(`\n  (a room showing "—" at 1n but a price at ${nights}n is hidden behind a minimum stay)`);
    }

    writeFileSync('dump-debug-rates.json', JSON.stringify(dump, null, 2));
    console.log(`\nSaved dump-debug-rates.json`);
  } catch (err) {
    console.error('Debug run failed:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

// ============================================================================
//  debug-scrape.js  —  one-shot diagnostic for the "inflated price" bug
//
//  It loads ONE Booking.com URL and, for every room row, prints:
//    - the full row text the scraper sees
//    - every price the regex matched
//    - whether each price was KEPT or DROPPED, and the exact reason
//    - what the production scraper WOULD have stored, vs the cheapest
//      price actually visible on the page (the smoking gun)
//
//  The price-filtering logic below is copied verbatim from scrape.js so the
//  diagnosis is faithful. The ONLY change is that nothing is silently dropped —
//  every decision is logged.
//
//  USAGE (any one of these):
//    node debug-scrape.js "https://www.booking.com/hotel/au/SLUG.en-gb.html?checkin=2026-06-18&checkout=2026-06-19&group_adults=2&group_children=0&no_rooms=1&selected_currency=AUD"
//    DEBUG_URL="https://www.booking.com/hotel/au/SLUG..." node debug-scrape.js
//    node debug-scrape.js SLUG 2026-06-18 2026-06-19
//
//  TIP: the easiest URL to use is a "Verify on Booking.com ↗" link copied
//  straight from the new "Data to double-check" section of the dashboard —
//  it already has the right slug + dates.
// ============================================================================

import { chromium } from 'playwright';

// ---- Config mirrored from scrape.js ----
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// Instrumented version of pricesFromText: returns a decision for EVERY match.
function analyzePrices(text) {
  const re = /(?:AUD|AU\$|A\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const value = parseFloat(m[1].replace(/,/g, ''));
    const afterStart = m.index + raw.length;
    const windowStart = Math.max(0, m.index - 80);
    const windowEnd = Math.min(text.length, afterStart + 80);
    const windowText = text.substring(windowStart, windowEnd).toLowerCase();
    const tightAfter = text.substring(afterStart, Math.min(text.length, afterStart + 25)).toLowerCase();

    let kept = true;
    let reason = 'KEPT (counts toward stored price)';

    if (!(value >= 50 && value < 10000)) {
      kept = false; reason = 'dropped: out of range (must be 50–9999)';
    } else if (/\b(?:genius|loyalty|member[\s-]?only|app[\s-]?only|mobile[\s-]?only|signed\s*in|sign\s*in|book\s+direct|earn\s+\d|reward(?:\s+nights?)?)\b/.test(windowText)) {
      kept = false; reason = 'dropped: member/genius/loyalty label nearby';
    } else if (/\b(?:was|before|originally|original\s+price|rrp|crossed[\s-]?out|reduced\s+from|save\s+(?:au\$|aud|a\$|\$))\b/.test(windowText)) {
      kept = false; reason = 'dropped: strikethrough / "was" price label nearby';
    } else if (/^\s*(?:per\s*night|\/\s*night|each\s*night|nightly|avg\.?\s*\/?\s*night|average\s+per\s+night)/.test(tightAfter)) {
      kept = false; reason = '*** dropped: PER-NIGHT suffix (this is the suspect rule) ***';
    }

    const ctx = text.substring(windowStart, windowEnd).replace(/\s+/g, ' ').trim();
    results.push({ value, raw, kept, reason, ctx });
  }
  return results;
}

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

function nightsFromUrl(u) {
  try {
    const url = new URL(u);
    const ci = url.searchParams.get('checkin');
    const co = url.searchParams.get('checkout');
    if (ci && co) {
      const n = Math.round((new Date(co) - new Date(ci)) / 86400000);
      return n >= 1 ? n : 1;
    }
  } catch {}
  return 1;
}

function resolveTarget() {
  const a2 = process.argv[2];
  const envUrl = process.env.DEBUG_URL;
  if (a2 && /^https?:\/\//i.test(a2)) return a2;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl;
  if (a2 && process.argv[3] && process.argv[4]) return buildUrl(a2, process.argv[3], process.argv[4]);
  return null;
}

const line = (ch = '=') => ch.repeat(78);

(async () => {
  const url = resolveTarget();
  if (!url) {
    console.error('No URL provided.\n');
    console.error('Usage:');
    console.error('  node debug-scrape.js "<full booking.com URL>"');
    console.error('  DEBUG_URL="<full booking.com URL>" node debug-scrape.js');
    console.error('  node debug-scrape.js <slug> <checkin YYYY-MM-DD> <checkout YYYY-MM-DD>');
    process.exit(1);
  }

  const nights = nightsFromUrl(url);
  console.log(line());
  console.log('BOOKING.COM PRICE DIAGNOSTIC');
  console.log(line());
  console.log('URL    :', url);
  console.log('Nights :', nights, '(parsed from checkin/checkout)');
  console.log('Note   : run this in GitHub Actions to match the real scrape environment.');
  console.log('         A local run from your own IP may show different prices.');
  console.log(line());
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-AU',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(
      '#hprt-table, [data-testid="property-most-relevant-units"], [data-component="availability"], [id*="hprt"]',
      { timeout: 8000 }
    ).catch(() => {});
    await page.waitForTimeout(1500);

    // Dismiss the sign-in / cookie nags exactly like production does.
    for (const sel of [
      '[aria-label="Dismiss sign-in info."]',
      '[aria-label="Dismiss sign in information."]',
      'button[aria-label*="Dismiss"]',
      '#onetrust-accept-btn-handler',
    ]) {
      try { await page.click(sel, { timeout: 500 }); break; } catch {}
    }

    // --- Page-level context ---
    const bodyText = await page.locator('body').innerText();
    const isSoldOut = /sold out|no rooms available/i.test(bodyText);
    const minStayMatch = bodyText.match(/you need to stay (\d+)\+? nights?/i);
    console.log('PAGE-LEVEL SIGNALS');
    console.log(line('-'));
    console.log('Sold out marker on page :', isSoldOut ? 'YES' : 'no');
    console.log('Min-stay message        :', minStayMatch ? `${minStayMatch[1]} nights` : 'none');
    console.log('');

    // --- Find the rates table the same way production does ---
    const tableSelectors = ['#hprt-table', 'table.hprt-table', '[data-testid="property-most-relevant-units"]'];
    let table = null;
    for (const sel of tableSelectors) {
      table = await page.$(sel);
      if (table) { console.log('Found rates table via selector:', sel); break; }
    }

    if (!table) {
      console.log('');
      console.log('!! No rates table found. The page layout may differ, or it is sold out.');
      console.log('   Dumping the first 1500 chars of body text for inspection:');
      console.log(line('-'));
      console.log(bodyText.slice(0, 1500).replace(/\n{3,}/g, '\n\n'));
    } else {
      let rows = await table.$$('tr.hprt-table-row, tr[data-block-id], tr.js-rt-block-row');
      if (rows.length === 0) rows = await table.$$('tr');
      console.log('Room rows found:', rows.length);
      console.log('');

      const summary = [];
      let rowIdx = 0;
      for (const row of rows) {
        const text = (await row.innerText().catch(() => '')).trim();
        if (!text || text.length < 15) continue;
        if (/^(room type|sleeps|today.?s price|select|your choices)/i.test(text)) continue;

        const priceDecisions = analyzePrices(text);
        if (priceDecisions.length === 0) continue;

        rowIdx++;
        const nameLines = text.split('\n').map(l => l.trim()).filter(looksLikeRoomName);
        const roomName = nameLines[0] || '(no room name parsed)';

        console.log(line());
        console.log(`ROOM ROW #${rowIdx}: ${roomName}`);
        console.log(line());
        console.log('Full row text:');
        console.log('  ' + text.replace(/\n/g, '\n  ').slice(0, 1500));
        console.log('');
        console.log('Prices found (in order of appearance):');
        for (const p of priceDecisions) {
          const mark = p.kept ? '  [KEEP]' : '  [DROP]';
          console.log(`${mark} AU$${p.value}   ${p.reason}`);
          console.log(`          context: "...${p.ctx}..."`);
        }

        const kept = priceDecisions.filter(p => p.kept).map(p => p.value);
        const allInRange = priceDecisions.filter(p => p.value >= 50 && p.value < 10000).map(p => p.value);
        const storedMin = kept.length ? Math.min(...kept) : null;
        const storedRate = storedMin != null ? storedMin / nights : null;
        const cheapestVisible = allInRange.length ? Math.min(...allInRange) : null;

        console.log('');
        console.log('  Decision:');
        console.log('    Kept prices         :', kept.length ? kept.join(', ') : '(none)');
        if (storedRate != null) {
          console.log(`    Math.min(kept)=${storedMin}  / nights=${nights}  =>  WOULD STORE: AU$${Math.round(storedRate)}/night`);
        } else {
          console.log('    WOULD STORE: nothing (all prices were dropped)');
        }
        console.log('    Cheapest price visible anywhere in row (ignoring filters):',
          cheapestVisible != null ? `AU$${cheapestVisible}` : '(none)');

        let verdict = 'looks consistent';
        if (storedMin != null && cheapestVisible != null && storedMin > cheapestVisible * 1.2) {
          verdict = `*** MISMATCH: would store AU$${storedMin} but a cheaper AU$${cheapestVisible} was visible and got filtered ***`;
        } else if (storedMin == null && cheapestVisible != null) {
          verdict = `*** ALL prices filtered, but AU$${cheapestVisible} was visible ***`;
        }
        console.log('    Verdict             :', verdict);
        console.log('');

        summary.push({ roomName, storedRate: storedRate != null ? Math.round(storedRate) : null, cheapestVisible, verdict });
      }

      console.log(line());
      console.log('SUMMARY');
      console.log(line());
      for (const s of summary) {
        console.log(`- ${s.roomName}`);
        console.log(`    would store: ${s.storedRate != null ? 'AU$' + s.storedRate : '(nothing)'}   | cheapest visible: ${s.cheapestVisible != null ? 'AU$' + s.cheapestVisible : '(none)'}`);
        if (s.verdict.includes('MISMATCH') || s.verdict.includes('ALL prices filtered')) {
          console.log(`    ${s.verdict}`);
        }
      }
      console.log('');
      console.log('HOW TO READ THIS:');
      console.log('  • If a DROPPED price (especially one marked PER-NIGHT) is LOWER than what');
      console.log('    would be stored, the parsing rule is the bug — fix is to stop discarding');
      console.log('    per-night prices and prefer the cheapest bookable rate.');
      console.log('  • If the cheapest price you see live on Booking.com never appears at all in');
      console.log('    the lists above, the scraper is being shown a different (higher) price than');
      console.log('    a real browser — that points to environment/IP pricing, not parsing.');
    }

    // --- Save artefacts for manual inspection ---
    let stem = 'debug';
    try {
      const u = new URL(url);
      const slug = (u.pathname.match(/\/hotel\/[a-z]{2}\/([a-z0-9\-]+)\./i) || [])[1] || u.hostname;
      const ci = u.searchParams.get('checkin') || 'nodate';
      stem = `debug-${slug}-${ci}`;
    } catch {}

    try {
      await page.screenshot({ path: `${stem}.png`, fullPage: true });
      console.log('');
      console.log('Saved screenshot:', `${stem}.png`);
    } catch (e) {
      console.log('Screenshot failed:', e.message);
    }
    try {
      const fs = await import('fs');
      fs.writeFileSync(`${stem}.html`, await page.content());
      console.log('Saved page HTML :', `${stem}.html`);
    } catch (e) {
      console.log('HTML dump failed:', e.message);
    }
  } catch (err) {
    console.error('');
    console.error('ERROR during diagnostic:', err.message);
  } finally {
    await context.close();
    await browser.close();
  }
})();

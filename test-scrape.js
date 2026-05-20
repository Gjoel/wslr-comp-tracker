import { chromium } from 'playwright';

const PROPERTIES = [
  { name: 'WSLR (us)',                    slug: 'wollongong-surf-leisure-resort' },
  { name: 'Novotel Wollongong',           slug: 'test-novotel-northbeach' },
  { name: 'Quality Suites Pioneer Sands', slug: 'quality-suites-pioneer-sands' },
  { name: 'Sage Hotel Wollongong',        slug: 'chifley-wollongong' },
  { name: 'Corrimal Beach Tourist Park',  slug: 'corrimal-beach-tourist-park' },
];

const CHECK_IN  = '2026-06-12'; // Friday
const CHECK_OUT = '2026-06-14'; // Sunday
const NIGHTS    = 2;

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

function extractPrices(text) {
  const matches = text.match(/(?:AUD|AU\$|A\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/g) || [];
  return matches
    .map(m => parseFloat(m.replace(/[^\d.]/g, '')))
    .filter(n => n >= 50 && n < 10000);
}

// Try to locate the room/rate table; fall back to whole page with stricter floor
async function getRateContext(page) {
  const selectors = [
    '#hprt-table',
    'table.hprt-table',
    '[data-testid="property-most-relevant-units"]',
    '#availability_block',
    '#maxotel_rooms',
    '[id*="hprt"]',
    '[data-component="availability"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      const text = await el.innerText();
      if (text && text.length > 100) {
        return { text, source: `selector:${sel}`, strict: false };
      }
    }
  }
  // Fallback: whole body, but apply a much higher floor to skip noise
  const text = await page.locator('body').innerText();
  return { text, source: 'body-fallback', strict: true };
}

async function scrapeProperty(browser, property) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-AU',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const url = buildUrl(property.slug, CHECK_IN, CHECK_OUT);

  try {
    console.log(`\n→ ${property.name}`);
    console.log(`  ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    for (const sel of [
      '[aria-label="Dismiss sign-in info."]',
      '[aria-label="Dismiss sign in information."]',
      'button[aria-label*="Dismiss"]',
    ]) {
      try { await page.click(sel, { timeout: 800 }); break; } catch {}
    }

    const bodyText = await page.locator('body').innerText();
    const isNotFound      = /page not found/i.test(bodyText);
    const isSoldOut       = /sold out|no rooms available/i.test(bodyText);
    const showsAlternates = /similar properties available for your dates|alternative dates/i.test(bodyText);
    const notAvailable    = /not available on our site for your dates/i.test(bodyText);

    if (isNotFound)  { console.log(`  ✗ Page not found — slug is wrong`); return; }
    if (isSoldOut)   { console.log(`  • SOLD OUT`); return; }

    const { text, source, strict } = await getRateContext(page);
    let prices = extractPrices(text);

    // On the whole-body fallback, raise floor to filter out menu/parking/breakfast noise
    if (strict) prices = prices.filter(n => n >= 150);

    if (showsAlternates && notAvailable && prices.length === 0) {
      console.log(`  • NOT AVAILABLE for these dates (showing alternatives)`);
      return;
    }

    if (prices.length === 0) {
      console.log(`  ⚠ No prices matched (source: ${source}) — selectors may need updating`);
      const file = `debug-${property.slug}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(`    Screenshot saved: ${file}`);
    } else {
      const min = Math.min(...prices);
      const perNight = (min / NIGHTS).toFixed(2);
      console.log(`  ✓ Lowest rate AU$${min.toFixed(2)} for ${NIGHTS}n  →  ~AU$${perNight}/night  (${prices.length} price tokens, source: ${source})`);
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  } finally {
    await context.close();
  }
}

(async () => {
  console.log(`Scraping for ${CHECK_IN} → ${CHECK_OUT} (${NIGHTS} nights)\n`);
  const browser = await chromium.launch({ headless: false });
  for (const property of PROPERTIES) {
    await scrapeProperty(browser, property);
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  }
  await browser.close();
  console.log('\nDone.');
})();
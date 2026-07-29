// test-digest-mock.js — offline end-to-end test of digest.js
// Replays the REAL run history (from the live DB) through a mocked PostgREST
// endpoint, with synthetic rate rows crafted to exercise every email section.
// Run: BASELINE_DAYS_BACK=7 node test-digest-mock.js

import fs from 'node:fs';

process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-key';
process.env.BASELINE_DAYS_BACK ||= '7';
delete process.env.DIGEST_WEBHOOK_URL; // force preview mode

// Real run history captured from the live DB on 2026-07-29 (newest first),
// including the two small on-demand runs from Jul 20 that must be skipped.
const RUNS = [
  { scrape_run_id: '1209926a-7a28-4407-9cbe-833de8fdaff4', run_start: '2026-07-29T15:51:08.123841+00:00', run_end: '2026-07-29T17:58:39.907691+00:00', n_rows: 10717 },
  { scrape_run_id: 'c670b459-ef23-4dbe-ae99-964730a27fae', run_start: '2026-07-28T16:04:09.516484+00:00', run_end: '2026-07-28T18:24:44.958007+00:00', n_rows: 10635 },
  { scrape_run_id: '51bd2c03-1abb-4619-9a7e-fd12bcf8ac6b', run_start: '2026-07-27T16:14:57.022696+00:00', run_end: '2026-07-27T18:28:15.576514+00:00', n_rows: 10727 },
  { scrape_run_id: 'b52915b1-8484-499a-bd1f-107b2f92413a', run_start: '2026-07-26T15:01:39.635280+00:00', run_end: '2026-07-26T17:19:34.368513+00:00', n_rows: 10726 },
  { scrape_run_id: 'b8eb5f7d-3e5b-4515-a330-d0dbb707388a', run_start: '2026-07-25T15:00:13.842969+00:00', run_end: '2026-07-25T17:21:43.270575+00:00', n_rows: 10746 },
  { scrape_run_id: '702c6a2d-c5e9-4406-87e0-6d19a4cca68b', run_start: '2026-07-24T15:25:18.163367+00:00', run_end: '2026-07-24T17:44:05.337792+00:00', n_rows: 10745 },
  { scrape_run_id: 'f6e3cd6d-7719-4690-a25a-ab6c830d1df3', run_start: '2026-07-23T15:52:53.275860+00:00', run_end: '2026-07-23T18:01:15.951843+00:00', n_rows: 10771 },
  { scrape_run_id: '863551f0-a537-44d7-8cac-80291d7ba123', run_start: '2026-07-22T15:30:02.859506+00:00', run_end: '2026-07-22T17:46:50.310976+00:00', n_rows: 10735 },
  { scrape_run_id: 'ef381972-fa1c-4f82-a5e5-fa1389b73291', run_start: '2026-07-21T15:32:25.412265+00:00', run_end: '2026-07-21T17:53:35.396519+00:00', n_rows: 10762 },
  { scrape_run_id: 'fb340911-3154-402b-9d9e-1d004fc01c7a', run_start: '2026-07-20T15:49:16.910371+00:00', run_end: '2026-07-20T18:07:56.962863+00:00', n_rows: 10748 },
  { scrape_run_id: '5c4fc00c-f810-4860-a409-4cfb7f9ca465', run_start: '2026-07-20T02:21:10.643249+00:00', run_end: '2026-07-20T02:29:33.247729+00:00', n_rows: 907 },
  { scrape_run_id: '692c919c-53b1-4e22-823d-6043b6c54b8c', run_start: '2026-07-20T02:20:22.729423+00:00', run_end: '2026-07-20T02:27:34.970683+00:00', n_rows: 910 },
];

const CURR = '1209926a-7a28-4407-9cbe-833de8fdaff4'; // Jul 29 run
const BASE = '863551f0-a537-44d7-8cac-80291d7ba123'; // Jul 22 run — expected baseline

// Synthetic rate rows (check_in dates inside the next-60-days window)
const row = (property, check_in, room_name, rate, available, rooms_left) =>
  ({ property, check_in, room_name, rate, available, rooms_left });

const ROWS = {
  [BASE]: [ // last week
    row('Hotel Alpha', '2026-08-10', 'Standard Queen', 200, true, 5),
    row('Hotel Alpha', '2026-08-11', 'Standard Queen', 210, true, null),
    row('Hotel Bravo', '2026-08-15', 'Ocean Suite',    380, true, 2),
    row('Hotel Charlie', '2026-08-20', 'Bunk Room',    null, false, null), // sold out last week
    row('Hotel Charlie', '2026-08-21', 'Bunk Room',    140, true, 4),
  ],
  [CURR]: [ // this week
    row('Hotel Alpha', '2026-08-10', 'Standard Queen', 170, true, 2),      // -15% / -$30 price move, 3 rooms sold
    row('Hotel Alpha', '2026-08-11', 'Standard Queen', 212, true, null),   // +1% — below threshold
    row('Hotel Bravo', '2026-08-15', 'Ocean Suite',    null, false, null), // flipped to sold out
    row('Hotel Charlie', '2026-08-20', 'Bunk Room',    150, true, 3),      // back on sale
    row('Hotel Charlie', '2026-08-21', 'Bunk Room',    140, true, 4),      // unchanged
  ],
};

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname.endsWith('/rpc/get_scrape_runs')) return json(RUNS);
  if (url.pathname.endsWith('/competitor_room_rates')) {
    const runId = (url.searchParams.get('scrape_run_id') || '').replace(/^eq\./, '');
    return json(ROWS[runId] || []);
  }
  throw new Error('Unexpected URL in mock: ' + url.href);
};

await import('./digest.js');

// Give main() a beat to finish, then assert on the preview it wrote.
// (Run timestamps render in Sydney time: Jul 22 17:46 UTC → Thu 23 Jul,
//  Jul 29 17:58 UTC → Thu 30 Jul.)
setTimeout(() => {
  const html = fs.readFileSync('digest-preview.html', 'utf8');
  const must = ['Weekly digest', 'Hotel Alpha', 'Standard Queen', 'Sold out', 'Back on sale', 'AU$170', '23 Jul', '30 Jul'];
  const missing = must.filter(s => !html.includes(s));
  if (missing.length) { console.error('FAIL — preview missing:', missing); process.exit(1); }
  console.log('PASS — preview contains all expected sections and values');
}, 2000);

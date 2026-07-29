// digest.js (v2.2)
// Compares two scrape runs and emails a digest of big price and volume
// movement via the Apps Script webhook.
//
// By default it compares the two most recent runs (a daily-style digest).
// With BASELINE_DAYS_BACK=7 it runs in weekly mode: the latest full run is
// compared against the full run closest to 7 days earlier, so the email
// shows the week's net movement. Small on-demand runs are ignored when
// picking the pair in weekly mode.
//
// Signals:
//   1. Price moves   headline (cheapest) nightly rate per property per date,
//                    flagged when it moves by MIN_PCT_MOVE % AND MIN_ABS_MOVE dollars
//   2. Availability  dates that flipped sold out or came back on sale
//   3. Volume        net movement in "only X rooms left" counts (rooms sold vs
//                    released, matched room for room) plus available-date counts
//
// All comparisons cover only dates present in BOTH runs, so a short on-demand
// scrape compared against a full nightly run stays honest.
//
// Env vars (all optional except the first two):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   DIGEST_WEBHOOK_URL   Apps Script web app URL. If unset, writes digest-preview.html locally
//   BASELINE_DAYS_BACK=0 0 = compare the two most recent runs (default).
//                        7 = weekly mode: compare against the run closest to
//                        7 days before the latest. Uses the get_scrape_runs()
//                        SQL function in Supabase.
//   HORIZON_DAYS=60      how far ahead to compare
//   MIN_PCT_MOVE=5       percent move needed to flag a price change
//   MIN_ABS_MOVE=10      dollar move needed to flag a price change (both must pass)
//   BIG_VOLUME=5         room-nights sold (or availability swing) that counts as big
//   MAX_ITEMS=25         cap per list in the email
//   SEND_WHEN_QUIET=true send the email even when nothing big moved
//   DASHBOARD_URL        link in the email footer

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import fs from 'fs';

const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/^\uFEFF/, '').replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
const supabase = createClient(supabaseUrl, (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim().replace(/^\uFEFF/, ''));

const DIGEST_URL         = process.env.DIGEST_WEBHOOK_URL;
const BASELINE_DAYS_BACK = parseInt(process.env.BASELINE_DAYS_BACK || '0', 10);
const HORIZON_DAYS    = parseInt(process.env.HORIZON_DAYS || '60', 10);
const MIN_PCT_MOVE    = parseFloat(process.env.MIN_PCT_MOVE || '5');
const MIN_ABS_MOVE    = parseFloat(process.env.MIN_ABS_MOVE || '10');
const BIG_VOLUME      = parseInt(process.env.BIG_VOLUME || '5', 10);
const MAX_ITEMS       = parseInt(process.env.MAX_ITEMS || '25', 10);
const SEND_WHEN_QUIET = (process.env.SEND_WHEN_QUIET || 'true') !== 'false';
const DASHBOARD_URL   = process.env.DASHBOARD_URL || 'https://gjoel.github.io/wslr-comp-tracker/';
const PAGE            = 1000; // Supabase caps responses at 1000 rows, so paginate everything

// ---------- Dates ----------

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

const today = new Date(); today.setHours(0, 0, 0, 0);
const WINDOW_START = fmt(addDays(today, 1));
const WINDOW_END   = fmt(addDays(today, HORIZON_DAYS));

const fmtDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtRun  = iso => new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const sydneyToday = () => new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short' });

// ---------- Formatting helpers ----------

const money  = n => 'AU$' + Math.round(n);
const signed = (n, dp = 1) => (n > 0 ? '+' : '') + n.toFixed(dp);
const esc    = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function pctSpan(pct) {
  if (pct == null || !isFinite(pct)) return '<span style="color:#888">n/a</span>';
  const colour = pct > 0 ? '#0a7f2e' : pct < 0 ? '#c0392b' : '#888';
  const arrow  = pct > 0 ? '&#9650; ' : pct < 0 ? '&#9660; ' : '';
  return `<span style="color:${colour};font-weight:bold">${arrow}${signed(pct)}%</span>`;
}
function deltaSpan(n) {
  if (!n) return '<span style="color:#888">0</span>';
  const colour = n > 0 ? '#0a7f2e' : '#c0392b';
  return `<span style="color:${colour};font-weight:bold">${signed(n, 0)}</span>`;
}

// ---------- Supabase fetch (paginated) ----------

// One row per scrape run, newest first: { id, scraped_at, rows }.
// Uses the get_scrape_runs() SQL function so we never page through rate rows.
async function getRuns() {
  const { data, error } = await supabase.rpc('get_scrape_runs', { limit_runs: 30 });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.scrape_run_id,
    scraped_at: r.run_end,
    rows: Number(r.n_rows),
  }));
}

// Decide which two runs to compare, returned as [current, baseline].
//   Default (BASELINE_DAYS_BACK=0): the two most recent runs, whatever they are.
//   Weekly  (BASELINE_DAYS_BACK=7): latest full run vs the full run closest to
//     7 days before it. "Full" means at least half the size of the biggest
//     recent run, so small on-demand scrapes never anchor the comparison.
function pickRuns(all) {
  if (all.length < 2) return null;
  if (!BASELINE_DAYS_BACK) return [all[0], all[1]];

  const biggest = Math.max(...all.map(r => r.rows));
  const full = all.filter(r => r.rows >= biggest * 0.5);
  if (full.length < 2) return [all[0], all[1]];

  const latest = full[0];
  const target = new Date(latest.scraped_at).getTime() - BASELINE_DAYS_BACK * 86400e3;
  let baseline = null, bestGap = Infinity;
  for (const r of full) {
    if (r.id === latest.id) continue;
    const gap = Math.abs(new Date(r.scraped_at).getTime() - target);
    if (gap < bestGap) { bestGap = gap; baseline = r; }
  }
  return baseline ? [latest, baseline] : null;
}

async function getRunRows(runId) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('competitor_room_rates')
      .select('property, check_in, room_name, rate, available, rooms_left')
      .eq('scrape_run_id', runId)
      .gte('check_in', WINDOW_START)
      .lte('check_in', WINDOW_END)
      .order('check_in', { ascending: true })
      .order('property', { ascending: true })
      .order('room_name', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

// ---------- Summarise a run ----------

function summariseRun(rows) {
  const headline  = new Map(); // "prop|date" -> { rate, roomName }  cheapest priced room
  const anyAvail  = new Map(); // "prop|date" -> boolean
  const roomsLeft = new Map(); // "prop|date|room" -> rooms_left
  const props     = new Set();

  for (const r of rows) {
    props.add(r.property);
    const pd = r.property + '|' + r.check_in;

    if (r.available) anyAvail.set(pd, true);
    else if (!anyAvail.has(pd)) anyAvail.set(pd, false);

    if (r.rate != null) {
      const h = headline.get(pd);
      if (!h || r.rate < h.rate) headline.set(pd, { rate: r.rate, roomName: r.room_name });
    }

    if (r.rooms_left != null) {
      const k = pd + '|' + r.room_name;
      const existing = roomsLeft.get(k);
      if (existing == null || r.rooms_left < existing) roomsLeft.set(k, r.rooms_left);
    }
  }
  return { headline, anyAvail, roomsLeft, props };
}

// ---------- Compare two runs ----------

function compare(prev, curr) {
  const priceMoves = [];
  for (const [k, c] of curr.headline) {
    const p = prev.headline.get(k);
    if (!p) continue;
    const dAbs = c.rate - p.rate;
    const dPct = (dAbs / p.rate) * 100;
    if (Math.abs(dPct) >= MIN_PCT_MOVE && Math.abs(dAbs) >= MIN_ABS_MOVE) {
      const [property, check_in] = k.split('|');
      priceMoves.push({ property, check_in, prevRate: p.rate, currRate: c.rate, dPct, roomName: c.roomName });
    }
  }
  priceMoves.sort((a, b) => Math.abs(b.dPct) - Math.abs(a.dPct));

  const soldOut = [], backOn = [];
  for (const [k, av] of curr.anyAvail) {
    if (!prev.anyAvail.has(k)) continue;
    const was = prev.anyAvail.get(k);
    const [property, check_in] = k.split('|');
    if (was && !av)      soldOut.push({ property, check_in, rate: prev.headline.get(k)?.rate ?? null });
    else if (!was && av) backOn.push({ property, check_in, rate: curr.headline.get(k)?.rate ?? null });
  }
  soldOut.sort((a, b) => a.check_in.localeCompare(b.check_in));
  backOn.sort((a, b) => a.check_in.localeCompare(b.check_in));

  // Per property stats
  const names = [...new Set([...curr.props, ...prev.props])].sort();
  const stats = [];
  for (const name of names) {
    const pre = name + '|';

    let sumC = 0, sumP = 0, n = 0;
    for (const [k, c] of curr.headline) {
      if (!k.startsWith(pre)) continue;
      const p = prev.headline.get(k);
      if (!p) continue;
      sumC += c.rate; sumP += p.rate; n++;
    }
    const avgC = n ? sumC / n : null;
    const avgP = n ? sumP / n : null;
    const avgPct = n ? ((avgC - avgP) / avgP) * 100 : null;

    // Availability compared over matched dates only, so a partial on-demand
    // run against a full nightly run does not produce phantom swings
    let availC = 0, availP = 0, matchedDates = 0;
    for (const [k, v] of curr.anyAvail) {
      if (!k.startsWith(pre)) continue;
      if (!prev.anyAvail.has(k)) continue;
      matchedDates++;
      if (v) availC++;
      if (prev.anyAvail.get(k)) availP++;
    }

    let sold = 0, released = 0, matchedRooms = 0;
    for (const [k, cl] of curr.roomsLeft) {
      if (!k.startsWith(pre)) continue;
      const pl = prev.roomsLeft.get(k);
      if (pl == null) continue;
      matchedRooms++;
      if (cl < pl) sold += pl - cl;
      else if (cl > pl) released += cl - pl;
    }

    stats.push({ name, avgC, avgP, avgPct, nDates: n, availC, availP, matchedDates, sold, released, matchedRooms });
  }

  return { priceMoves, soldOut, backOn, stats };
}

// ---------- Render email ----------

const TH = 'style="text-align:left;padding:6px 8px;background:#eef2f7;border-bottom:2px solid #d4dbe4;font-size:12px;color:#334;white-space:nowrap"';
const TD = 'style="padding:6px 8px;border-bottom:1px solid #e8ecf1;font-size:13px;color:#222"';

function renderEmail(runs, res) {
  const { priceMoves, soldOut, backOn, stats } = res;
  const totalSold = stats.reduce((s, p) => s + p.sold, 0);

  const summaryRows = stats.map(p => `
    <tr>
      <td ${TD}><b>${esc(p.name)}</b></td>
      <td ${TD}>${p.avgC != null ? money(p.avgC) : '<span style="color:#888">n/a</span>'}</td>
      <td ${TD}>${pctSpan(p.avgPct)}</td>
      <td ${TD}>${p.availC} / ${p.matchedDates} (${deltaSpan(p.availC - p.availP)})</td>
      <td ${TD}>${p.sold ? `<b>${p.sold}</b>` : '0'}${p.released ? ` / +${p.released}` : ''}</td>
    </tr>`).join('');

  const priceRows = priceMoves.slice(0, MAX_ITEMS).map(m => `
    <tr>
      <td ${TD}>${fmtDate(m.check_in)}</td>
      <td ${TD}>${esc(m.property)}</td>
      <td ${TD}>${esc(m.roomName)}</td>
      <td ${TD}>${money(m.prevRate)} &#8594; <b>${money(m.currRate)}</b></td>
      <td ${TD}>${pctSpan(m.dPct)}</td>
    </tr>`).join('');

  const flipRows = [
    ...soldOut.slice(0, MAX_ITEMS).map(f => `
    <tr>
      <td ${TD}>${fmtDate(f.check_in)}</td>
      <td ${TD}>${esc(f.property)}</td>
      <td ${TD}><span style="color:#c0392b;font-weight:bold">Sold out</span></td>
      <td ${TD}>${f.rate != null ? 'was ' + money(f.rate) : ''}</td>
    </tr>`),
    ...backOn.slice(0, MAX_ITEMS).map(f => `
    <tr>
      <td ${TD}>${fmtDate(f.check_in)}</td>
      <td ${TD}>${esc(f.property)}</td>
      <td ${TD}><span style="color:#0a7f2e;font-weight:bold">Back on sale</span></td>
      <td ${TD}>${f.rate != null ? 'now ' + money(f.rate) : ''}</td>
    </tr>`),
  ].join('');

  const more = (list, shown) => list.length > shown ? `<p style="font-size:12px;color:#888;margin:4px 0 0">+ ${list.length - shown} more not shown</p>` : '';

  const section = (title, table) => `
    <h3 style="font-size:15px;color:#1a2b45;margin:22px 0 8px">${title}</h3>
    ${table}`;

  const priceTable = priceMoves.length ? `
    <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
      <tr><th ${TH}>Date</th><th ${TH}>Property</th><th ${TH}>Room</th><th ${TH}>Rate</th><th ${TH}>Move</th></tr>
      ${priceRows}
    </table>${more(priceMoves, MAX_ITEMS)}`
    : '<p style="font-size:13px;color:#666;margin:0">No headline rate moved by more than ' + MIN_PCT_MOVE + '% and ' + money(MIN_ABS_MOVE) + '.</p>';

  const flipTable = (soldOut.length + backOn.length) ? `
    <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
      <tr><th ${TH}>Date</th><th ${TH}>Property</th><th ${TH}>Change</th><th ${TH}>Rate</th></tr>
      ${flipRows}
    </table>${more(soldOut, MAX_ITEMS)}${more(backOn, MAX_ITEMS)}`
    : '<p style="font-size:13px;color:#666;margin:0">No dates flipped either way.</p>';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;background:#ffffff">
    <div style="background:#1a2b45;color:#fff;padding:14px 18px;border-radius:6px 6px 0 0">
      <div style="font-size:17px;font-weight:bold">WSLR Competitor Tracker</div>
      <div style="font-size:12px;color:#b9c4d6;margin-top:2px">
        ${BASELINE_DAYS_BACK ? 'Weekly digest &bull; ' : ''}Next ${HORIZON_DAYS} days &bull; ${fmtRun(runs[1].scraped_at)} &#8594; ${fmtRun(runs[0].scraped_at)}
      </div>
    </div>
    <div style="padding:16px 18px;border:1px solid #e2e7ee;border-top:0;border-radius:0 0 6px 6px">

      ${section('Property summary', `
      <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
        <tr><th ${TH}>Property</th><th ${TH}>Avg rate</th><th ${TH}>Move</th><th ${TH}>Dates available</th><th ${TH}>Rooms sold / released*</th></tr>
        ${summaryRows}
      </table>
      <p style="font-size:11px;color:#888;margin:6px 0 0">* From Booking.com "only X rooms left" counts, matched room for room between runs. Scarce inventory only, so it understates true volume. All columns compare only dates covered by both runs, so short on-demand scrapes show small totals.</p>`)}

      ${section(`Big price moves (&#8805;${MIN_PCT_MOVE}% and &#8805;${money(MIN_ABS_MOVE)})`, priceTable)}

      ${section('Sold out / back on sale', flipTable)}

      <p style="margin:22px 0 4px"><a href="${DASHBOARD_URL}" style="font-size:13px;color:#1a5fb4">Open the full dashboard &#8594;</a></p>
    </div>
  </div>`;

  const bits = [];
  if (priceMoves.length) bits.push(`${priceMoves.length} big price move${priceMoves.length === 1 ? '' : 's'}`);
  if (soldOut.length)    bits.push(`${soldOut.length} sold out`);
  if (backOn.length)     bits.push(`${backOn.length} back on sale`);
  if (totalSold)         bits.push(`~${totalSold} rooms sold`);
  const subject = (BASELINE_DAYS_BACK ? `Comp tracker week to ${sydneyToday()}: ` : `Comp tracker ${sydneyToday()}: `)
    + (bits.length ? bits.join(', ') : 'no big movement');

  const text = bits.length ? bits.join(', ') : 'No big price or volume movement in the next ' + HORIZON_DAYS + ' days.';

  return { subject, html, text, quiet: bits.length === 0 };
}

// ---------- Main ----------

async function main() {
  console.log(`Window: ${WINDOW_START} to ${WINDOW_END} (${HORIZON_DAYS} days)`);
  console.log(BASELINE_DAYS_BACK
    ? `Weekly mode: comparing the latest full run against the run closest to ${BASELINE_DAYS_BACK} days back...`
    : 'Finding the two most recent scrape runs...');
  const runs = pickRuns(await getRuns());
  if (!runs) {
    console.log('Fewer than 2 usable scrape runs found. Skipping digest.');
    return;
  }
  const gapDays = (new Date(runs[0].scraped_at) - new Date(runs[1].scraped_at)) / 86400e3;
  console.log(`Comparing ${runs[0].id.slice(0, 8)} (${runs[0].scraped_at}, ${runs[0].rows} rows) vs ` +
              `${runs[1].id.slice(0, 8)} (${runs[1].scraped_at}, ${runs[1].rows} rows) — ${gapDays.toFixed(1)} days apart`);

  const [currRows, prevRows] = await Promise.all([getRunRows(runs[0].id), getRunRows(runs[1].id)]);
  console.log(`Rows in window: current ${currRows.length}, previous ${prevRows.length}`);

  const res = compare(summariseRun(prevRows), summariseRun(currRows));
  console.log(`Price moves: ${res.priceMoves.length}, sold out: ${res.soldOut.length}, back on sale: ${res.backOn.length}`);

  const email = renderEmail(runs, res);

  if (email.quiet && !SEND_WHEN_QUIET) {
    console.log('Quiet day and SEND_WHEN_QUIET=false. Skipping email.');
    return;
  }

  if (!DIGEST_URL) {
    fs.writeFileSync('digest-preview.html', email.html);
    console.log(`No DIGEST_WEBHOOK_URL set. Preview written to digest-preview.html`);
    console.log(`Subject would be: ${email.subject}`);
    return;
  }

  console.log('Posting to Apps Script webhook...');
  const resp = await fetch(DIGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: email.subject, html: email.html, text: email.text }),
    redirect: 'follow',
  });
  const body = await resp.text();
  console.log(`Webhook responded ${resp.status}: ${body.slice(0, 200)}`);
}

main().catch(err => {
  console.error('Digest failed:', err);
  process.exit(1);
});
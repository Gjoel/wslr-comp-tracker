import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DIGEST_URL = process.env.DIGEST_WEBHOOK_URL;
const HORIZON_DAYS = 60;
const THRESHOLD_PCT = 0.05;
const MAX_ITEMS = 25;

async function getLatestRuns() {
  // Pull most recent rows ordered by scraped_at desc and find the 2 most recent scrape_run_id values.
  const { data, error } = await supabase
    .from('competitor_room_rates')
    .select('scrape_run_id, scraped_at')
    .order('scraped_at', { ascending: false })
    .limit(20000);
  if (error) throw error;
  const seen = new Set();
  const runs = [];
  for (const r of data) {
    if (!seen.has(r.scrape_run_id)) {
      seen.add(r.scrape_run_id);
      runs.push({ id: r.scrape_run_id, scraped_at: r.scraped_at });
    }
    if (runs.length >= 2) break;
  }
  return runs;
}

async function getRatesForRun(runId) {
  const { data, error } = await supabase
    .from('competitor_room_rates')
    .select('property, check_in, rate, room_name')
    .eq('scrape_run_id', runId)
    .limit(20000);
  if (error) throw error;
  // Reduce to cheapest per (property, check_in)
  const map = {};
  for (const r of data) {
    const k = r.property + '|' + r.check_in;
    if (!map[k]) { map[k] = r; continue; }
    if (r.rate != null && (map[k].rate == null || r.rate < map[k].rate)) map[k] = r;
  }
  return map;
}

function computeDeltas(prevMap, currMap) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);

  const rateChanges = [];
  const soldOutChanges = [];

  for (const k of Object.keys(currMap)) {
    const curr = currMap[k];
    const prev = prevMap[k];
    const dt = new Date(curr.check_in + 'T00:00:00');
    if (dt < today || dt > horizon) continue;
    if (!prev) continue;

    if (curr.rate == null && prev.rate != null) {
      soldOutChanges.push({ property: curr.property, check_in: curr.check_in, change: 'now_sold_out', prevRate: prev.rate });
    } else if (curr.rate != null && prev.rate == null) {
      soldOutChanges.push({ property: curr.property, check_in: curr.check_in, change: 'now_available', currRate: curr.rate });
    } else if (curr.rate != null && prev.rate != null) {
      const delta = (curr.rate - prev.rate) / prev.rate;
      if (Math.abs(delta) > THRESHOLD_PCT) {
        rateChanges.push({
          property: curr.property,
          check_in: curr.check_in,
          prevRate: prev.rate,
          currRate: curr.rate,
          deltaPct: delta * 100,
          roomName: curr.room_name,
        });
      }
    }
  }

  rateChanges.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  soldOutChanges.sort((a, b) => a.check_in.localeCompare(b.check_in));
  return { rateChanges, soldOutChanges };
}

async function main() {
  console.log('Fetching latest scrape runs...');
  const runs = await getLatestRuns();

  if (runs.length < 2) {
    console.log(`Only ${runs.length} scrape run(s) found — need 2 for comparison. Skipping digest.`);
    return;
  }
  console.log(`Comparing run ${runs[0].id.slice(0, 8)} (${runs[0].scraped_at}) vs ${runs[1].id.slice(0, 8)} (${runs[1].scraped_at})`);

  const [currMap, prevMap] = await Promise.all([
    getRatesForRun(runs[0].id),
    getRatesForRun(runs[1].id),
  ]);

  const { rateChanges, soldOutChanges } = computeDeltas(prevMap, currMap);
  console.log(`Found ${rateChanges.length} rate changes >${THRESHOLD_PCT * 100}% and ${soldOutChanges.length} sold-out flips`);

  // Skip the email when there's nothing worth reporting.
  if (rateChanges.length === 0 && soldOutChanges.length === 0) {
    console.log('No significant changes since last scrape — skipping digest email.');
    return;
  }

  const payload = {
    summary: {
      currentRunDate: runs[0].scraped_at,
      previousRunDate: runs[1].scraped_at,
      horizonDays: HORIZON_DAYS,
      rateChangeCount: rateChanges.length,
      soldOutChangeCount: soldOutChanges.length,
    },
    rateChanges: rateChanges.slice(0, MAX_ITEMS),
    soldOutChanges: soldOutChanges.slice(0, MAX_ITEMS),
  };

  if (!DIGEST_URL) {
    console.log('No DIGEST_WEBHOOK_URL configured. Skipping email send. Payload preview:');
    console.log(JSON.stringify(payload, null, 2).slice(0, 1000));
    return;
  }

  console.log('Posting digest to Apps Script webhook...');
  const res = await fetch(DIGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const text = await res.text();
  console.log(`Webhook responded ${res.status}: ${text.slice(0, 200)}`);
}

main().catch(err => {
  console.error('Digest failed:', err);
  process.exit(1);
});
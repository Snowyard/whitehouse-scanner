// Store: all Supabase reads/writes (service role — bypasses RLS).

const { createClient } = require('@supabase/supabase-js');

// Node 20 lacks native WebSocket; give the (unused) realtime module the `ws`
// package so the client can initialize. We only use the database REST API.
let ws;
try { ws = require('ws'); } catch (_) {}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
    ...(ws ? { realtime: { transport: ws } } : {})
  }
);

// "President Donald J. Trump Periodic Transaction Report 05.08.26 (1)" -> "Donald J. Trump"
// "Kenny, Stephen – Periodic Transaction Report – 01.28.26"            -> "Stephen Kenny"
function officialFromTitle(title) {
  const before = title.split(/periodic/i)[0].replace(/[–—–—-]+\s*$/, '').trim();
  if (/^president\s/i.test(before)) return before.replace(/^president\s+/i, '').trim();
  const m = before.match(/^([^,]+),\s*(.+)$/);
  if (m) return `${m[2].trim()} ${m[1].trim()}`;
  return before || 'Unknown Official';
}

// "... 05.08.26 ..." -> "2026-05-08"
function filedDateFromTitle(title) {
  const m = title.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return null;
  let [, mo, day, yr] = m;
  yr = yr.length === 2 ? `20${yr}` : yr;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ".../wp-content/uploads/2026/04/..." -> "2026-04-01"
function uploadMonthFromUrl(url) {
  const m = (url || '').match(/\/uploads\/(\d{4})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// Trust the title date — UNLESS it's missing or in the future. The WH page has
// occasional typos (e.g. "08.27.26" on a filing actually uploaded April 2026).
// In that case fall back to the PDF's upload month from the URL path.
function safeFiledDate(title, url) {
  const fromTitle = filedDateFromTitle(title);
  const today = new Date().toISOString().slice(0, 10);
  if (fromTitle && fromTitle <= today) return fromTitle;
  return uploadMonthFromUrl(url); // typo/missing -> upload month (null only if URL has no date)
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function knownFilingUrls() {
  const { data, error } = await supabase.from('filings').select('source_url');
  if (error) throw new Error(`filings select failed: ${error.message}`);
  return new Set((data || []).map((r) => r.source_url));
}

async function getOrCreateOfficial(fullName) {
  const slug = slugify(fullName);
  const { data: found } = await supabase
    .from('officials').select('id').eq('slug', slug).maybeSingle();
  if (found) return found.id;

  const initials = fullName.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const { data: created, error } = await supabase
    .from('officials')
    .insert({ full_name: fullName, slug, initials, office: 'White House' })
    .select('id').single();
  if (error) throw new Error(`official insert failed: ${error.message}`);
  return created.id;
}

async function insertFiling({ officialId, url, title, rawText }) {
  const { data, error } = await supabase
    .from('filings')
    .insert({
      official_id: officialId,
      source_url: url,
      filed_date: safeFiledDate(title, url),
      raw_text: rawText,
      processed: false
    })
    .select('id').single();
  if (error) throw new Error(`filing insert failed: ${error.message}`);
  return data.id;
}

async function insertTrades(filingId, officialId, rows) {
  const records = rows.map((r) => ({
    filing_id: filingId,
    official_id: officialId,
    security_name: String(r.security_name).slice(0, 500),
    ticker: r.ticker || null,
    asset_class: r.asset_class || 'other',
    transaction_type: r.transaction_type,
    transaction_date: r.transaction_date || null,
    notification_date: r.notification_date || null,
    amount_min: r.amount_min || null,
    amount_max: r.amount_max || null,
    amount_band: r.amount_band || null
  }));
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const { error } = await supabase.from('trades').insert(batch);
    if (error) throw new Error(`trades insert failed: ${error.message}`);
  }
}

async function deleteFiling(filingId) {
  // remove a filing row (e.g. after a failed parse) so it gets retried next run
  await supabase.from('trades').delete().eq('filing_id', filingId);
  await supabase.from('filings').delete().eq('id', filingId);
}

async function markProcessed(filingId, aiSummary) {
  const { error } = await supabase
    .from('filings')
    .update({ processed: true, ai_summary: aiSummary || null })
    .eq('id', filingId);
  if (error) throw new Error(`filing update failed: ${error.message}`);
}

module.exports = {
  supabase,
  knownFilingUrls,
  getOrCreateOfficial,
  insertFiling,
  insertTrades,
  markProcessed,
  deleteFiling,
  officialFromTitle,
  filedDateFromTitle,
  safeFiledDate
};

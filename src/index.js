// Whitehouse Trader — filing scanner
// Pipeline: discover -> diff against DB -> fetch PDF -> parse (LLM) -> store -> summarize.
// Run locally:  npm run scan      (reads .env)
// In CI:        GitHub Actions cron (secrets as env vars)

require('dotenv').config();

const { discover } = require('./discover');
const { fetchPdf } = require('./pdf');
const { parseFiling } = require('./parse');
const { summarizeFiling } = require('./summarize');
const store = require('./store');

// big filings take a while; process at most N new ones per run.
// Override for backlog draining, e.g.  MAX_PER_RUN=100 npm run scan
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 3);

async function main() {
  console.log(`[scan] ${new Date().toISOString()}`);

  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
  }

  // 1. discover all PTR links on the disclosures page
  const links = await discover();
  console.log(`[scan] discovered ${links.length} transaction-report links`);
  if (links.length === 0) {
    // the page should never have zero — treat as a failure so we notice
    throw new Error('Discovered 0 links — page layout may have changed!');
  }

  // 2. diff against what we already have
  const known = await store.knownFilingUrls();
  const fresh = links.filter((l) => !known.has(l.url));
  console.log(`[scan] ${fresh.length} new filing(s)`);

  // 3. process the new ones (oldest-listed last, so process from the end first run)
  const toProcess = fresh.slice(0, MAX_PER_RUN);
  let failures = 0;
  for (const f of toProcess) {
    console.log(`\n[filing] ${f.title}`);
    let filingId = null;
    try {
      const officialName = store.officialFromTitle(f.title);
      const officialId = await store.getOrCreateOfficial(officialName);

      const { buffer, text, pages } = await fetchPdf(f.url);
      console.log(`  fetched PDF: ${pages} pages (${text.length} chars of embedded text — scans have ~0)`);

      filingId = await store.insertFiling({ officialId, url: f.url, title: f.title, rawText: text });

      const rows = await parseFiling(buffer);
      console.log(`  extracted ${rows.length} trades`);
      if (rows.length > 0) await store.insertTrades(filingId, officialId, rows);

      let summary = null;
      try {
        summary = rows.length > 0 ? await summarizeFiling(officialName, rows) : null;
      } catch (e) {
        console.warn(`  summary failed (non-fatal): ${e.message}`);
      }

      await store.markProcessed(filingId, summary);
      console.log(`  done. summary: ${summary ? summary.slice(0, 120) + '…' : '(none)'}`);
    } catch (e) {
      failures++;
      console.warn(`  ✗ failed: ${e.message} — removing partial record so it retries next run`);
      if (filingId) { try { await store.deleteFiling(filingId); } catch (_) {} }
    }
  }
  if (failures) console.log(`\n[scan] ${failures} filing(s) failed this run — they'll be retried.`);

  if (fresh.length > MAX_PER_RUN) {
    console.log(`\n[scan] ${fresh.length - MAX_PER_RUN} remaining — next run will continue.`);
  }
  console.log('\n[scan] complete ✓');
}

main().catch((err) => {
  console.error(`[scan] FAILED: ${err.message}`);
  process.exit(1); // non-zero exit => GitHub Actions marks the run failed => you get notified
});

// Parse: extract structured trades from a 278-T PDF.
// The filings are usually IMAGE SCANS (no text layer), so we send the actual
// PDF pages to Claude, which reads them visually. Large filings are split
// into small page-chunks (Trump's can be 113 pages / 3,500+ rows).

const Anthropic = require('@anthropic-ai/sdk');
const { PDFDocument } = require('pdf-lib');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
// Tuned for Tier 2 limits (90k output tokens/min, 450k input tokens/min):
const PAGES_PER_CHUNK = 4;   // ~130 rows ≈ ~14k output tokens per chunk
const MAX_TOKENS = 16000;
const CONCURRENCY = Number(process.env.PARSE_CONCURRENCY || 5); // 5 × 16k ≈ 80k/min, inside the cap

// Wait-and-retry on rate limits / transient errors instead of crashing.
async function withRetry(fn, label) {
  let delay = 25000;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e && (e.status || e.statusCode);
      const retryable = status === 429 || status === 529 || (status >= 500 && status < 600);
      if (retryable && attempt < 8) {
        console.warn(`  ${label}: HTTP ${status} — waiting ${Math.round(delay / 1000)}s, retry ${attempt}/8`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 90000);
      } else {
        throw e;
      }
    }
  }
}

const SYSTEM = `You extract financial transactions from scanned pages of a US OGE Form 278-T (Periodic Transaction Report).
Each transaction row in the document's table has: a row number, a security description, a type (purchase/sale/exchange), a notification date, an over-30-days flag, and a dollar amount range.
Extract EVERY transaction row visible on these pages. Output ONLY a JSON array — no prose, no markdown fences.

Each array item must have exactly these fields:
- "security_name": cleaned, readable security description
- "ticker": stock ticker symbol if clearly identifiable (e.g. "NVDA"), otherwise null. Bonds get null.
- "asset_class": one of "equity" | "municipal_bond" | "corporate_bond" | "treasury" | "fund" | "other"
- "transaction_type": one of "buy" | "sell" | "exchange"  ("purchase" = buy, "sale" = sell)
- "notification_date": the row's notification date as "YYYY-MM-DD", or null
- "transaction_date": transaction date if shown as "YYYY-MM-DD", or null
- "amount_min": lower bound of the amount band as an integer (e.g. 250001), or null
- "amount_max": upper bound as an integer (e.g. 500000), or null
- "amount_band": the band as a clean display string (e.g. "$250,001 – $500,000"), or null

Pages with no transaction rows (cover pages, signatures, instructions): output [].`;

async function splitPdf(buffer) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  const chunks = [];
  for (let start = 0; start < total; start += PAGES_PER_CHUNK) {
    const out = await PDFDocument.create();
    const indices = [];
    for (let i = start; i < Math.min(start + PAGES_PER_CHUNK, total); i++) indices.push(i);
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    chunks.push({
      b64: Buffer.from(bytes).toString('base64'),
      from: start + 1,
      to: Math.min(start + PAGES_PER_CHUNK, total)
    });
  }
  return { chunks, total };
}

function extractJsonArray(s) {
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return [];
  }
}

async function parseChunk(client, chunk, total) {
  const msg = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: chunk.b64 }
        },
        {
          type: 'text',
          text: `These are pages ${chunk.from}–${chunk.to} of ${total} of the filing. Extract every transaction row. Output ONLY the JSON array.`
        }
      ]
    }]
  }), `pages ${chunk.from}–${chunk.to}`);

  if (msg.stop_reason === 'max_tokens') {
    console.warn(`  ⚠ pages ${chunk.from}–${chunk.to}: output hit the token limit; some rows may be missing`);
  }

  const textOut = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const rows = extractJsonArray(textOut);
  console.log(`  parsed pages ${chunk.from}–${chunk.to}/${total}: +${rows.length} rows`);
  return rows;
}

async function parseFiling(buffer) {
  const client = new Anthropic(); // uses ANTHROPIC_API_KEY
  const { chunks, total } = await splitPdf(buffer);
  const results = new Array(chunks.length);
  let next = 0;

  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      results[i] = await parseChunk(client, chunks[i], total);
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, chunks.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results
    .flat()
    .filter((r) => r && r.security_name && r.transaction_type);
}

module.exports = { parseFiling, MODEL, withRetry };

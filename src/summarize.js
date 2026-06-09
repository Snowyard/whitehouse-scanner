// Summarize: one filing-level AI summary (the "triage" that picks highlights).
// For a 3,500-row Trump filing this is what subscribers actually read.

const Anthropic = require('@anthropic-ai/sdk');
const { MODEL, withRetry } = require('./parse');

async function summarizeFiling(officialName, rows) {
  const client = new Anthropic();

  const buys = rows.filter((r) => r.transaction_type === 'buy').length;
  const sells = rows.filter((r) => r.transaction_type === 'sell').length;

  // give the model a manageable sample: biggest amounts + all equities/recognizable names
  const sorted = [...rows].sort((a, b) => (b.amount_max || 0) - (a.amount_max || 0));
  const sample = sorted.slice(0, 60).map((r) =>
    `${r.transaction_type.toUpperCase()} | ${r.security_name} | ${r.amount_band || ''} | ${r.asset_class}`
  ).join('\n');

  const prompt = `A White House official just disclosed trades. Write a 2–3 sentence plain-English summary for retail investors.

Rules: factual and neutral — describe what was disclosed, never imply profit or give advice. Lead with the most notable/recognizable positions (well-known companies, biggest amounts, any sells). Mention the overall pattern (e.g. "mostly municipal bonds") if relevant. No markdown.

Official: ${officialName}
Total transactions: ${rows.length} (${buys} buys, ${sells} sells)
Largest/most notable rows:
${sample}`;

  const msg = await withRetry(() => client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  }), 'filing summary');

  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
}

module.exports = { summarizeFiling };

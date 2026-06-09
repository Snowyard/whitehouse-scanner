// Fetch a filing PDF. Returns the raw buffer (for vision parsing) plus
// best-effort extracted text (many filings are image scans with no text layer).

const pdfParse = require('pdf-parse');
const { UA } = require('./discover');

async function fetchPdf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`PDF fetch failed (${res.status}): ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  let text = '';
  let pages = 0;
  try {
    const data = await pdfParse(buffer);
    text = data.text || '';
    pages = data.numpages || 0;
  } catch (_) {
    // image-only scans sometimes choke pdf-parse entirely; that's fine
  }
  return { buffer, text, pages };
}

module.exports = { fetchPdf };

// Discover: fetch the White House public-disclosures page and extract
// every Periodic Transaction Report (OGE 278-T) PDF link.

const PAGE_URL = 'https://www.whitehouse.gov/disclosures/';
const UA = 'WhitehouseTraderScanner/1.0 (+https://whitehousetrader.com)';

// The page encodes punctuation as HTML entities (e.g. "–" as "&#8211;").
// Decode them so titles parse into clean names like "Daniel Burrows".
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

async function discover() {
  const res = await fetch(PAGE_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Disclosures page returned HTTP ${res.status}`);
  const html = await res.text();

  const links = [];
  const re = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch (_) {}
    const isPTR =
      /periodic[-\s]transaction[-\s]report/i.test(decoded) ||
      /periodic transaction report/i.test(text);
    if (isPTR) {
      links.push({ url: new URL(href, PAGE_URL).href, title: text });
    }
  }

  // de-dupe by URL
  return [...new Map(links.map((l) => [l.url, l])).values()];
}

module.exports = { discover, UA };

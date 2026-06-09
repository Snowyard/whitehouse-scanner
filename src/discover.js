// Discover: fetch the White House public-disclosures page and extract
// every Periodic Transaction Report (OGE 278-T) PDF link.

const PAGE_URL = 'https://www.whitehouse.gov/disclosures/';
const UA = 'WhitehouseTraderScanner/1.0 (+https://whitehousetrader.com)';

async function discover() {
  const res = await fetch(PAGE_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Disclosures page returned HTTP ${res.status}`);
  const html = await res.text();

  const links = [];
  const re = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
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

# Whitehouse Scanner

Watches [whitehouse.gov/disclosures](https://www.whitehouse.gov/disclosures/) for new
**Periodic Transaction Reports (OGE Form 278-T)**, parses them into structured trades
with the Anthropic API, and stores everything in the Whitehouse Trader Supabase database.

## How it works

```
discover  →  fetch the disclosures page, extract all 278-T PDF links
diff      →  anything whose URL isn't in the filings table is new
fetch     →  download the PDF, extract raw text (kept for re-parsing)
parse     →  LLM turns messy text into clean trade rows (chunked for 100+ page filings)
store     →  filings + trades inserted into Supabase
summarize →  one filing-level AI summary (the highlights subscribers actually read)
```

Alerts are sent **per filing, not per trade** — Trump's filings can contain 3,500+ rows.

## One-time database addition

The schema needs one extra column for the filing-level summary. Run in the Supabase SQL editor:

```sql
alter table public.filings add column if not exists ai_summary text;
```

## Local setup

```bash
npm install
cp .env.example .env    # then fill in the real values
npm run scan
```

`.env` needs: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Settings → API),
`ANTHROPIC_API_KEY` (console.anthropic.com).

The first runs will work through the backlog of existing filings
(max 3 per run — just run it repeatedly until it reports 0 new).
That backlog **is** the 90-day history seed.

## Running on a schedule (GitHub Actions)

1. Push this repo to GitHub.
2. Repo → Settings → Secrets and variables → Actions → add the same three values
   as **Repository secrets**.
3. The workflow (`.github/workflows/scan.yml`) runs every 10 minutes automatically,
   and can be triggered manually from the Actions tab (**Run workflow**).
4. A failed run (page layout changed, parse error, etc.) marks the workflow red and
   GitHub emails you — silent failure is designed out.

> **Note on minutes:** private repos get 2,000 free Actions minutes/month, which a
> 10-minute schedule can exceed. Either make this repo **public** (it contains no
> secrets — they live in GitHub Secrets) for unlimited minutes, or relax the cron to
> `*/30`.

## Design notes

- Dedupe is by `filings.source_url` (unique) — re-runs never duplicate.
- Raw text is stored on the filing, so the parser can be improved and re-run later
  without re-downloading anything.
- `MAX_PER_RUN = 3` keeps runs short; the backlog drains across consecutive runs.
- Parsing model defaults to `claude-sonnet-4-6` (override with `ANTHROPIC_MODEL`).

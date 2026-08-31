const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const key = process.env.FMP_API_KEY;
const symbol = process.argv[2] || "AAPL";
const today = new Date();
const future = new Date(today.getTime() + 45 * 86400000);
const date = (value) => value.toISOString().slice(0, 10);
const endpoints = [
  ["earnings", "/stable/earnings", { symbol, limit: "5" }],
  ["earningsCalendar", "/stable/earnings-calendar", { from: date(today), to: date(future) }],
  ["analystEstimates", "/stable/analyst-estimates", { symbol, period: "annual", page: "0", limit: "5" }],
  ["priceTargetConsensus", "/stable/price-target-consensus", { symbol }],
  ["gradesConsensus", "/stable/grades-consensus", { symbol }],
  ["stockNews", "/stable/news/stock", { symbols: symbol, page: "0", limit: "5" }],
  ["stockNewsBatch", "/stable/news/stock", { symbols: `${symbol},MSFT,NVDA`, page: "0", limit: "15" }],
  ["pressReleases", "/stable/news/press-releases", { symbols: symbol, page: "0", limit: "5" }]
];

async function probe(label, pathname, params) {
  const url = new URL(`https://financialmodelingprep.com${pathname}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    headers: { apikey: key, "user-agent": "stock-radar-dashboard/1.0" }
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Report only metadata; never print provider bodies or credentials.
  }
  const rows = Array.isArray(json) ? json : json && typeof json === "object" ? [json] : [];
  return {
    label,
    status: response.status,
    rows: rows.length,
    keys: Object.keys(rows[0] || {}).slice(0, 40),
    available: response.ok && rows.length > 0
  };
}

async function run() {
  if (!key) throw new Error("Missing FMP_API_KEY");
  console.log(`FMP catalyst smoke test for ${symbol}`);
  for (const endpoint of endpoints) {
    const result = await probe(...endpoint);
    console.log(`${result.available ? "OK" : "NO"} ${result.label} status=${result.status} rows=${result.rows} keys=${result.keys.join("|")}`);
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

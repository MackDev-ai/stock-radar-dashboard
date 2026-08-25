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
const endpoints = [
  ["/stable/profile", "profile"],
  ["/stable/ratios-ttm", "ratiosTTM"],
  ["/stable/key-metrics-ttm", "keyMetricsTTM"],
  ["/stable/income-statement-ttm", "incomeTTM"],
  ["/stable/balance-sheet-statement-ttm", "balanceTTM"],
  ["/stable/cash-flow-statement-ttm", "cashFlowTTM"],
  ["/stable/financial-growth", "growth"],
  ["/stable/enterprise-values", "enterpriseValue"],
  ["/stable/financial-scores", "financialScores"]
];

async function fetchEndpoint(pathname, label) {
  const query = new URLSearchParams({ symbol, limit: "1" });
  const response = await fetch(`https://financialmodelingprep.com${pathname}?${query.toString()}`, {
    headers: {
      "user-agent": "stock-radar-dashboard/1.0",
      "apikey": key
    }
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep body length only. Do not print raw responses; they may include provider messages.
  }
  const rows = Array.isArray(json) ? json.length : json && typeof json === "object" ? 1 : 0;
  const keys = Array.isArray(json) ? Object.keys(json[0] || {}).slice(0, 8) : Object.keys(json || {}).slice(0, 8);
  return {
    label,
    status: response.status,
    ok: response.ok && rows > 0,
    rows,
    keys,
    bodyLength: text.length
  };
}

async function run() {
  if (!key) throw new Error("Missing FMP_API_KEY");
  console.log(`FMP smoke test for ${symbol}`);
  for (const [pathname, label] of endpoints) {
    try {
      const result = await fetchEndpoint(pathname, label);
      console.log(`${result.ok ? "OK" : "NO"} ${label} status=${result.status} rows=${result.rows} keys=${result.keys.join("|")}`);
    } catch (error) {
      console.log(`ERR ${label} ${error.message}`);
    }
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "monitoring-config.json"), "utf8"));
const dataDir = path.join(root, "data");
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const publicBaseUrl = dashboardUrl.replace(/\/?([?#].*)?$/, "/");

const files = [
  "data/monitoring-data.js",
  "data/monitoring-history.json",
  "data/elite-flow-data.js",
  "data/alerts.json",
  "data/decision-change-log.json",
  "data/filing-analysis.json",
  "data/filing-watch-history.json"
];

async function downloadFile(file) {
  const target = path.join(root, file);
  if (fs.existsSync(target)) return false;
  const response = await fetch(`${publicBaseUrl}${file}`, {
    headers: {
      "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com"
    }
  });
  if (!response.ok) throw new Error(`Download ${file} failed: HTTP ${response.status}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, await response.text());
  return true;
}

async function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  let restored = 0;
  for (const file of files) {
    if (await downloadFile(file)) restored += 1;
  }
  console.log(`Restored public data files: ${restored}/${files.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

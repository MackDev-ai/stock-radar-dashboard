const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "monitoring-config.json"), "utf8"));
const dataDir = path.join(root, "data");
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const publicBaseUrl = dashboardUrl.replace(/\/?([?#].*)?$/, "/");

const files = [
  { path: "data/monitoring-data.js", required: true },
  { path: "data/monitoring-history.json" },
  { path: "data/elite-flow-data.js" },
  { path: "data/alerts.json" },
  { path: "data/action-queue.json" },
  { path: "data/triage-queue.json" },
  { path: "data/today-decision-queue.json" },
  { path: "data/today-decision-changes.json" },
  { path: "data/decision-packages.json" },
  { path: "data/decision-registry.json" },
  { path: "data/research-priority-queue.json" },
  { path: "data/decision-change-log.json" },
  { path: "data/filing-analysis.json" },
  { path: "data/filing-watch-history.json" }
];

async function downloadFile({ path: file, required = false }) {
  const target = path.join(root, file);
  if (fs.existsSync(target)) return false;
  const response = await fetch(`${publicBaseUrl}${file}`, {
    headers: {
      "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com"
    }
  });
  if (!response.ok) {
    if (required) throw new Error(`Download ${file} failed: HTTP ${response.status}`);
    console.warn(`Optional public data unavailable: ${file} (HTTP ${response.status})`);
    return false;
  }
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

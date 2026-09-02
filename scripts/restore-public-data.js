const fs = require("node:fs");
const path = require("node:path");
const { dashboardBaseUrl, dashboardFetchHeaders } = require("./lib/dashboard-source");

const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "monitoring-config.json"), "utf8"));
const dataDir = path.join(root, "data");
const publicBaseUrl = dashboardBaseUrl();
const restoreMode = String(process.env.RESTORE_PUBLIC_DATA_MODE || "missing").toLowerCase();
const watcherOwnedFiles = new Set(["data/filing-analysis.json", "data/filing-watch-history.json"]);

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

function shouldRefreshExisting(file, mode = restoreMode) {
  if (mode === "refresh") return true;
  if (mode === "refresh-monitoring") return !watcherOwnedFiles.has(file);
  return false;
}

async function downloadFile({ path: file, required = false }) {
  const target = path.join(root, file);
  if (fs.existsSync(target) && !shouldRefreshExisting(file)) return false;
  const response = await fetch(`${publicBaseUrl}${file}`, {
    headers: dashboardFetchHeaders({
      "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com"
    })
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

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { shouldRefreshExisting };

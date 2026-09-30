const fs = require("node:fs");
const path = require("node:path");
const {
  buildAlerts,
  writeAlertsMarkdown,
  writeDailyReport
} = require("./update-monitoring");

const root = path.resolve(__dirname, "..");
const snapshotPath = path.join(root, "data", "monitoring-data.js");

function loadSnapshot() {
  const source = fs.readFileSync(snapshotPath, "utf8").trim();
  const prefix = "window.MONITORING_DATA = ";
  if (!source.startsWith(prefix)) {
    throw new Error("Invalid data/monitoring-data.js format");
  }
  const json = source.slice(prefix.length).replace(/;\s*$/, "");
  return JSON.parse(json);
}

const snapshot = loadSnapshot();
const alerts = buildAlerts(snapshot);
writeAlertsMarkdown(snapshot, alerts);
writeDailyReport(snapshot);

console.log(`Rendered monitoring reports for ${snapshot.generatedAt}`);
console.log(`Alerts: ${alerts.length}`);

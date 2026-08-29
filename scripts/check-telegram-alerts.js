const fs = require("node:fs");
const path = require("node:path");
const {
  buildAlertSections,
  buildBriefMessages
} = require("./send-telegram-alerts");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "data", "monitoring-data.js");
const marker = "window.MONITORING_DATA = ";
const telegramLimit = 2800;

function parseMonitoringData(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`MONITORING_DATA marker not found in ${filePath}`);
  return JSON.parse(text.slice(start + marker.length).trim().replace(/;$/, ""));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const snapshot = parseMonitoringData(sourcePath);
snapshot.generatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
snapshot.fmpCoverage = {
  ...(snapshot.fmpCoverage || {}),
  enabled: true,
  disabledEndpoints: [...new Set([...(snapshot.fmpCoverage?.disabledEndpoints || []), "testEndpoint"])]
};

const sections = buildAlertSections(snapshot);
const messages = buildBriefMessages(snapshot, sections);
const output = messages.join("\n\n");

assert(messages.length > 0, "dry run did not produce Telegram messages");
assert(output.includes("Status pipeline'u: PROBLEM"), "stale fixture did not trigger PROBLEM guard");
assert(output.includes("PROBLEM: Dane:"), "freshness warning is missing from Telegram guard");
assert(output.includes("#statusView"), "status dashboard link is missing from Telegram guard");
for (const [index, message] of messages.entries()) {
  assert(message.length <= telegramLimit, `Telegram message ${index + 1} exceeds ${telegramLimit} characters`);
}

console.log(`Telegram alert check OK: ${messages.length} message(s), limit ${telegramLimit}`);

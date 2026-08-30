const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "site-dist");

const files = [
  ["monitoring-dashboard.html", "index.html"],
  ["stock-map.html", "stock-map.html"],
  ["daily-report.md", "daily-report.md"],
  ["alerts.md", "alerts.md"],
  ["new-filings.md", "new-filings.md"],
  ["filing-watch.md", "filing-watch.md"],
  ["sec-analysis.md", "sec-analysis.md"],
  ["elite-flow-report.md", "elite-flow-report.md"],
  ["automation-workflow.md", "automation-workflow.md"],
  ["research/sector-radar-report.md", "research/sector-radar-report.md"],
  ["research/valuation-scenarios.md", "research/valuation-scenarios.md"],
  ["research/memo-index.md", "research/memo-index.md"],
  ["research/ETN-vs-Schneider.md", "research/ETN-vs-Schneider.md"],
  ["data/monitoring-data.js", "data/monitoring-data.js"],
  ["data/monitoring-history.json", "data/monitoring-history.json"],
  ["data/elite-flow-data.js", "data/elite-flow-data.js"],
  ["data/alerts.json", "data/alerts.json"],
  ["data/action-queue.json", "data/action-queue.json"],
  ["data/triage-queue.json", "data/triage-queue.json"],
  ["data/today-decision-queue.json", "data/today-decision-queue.json"],
  ["data/today-decision-changes.json", "data/today-decision-changes.json"],
  ["data/decision-packages.json", "data/decision-packages.json"],
  ["data/decision-registry.json", "data/decision-registry.json"],
  ["data/research-priority-queue.json", "data/research-priority-queue.json"],
  ["data/decision-change-log.json", "data/decision-change-log.json"],
  ["data/filing-watch-history.json", "data/filing-watch-history.json"],
  ["data/filing-analysis.json", "data/filing-analysis.json"]
];

const csvFiles = [
  "ai-infra-watchlist.csv",
  "biotech-watchlist.csv",
  "core-shortlist.csv",
  "data-power-watchlist.csv",
  "example-synthetic-stocks.csv",
  "expanded-universe.csv",
  "manual-fundamentals-template.csv",
  "market-themes-watchlist.csv",
  "monitoring-events-template.csv",
  "monitoring-events.csv",
  "political-trades.csv",
  "power-grid-watchlist.csv",
  "research-decisions.csv",
  "secondary-raw-materials-watchlist.csv",
  "sector-opportunity-radar.csv",
  "stock-map-template.csv"
];

function copyFile(from, to) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) return false;
  const target = path.join(outDir, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function copyDir(from, to) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFile(src, dst);
  }
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeReportsIndex() {
  const reports = [
    ["Dashboard", "index.html"],
    ["Mapa spolek", "stock-map.html"],
    ["Daily report", "daily-report.md"],
    ["Elite flow", "elite-flow-report.md"],
    ["Sector radar", "research/sector-radar-report.md"],
    ["Deep dive index", "research/deep-dive-index.md"],
    ["Investment memo index", "research/memo-index.md"],
    ["Valuation scenarios", "research/valuation-scenarios.md"],
    ["ETN vs Schneider", "research/ETN-vs-Schneider.md"],
    ["Alerts", "alerts.md"],
    ["Filing Watch", "filing-watch.md"],
    ["SEC analysis", "sec-analysis.md"],
    ["Automation workflow", "automation-workflow.md"]
  ];
  const html = `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stock Radar Reports</title>
  <style>
    body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f6f8; color: #1c2430; }
    main { max-width: 900px; margin: 0 auto; padding: 28px 18px; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    p { color: #657084; margin: 0 0 20px; }
    a { color: #1769aa; text-decoration: none; }
    ul { display: grid; gap: 10px; padding: 0; list-style: none; }
    li { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 12px 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Stock Radar Reports</h1>
    <p>Automatycznie generowane raporty. To material researchowy, nie rekomendacje inwestycyjne.</p>
    <ul>
      ${reports.map(([label, href]) => `<li><a href="${href}">${label}</a></li>`).join("\n      ")}
    </ul>
  </main>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, "reports.html"), html);
}

function writeFallbackRuntimeFiles() {
  const analysisTarget = path.join(outDir, "data", "filing-analysis.json");
  if (!fs.existsSync(analysisTarget)) {
    fs.mkdirSync(path.dirname(analysisTarget), { recursive: true });
    fs.writeFileSync(analysisTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      universeSize: 0,
      newFilings: 0,
      analyzedCount: 0,
      items: []
    }, null, 2));
  }

  const changeLogTarget = path.join(outDir, "data", "decision-change-log.json");
  if (!fs.existsSync(changeLogTarget)) {
    fs.mkdirSync(path.dirname(changeLogTarget), { recursive: true });
    fs.writeFileSync(changeLogTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      historyRuns: 0,
      changes: []
    }, null, 2));
  }

  const actionQueueTarget = path.join(outDir, "data", "action-queue.json");
  if (!fs.existsSync(actionQueueTarget)) {
    fs.mkdirSync(path.dirname(actionQueueTarget), { recursive: true });
    fs.writeFileSync(actionQueueTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: 0,
      byTask: {},
      items: []
    }, null, 2));
  }

  const triageQueueTarget = path.join(outDir, "data", "triage-queue.json");
  if (!fs.existsSync(triageQueueTarget)) {
    fs.mkdirSync(path.dirname(triageQueueTarget), { recursive: true });
    fs.writeFileSync(triageQueueTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      byBucket: {},
      buckets: { TODAY: [], THIS_WEEK: [], PARKING: [], DEFERRED: [] },
      today: [],
      thisWeek: [],
      parking: [],
      deferred: []
    }, null, 2));
  }

  const todayDecisionQueueTarget = path.join(outDir, "data", "today-decision-queue.json");
  if (!fs.existsSync(todayDecisionQueueTarget)) {
    fs.mkdirSync(path.dirname(todayDecisionQueueTarget), { recursive: true });
    fs.writeFileSync(todayDecisionQueueTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: 0,
      ready: 0,
      deepDive: 0,
      wait: 0,
      items: []
    }, null, 2));
  }

  const decisionRegistryTarget = path.join(outDir, "data", "decision-registry.json");
  if (!fs.existsSync(decisionRegistryTarget)) {
    fs.mkdirSync(path.dirname(decisionRegistryTarget), { recursive: true });
    fs.writeFileSync(decisionRegistryTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: 0,
      open: 0,
      matured5d: 0,
      matured20d: 0,
      matured60d: 0,
      byWindow: {},
      byVerdict: [],
      byBriefVerdict: [],
      byBriefConfidence: [],
      decisionLearning: {},
      items: []
    }, null, 2));
  }

  const researchPriorityTarget = path.join(outDir, "data", "research-priority-queue.json");
  if (!fs.existsSync(researchPriorityTarget)) {
    fs.mkdirSync(path.dirname(researchPriorityTarget), { recursive: true });
    fs.writeFileSync(researchPriorityTarget, JSON.stringify([], null, 2));
  }

  const decisionPackagesTarget = path.join(outDir, "data", "decision-packages.json");
  if (!fs.existsSync(decisionPackagesTarget)) {
    fs.mkdirSync(path.dirname(decisionPackagesTarget), { recursive: true });
    fs.writeFileSync(decisionPackagesTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: 0,
      items: []
    }, null, 2));
  }

  const todayDecisionChangesTarget = path.join(outDir, "data", "today-decision-changes.json");
  if (!fs.existsSync(todayDecisionChangesTarget)) {
    fs.mkdirSync(path.dirname(todayDecisionChangesTarget), { recursive: true });
    fs.writeFileSync(todayDecisionChangesTarget, JSON.stringify({
      generatedAt: new Date().toISOString(),
      previousGeneratedAt: null,
      added: [],
      removed: [],
      verdictChanged: [],
      readyNow: [],
      totalChanges: 0
    }, null, 2));
  }
}

removeDir(outDir);
fs.mkdirSync(outDir, { recursive: true });

const copied = [];
for (const [from, to] of files) {
  if (copyFile(from, to)) copied.push(to);
}
if (!copied.includes("data/monitoring-data.js")) {
  throw new Error("Missing required data/monitoring-data.js; restore or generate monitoring data before build");
}
for (const file of csvFiles) {
  if (copyFile(file, file)) copied.push(file);
}
copyDir("research/deep-dives", "research/deep-dives");
copyDir("research/memos", "research/memos");
fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
writeFallbackRuntimeFiles();
writeReportsIndex();

console.log(`Built ${path.relative(root, outDir)}`);
console.log(`Copied ${copied.length} explicit files`);

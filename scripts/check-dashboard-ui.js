const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "monitoring-dashboard.html");
const builtPath = path.join(root, "site-dist", "index.html");
const html = fs.readFileSync(fs.existsSync(builtPath) ? builtPath : sourcePath, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function count(pattern) {
  return (html.match(pattern) || []).length;
}

const requiredViews = [
  "overviewView",
  "statusView",
  "decisionBriefView",
  "todayDecisionView",
  "decisionPackagesView",
  "telegramBriefView",
  "legendView"
];

for (const view of requiredViews) {
  assert(html.includes(`data-tab="${view}"`), `missing tab for ${view}`);
  assert(html.includes(`id="${view}"`), `missing section for ${view}`);
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert(scripts.length > 0, "dashboard script not found");
const dashboardScript = scripts.at(-1)[1];
new Function(dashboardScript);

const requiredFunctions = [
  "renderPipelineHealth",
  "renderDecisionBrief",
  "renderTodayDecision",
  "renderDecisionPackages",
  "renderTelegramBrief"
];

for (const fn of requiredFunctions) {
  assert(dashboardScript.includes(`function ${fn}`), `missing ${fn}`);
  assert(dashboardScript.includes(`${fn}(`), `render flow does not reference ${fn}`);
}

assert(count(/class="tab/g) >= requiredViews.length, "too few tabs rendered");
assert(html.includes("To nie sa rekomendacje inwestycyjne"), "investment disclaimer missing");
assert(html.includes("material decyzyjny, nie rekomendacja inwestycyjna"), "decision brief disclaimer missing");
assert(dashboardScript.includes("byBriefVerdict"), "decision registry brief verdict aggregate missing");
assert(dashboardScript.includes("briefVerdictLabel"), "brief verdict label renderer missing");
assert(html.includes("decisionLearningSummary"), "decision learning summary missing");
assert(dashboardScript.includes("renderDecisionLearning"), "decision learning renderer missing");
assert(html.includes("Pewnosc"), "decision confidence label missing");

console.log(`Dashboard UI check OK: ${requiredViews.length} critical views, ${count(/class="tab/g)} tabs`);

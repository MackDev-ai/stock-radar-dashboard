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
  "catalystsView",
  "postEarningsView",
  "performanceView",
  "riskView",
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
  "renderResearchPriorityQueue",
  "renderTodayDecision",
  "renderDecisionPackages",
  "renderTelegramBrief",
  "renderCatalysts",
  "renderPostEarnings",
  "renderPerformance",
  "renderRisk"
];

for (const fn of requiredFunctions) {
  assert(dashboardScript.includes(`function ${fn}`), `missing ${fn}`);
  assert(dashboardScript.includes(`${fn}(`), `render flow does not reference ${fn}`);
}

assert(count(/class="tab/g) >= requiredViews.length, "too few tabs rendered");
assert(html.includes("To nie sa rekomendacje inwestycyjne"), "investment disclaimer missing");
assert(html.includes("material decyzyjny, nie rekomendacja inwestycyjna"), "decision brief disclaimer missing");
assert(dashboardScript.includes("briefVerdictLabel"), "brief verdict label renderer missing");
assert(html.includes("decisionLearningSummary"), "decision learning summary missing");
assert(html.includes("Top priorytet teraz"), "research priority panel missing");
assert(html.includes("researchPriorityQueue"), "research priority queue container missing");
assert(dashboardScript.includes("fallbackResearchPriorityQueue"), "research priority queue fallback missing");
assert(html.includes("paperPortfolioSummary"), "paper portfolio summary missing");
assert(html.includes("paperPortfolioPositions"), "paper portfolio positions missing");
assert(html.includes("riskSummary"), "risk summary missing");
assert(html.includes("riskThemeExposure"), "theme exposure panel missing");
assert(html.includes("riskPositions"), "risk positions panel missing");
assert(html.includes("riskActivity"), "risk activity panel missing");
assert(dashboardScript.includes("verdictPerformance"), "explicit verdict performance renderer missing");
assert(html.includes("Jedno zdarzenie na zmiane MODEL"), "deduplicated verdict methodology label missing");
assert(html.includes("kolejnej sesji"), "next-session paper execution label missing");
assert(html.includes("luka 3%"), "entry gap risk legend missing");

console.log(`Dashboard UI check OK: ${requiredViews.length} critical views, ${count(/class="tab/g)} tabs`);

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "monitoring-config.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "data", "monitoring-data.js"), "utf8");
const marker = "window.MONITORING_DATA = ";
const start = source.indexOf(marker);
if (start === -1) throw new Error("Invalid monitoring-data.js: assignment marker missing");
const snapshot = JSON.parse(source.slice(start + marker.length).replace(/;\s*$/, ""));
const errors = [];
const checks = [];
const check = (condition, message) => {
  if (condition) checks.push(message);
  else errors.push(message);
};

const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
const tickers = rows.map((row) => row.ticker).filter(Boolean);
const uniqueTickers = new Set(tickers);
const configuredTickers = new Set((config.watchlist || []).map((row) => row.ticker));
const generatedAt = new Date(snapshot.generatedAt).getTime();
const maxAgeHours = Number(process.env.MAX_SNAPSHOT_AGE_HOURS || 72);
const ageHours = (Date.now() - generatedAt) / 3600000;
const requireCanonical = process.env.REQUIRE_CANONICAL_DECISIONS !== "false";

check(Number.isFinite(generatedAt), "snapshot has a valid generatedAt");
check(ageHours <= maxAgeHours && ageHours >= -1, `snapshot age is within ${maxAgeHours}h`);
check(rows.length >= 200, "snapshot contains at least 200 companies");
check(rows.length === configuredTickers.size, "snapshot row count matches configured universe");
check(uniqueTickers.size === rows.length, "snapshot tickers are unique");
check([...configuredTickers].every((ticker) => uniqueTickers.has(ticker)), "snapshot contains every configured ticker");

const withPrice = rows.filter((row) => Number.isFinite(row.metrics?.price)).length;
check(rows.length > 0 && withPrice / rows.length >= 0.95, "price coverage is at least 95%");
check(!requireCanonical || (snapshot.quality?.status && snapshot.quality.status !== "FAIL"), "snapshot quality gate passed");

if (requireCanonical) {
  check(rows.every((row) => row.researchScore && row.investmentVerdict && row.decisionEngine && row.decisionBrief && row.concreteVerdict), "every row has score and canonical decision fields");
  check(rows.every((row) => ["INWESTUJ", "CZEKAJ", "ODRZUC"].includes(row.concreteVerdict?.action)), "every row has an explicit INWESTUJ/CZEKAJ/ODRZUC model verdict");
  for (const row of rows) {
    const brief = row.decisionBrief?.briefVerdict;
    const filing = row.secAnalysis?.filingBrief?.decisionBrief?.verdict;
    const engine = row.decisionEngine?.category;
    const investment = row.investmentVerdict?.verdict;
    const rejectSignal = filing === "AVOID_NOW" || engine === "ODRZUC_TERAZ" || ["NIE_INWESTOWAC_TERAZ", "ODRZUCIC"].includes(investment);
    if (rejectSignal && brief !== "ODRZUC") errors.push(`${row.ticker}: reject signal conflicts with canonical verdict ${brief || "missing"}`);
    if (brief === "KANDYDAT" && rejectSignal) errors.push(`${row.ticker}: candidate conflicts with a reject signal`);
    if (row.concreteVerdict?.action === "INWESTUJ") {
      const binaryEvent = row.catalystAssessment?.nextEvent?.type === "earnings"
        && Number.isFinite(row.catalystAssessment?.daysToEvent)
        && row.catalystAssessment.daysToEvent <= 3;
      if (binaryEvent) errors.push(`${row.ticker}: INWESTUJ conflicts with earnings within 3 days`);
      if (rejectSignal || brief !== "KANDYDAT" || engine !== "ROZWAZ_WEJSCIE") errors.push(`${row.ticker}: INWESTUJ conflicts with canonical decision fields`);
      if ((row.researchScore?.total ?? 0) < 80) errors.push(`${row.ticker}: INWESTUJ requires radar score >= 80`);
      if (["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(row.signal?.action)) errors.push(`${row.ticker}: INWESTUJ conflicts with action ${row.signal.action}`);
      if (row.postEarnings && (row.postEarnings.status !== "ANALYZED" || row.postEarnings.modelAction !== "INWESTUJ")) errors.push(`${row.ticker}: INWESTUJ conflicts with incomplete or weak post-earnings assessment`);
    }
  }
}

if (snapshot.fmpCoverage?.enabled) {
  check((snapshot.fmpCoverage.loaded?.profile || 0) / rows.length >= 0.65, "FMP profile coverage is at least 65%");
  check(!requireCanonical || Number.isFinite(snapshot.fmpCoverage.requestCount), "FMP request count is recorded");
}

if (requireCanonical && config.data_providers?.fmp_catalysts !== false && snapshot.fmpCoverage?.enabled) {
  const catalystCoverage = snapshot.catalystCoverage || {};
  const detailPlan = catalystCoverage.detailPlan || {};
  check(rows.every((row) => row.catalysts && row.catalystAssessment), "every row has catalyst data and an interpreted assessment");
  check(Number.isFinite(catalystCoverage.requestsUsed) && catalystCoverage.requestsUsed <= 110, "catalyst layer uses no more than 110 FMP requests per run");
  check((detailPlan.selectedSymbols || []).length <= Number(config.data_providers?.fmp_catalyst_detail_limit || 20), "catalyst detail rotation respects its configured limit");
  check(rows.every((row) => Number.isFinite(row.catalystAssessment?.score) && Math.abs(row.catalystAssessment.score) <= 15), "catalyst scores are present and within -15..15");
  for (const row of rows) {
    const binaryEvent = row.catalystAssessment?.nextEvent?.type === "earnings"
      && Number.isFinite(row.catalystAssessment?.daysToEvent)
      && row.catalystAssessment.daysToEvent <= 3;
    if (binaryEvent && !["WSTRZYMAJ", "ODRZUC"].includes(row.decisionBrief?.briefVerdict)) {
      errors.push(`${row.ticker}: earnings within 3 days must not produce ${row.decisionBrief?.briefVerdict || "a missing verdict"}`);
    }
  }
}

if (requireCanonical) {
  const postCoverage = snapshot.postEarningsCoverage || {};
  const postRows = rows.filter((row) => row.postEarnings);
  check(Number.isFinite(postCoverage.candidates), "post-earnings candidate count is recorded");
  check(Number.isFinite(postCoverage.secRequestsUsed) && postCoverage.secRequestsUsed <= Number(config.runtime?.max_post_earnings_per_run || 20) * 3, "post-earnings SEC requests respect the configured limit");
  check(postRows.every((row) => ["ANALYZED", "QUEUED", "NO_RELEASE", "NON_EARNINGS_EXHIBIT", "ERROR", "PENDING_RELEASE", "NO_FILING"].includes(row.postEarnings.status)), "post-earnings statuses use the supported contract");
  for (const row of postRows.filter((item) => item.postEarnings.status === "ANALYZED")) {
    const sourceUrl = row.postEarnings.release?.document?.url;
    if (!/^https:\/\/www\.sec\.gov\//i.test(sourceUrl || "")) errors.push(`${row.ticker}: analyzed earnings release must link to sec.gov`);
  }
}

const upcomingEvents = Array.isArray(snapshot.upcomingEvents) ? snapshot.upcomingEvents : [];
check(upcomingEvents.every((event) => uniqueTickers.has(event.ticker)), "upcoming events only contain monitored tickers");
check(upcomingEvents.every((event) => Number.isFinite(new Date(`${event.date}T00:00:00Z`).getTime())), "upcoming event dates are valid");

const researchQueue = snapshot.researchPriorityQueue || [];
check(Array.isArray(researchQueue) && researchQueue.length <= 20, "research priority queue has at most 20 items");
check(researchQueue.every((item) => uniqueTickers.has(item.ticker)), "research priority queue only contains monitored tickers");

const mirrors = [
  ["data/today-decision-queue.json", "todayDecisionQueue"],
  ["data/today-decision-changes.json", "todayDecisionChanges"],
  ["data/decision-packages.json", "decisionPackages"],
  ["data/decision-registry.json", "decisionRegistry"],
  ["data/research-priority-queue.json", "researchPriorityQueue"]
];
for (const [file, key] of mirrors) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) continue;
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  check(JSON.stringify(value) === JSON.stringify(snapshot[key]), `${file} matches the main snapshot`);
}

const historyPath = path.join(root, "data", "monitoring-history.json");
if (fs.existsSync(historyPath)) {
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  const times = history.map((entry) => new Date(entry.generatedAt).getTime());
  check(Array.isArray(history) && history.length > 0, "monitoring history is non-empty");
  check(times.every(Number.isFinite), "monitoring history timestamps are valid");
  check(times.every((time, index) => index === 0 || time > times[index - 1]), "monitoring history is ordered and deduplicated");
  check(history.at(-1)?.generatedAt === snapshot.generatedAt, "monitoring history ends at the current snapshot");
}

const registry = snapshot.decisionRegistry;
if (registry?.items) {
  check(registry.generatedAt === snapshot.generatedAt, "decision registry timestamp matches the snapshot");
  check(new Set(registry.items.map((item) => item.id)).size === registry.items.length, "decision registry ids are unique");
}

const verdictPerformance = snapshot.verdictPerformance;
check(verdictPerformance?.version === 1, "explicit verdict performance uses contract version 1");
check(verdictPerformance?.generatedAt === snapshot.generatedAt, "verdict performance timestamp matches the snapshot");
check(["LOCKED", "READY"].includes(verdictPerformance?.calibration?.status), "verdict calibration has a supported status");
check((verdictPerformance?.byAction || []).every((item) => ["INWESTUJ", "CZEKAJ", "ODRZUC"].includes(item.action)), "verdict performance only contains explicit model actions");

const verdictLedgerPath = path.join(root, "data", "verdict-ledger.json");
if (fs.existsSync(verdictLedgerPath)) {
  const ledger = JSON.parse(fs.readFileSync(verdictLedgerPath, "utf8"));
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  const openEvents = events.filter((event) => event.status === "OPEN");
  check(ledger.version === 1, "verdict ledger uses contract version 1");
  check(ledger.generatedAt === snapshot.generatedAt, "verdict ledger timestamp matches the snapshot");
  check(JSON.stringify(ledger.summary) === JSON.stringify(verdictPerformance), "verdict ledger summary matches the main snapshot");
  check(new Set(events.map((event) => event.id)).size === events.length, "verdict ledger ids are unique");
  check(events.every((event) => ["INWESTUJ", "CZEKAJ", "ODRZUC"].includes(event.action)), "verdict ledger only contains explicit actions");
  check(new Set(openEvents.map((event) => event.ticker)).size === openEvents.length, "verdict ledger has at most one open event per ticker");
  check(openEvents.length === rows.length, "verdict ledger has one current open event per monitored ticker");
  const currentByTicker = new Map(rows.map((row) => [row.ticker, row.concreteVerdict?.action]));
  check(openEvents.every((event) => currentByTicker.get(event.ticker) === event.action), "open verdict events match current model actions");
  const paper = ledger.paperPortfolio || {};
  check(Number.isFinite(paper.initialCapital) && paper.initialCapital > 0, "paper portfolio has positive initial capital");
  check((paper.positions || []).length <= Number(config.runtime?.paper_portfolio_max_positions || 10), "paper portfolio respects the position limit");
  check((paper.positions || []).every((position) => !position.signalDate || position.openedAt > position.signalDate), "paper buys execute after the signal session");
  check((paper.trades || []).every((trade) => ["BUY", "SELL"].includes(trade.side)), "paper portfolio only contains buy and sell trades");
}

if (errors.length) {
  console.error(`Data contract failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Data contract OK: ${rows.length} rows, ${checks.length} checks, ${withPrice} prices`);

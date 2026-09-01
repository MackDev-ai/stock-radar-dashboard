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
const supportedConcreteLabels = new Set(["WEJSCIE TERAZ", "CZEKAJ", "ODRZUC", "BRAK WYSTARCZAJACYCH DANYCH"]);

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
  check(rows.every((row) => supportedConcreteLabels.has(row.concreteVerdict?.label)), "every row has one supported user-facing verdict");
  check(rows.every((row) => row.concreteVerdict?.scores && row.concreteVerdict?.dataQuality && row.concreteVerdict?.entrySetup), "every row has named decision scores, data quality and entry setup");
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
      if (row.concreteVerdict.label !== "WEJSCIE TERAZ") errors.push(`${row.ticker}: INWESTUJ must use the WEJSCIE TERAZ label`);
      if (row.concreteVerdict.entrySetup?.status !== "MET") errors.push(`${row.ticker}: WEJSCIE TERAZ requires a met entry trigger`);
      if (row.concreteVerdict.dataQuality?.status === "INSUFFICIENT") errors.push(`${row.ticker}: WEJSCIE TERAZ conflicts with insufficient data`);
    }
    if (row.concreteVerdict?.dataQuality?.status === "LIMITED" && row.concreteVerdict?.confidenceScore > 74) errors.push(`${row.ticker}: limited data must cap confidence at 74`);
    if (row.concreteVerdict?.dataQuality?.status === "INSUFFICIENT" && row.concreteVerdict?.confidenceScore > 49) errors.push(`${row.ticker}: insufficient data must cap confidence at 49`);
    if (row.concreteVerdict?.label === "BRAK WYSTARCZAJACYCH DANYCH" && row.concreteVerdict?.action !== "CZEKAJ") errors.push(`${row.ticker}: missing-data verdict must map to CZEKAJ internally`);
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
check(researchQueue.every((item) => supportedConcreteLabels.has(item.label)), "research priority queue uses canonical verdict labels");
check(researchQueue.every((item) => item.scores && Number.isFinite(item.scores.attractiveness) && Number.isFinite(item.scores.readiness) && Number.isFinite(item.scores.risk) && Number.isFinite(item.scores.dataCompleteness)), "research priority queue carries named canonical scores");
for (const item of researchQueue) {
  const row = rows.find((candidate) => candidate.ticker === item.ticker);
  if (row && item.label !== row.concreteVerdict?.label) {
    errors.push(`${item.ticker}: research priority queue conflicts with canonical verdict ${row.concreteVerdict?.label}`);
  }
}

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

for (const item of snapshot.decisionPackages?.items || []) {
  const row = rows.find((candidate) => candidate.ticker === item.ticker);
  if (row && item.decisionLabel !== row.concreteVerdict?.label) {
    errors.push(`${item.ticker}: decision package conflicts with canonical verdict ${row.concreteVerdict?.label}`);
  }
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
  const paperLimits = paper.riskLimits || {};
  check(Number.isFinite(paper.initialCapital) && paper.initialCapital > 0, "paper portfolio has positive initial capital");
  check((paper.positions || []).length <= Number(config.runtime?.paper_portfolio_max_positions || 10), "paper portfolio respects the position limit");
  check((paper.positions || []).every((position) => !position.signalDate || position.openedAt > position.signalDate), "paper buys execute after the signal session");
  check((paper.trades || []).every((trade) => ["BUY", "SELL"].includes(trade.side)), "paper portfolio only contains buy and sell trades");
  check(paperLimits.maxPositionPct === Number(config.runtime?.paper_max_position_pct || 10), "paper portfolio exposes the configured company limit");
  check(paperLimits.maxPrimaryThemePct === Number(config.runtime?.paper_max_primary_theme_pct || 20), "paper portfolio exposes the configured theme limit");
  check(paperLimits.maxGapPct === Number(config.runtime?.paper_max_gap_pct || 3), "paper portfolio exposes the configured gap limit");
  check((paper.positions || []).every((position) => position.primaryTheme && Number.isFinite(position.stopPrice) && position.stopPrice < position.entryPrice), "every paper position has a theme and numeric invalidation level");
  check((paper.positions || []).every((position) => Number.isFinite(position.allocationPct) && position.allocationPct <= paperLimits.maxPositionPct + 0.05), "every paper position respects the company allocation limit");
  check((paper.themeExposure || []).every((theme) => theme.positions <= paperLimits.maxPositionsPerTheme && theme.exposurePct <= paperLimits.maxPrimaryThemePct + 0.05), "paper portfolio respects theme count and exposure limits");
  check((paper.trades || []).filter((trade) => trade.side === "BUY").every((trade) => Number.isFinite(trade.gapPct) && Math.abs(trade.gapPct) <= paperLimits.maxGapPct + 0.01), "paper buys respect the next-open gap limit");
  check((paper.pendingOrders || []).filter((order) => order.side === "BUY").every((order) => order.primaryTheme && Number.isFinite(order.signalPrice)), "pending paper buys include execution risk metadata");
  check((paper.activity || []).every((item) => ["FILLED_BUY", "FILLED_SELL", "CANCELLED", "RISK_BREACH", "REVIEW_DUE"].includes(item.type)), "paper activity contains supported risk events");
}

if (errors.length) {
  console.error(`Data contract failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Data contract OK: ${rows.length} rows, ${checks.length} checks, ${withPrice} prices`);

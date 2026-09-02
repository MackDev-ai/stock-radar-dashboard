const fs = require("node:fs");
const path = require("node:path");
const {
  buildAlertSections,
  buildBriefMessages,
  briefDeliveryDecision,
  eliteFlowLines
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
snapshot.verdictPerformance = snapshot.verdictPerformance || {};
snapshot.verdictPerformance.paperPortfolio = snapshot.verdictPerformance.paperPortfolio || {};
snapshot.verdictPerformance.paperPortfolio.activity = [{
  type: "FILLED_BUY",
  ticker: "TEST",
  price: 100,
  allocationPct: 8,
  stopPrice: 94
}];
snapshot.rows.forEach((row, index) => {
  const action = index === 0 ? "INWESTUJ" : index === 1 ? "ODRZUC" : "CZEKAJ";
  const label = action === "INWESTUJ" ? "WEJSCIE TERAZ" : action === "ODRZUC" ? "ODRZUC" : "CZEKAJ";
  row.concreteVerdict = {
    version: "v2",
    action,
    label,
    confidence: "medium",
    confidenceScore: 70,
    reason: action === "INWESTUJ" ? "potwierdzony trigger ceny i komplet danych" : action === "ODRZUC" ? "krytyczne ryzyko w filing" : "trigger ceny nie zostal jeszcze spelniony",
    nextStep: action === "INWESTUJ" ? "Sprawdz aktualna cene i spread przed decyzja." : action === "ODRZUC" ? "Wroc po usunieciu czerwonej flagi." : "Czekaj na stabilizacje ceny.",
    scores: { attractiveness: 82 - index, readiness: action === "INWESTUJ" ? 90 : action === "ODRZUC" ? 0 : 45, risk: action === "ODRZUC" ? 90 : 35, dataCompleteness: 100 },
    dataQuality: { status: "COMPLETE", completeness: 100, missing: [], warnings: [] },
    entrySetup: { status: action === "INWESTUJ" ? "MET" : "WAIT", trigger: "test trigger" },
    sourceLinks: []
  };
});

const sections = buildAlertSections(snapshot);
const eliteFixture = {
  loaded: true,
  lookbackDays: 120,
  summaries: [{
    ticker: snapshot.rows[0].ticker,
    filingCount: 1,
    purchaseValue: 125000,
    saleValue: 0
  }],
  form4: [{
    ticker: snapshot.rows[0].ticker,
    filingDate: "2026-08-30",
    owners: [{ name: "JANE TEST", isDirector: true }],
    transactions: [{ code: "P", date: "2026-08-29", value: 125000 }]
  }],
  politicalTrades: [{
    ticker: snapshot.rows[0].ticker,
    date: "2026-08-28",
    person: "John Public",
    role: "Senator",
    transaction: "Purchase",
    amountRange: "$15,001-$50,000"
  }]
};
const messages = buildBriefMessages(snapshot, sections, eliteFixture);
const output = messages.join("\n\n");

assert(messages.length > 0, "dry run did not produce Telegram messages");
assert(output.includes("STOCK RADAR - DECYZJE"), "clear decision digest header is missing");
assert(output.includes("Jakosc danych: PROBLEM"), "stale fixture did not trigger the data-quality warning");
assert(output.includes("WEJSCIE TERAZ:"), "verdict counts are missing from Telegram alert");
assert(output.includes("#decisionBriefView"), "decision brief dashboard link is missing from Telegram alert");
assert(output.includes("Oceny: atrakcyjnosc"), "named decision scores are missing");
assert(output.includes("1. ") && output.includes(" - WEJSCIE TERAZ"), "single user-facing verdict is missing");
assert(output.includes("Paper portfolio - wykonanie"), "paper execution section is missing from Telegram alert");
assert(output.includes("TEST WEJSCIE @ 100.00"), "paper execution details are missing from Telegram alert");
assert(output.includes("#riskView"), "risk dashboard link is missing from Telegram alert");
assert(output.includes("Insiderzy: TAK | KUPNO / LONG | 2026-08-29 | Jane Test (dyrektor) | ostatnia $125 tys., suma $125 tys."), "clear corporate insider transaction is missing");
assert(output.includes("Politycy USA: TAK | KUPNO / LONG | 2026-08-28 | John Public (Senator) | $15,001-$50,000"), "political trade details are missing");
assert(!output.includes("typ transakcji insiderow"), "duplicated generic insider label is still present");
assert(!output.includes("Pakiety decyzji") && !output.includes("Kolejka na dzis") && !output.includes("Top szanse"), "duplicated decision sections are still present");
assert(!output.includes("..."), "Telegram digest still contains truncated ellipses");

const sameDaySnapshot = {
  ...snapshot,
  generatedAt: "2026-08-30T12:00:00.000Z",
  todayDecisionChanges: {
    generatedAt: "2026-08-30T12:00:00.000Z",
    previousGeneratedAt: "2026-08-30T08:00:00.000Z",
    readyNow: [],
    verdictChanged: []
  },
  rows: (snapshot.rows || []).map((row) => ({ ...row, sec: { ...(row.sec || {}), newFilings: [] } })),
  verdictPerformance: { paperPortfolio: { activity: [] } }
};
assert(!briefDeliveryDecision(sameDaySnapshot).send, "unchanged same-day brief should be suppressed");
assert(briefDeliveryDecision({ ...sameDaySnapshot, generatedAt: "2026-08-31T08:00:00.000Z" }).send, "first brief of a new Warsaw day should be sent");
assert(briefDeliveryDecision({
  ...sameDaySnapshot,
  todayDecisionChanges: { ...sameDaySnapshot.todayDecisionChanges, verdictChanged: [{ ticker: "TEST" }] }
}).send, "changed verdict should bypass same-day suppression");
assert(briefDeliveryDecision(sameDaySnapshot, true).send, "forced brief should bypass suppression");

const sellLines = eliteFlowLines("SELL", {
  loaded: true,
  lookbackDays: 120,
  summaries: [{ ticker: "SELL", filingCount: 1, purchaseValue: 0, saleValue: 500000 }],
  form4: [{
    ticker: "SELL",
    filingDate: "2026-08-20",
    owners: [{ name: "JOHN SELL", officerTitle: "CFO" }],
    transactions: [{ code: "S", date: "2026-08-19", value: 500000 }]
  }],
  politicalTrades: []
}).join("\n");
assert(sellLines.includes("SPRZEDAZ / REDUKCJA (nie potwierdza shorta)"), "Form 4 sale is incorrectly presented as a short");
assert(sellLines.includes("Politycy USA: NIE W REJESTRZE"), "empty political registry status is unclear");
for (const [index, message] of messages.entries()) {
  assert(message.length <= telegramLimit, `Telegram message ${index + 1} exceeds ${telegramLimit} characters`);
}

console.log(`Telegram alert check OK: ${messages.length} message(s), limit ${telegramLimit}`);

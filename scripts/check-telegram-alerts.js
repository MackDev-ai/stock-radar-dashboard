const fs = require("node:fs");
const path = require("node:path");
const {
  buildAlertSections,
  buildBriefMessages,
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

const sections = buildAlertSections(snapshot);
const eliteFixture = {
  loaded: true,
  lookbackDays: 120,
  summaries: snapshot.rows.map((row) => ({
    ticker: row.ticker,
    filingCount: 1,
    purchaseValue: 125000,
    saleValue: 0
  })),
  form4: snapshot.rows.map((row) => ({
    ticker: row.ticker,
    filingDate: "2026-08-30",
    owners: [{ name: "JANE TEST", isDirector: true }],
    transactions: [{ code: "P", date: "2026-08-29", value: 125000 }]
  })),
  politicalTrades: snapshot.rows.map((row) => ({
    ticker: row.ticker,
    date: "2026-08-28",
    person: "John Public",
    role: "Senator",
    transaction: "Purchase",
    amountRange: "$15,001-$50,000"
  }))
};
const messages = buildBriefMessages(snapshot, sections, eliteFixture);
const output = messages.join("\n\n");

assert(messages.length > 0, "dry run did not produce Telegram messages");
assert(output.includes("Status pipeline'u: PROBLEM"), "stale fixture did not trigger PROBLEM guard");
assert(output.includes("PROBLEM: Dane:"), "freshness warning is missing from Telegram guard");
assert(output.includes("#statusView"), "status dashboard link is missing from Telegram guard");
assert(output.includes("Do decyzji"), "decision brief section is missing from Telegram alert");
assert(output.includes("#decisionBriefView"), "decision brief dashboard link is missing from Telegram alert");
assert(/pewnosc| p \d+/i.test(output), "decision brief confidence is missing from Telegram alert");
assert(/MODEL: (?:INWESTUJ|CZEKAJ|ODRZUC)/.test(output), "explicit model verdict is missing from Telegram alert");
assert(output.includes("Paper portfolio - wykonanie"), "paper execution section is missing from Telegram alert");
assert(output.includes("TEST WEJSCIE @ 100.00"), "paper execution details are missing from Telegram alert");
assert(output.includes("#riskView"), "risk dashboard link is missing from Telegram alert");
assert(output.includes("Insiderzy firmy (Form 4, 120 dni): TAK | KUPNO / LONG"), "clear corporate insider status is missing");
assert(output.includes("Ostatnia transakcja insidera: KUPNO / LONG | 2026-08-29 | Jane Test (dyrektor) | $125 tys."), "insider date, person and value are missing");
assert(output.includes("Politycy USA: TAK | KUPNO / LONG | 2026-08-28 | John Public (Senator) | $15,001-$50,000"), "political trade details are missing");
assert(!output.includes("typ transakcji insiderow"), "duplicated generic insider label is still present");

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

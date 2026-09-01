"use strict";

const assert = require("node:assert/strict");
const { buildVerdictLedger } = require("./lib/verdict-performance");

const dates = [
  "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
  "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15",
  "2026-01-16", "2026-01-19"
];

function series(prices, opens = []) {
  return prices.map((close, index) => ({
    date: dates[index],
    open: opens[index] ?? close,
    high: close,
    low: close,
    close
  }));
}

function row(ticker, action, price, date, score = 90, theme = "TEST", volatility = 30) {
  return {
    ticker,
    yahoo: ticker,
    name: ticker,
    themes: [theme],
    metrics: { price, date, volatility60dAnnualized: volatility },
    researchScore: { total: score },
    concreteVerdict: {
      action,
      confidence: "high",
      confidenceScore: 85,
      reason: "synthetic test"
    }
  };
}

const options = {
  benchmarkSymbol: "SPY",
  initialCapital: 100000,
  maxPositions: 2,
  maxPositionPct: 10,
  maxPrimaryThemePct: 20,
  maxPositionsPerTheme: 2,
  maxGapPct: 3,
  targetRiskPct: 0.75,
  minPositionPct: 2,
  reviewSessions: 20,
  stopMinPct: 5,
  stopMaxPct: 12
};
const initialRows = [
  row("AAA", "INWESTUJ", 100, dates[0], 95),
  row("BBB", "CZEKAJ", 50, dates[0], 70),
  row("CCC", "ODRZUC", 30, dates[0], 40)
];
const initialSeries = new Map([
  ["AAA", series([100])],
  ["BBB", series([50])],
  ["CCC", series([30])]
]);
let ledger = buildVerdictLedger(null, initialRows, initialSeries, series([200]), "2026-01-02T22:30:00.000Z", options);
assert.equal(ledger.events.length, 3, "first run creates one event per ticker");
assert.equal(ledger.summary.currentActions.INWESTUJ, 1);
assert.equal(ledger.paperPortfolio.positions.length, 0, "paper order cannot use the signal close");
assert.equal(ledger.paperPortfolio.pendingOrders.filter((order) => order.side === "BUY").length, 1);

const matureRows = [
  row("AAA", "INWESTUJ", 112, dates[6], 96),
  row("BBB", "CZEKAJ", 49, dates[6], 68),
  row("CCC", "ODRZUC", 25, dates[6], 35)
];
const matureSeries = new Map([
  ["AAA", series([100, 102, 104, 106, 108, 110, 112], [100, 101, 103, 105, 107, 109, 111])],
  ["BBB", series([50, 50, 49, 51, 50, 49, 49])],
  ["CCC", series([30, 29, 28, 27, 26, 25, 25])]
]);
ledger = buildVerdictLedger(ledger, matureRows, matureSeries, series([200, 202, 204, 206, 208, 210, 212]), "2026-01-12T22:30:00.000Z", options);
assert.equal(ledger.events.length, 3, "unchanged verdicts are not duplicated");
const investEvent = ledger.events.find((event) => event.ticker === "AAA");
assert.equal(investEvent.sessionsElapsed, 6);
assert.equal(investEvent.outcomes["5"].returnPct, 10);
assert.equal(investEvent.outcomes["5"].benchmarkReturnPct, 5);
assert.equal(investEvent.outcomes["5"].excessReturnPct, 5);
assert.equal(ledger.summary.byAction.find((item) => item.action === "INWESTUJ").byWindow["5"].count, 1);
assert.equal(ledger.paperPortfolio.positions.length, 1, "pending buy fills at the next session open");
assert.equal(ledger.paperPortfolio.positions[0].entryPrice, 101);

const changedRows = [
  row("AAA", "CZEKAJ", 109, dates[7], 74),
  row("BBB", "CZEKAJ", 48, dates[7], 66),
  row("CCC", "ODRZUC", 24, dates[7], 34)
];
const changedSeries = new Map([
  ["AAA", series([100, 102, 104, 106, 108, 110, 112, 109], [100, 101, 103, 105, 107, 109, 111, 110])],
  ["BBB", series([50, 50, 49, 51, 50, 49, 49, 48])],
  ["CCC", series([30, 29, 28, 27, 26, 25, 25, 24])]
]);
ledger = buildVerdictLedger(ledger, changedRows, changedSeries, series([200, 202, 204, 206, 208, 210, 212, 211]), "2026-01-13T22:30:00.000Z", options);
assert.equal(ledger.events.length, 4, "a verdict transition creates exactly one new event");
assert.equal(ledger.events.filter((event) => event.ticker === "AAA" && event.status === "OPEN").length, 1);
assert.equal(ledger.events.find((event) => event.ticker === "AAA" && event.action === "INWESTUJ").exitReason, "VERDICT_CHANGED");
assert.equal(ledger.paperPortfolio.pendingOrders.filter((order) => order.side === "SELL").length, 1);

const finalRows = changedRows.map((item) => item.ticker === "AAA" ? row("AAA", "CZEKAJ", 107, dates[8], 73) : item);
const finalSeries = new Map(changedSeries);
finalSeries.set("AAA", series([100, 102, 104, 106, 108, 110, 112, 109, 107], [100, 101, 103, 105, 107, 109, 111, 110, 108]));
ledger = buildVerdictLedger(ledger, finalRows, finalSeries, series([200, 202, 204, 206, 208, 210, 212, 211, 209]), "2026-01-14T22:30:00.000Z", options);
assert.equal(ledger.events.length, 4, "same verdict after transition stays deduplicated");
assert.equal(ledger.paperPortfolio.positions.length, 1, "CZEKAJ keeps half of the position");
assert.equal(ledger.paperPortfolio.trades.filter((trade) => trade.side === "SELL").length, 1);
assert.equal(ledger.paperPortfolio.trades.find((trade) => trade.side === "SELL").fraction, 0.5);
assert.equal(ledger.summary.calibration.status, "LOCKED");

const rejectRows = finalRows.map((item) => item.ticker === "AAA" ? row("AAA", "ODRZUC", 106, dates[9], 35) : item);
const rejectSeries = new Map(finalSeries);
rejectSeries.set("AAA", series([100, 102, 104, 106, 108, 110, 112, 109, 107, 106], [100, 101, 103, 105, 107, 109, 111, 110, 108, 106]));
ledger = buildVerdictLedger(ledger, rejectRows, rejectSeries, series([200, 202, 204, 206, 208, 210, 212, 211, 209, 208]), "2026-01-15T22:30:00.000Z", options);
assert.equal(ledger.paperPortfolio.pendingOrders.filter((order) => order.side === "SELL").length, 1, "ODRZUC queues a full exit");

const exitRows = rejectRows.map((item) => item.ticker === "AAA" ? row("AAA", "ODRZUC", 105, dates[10], 34) : item);
const exitSeries = new Map(rejectSeries);
exitSeries.set("AAA", series([100, 102, 104, 106, 108, 110, 112, 109, 107, 106, 105], [100, 101, 103, 105, 107, 109, 111, 110, 108, 106, 105]));
ledger = buildVerdictLedger(ledger, exitRows, exitSeries, series([200, 202, 204, 206, 208, 210, 212, 211, 209, 208, 207]), "2026-01-16T22:30:00.000Z", options);
assert.equal(ledger.paperPortfolio.positions.length, 0, "ODRZUC exits the remaining position at the next open");
assert.equal(ledger.paperPortfolio.trades.filter((trade) => trade.side === "SELL").length, 2);

const riskOptions = { ...options, maxPositions: 4 };
const riskRows = [
  row("LOW1", "INWESTUJ", 100, dates[0], 99, "GRID", 20),
  row("LOW2", "INWESTUJ", 100, dates[0], 98, "GRID", 20),
  row("EXCESS", "INWESTUJ", 100, dates[0], 97, "GRID", 20),
  row("GAP", "INWESTUJ", 100, dates[0], 96, "GAP", 30),
  row("VOL", "INWESTUJ", 100, dates[0], 95, "VOL", 120)
];
const riskInitialSeries = new Map(riskRows.map((item) => [item.ticker, series([100])]));
let riskLedger = buildVerdictLedger(null, riskRows, riskInitialSeries, series([200]), "2026-01-02T22:30:00.000Z", riskOptions);
assert.equal(riskLedger.paperPortfolio.pendingOrders.filter((order) => order.primaryTheme === "GRID").length, 2, "queue caps one primary theme at two positions");
assert(!riskLedger.paperPortfolio.pendingOrders.some((order) => order.ticker === "EXCESS"), "third company from one theme is not queued");

riskLedger.paperPortfolio.pendingOrders.push({
  id: `BUY-EXCESS-${dates[0]}`,
  side: "BUY",
  ticker: "EXCESS",
  name: "EXCESS",
  signalDate: dates[0],
  researchScore: 97,
  reason: "MIGRATION_TEST"
});
const riskMatureRows = riskRows.map((item) => row(item.ticker, "INWESTUJ", item.ticker === "GAP" ? 110 : 101, dates[1], item.researchScore.total, item.themes[0], item.metrics.volatility60dAnnualized));
const riskMatureSeries = new Map(riskRows.map((item) => [
  item.ticker,
  series([100, item.ticker === "GAP" ? 110 : 101], [100, item.ticker === "GAP" ? 110 : 101])
]));
riskLedger = buildVerdictLedger(riskLedger, riskMatureRows, riskMatureSeries, series([200, 201]), "2026-01-05T22:30:00.000Z", riskOptions);
assert(riskLedger.paperPortfolio.cancelledOrders.some((order) => order.ticker === "EXCESS" && order.reason === "THEME_POSITION_LIMIT"), "legacy concentrated order is cancelled before execution");
assert(riskLedger.paperPortfolio.cancelledOrders.some((order) => order.ticker === "GAP" && order.reason === "GAP_LIMIT"), "entry gap above 3% is cancelled");
assert.equal(riskLedger.paperPortfolio.positions.filter((position) => position.primaryTheme === "GRID").length, 2);
const lowPosition = riskLedger.paperPortfolio.positions.find((position) => position.ticker === "LOW1");
const volatilePosition = riskLedger.paperPortfolio.positions.find((position) => position.ticker === "VOL");
assert(lowPosition && volatilePosition, "low and high volatility positions are both opened");
assert(volatilePosition.allocationPct < lowPosition.allocationPct, "high volatility receives a smaller allocation");
assert(lowPosition.stopPrice < lowPosition.entryPrice, "entry has a numeric invalidation level");
assert.equal(riskLedger.paperPortfolio.riskStatus, "OK");

console.log(`Verdict performance check OK: ${ledger.events.length} events, ${ledger.paperPortfolio.trades.length} paper trades, risk engine verified`);

"use strict";

const assert = require("node:assert/strict");
const { buildVerdictLedger } = require("./lib/verdict-performance");

const dates = [
  "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
  "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14"
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

function row(ticker, action, price, date, score = 90) {
  return {
    ticker,
    yahoo: ticker,
    name: ticker,
    themes: ["TEST"],
    metrics: { price, date },
    researchScore: { total: score },
    concreteVerdict: {
      action,
      confidence: "high",
      confidenceScore: 85,
      reason: "synthetic test"
    }
  };
}

const options = { benchmarkSymbol: "SPY", initialCapital: 100000, maxPositions: 2 };
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
assert.equal(ledger.paperPortfolio.positions.length, 0, "sell executes at the next session open");
assert.equal(ledger.paperPortfolio.trades.filter((trade) => trade.side === "SELL").length, 1);
assert.equal(ledger.summary.calibration.status, "LOCKED");

console.log(`Verdict performance check OK: ${ledger.events.length} events, ${ledger.paperPortfolio.trades.length} paper trades`);

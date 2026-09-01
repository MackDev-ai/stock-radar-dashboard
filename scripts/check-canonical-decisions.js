const assert = require("node:assert/strict");
const {
  buildCanonicalDataQuality,
  buildCanonicalEntrySetup,
  buildConcreteVerdict,
  firstNumber
} = require("./update-monitoring");

assert.equal(firstNumber(null, "", undefined), null, "empty API values must not become zero");
assert.equal(firstNumber(null, "1.5"), 1.5, "first valid numeric API value should be used");

function fixture(overrides = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const row = {
    ticker: "TEST",
    name: "Test Company",
    metrics: {
      date: today,
      price: 100,
      high52w: 110,
      drawdown52w: -9.1,
      return5d: 2,
      return20d: 5,
      return60d: 8,
      volatility60dAnnualized: 30,
      volume: 200000
    },
    fundamentals: {
      averageVolume: 100000,
      revenueGrowthYoY: 0.1,
      operatingMarginTTM: 0.2,
      freeCashFlowTTM: 1000000,
      netDebtToEbitdaTTM: 1,
      peTTM: 20
    },
    researchScore: { total: 90, positives: ["rentowny biznes"] },
    investmentVerdict: { blockers: [], reasons: ["dodatni cash flow"] },
    decisionEngine: { category: "ROZWAZ_WEJSCIE", blockers: [] },
    decisionBrief: { briefVerdict: "KANDYDAT", confidenceScore: 80, briefReason: "mocny kandydat" },
    signal: { action: "MONITOR", alerts: [] },
    sec: { filings: [] },
    catalystAssessment: null,
    postEarnings: null
  };
  for (const [key, value] of Object.entries(overrides)) {
    row[key] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...(row[key] || {}), ...value }
      : value;
  }
  return row;
}

const ready = fixture();
assert.equal(buildCanonicalDataQuality(ready).status, "COMPLETE");
assert.equal(buildCanonicalEntrySetup(ready).status, "MET");
const readyVerdict = buildConcreteVerdict(ready);
assert.equal(readyVerdict.action, "INWESTUJ");
assert.equal(readyVerdict.label, "WEJSCIE TERAZ");
assert.equal(readyVerdict.entrySetup.status, "MET");

const waiting = fixture({ metrics: { return5d: -2, return20d: -5, volume: 80000 } });
const waitingVerdict = buildConcreteVerdict(waiting);
assert.equal(waitingVerdict.action, "CZEKAJ");
assert.equal(waitingVerdict.label, "CZEKAJ");
assert.notEqual(waitingVerdict.entrySetup.status, "MET");

const missingData = fixture({ fundamentals: { freeCashFlowTTM: null } });
const missingVerdict = buildConcreteVerdict(missingData);
assert.equal(missingVerdict.action, "CZEKAJ");
assert.equal(missingVerdict.label, "BRAK WYSTARCZAJACYCH DANYCH");
assert.equal(missingVerdict.dataQuality.status, "INSUFFICIENT");
assert(missingVerdict.confidenceScore <= 49);

const rejected = fixture({
  investmentVerdict: { blockers: ["going concern"], reasons: [] },
  decisionEngine: { category: "ODRZUC_TERAZ", blockers: ["going concern"] },
  decisionBrief: { briefVerdict: "ODRZUC", confidenceScore: 90, briefReason: "going concern" }
});
const rejectedVerdict = buildConcreteVerdict(rejected);
assert.equal(rejectedVerdict.action, "ODRZUC");
assert.equal(rejectedVerdict.label, "ODRZUC");

const limited = fixture({
  fundamentals: {
    freeCashFlowTTM: null,
    cashFlowFallback: { freeCashFlow: 1000000, basis: "FY" }
  }
});
const limitedVerdict = buildConcreteVerdict(limited);
assert.equal(limitedVerdict.dataQuality.status, "LIMITED");
assert(limitedVerdict.confidenceScore <= 74);

console.log("Canonical decision check OK: trigger, wait, missing data and reject gates verified");

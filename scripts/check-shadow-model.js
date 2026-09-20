"use strict";

const assert = require("node:assert/strict");
const { applyShadowModel, buildThemeRegimes } = require("./lib/shadow-model");

function row(ticker, action, themes, return5d, return20d, return60d, overrides = {}) {
  return {
    ticker,
    name: ticker,
    themes,
    metrics: { return5d, return20d, return60d, volatility60dAnnualized: 35, price: 100 },
    researchScore: { total: 75 },
    signal: { action: "WATCH_PULLBACK" },
    decisionEngine: { blockers: [], flags: { redFlags: [] } },
    investmentVerdict: { blockers: [] },
    concreteVerdict: {
      action,
      conditions: [],
      scores: { risk: 30, attractiveness: 75, dataCompleteness: 100 },
      dataQuality: { status: "COMPLETE" },
      ...overrides
    }
  };
}

const hotRows = Array.from({ length: 6 }, (_, index) => row(`HOT${index}`, index === 0 ? "CZEKAJ" : "ODRZUC", ["HOT-THEME"], 2 + index, 8 + index, 15 + index));
const weakRows = Array.from({ length: 6 }, (_, index) => row(`WEAK${index}`, index === 0 ? "INWESTUJ" : "CZEKAJ", ["WEAK-THEME"], -2 - index, -5 - index, -8 - index));
const blocked = row("BLOCK", "CZEKAJ", ["HOT-THEME"], 4, 12, 20, { conditions: ["going concern"] });
const rows = [...hotRows, ...weakRows, blocked];
const regimes = buildThemeRegimes(rows);
assert.equal(regimes.find((item) => item.theme === "HOT-THEME").regime, "HOT");
assert.equal(regimes.find((item) => item.theme === "WEAK-THEME").regime, "WEAK");

const result = applyShadowModel(rows);
assert.equal(rows.find((item) => item.ticker === "HOT0").shadowVerdict.action, "INWESTUJ", "hot breadth upgrades a confirmed wait signal");
assert.equal(rows.find((item) => item.ticker === "WEAK0").shadowVerdict.action, "CZEKAJ", "weak breadth pauses a canonical entry");
assert.equal(rows.find((item) => item.ticker === "BLOCK").shadowVerdict.action, "CZEKAJ", "hard risk cannot be upgraded");
assert(result.changes.some((item) => item.ticker === "HOT0" && item.direction === "UPGRADE"));
assert(result.changes.some((item) => item.ticker === "WEAK0" && item.direction === "DOWNGRADE"));

const missingRows = Array.from({ length: 6 }, (_, index) => row(`MISS${index}`, "CZEKAJ", ["MISSING-THEME"], null, null, null));
const missingRegime = buildThemeRegimes(missingRows).find((item) => item.theme === "MISSING-THEME");
assert.equal(missingRegime.priced20d, 0, "missing returns are not converted to zero");
assert.equal(missingRegime.regime, "NO_DATA", "a theme without priced observations cannot get a directional regime");

console.log(`Shadow model check OK: ${result.themeRegimes.length} regimes, ${result.changes.length} changed actions`);

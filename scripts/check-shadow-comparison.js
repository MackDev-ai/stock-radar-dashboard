"use strict";

const assert = require("node:assert/strict");
const { buildShadowComparison, buildShadowComparisonMarkdown } = require("./lib/shadow-comparison");

function event(index, positive = true) {
  const return5 = positive ? 8 : -3;
  const return20 = positive ? 12 : -5;
  return {
    id: `event-${index}`,
    ticker: `T${index % 15}`,
    name: `Test ${index}`,
    themes: [`THEME-${index % 3}`],
    action: "INWESTUJ",
    sourceAction: "CZEKAJ",
    direction: "UPGRADE",
    openedAt: `2026-01-${String((index % 20) + 1).padStart(2, "0")}T22:00:00.000Z`,
    entryDate: "2026-01-02",
    status: "CLOSED",
    outcomes: {
      "5": { returnPct: return5, benchmarkReturnPct: 2, excessReturnPct: return5 - 2 },
      "20": { returnPct: return20, benchmarkReturnPct: 3, excessReturnPct: return20 - 3 },
      "60": { returnPct: positive ? 18 : -8, benchmarkReturnPct: 6, excessReturnPct: positive ? 12 : -14 }
    }
  };
}

function ledger(events, returnPct = 0) {
  return {
    events,
    summary: {
      paperPortfolio: {
        returnPct,
        excessReturnPct: returnPct - 1,
        openPositions: 2
      }
    }
  };
}

const collecting = buildShadowComparison(ledger([], 1), ledger(Array.from({ length: 5 }, (_, index) => event(index)), 1.5), "2026-04-01T22:00:00.000Z");
assert.equal(collecting.gate.status, "COLLECTING", "small samples stay in collection mode");
assert.equal(collecting.notification.shouldNotify, false, "collection mode does not notify Telegram");

const strongEvents = Array.from({ length: 30 }, (_, index) => event(index, true));
const strong = buildShadowComparison(ledger([], 2), ledger(strongEvents, 5), "2026-04-30T22:00:00.000Z");
assert.equal(strong.gate.status, "REVIEW_READY", "stable advantage reaches manual review status");
assert.equal(strong.byWindow["5"].hitRateDelta, 100);
assert.equal(strong.byWindow["20"].netImproved, 30);
assert.equal(strong.gate.eligibleForReview, true);
assert.equal(strong.notification.shouldNotify, true, "first mature status creates one Telegram notification");
assert.equal(strong.portfolio.returnDeltaPct, 3);
assert.equal(strong.themes.length, 3);

const repeated = buildShadowComparison(ledger([], 2), ledger(strongEvents, 5), "2026-05-01T22:00:00.000Z", {}, strong);
assert.equal(repeated.notification.shouldNotify, false, "an already notified status is not repeated");

const weakEvents = Array.from({ length: 30 }, (_, index) => event(index, false));
const weak = buildShadowComparison(ledger([], 2), ledger(weakEvents, -2), "2026-04-30T22:00:00.000Z");
assert.equal(weak.gate.status, "HOLD", "a mature sample without advantage is not promoted");
assert(weak.byWindow["20"].hitRateDelta < 0);
assert.equal(weak.notification.shouldNotify, true, "first HOLD result is reported after the sample matures");

const markdown = buildShadowComparisonMarkdown(strong);
assert(markdown.includes("Status bramki: **REVIEW_READY**"));
assert(markdown.includes("| 20 sesji | 30 |"));

console.log("Shadow comparison check OK: COLLECTING, HOLD and REVIEW_READY gates verified");

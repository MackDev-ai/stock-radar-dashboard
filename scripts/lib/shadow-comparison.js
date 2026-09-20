"use strict";

const ACTIONS = ["INWESTUJ", "CZEKAJ", "ODRZUC"];
const WINDOWS = [5, 20, 60];

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length) : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function hitForAction(action, outcome) {
  const assetReturn = finite(outcome?.returnPct);
  const excessReturn = finite(outcome?.excessReturnPct);
  if (!Number.isFinite(assetReturn)) return null;
  if (action === "INWESTUJ") return assetReturn > 0 && (!Number.isFinite(excessReturn) || excessReturn > 0);
  if (action === "ODRZUC") return assetReturn <= 0;
  if (action === "CZEKAJ") return assetReturn < 5;
  return null;
}

function financialAdvantage(event, outcome) {
  const excess = finite(outcome?.excessReturnPct);
  if (!Number.isFinite(excess)) return null;
  if (event.action === "INWESTUJ" && event.sourceAction !== "INWESTUJ") return excess;
  if (event.sourceAction === "INWESTUJ" && event.action !== "INWESTUJ") return -excess;
  return null;
}

function disagreementEvents(shadowLedger) {
  return (shadowLedger?.events || []).filter((event) => ACTIONS.includes(event.action)
    && ACTIONS.includes(event.sourceAction)
    && event.action !== event.sourceAction);
}

function windowStats(events, window) {
  const matured = events.filter((event) => Number.isFinite(finite(event.outcomes?.[String(window)]?.returnPct)));
  const comparisons = matured.map((event) => {
    const outcome = event.outcomes[String(window)];
    const shadowHit = hitForAction(event.action, outcome);
    const canonicalHit = hitForAction(event.sourceAction, outcome);
    return {
      event,
      outcome,
      shadowHit,
      canonicalHit,
      advantage: financialAdvantage(event, outcome)
    };
  });
  const comparable = comparisons.filter((item) => item.shadowHit !== null && item.canonicalHit !== null);
  const improved = comparable.filter((item) => item.shadowHit && !item.canonicalHit).length;
  const worsened = comparable.filter((item) => !item.shadowHit && item.canonicalHit).length;
  const shadowHits = comparable.filter((item) => item.shadowHit).length;
  const canonicalHits = comparable.filter((item) => item.canonicalHit).length;
  const shadowHitRate = comparable.length ? round(shadowHits / comparable.length * 100) : null;
  const canonicalHitRate = comparable.length ? round(canonicalHits / comparable.length * 100) : null;
  const advantages = comparisons.map((item) => item.advantage).filter(Number.isFinite);
  const excessReturns = comparisons.map((item) => finite(item.outcome.excessReturnPct)).filter(Number.isFinite);
  return {
    sessions: window,
    count: matured.length,
    comparableCount: comparable.length,
    distinctTickers: new Set(matured.map((event) => event.ticker)).size,
    shadowHitRate,
    canonicalHitRate,
    hitRateDelta: Number.isFinite(shadowHitRate) && Number.isFinite(canonicalHitRate)
      ? round(shadowHitRate - canonicalHitRate)
      : null,
    improved,
    worsened,
    neutral: comparable.length - improved - worsened,
    netImproved: improved - worsened,
    avgFinancialAdvantage: average(advantages),
    medianFinancialAdvantage: median(advantages),
    advantageCount: advantages.length,
    avgUnderlyingExcessReturn: average(excessReturns)
  };
}

function normalizeOptions(options = {}) {
  return {
    min5dEvents: finite(options.shadow_validation_min_5d_events) ?? 30,
    min20dEvents: finite(options.shadow_validation_min_20d_events) ?? 30,
    minDistinctTickers: finite(options.shadow_validation_min_distinct_tickers) ?? 15,
    minDistinctThemes: finite(options.shadow_validation_min_distinct_themes) ?? 3,
    minHitRateDelta: finite(options.shadow_validation_min_hit_rate_delta_pp) ?? 5,
    minNetImproved: finite(options.shadow_validation_min_net_improved) ?? 3
  };
}

function requirement(key, label, actual, required, passed, unit = "") {
  return { key, label, actual, required, unit, passed: Boolean(passed) };
}

function themeComparisons(events) {
  const buckets = new Map();
  for (const event of events) {
    for (const theme of event.themes?.length ? event.themes : ["OTHER"]) {
      if (!buckets.has(theme)) buckets.set(theme, []);
      buckets.get(theme).push(event);
    }
  }
  return [...buckets.entries()].map(([theme, themeEvents]) => ({
    theme,
    events: themeEvents.length,
    byWindow: Object.fromEntries(WINDOWS.map((window) => [String(window), windowStats(themeEvents, window)]))
  })).sort((a, b) => (b.byWindow["20"].hitRateDelta ?? -Infinity) - (a.byWindow["20"].hitRateDelta ?? -Infinity)
    || (b.byWindow["5"].hitRateDelta ?? -Infinity) - (a.byWindow["5"].hitRateDelta ?? -Infinity)
    || a.theme.localeCompare(b.theme));
}

function transitionComparisons(events) {
  const buckets = new Map();
  for (const event of events) {
    const key = `${event.sourceAction}->${event.action}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(event);
  }
  return [...buckets.entries()].map(([transition, transitionEvents]) => ({
    transition,
    events: transitionEvents.length,
    byWindow: Object.fromEntries(WINDOWS.map((window) => [String(window), windowStats(transitionEvents, window)]))
  })).sort((a, b) => b.events - a.events || a.transition.localeCompare(b.transition));
}

function portfolioComparison(canonicalLedger, shadowLedger) {
  const canonical = canonicalLedger?.summary?.paperPortfolio || {};
  const shadow = shadowLedger?.summary?.paperPortfolio || {};
  const canonicalReturn = finite(canonical.returnPct);
  const shadowReturn = finite(shadow.returnPct);
  return {
    canonicalReturnPct: canonicalReturn,
    shadowReturnPct: shadowReturn,
    returnDeltaPct: Number.isFinite(canonicalReturn) && Number.isFinite(shadowReturn)
      ? round(shadowReturn - canonicalReturn)
      : null,
    canonicalExcessReturnPct: finite(canonical.excessReturnPct),
    shadowExcessReturnPct: finite(shadow.excessReturnPct),
    canonicalOpenPositions: finite(canonical.openPositions) ?? 0,
    shadowOpenPositions: finite(shadow.openPositions) ?? 0
  };
}

function buildShadowComparison(canonicalLedger, shadowLedger, generatedAt, rawOptions = {}, previousReport = null) {
  const options = normalizeOptions(rawOptions);
  const events = disagreementEvents(shadowLedger);
  const byWindow = Object.fromEntries(WINDOWS.map((window) => [String(window), windowStats(events, window)]));
  const matured20 = events.filter((event) => Number.isFinite(finite(event.outcomes?.["20"]?.returnPct)));
  const distinctThemes20 = new Set(matured20.flatMap((event) => event.themes?.length ? event.themes : ["OTHER"])).size;
  const sampleRequirements = [
    requirement("matured5", "Dojrzale rozbieznosci 5 sesji", byWindow["5"].count, options.min5dEvents, byWindow["5"].count >= options.min5dEvents),
    requirement("matured20", "Dojrzale rozbieznosci 20 sesji", byWindow["20"].count, options.min20dEvents, byWindow["20"].count >= options.min20dEvents),
    requirement("tickers20", "Rozne spolki po 20 sesjach", byWindow["20"].distinctTickers, options.minDistinctTickers, byWindow["20"].distinctTickers >= options.minDistinctTickers),
    requirement("themes20", "Rozne tematy po 20 sesjach", distinctThemes20, options.minDistinctThemes, distinctThemes20 >= options.minDistinctThemes)
  ];
  const performanceRequirements = [
    requirement("delta5", "Przewaga trafnosci po 5 sesjach", byWindow["5"].hitRateDelta, options.minHitRateDelta, finite(byWindow["5"].hitRateDelta) >= options.minHitRateDelta, "pp"),
    requirement("delta20", "Przewaga trafnosci po 20 sesjach", byWindow["20"].hitRateDelta, options.minHitRateDelta, finite(byWindow["20"].hitRateDelta) >= options.minHitRateDelta, "pp"),
    requirement("net5", "Bilans poprawionych decyzji po 5 sesjach", byWindow["5"].netImproved, options.minNetImproved, byWindow["5"].netImproved >= options.minNetImproved),
    requirement("net20", "Bilans poprawionych decyzji po 20 sesjach", byWindow["20"].netImproved, options.minNetImproved, byWindow["20"].netImproved >= options.minNetImproved)
  ];
  const sampleReady = sampleRequirements.every((item) => item.passed);
  const performanceReady = performanceRequirements.every((item) => item.passed);
  const status = !sampleReady ? "COLLECTING" : performanceReady ? "REVIEW_READY" : "HOLD";
  const previousStatuses = Array.isArray(previousReport?.notification?.notifiedStatuses)
    ? previousReport.notification.notifiedStatuses.filter((item) => ["HOLD", "REVIEW_READY"].includes(item))
    : [];
  const shouldNotify = status !== "COLLECTING" && !previousStatuses.includes(status);
  const notifiedStatuses = shouldNotify ? [...new Set([...previousStatuses, status])] : previousStatuses;
  const recommendation = status === "REVIEW_READY"
    ? "RECZNY PRZEGLAD: shadow spelnia bramke przewagi, ale nie zmienia automatycznie modelu glownego."
    : status === "HOLD"
      ? "NIE PROMUJ: probka jest wystarczajaca, lecz przewaga shadow nie jest stabilna."
      : "ZBIERAJ DANE: za malo dojrzalych rozbieznosci do oceny shadow.";

  return {
    version: 1,
    generatedAt,
    policy: "Tylko rozbieznosci shadow vs model glowny, mierzone od wspolnej daty. Brak automatycznej promocji regul.",
    disagreementCount: events.length,
    openDisagreementCount: events.filter((event) => event.status === "OPEN").length,
    distinctTickers: new Set(events.map((event) => event.ticker)).size,
    byWindow,
    transitions: transitionComparisons(events),
    themes: themeComparisons(events),
    portfolio: portfolioComparison(canonicalLedger, shadowLedger),
    gate: {
      status,
      sampleReady,
      performanceReady,
      eligibleForReview: status === "REVIEW_READY",
      recommendation,
      requirements: [...sampleRequirements, ...performanceRequirements]
    },
    notification: {
      shouldNotify,
      reason: shouldNotify ? `Shadow osiagnal status ${status} po wymaganej probie.` : "Brak nowego dojrzalego statusu do wyslania.",
      notifiedStatuses
    },
    recentDisagreements: events.slice().sort((a, b) => String(b.openedAt || "").localeCompare(String(a.openedAt || ""))).slice(0, 50).map((event) => ({
      ticker: event.ticker,
      name: event.name || "",
      themes: event.themes || [],
      sourceAction: event.sourceAction,
      shadowAction: event.action,
      direction: event.direction || null,
      entryDate: event.entryDate,
      status: event.status,
      outcomes: event.outcomes || {}
    }))
  };
}

function fmt(value, suffix = "") {
  return Number.isFinite(finite(value)) ? `${round(finite(value))}${suffix}` : "-";
}

function buildShadowComparisonMarkdown(report) {
  const lines = [
    "# Shadow Model Comparison",
    "",
    `Aktualizacja: ${report.generatedAt}`,
    `Status bramki: **${report.gate.status}**`,
    "",
    report.gate.recommendation,
    "",
    "## Model glowny vs shadow",
    "",
    "| Horyzont | Rozbieznosci | Shadow hit rate | Glowny hit rate | Delta | Poprawione | Pogorszone |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...WINDOWS.map((window) => {
      const item = report.byWindow[String(window)];
      return `| ${window} sesji | ${item.count} | ${fmt(item.shadowHitRate, "%")} | ${fmt(item.canonicalHitRate, "%")} | ${fmt(item.hitRateDelta, " pp")} | ${item.improved} | ${item.worsened} |`;
    }),
    "",
    "## Bramka walidacyjna",
    "",
    "| Warunek | Wynik | Minimum | Status |",
    "|---|---:|---:|---|",
    ...report.gate.requirements.map((item) => `| ${item.label} | ${fmt(item.actual, item.unit ? ` ${item.unit}` : "")} | ${fmt(item.required, item.unit ? ` ${item.unit}` : "")} | ${item.passed ? "PASS" : "WAIT"} |`),
    "",
    "## Portfele papierowe",
    "",
    `- Model glowny: ${fmt(report.portfolio.canonicalReturnPct, "%")}`,
    `- Shadow: ${fmt(report.portfolio.shadowReturnPct, "%")}`,
    `- Roznica shadow minus glowny: ${fmt(report.portfolio.returnDeltaPct, " pp")}`,
    "",
    "## Najlepsze tematy porownawcze",
    "",
    "| Temat | Zdarzenia | Delta hit rate 5 sesji | Delta hit rate 20 sesji |",
    "|---|---:|---:|---:|",
    ...report.themes.slice(0, 20).map((item) => `| ${item.theme} | ${item.events} | ${fmt(item.byWindow["5"].hitRateDelta, " pp")} | ${fmt(item.byWindow["20"].hitRateDelta, " pp")} |`),
    "",
    "Raport ma charakter eksperymentalny. Nie zmienia regul glownego modelu ani decyzji inwestycyjnych."
  ];
  return `${lines.join("\n")}\n`;
}

module.exports = {
  buildShadowComparison,
  buildShadowComparisonMarkdown,
  disagreementEvents,
  hitForAction,
  normalizeOptions,
  windowStats
};

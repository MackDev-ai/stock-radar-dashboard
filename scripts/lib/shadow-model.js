"use strict";

const ACTIONS = ["INWESTUJ", "CZEKAJ", "ODRZUC"];
const REGIME_RANK = { HOT: 4, POSITIVE: 3, NEUTRAL: 2, WEAK: 1, NO_DATA: 0 };

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

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function themeRegime(stats, options) {
  if (stats.members < options.minMembers || stats.priced20d < options.minMembers) return "NO_DATA";
  if (stats.median20d >= options.hotMedian20d
    && stats.priced60d >= options.minMembers
    && stats.median60d >= options.hotMedian60d
    && stats.breadth20d >= options.hotBreadth20d) return "HOT";
  if (stats.median20d >= options.positiveMedian20d && stats.breadth20d >= options.positiveBreadth20d) return "POSITIVE";
  if (stats.median20d <= options.weakMedian20d && stats.breadth20d <= options.weakBreadth20d) return "WEAK";
  return "NEUTRAL";
}

function normalizeOptions(options = {}) {
  return {
    minMembers: finite(options.shadow_theme_min_members) || 5,
    hotMedian20d: finite(options.shadow_hot_median_20d) ?? 4,
    hotMedian60d: finite(options.shadow_hot_median_60d) ?? 5,
    hotBreadth20d: finite(options.shadow_hot_breadth_20d) ?? 0.6,
    positiveMedian20d: finite(options.shadow_positive_median_20d) ?? 1,
    positiveBreadth20d: finite(options.shadow_positive_breadth_20d) ?? 0.5,
    weakMedian20d: finite(options.shadow_weak_median_20d) ?? -3,
    weakBreadth20d: finite(options.shadow_weak_breadth_20d) ?? 0.4,
    maxUpgradeRisk: finite(options.shadow_max_upgrade_risk) ?? 45,
    minUpgradeCompleteness: finite(options.shadow_min_upgrade_completeness) ?? 80,
    minUpgradeAttractiveness: finite(options.shadow_min_upgrade_attractiveness) ?? 55,
    maxUpgradeVolatility: finite(options.shadow_max_upgrade_volatility) ?? 70
  };
}

function buildThemeRegimes(rows, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const buckets = new Map();
  for (const row of rows || []) {
    const metrics = row.metrics || {};
    for (const theme of row.themes || []) {
      if (!buckets.has(theme)) buckets.set(theme, []);
      buckets.get(theme).push({
        ticker: row.ticker,
        return5d: finite(metrics.return5d),
        return20d: finite(metrics.return20d),
        return60d: finite(metrics.return60d),
        volatility: finite(metrics.volatility60dAnnualized)
      });
    }
  }

  return [...buckets.entries()].map(([theme, members]) => {
    const returns5d = members.map((item) => item.return5d).filter(Number.isFinite);
    const returns20d = members.map((item) => item.return20d).filter(Number.isFinite);
    const returns60d = members.map((item) => item.return60d).filter(Number.isFinite);
    const volatility = members.map((item) => item.volatility).filter(Number.isFinite);
    const stats = {
      theme,
      members: members.length,
      priced5d: returns5d.length,
      priced20d: returns20d.length,
      priced60d: returns60d.length,
      median5d: round(median(returns5d)),
      median20d: round(median(returns20d)),
      median60d: round(median(returns60d)),
      average20d: round(average(returns20d)),
      breadth20d: returns20d.length ? round(returns20d.filter((value) => value > 0).length / returns20d.length, 4) : null,
      breadth60d: returns60d.length ? round(returns60d.filter((value) => value > 0).length / returns60d.length, 4) : null,
      medianVolatility: round(median(volatility))
    };
    return { ...stats, regime: themeRegime(stats, options) };
  }).sort((a, b) => (REGIME_RANK[b.regime] || 0) - (REGIME_RANK[a.regime] || 0)
    || (b.median20d ?? -Infinity) - (a.median20d ?? -Infinity)
    || a.theme.localeCompare(b.theme));
}

function strongestRegime(row, regimesByTheme) {
  const available = (row.themes || [])
    .map((theme) => regimesByTheme.get(theme))
    .filter(Boolean)
    .sort((a, b) => (REGIME_RANK[b.regime] || 0) - (REGIME_RANK[a.regime] || 0)
      || (b.median20d ?? -Infinity) - (a.median20d ?? -Infinity));
  return available[0] || { theme: row.themes?.[0] || "OTHER", regime: "NO_DATA", members: 0 };
}

function hardRisk(row) {
  const text = [
    ...(row.concreteVerdict?.conditions || []),
    ...(row.decisionEngine?.blockers || []),
    ...(row.investmentVerdict?.blockers || [])
  ].join(" ");
  return /going concern|bankructwo|default|delisting|material weakness|krytyczne ryzyko|brak danych|rozwodnienie/i.test(text)
    || row.concreteVerdict?.dataQuality?.status === "INSUFFICIENT"
    || ["REVIEW_RISK", "NO_DATA"].includes(row.signal?.action)
    || (row.decisionEngine?.flags?.redFlags || []).length > 0;
}

function buildShadowVerdict(row, regimesByTheme, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const canonical = row.concreteVerdict || {};
  const sourceAction = ACTIONS.includes(canonical.action) ? canonical.action : "CZEKAJ";
  const regime = strongestRegime(row, regimesByTheme);
  const metrics = row.metrics || {};
  const scores = canonical.scores || {};
  const riskBlocked = hardRisk(row);
  const momentumConfirmed = finite(metrics.return5d) >= 1
    && finite(metrics.return20d) >= 2
    && finite(metrics.return20d) <= 20;
  const upgradeEligible = !riskBlocked
    && regime.regime === "HOT"
    && momentumConfirmed
    && (finite(scores.risk) ?? 100) <= options.maxUpgradeRisk
    && (finite(scores.dataCompleteness) ?? 0) >= options.minUpgradeCompleteness
    && (finite(scores.attractiveness) ?? 0) >= options.minUpgradeAttractiveness
    && (!Number.isFinite(finite(metrics.volatility60dAnnualized)) || finite(metrics.volatility60dAnnualized) <= options.maxUpgradeVolatility);
  const weakRegime = regime.regime === "WEAK"
    && finite(metrics.return5d) < 0
    && finite(metrics.return20d) < 0;
  let action = sourceAction;
  let reason = `brak zmiany: rezim ${regime.regime} dla ${regime.theme}`;

  if (sourceAction === "CZEKAJ" && upgradeEligible) {
    action = "INWESTUJ";
    reason = `${regime.theme}: HOT, mediana 20d ${round(regime.median20d)}%, szerokosc ${(regime.breadth20d * 100).toFixed(0)}%; ticker potwierdza momentum`;
  } else if (sourceAction === "ODRZUC" && upgradeEligible) {
    action = "CZEKAJ";
    reason = `${regime.theme}: HOT i momentum dodatnie; shadow usuwa odrzucenie, ale nie otwiera pozycji`;
  } else if (sourceAction === "INWESTUJ" && weakRegime) {
    action = "CZEKAJ";
    reason = `${regime.theme}: WEAK oraz ujemne momentum 5d i 20d; shadow wstrzymuje wejscie`;
  } else if (riskBlocked) {
    reason = "brak zmiany: aktywna twarda blokada ryzyka lub brak danych";
  } else if (regime.regime === "HOT" && !momentumConfirmed) {
    reason = `${regime.theme}: HOT, ale ticker nie potwierdza momentum 5d/20d`;
  }

  const direction = ACTIONS.indexOf(action) < ACTIONS.indexOf(sourceAction)
    ? "UPGRADE"
    : ACTIONS.indexOf(action) > ACTIONS.indexOf(sourceAction) ? "DOWNGRADE" : "UNCHANGED";
  return {
    version: 1,
    experimental: true,
    action,
    sourceAction,
    changed: action !== sourceAction,
    direction,
    label: `SHADOW ${action}`,
    confidence: regime.members >= 10 ? "medium" : "low",
    confidenceScore: Math.min(74, 35 + Math.min(20, regime.members) + (regime.regime === "HOT" ? 15 : 0)),
    reason,
    themeRegime: regime,
    safeguards: {
      riskBlocked,
      momentumConfirmed,
      maxUpgradeRisk: options.maxUpgradeRisk,
      minUpgradeCompleteness: options.minUpgradeCompleteness,
      minUpgradeAttractiveness: options.minUpgradeAttractiveness,
      maxUpgradeVolatility: options.maxUpgradeVolatility
    },
    scores: canonical.scores || {},
    dataQuality: canonical.dataQuality || null,
    entrySetup: canonical.entrySetup || null
  };
}

function applyShadowModel(rows, rawOptions = {}) {
  const themeRegimes = buildThemeRegimes(rows, rawOptions);
  const regimesByTheme = new Map(themeRegimes.map((item) => [item.theme, item]));
  const changes = [];
  for (const row of rows || []) {
    row.shadowVerdict = buildShadowVerdict(row, regimesByTheme, rawOptions);
    if (row.shadowVerdict.changed) {
      changes.push({
        ticker: row.ticker,
        name: row.name || "",
        themes: row.themes || [],
        researchScore: row.researchScore?.total ?? null,
        price: row.metrics?.price ?? null,
        return5d: row.metrics?.return5d ?? null,
        return20d: row.metrics?.return20d ?? null,
        risk: row.concreteVerdict?.scores?.risk ?? null,
        from: row.shadowVerdict.sourceAction,
        to: row.shadowVerdict.action,
        direction: row.shadowVerdict.direction,
        reason: row.shadowVerdict.reason,
        themeRegime: row.shadowVerdict.themeRegime
      });
    }
  }
  return {
    version: 1,
    policy: "Eksperymentalny overlay rezimu tematycznego. Nie steruje glownym werdyktem ani Telegramem.",
    themeRegimes,
    changes: changes.sort((a, b) => (b.themeRegime?.median20d ?? -Infinity) - (a.themeRegime?.median20d ?? -Infinity)
      || (b.researchScore ?? -Infinity) - (a.researchScore ?? -Infinity))
  };
}

module.exports = {
  ACTIONS,
  applyShadowModel,
  buildShadowVerdict,
  buildThemeRegimes,
  normalizeOptions
};

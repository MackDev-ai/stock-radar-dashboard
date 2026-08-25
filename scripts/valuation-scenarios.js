const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const outPath = path.join(root, "research", "valuation-scenarios.md");

const scenarios = {
  ETN: {
    metric: "adjusted EPS",
    baseYear: 2026,
    baseValue: 13.50,
    growthRates: [0.08, 0.10, 0.12],
    exitMultiples: [24, 28, 32],
    note: "Base EPS uses midpoint of Eaton FY2026 adjusted EPS guidance 13.40-13.60 USD."
  }
};

function loadSnapshot() {
  const raw = fs.readFileSync(dataPath, "utf8");
  const json = raw.replace(/^window\.MONITORING_DATA\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(json);
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function compound(value, growth, years) {
  return value * Math.pow(1 + growth, years);
}

function scenarioRows(price, config) {
  const targetYear = config.baseYear + 2;
  const rows = [];
  for (const growth of config.growthRates) {
    const targetMetric = compound(config.baseValue, growth, targetYear - config.baseYear);
    for (const multiple of config.exitMultiples) {
      const targetPrice = targetMetric * multiple;
      rows.push({
        growth,
        multiple,
        targetMetric,
        targetPrice,
        upside: price ? ((targetPrice / price) - 1) * 100 : null
      });
    }
  }
  return rows;
}

function buildReport(snapshot) {
  const lines = [
    "# Scenariusze wyceny",
    "",
    `Aktualizacja danych: ${snapshot.generatedAt || "-"}`,
    "",
    "To sa proste scenariusze do researchu, nie rekomendacje inwestycyjne. Model nie uwzglednia dywidend, zmian liczby akcji, długu netto ani ryzyka wykonania.",
    ""
  ];

  for (const [ticker, config] of Object.entries(scenarios)) {
    const row = snapshot.rows.find((item) => item.ticker === ticker);
    const price = row?.metrics?.price;
    lines.push(`## ${ticker} - ${row?.name || ""}`);
    lines.push("");
    lines.push(`- Cena bazowa: ${fmt(price, 2)}`);
    lines.push(`- Metryka: ${config.metric}`);
    lines.push(`- Baza ${config.baseYear}: ${fmt(config.baseValue, 2)}`);
    lines.push(`- Uwaga: ${config.note}`);
    lines.push("");
    lines.push("| CAGR metryki | Multiple exit | Metryka za 2 lata | Cena teoretyczna | Upside/downside |");
    lines.push("|---:|---:|---:|---:|---:|");
    for (const item of scenarioRows(price, config)) {
      lines.push(`| ${fmt(item.growth * 100, 0)}% | ${fmt(item.multiple, 0)}x | ${fmt(item.targetMetric, 2)} | ${fmt(item.targetPrice, 2)} | ${fmt(item.upside, 1)}% |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

const snapshot = loadSnapshot();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buildReport(snapshot));
console.log(path.relative(root, outPath));

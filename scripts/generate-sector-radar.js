const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const themesPath = path.join(root, "sector-opportunity-radar.csv");
const outPath = path.join(root, "research", "sector-radar-report.md");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] || ""]));
  });
}

function loadSnapshot() {
  const raw = fs.readFileSync(dataPath, "utf8");
  const json = raw.replace(/^window\.MONITORING_DATA\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(json);
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function groupThemes(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const theme of row.themes || []) {
      if (!groups.has(theme)) groups.set(theme, []);
      groups.get(theme).push(row);
    }
  }
  return [...groups.entries()].map(([theme, items]) => {
    const avgScore = avg(items.map((row) => row.researchScore?.total));
    const avg20d = avg(items.map((row) => row.metrics?.return20d));
    const avg60d = avg(items.map((row) => row.metrics?.return60d));
    const avgDrawdown = avg(items.map((row) => row.metrics?.drawdown52w));
    const top = items.slice().sort((a, b) => (b.researchScore?.total ?? 0) - (a.researchScore?.total ?? 0)).slice(0, 5);
    const reboundTop = items
      .filter((row) => row.reboundScore)
      .sort((a, b) => (b.reboundScore?.total ?? 0) - (a.reboundScore?.total ?? 0))
      .slice(0, 5);
    const distressCount = items.filter((row) => row.status === "DISTRESSED").length;
    return {
      theme,
      count: items.length,
      avgScore,
      avg20d,
      avg60d,
      avgDrawdown,
      candidateCount: items.filter((row) => row.decision?.status === "Candidate").length,
      specReboundCount: items.filter((row) => row.decision?.status === "Spec rebound").length,
      needsReviewCount: items.filter((row) => /Needs/.test(row.decision?.status || "")).length,
      distressCount,
      top,
      reboundTop
    };
  }).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
}

function buildReport(snapshot) {
  const themes = fs.existsSync(themesPath) ? parseCsv(fs.readFileSync(themesPath, "utf8")) : [];
  const grouped = groupThemes(snapshot.rows || []);
  const lines = [
    "# Sektorowy radar okazji",
    "",
    `Aktualizacja danych: ${snapshot.generatedAt || "-"}`,
    "",
    "To jest radar researchowy na tygodnie i miesiace. Nie jest rekomendacja inwestycyjna.",
    "",
    "## Najciekawsze obszary teraz",
    "",
    "| Obszar | Horyzont | Conviction | Dlaczego teraz | Przyklady | Glowne ryzyko |",
    "|---|---|---|---|---|---|"
  ];

  for (const theme of themes) {
    lines.push(`| ${theme.theme} | ${theme.horizon} | ${theme.conviction} | ${theme.why_now} | ${theme.example_tickers} | ${theme.main_risk} |`);
  }

  lines.push("");
  lines.push("## Ranking tematow z watchlisty");
  lines.push("");
  lines.push("| Theme | Spolki | Avg score | Avg 20d | Avg 60d | Avg drawdown | Candidate | Spec rebound | Needs review | Top tickers |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const group of grouped) {
    lines.push(`| ${group.theme} | ${group.count} | ${fmt(group.avgScore, 0)} | ${fmtPct(group.avg20d)} | ${fmtPct(group.avg60d)} | ${fmtPct(group.avgDrawdown)} | ${group.candidateCount} | ${group.specReboundCount} | ${group.needsReviewCount} | ${group.top.map((row) => `${row.ticker} ${row.researchScore?.total ?? "-"}`).join(", ")} |`);
  }

  lines.push("");
  lines.push("## Distressed rebound - najlepsze setupy techniczne");
  lines.push("");
  lines.push("| Theme | Distressed names | Top rebound |");
  lines.push("|---|---:|---|");
  for (const group of grouped.filter((item) => item.distressCount)) {
    lines.push(`| ${group.theme} | ${group.distressCount} | ${group.reboundTop.map((row) => `${row.ticker} ${row.reboundScore?.total ?? "-"}`).join(", ") || "-"} |`);
  }

  lines.push("");
  lines.push("## Jak czytac distressed rebound");
  lines.push("");
  lines.push("- To nie jest koszyk do kupowania w ciemno.");
  lines.push("- Najpierw sprawdz cash runway, debt maturities, gross margin, free cash flow i ryzyko emisji akcji.");
  lines.push("- Najlepszy sygnal to kombinacja: bardzo duzy drawdown + stabilizacja przychodow + poprawa marzy + rosnacy wolumen + brak presji finansowania.");
  lines.push("- Najgorszy sygnal to tani wykres bez bilansu: spolka moze dalej spadac mimo odbicia sektora.");
  lines.push("");
  lines.push("## Nastepne akcje");
  lines.push("");
  lines.push("1. Dla `DISTRESSED-REBOUND` zrobic osobny deep dive tylko na survival.");
  lines.push("2. Dodac do `manual-fundamentals.csv` cash, debt, FCF, revenue growth i gross margin dla distressed.");
  lines.push("3. Oddzielic score jakosciowy od score odbicia, bo to dwa rozne typy ryzyka.");
  return `${lines.join("\n")}\n`;
}

const snapshot = loadSnapshot();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buildReport(snapshot));
console.log(path.relative(root, outPath));

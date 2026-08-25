const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const outputDir = path.join(root, "research", "deep-dives");
const target = String(process.argv[2] || "ETN").toUpperCase();

function loadSnapshot() {
  const raw = fs.readFileSync(dataPath, "utf8");
  const json = raw.replace(/^window\.MONITORING_DATA\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(json);
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function fmtMarketCap(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  return value.toFixed(0);
}

function list(items, fallback = "Brak danych.") {
  return items?.length ? items.map((item) => `- ${item}`).join("\n") : fallback;
}

function ratio(value) {
  return Number.isFinite(value) ? fmtPct(value * 100) : "-";
}

function latestFilings(row) {
  const filings = row.sec?.filings || [];
  if (!filings.length) return "Brak danych SEC.";
  return filings.slice(0, 5).map((filing) => (
    `- ${filing.form} z ${filing.filingDate}${filing.reportDate ? `, report date ${filing.reportDate}` : ""}: ${filing.url}`
  )).join("\n");
}

function secKeywords(row) {
  const matches = row.secAnalysis?.matches || [];
  if (!matches.length) return "Brak trafien slow-kluczy albo dokument nie zostal przeanalizowany.";
  return matches.slice(0, 10).map((match) => `- ${match.keyword}: ${match.count}`).join("\n");
}

function buildReport(snapshot, row) {
  const m = row.metrics || {};
  const f = row.fundamentals || {};
  const score = row.researchScore || {};
  const decision = row.decision || {};
  const generatedDate = new Date(snapshot.generatedAt || Date.now()).toISOString().slice(0, 10);

  return `# Deep dive: ${row.ticker} - ${row.name}

Data wygenerowania: ${generatedDate}

To jest material researchowy do dalszej analizy. Nie jest rekomendacja inwestycyjna.

## 1. Decyzja robocza

- Status decyzji: ${decision.status || "-"}
- Priorytet: ${decision.priority || "-"}
- Nastepny przeglad: ${decision.nextReviewDate || "-"}
- Radar score: ${score.total ?? "-"} / ${score.grade || "-"}
- Nastepny krok: ${score.nextStep || "-"}
- Notatka: ${decision.note || "-"}
- Trigger uniewaznienia tezy: ${decision.invalidationTrigger || "-"}

## 2. Teza

${row.thesis || "Brak tezy w konfiguracji."}

## 3. Dlaczego spolka jest w radarze

${list(score.positives)}

## 4. Co moze psuc teze

${list([row.risk, ...(score.negatives || [])].filter(Boolean))}

## 5. Dane rynkowe

- Cena: ${fmt(m.price)}
- Data ceny: ${m.date || "-"}
- Od high 52w: ${fmtPct(m.drawdown52w)}
- Od low 52w: ${fmtPct(m.fromLow52w)}
- Momentum 20d: ${fmtPct(m.return20d)}
- Momentum 60d: ${fmtPct(m.return60d)}
- Momentum 120d: ${fmtPct(m.return120d)}
- Momentum 252d: ${fmtPct(m.return252d)}
- Zmiennosc 60d annualized: ${fmtPct(m.volatility60dAnnualized)}
- Volume: ${Number.isFinite(m.volume) ? Math.round(m.volume).toLocaleString("en-US") : "-"}

## 6. Profil i fundamenty

- Zrodlo fundamentow: ${row.fundamentalsProvider || "-"} / ${f.source || "-"}
- FMP symbol: ${f.symbol || row.fmp_symbol || row.yahoo || row.ticker}
- Market cap: ${fmtMarketCap(f.marketCap)}
- Beta: ${fmt(f.beta, 2)}
- Sektor: ${f.sector || "-"}
- Branża: ${f.industry || "-"}
- Kraj: ${f.country || "-"}
- Pracownicy: ${Number.isFinite(f.employees) ? Math.round(f.employees).toLocaleString("en-US") : "-"}
- P/E TTM: ${fmt(f.peTTM, 1)}
- EV/EBITDA TTM: ${fmt(f.evToEbitdaTTM, 1)}
- P/S TTM: ${fmt(f.psTTM, 1)}
- ROE TTM: ${ratio(f.roeTTM)}
- ROIC TTM: ${ratio(f.roicTTM)}
- Marza operacyjna TTM: ${ratio(f.operatingMarginTTM)}
- Net debt / EBITDA: ${fmt(f.netDebtToEbitdaTTM, 1)}

## 7. SEC i raporty

${latestFilings(row)}

## 8. Slowa-klucze w ostatnim SEC

${secKeywords(row)}

## 9. Pytania do sprawdzenia

- Czy ostatni raport potwierdza teze: ${row.watch || "-"}?
- Czy obecny pullback wynika z wyceny, cyklu, czy zmiany fundamentow?
- Czy istnieje lepszy odpowiednik w tej samej ekspozycji tematycznej?
- Jakie 2-3 liczby musza poprawic sie w kolejnym raporcie?
- Co sprawi, ze spolka przejdzie z \`${decision.status || "Monitor"}\` do decyzji kupna, dalszego oczekiwania albo odrzucenia?

## 10. Werdykt roboczy

Na dzisiaj: **${decision.status || "Monitor"}**. Najpierw wykonac krok: **${score.nextStep || "TRACK"}**.
`;
}

function preserveManualSection(existingText) {
  const marker = "\n## 11.";
  const index = existingText.indexOf(marker);
  return index >= 0 ? existingText.slice(index) : "";
}

fs.mkdirSync(outputDir, { recursive: true });
const snapshot = loadSnapshot();
const rows = target === "ALL"
  ? snapshot.rows
  : target === "CANDIDATES"
    ? snapshot.rows.filter((row) => row.decision?.status === "Candidate")
    : snapshot.rows.filter((item) => String(item.ticker).toUpperCase() === target);

if (!rows.length) {
  console.error(`No matching rows for: ${target}`);
  process.exit(1);
}

for (const row of rows) {
  const safeTicker = String(row.ticker).toUpperCase().replace(/[^A-Z0-9.-]/g, "_");
  const outputPath = path.join(outputDir, `${safeTicker}-deep-dive.md`);
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  const manualSection = preserveManualSection(existing);
  fs.writeFileSync(outputPath, `${buildReport(snapshot, row).trimEnd()}${manualSection}\n`);
  console.log(path.relative(root, outputPath));
}

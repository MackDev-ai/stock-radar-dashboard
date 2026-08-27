const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const outputDir = path.join(root, "research", "deep-dives");
const memoDir = path.join(root, "research", "memos");
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

function deepDivePriority(row) {
  const engine = row.decisionEngine || {};
  const priority = { P1: 4, P2: 3, P3: 2, P4: 1 };
  const category = {
    ROZWAZ_WEJSCIE: 5,
    SPECULATIVE_ONLY: 4,
    CZEKAC: 3,
    ODRZUC_TERAZ: 2,
    OBSERWUJ: 1
  };
  return (category[engine.category] || 0) * 10000
    + (priority[engine.priority] || 0) * 1000
    + (row.researchScore?.total || 0);
}

function decisionRows(snapshot) {
  return (snapshot.rows || [])
    .filter((row) => ["ROZWAZ_WEJSCIE", "CZEKAC", "SPECULATIVE_ONLY", "ODRZUC_TERAZ"].includes(row.decisionEngine?.category))
    .sort((a, b) => deepDivePriority(b) - deepDivePriority(a))
    .slice(0, 40);
}

function memoRows(snapshot) {
  return decisionRows(snapshot)
    .filter((row) => row.decisionEngine?.category === "ROZWAZ_WEJSCIE" || row.decisionEngine?.category === "SPECULATIVE_ONLY")
}

function secKeywords(row) {
  const matches = row.secAnalysis?.matches || [];
  if (!matches.length) return "Brak trafien slow-kluczy albo dokument nie zostal przeanalizowany.";
  return matches.slice(0, 10).map((match) => `- ${match.keyword}: ${match.count}`).join("\n");
}

function compactList(items, fallback = "Brak mocnego sygnalu w danych.") {
  return items?.length ? items.slice(0, 5).map((item) => `- ${item}`).join("\n") : fallback;
}

function filingLinks(row) {
  const filings = row.sec?.filings || [];
  return filings.slice(0, 3).map((filing) => `- ${filing.form} ${filing.filingDate || ""}: ${filing.url}`).join("\n") || "- Brak linkow SEC.";
}

function memoVerdict(row) {
  const engine = row.decisionEngine || {};
  if (engine.category === "ROZWAZ_WEJSCIE") return "Do rozważenia po sprawdzeniu warunkow wejscia i czerwonych flag.";
  if (engine.category === "SPECULATIVE_ONLY") return "Tylko koszyk spekulacyjny; wymaga mniejszej ekspozycji i twardych warunkow uniewaznienia.";
  if (engine.category === "CZEKAC") return "Czekac na lepszy risk/reward, cofniecie ceny albo potwierdzenie danych.";
  if (engine.category === "ODRZUC_TERAZ") return "Odrzucic na teraz, dopoki blokery nie zostana wyjasnione.";
  return "Obserwowac.";
}

function buildInvestmentMemo(snapshot, row, index) {
  const m = row.metrics || {};
  const f = row.fundamentals || {};
  const score = row.researchScore || {};
  const engine = row.decisionEngine || {};
  const filingBrief = row.secAnalysis?.filingBrief || {};
  const generatedDate = new Date(snapshot.generatedAt || Date.now()).toISOString().slice(0, 10);
  const positives = [...(engine.reasons || []), ...(score.positives || [])];
  const blockers = [row.risk, ...(engine.blockers || []), ...(score.negatives || [])].filter(Boolean);
  const catalysts = [
    row.watch ? `Potwierdzenie w danych: ${row.watch}` : null,
    Number.isFinite(m.return20d) && m.return20d > 5 ? `Momentum 20d: ${fmtPct(m.return20d)}` : null,
    Number.isFinite(m.return60d) && m.return60d > 8 ? `Momentum 60d: ${fmtPct(m.return60d)}` : null,
    filingBrief.sentiment ? `Najnowszy filing: ${filingBrief.sentiment}` : null
  ].filter(Boolean);

  return `# Investment memo: ${row.ticker} - ${row.name}

Data: ${generatedDate}
Pozycja w kolejce memo: ${index + 1}

To jest material researchowy i checklista decyzyjna, nie rekomendacja inwestycyjna.

## 1. Roboczy werdykt

${memoVerdict(row)}

- Decision Engine v2: ${engine.label || "-"} / ${engine.priority || "-"} / ${engine.confidence || "-"}
- Radar score: ${score.total ?? "-"} / ${score.grade || "-"}
- Nastepny krok: ${engine.nextStep || score.nextStep || "-"}

## 2. Teza

${row.thesis || "Brak tezy w konfiguracji."}

## 3. Katalizatory do obserwacji

${compactList(catalysts)}

## 4. Dane, ktore wspieraja teze

${compactList(positives)}

## 5. Ryzyka i blokery

${compactList(blockers)}

## 6. Wycena i jakosc

- Cena: ${fmt(m.price)}
- Od high 52w: ${fmtPct(m.drawdown52w)}
- Momentum 20d / 60d: ${fmtPct(m.return20d)} / ${fmtPct(m.return60d)}
- Market cap: ${fmtMarketCap(f.marketCap)}
- P/E TTM: ${fmt(f.peTTM, 1)}
- EV/EBITDA TTM: ${fmt(f.evToEbitdaTTM, 1)}
- P/S TTM: ${fmt(f.psTTM, 1)}
- Marza operacyjna TTM: ${ratio(f.operatingMarginTTM)}
- ROIC TTM: ${ratio(f.roicTTM)}
- Net debt / EBITDA: ${fmt(f.netDebtToEbitdaTTM, 1)}
- Altman Z / Piotroski: ${fmt(f.altmanZScore, 1)} / ${fmt(f.piotroskiScore, 0)}

## 7. SEC i dokumenty do przeczytania

${filingLinks(row)}

## 8. Warunki wejscia do rozważenia

- Brak twardych czerwonych flag w najnowszym filing SEC.
- Wycena nie jest skrajnie rozciagnieta wobec tempa wzrostu i marz.
- Momentum nie jest ruchem do gonienia po pionowym wybiciu.
- Teza z konfiguracji jest potwierdzona przez ostatnie wyniki albo guidance.

## 9. Warunki odrzucenia

- Pogorszenie cash flow, marz albo zadluzenia bez jasnego powodu przejsciowego.
- Ryzyko rozwodnienia, plynnosci, covenantow, delistingu albo going concern.
- Brak poprawy danych mimo wysokiego score technicznego.
- Lepszy odpowiednik w tym samym sektorze ma wyzsza jakosc i nizsze ryzyko.

## 10. Plan obserwacji

- Sprawdz kolejny filing i earnings release.
- Porownaj z 2-3 konkurentami z tej samej ekspozycji tematycznej.
- Wroc do memo, gdy Decision Engine zmieni kategorie lub score zmieni sie o minimum 10 pkt.
`;
}

function buildReport(snapshot, row) {
  const m = row.metrics || {};
  const f = row.fundamentals || {};
  const score = row.researchScore || {};
  const decision = row.decision || {};
  const engine = row.decisionEngine || {};
  const generatedDate = new Date(snapshot.generatedAt || Date.now()).toISOString().slice(0, 10);

  return `# Deep dive: ${row.ticker} - ${row.name}

Data wygenerowania: ${generatedDate}

To jest material researchowy do dalszej analizy. Nie jest rekomendacja inwestycyjna.

## 1. Decyzja robocza

- Status decyzji: ${decision.status || "-"}
- Decision Engine v2: ${engine.label || "-"} / ${engine.priority || "-"} / ${engine.confidence || "-"}
- Priorytet: ${decision.priority || "-"}
- Nastepny przeglad: ${decision.nextReviewDate || "-"}
- Radar score: ${score.total ?? "-"} / ${score.grade || "-"}
- Nastepny krok: ${score.nextStep || "-"}
- Notatka: ${decision.note || "-"}
- Nastepny krok Decision v2: ${engine.nextStep || "-"}
- Trigger uniewaznienia tezy: ${decision.invalidationTrigger || "-"}

## 2. Teza

${row.thesis || "Brak tezy w konfiguracji."}

## 3. Dlaczego spolka jest w radarze

${list([...(engine.reasons || []), ...(score.positives || [])])}

## 4. Co moze psuc teze

${list([row.risk, ...(engine.blockers || []), ...(score.negatives || [])].filter(Boolean))}

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
fs.mkdirSync(memoDir, { recursive: true });
const snapshot = loadSnapshot();
const rows = target === "ALL"
  ? snapshot.rows
  : target === "DECISIONS"
    ? decisionRows(snapshot)
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

const selectedMemoRows = target === "DECISIONS" ? memoRows(snapshot) : rows.slice(0, 10);
for (const [index, row] of selectedMemoRows.entries()) {
  const safeTicker = String(row.ticker).toUpperCase().replace(/[^A-Z0-9.-]/g, "_");
  const outputPath = path.join(memoDir, `${safeTicker}-memo.md`);
  fs.writeFileSync(outputPath, `${buildInvestmentMemo(snapshot, row, index).trimEnd()}\n`);
  console.log(path.relative(root, outputPath));
}

const memoIndexRows = selectedMemoRows
  .map((row, index) => `${index + 1}. ${row.ticker} - ${row.name || "-"} | ${row.decisionEngine?.label || row.decision?.status || "-"} | score ${row.researchScore?.total ?? "-"} | [memo](memos/${String(row.ticker).toUpperCase().replace(/[^A-Z0-9.-]/g, "_")}-memo.md)`)
  .join("\n");
fs.writeFileSync(path.join(root, "research", "memo-index.md"), `# Investment memo index

Automatyczna lista top 10 memo z Decision Engine v2.

To jest material researchowy i checklista decyzyjna, nie rekomendacja inwestycyjna.

## Kolejka memo

${memoIndexRows || "Brak pozycji."}
`);

const indexRows = rows
  .map((row, index) => `${index + 1}. ${row.ticker} - ${row.name || "-"} | ${row.decisionEngine?.label || row.decision?.status || "-"} | score ${row.researchScore?.total ?? "-"} | [raport](deep-dives/${String(row.ticker).toUpperCase().replace(/[^A-Z0-9.-]/g, "_")}-deep-dive.md)`)
  .join("\n");
fs.writeFileSync(path.join(root, "research", "deep-dive-index.md"), `# Deep dive index

Automatyczna kolejka glebszego researchu z Decision Engine v2. Raporty powstaja ze snapshotu \`data/monitoring-data.js\`, danych SEC/FMP i reguly decyzyjnej dashboardu.

To jest material researchowy, nie rekomendacja inwestycyjna.

## Kolejka

${indexRows || "Brak pozycji."}

## Standard raportu

- Decision Engine v2 i nastepny krok.
- Teza i powody wyboru.
- Blokery oraz czerwone flagi.
- Dane rynkowe, wycena, marze, cash flow i zadluzenie.
- Najnowsze filing SEC i slowa-klucze.
- Pytania przed Twoja decyzja.
`);

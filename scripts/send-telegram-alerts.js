const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = process.env.MONITORING_DATA_PATH
  ? path.resolve(process.env.MONITORING_DATA_PATH)
  : path.join(root, "data", "monitoring-data.js");
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minScore = Number.isFinite(Number(process.env.TELEGRAM_MIN_SCORE)) ? Number(process.env.TELEGRAM_MIN_SCORE) : 75;
const maxAlerts = Number.isFinite(Number(process.env.TELEGRAM_MAX_ALERTS)) ? Number(process.env.TELEGRAM_MAX_ALERTS) : 12;
const maxPerSection = Number.isFinite(Number(process.env.TELEGRAM_MAX_PER_SECTION)) ? Number(process.env.TELEGRAM_MAX_PER_SECTION) : Math.max(3, Math.ceil(maxAlerts / 4));
const maxChangeLogItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_CHANGE_LOG)) ? Number(process.env.TELEGRAM_MAX_CHANGE_LOG) : 4;
const maxTodayChangeItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_TODAY_CHANGES)) ? Number(process.env.TELEGRAM_MAX_TODAY_CHANGES) : 4;
const maxDecisionPackageItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_DECISION_PACKAGES)) ? Number(process.env.TELEGRAM_MAX_DECISION_PACKAGES) : 3;
const maxTodayDecisionItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_TODAY_DECISIONS)) ? Number(process.env.TELEGRAM_MAX_TODAY_DECISIONS) : 5;
const maxTriageItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_TRIAGE)) ? Number(process.env.TELEGRAM_MAX_TRIAGE) : 6;
const maxOpportunityItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_OPPORTUNITIES)) ? Number(process.env.TELEGRAM_MAX_OPPORTUNITIES) : 4;
const telegramChunkLimit = Number.isFinite(Number(process.env.TELEGRAM_CHUNK_LIMIT)) ? Number(process.env.TELEGRAM_CHUNK_LIMIT) : 2800;
const telegramMode = String(process.env.TELEGRAM_MODE || "brief").toLowerCase();

function parseMonitoringData() {
  const text = fs.readFileSync(dataPath, "utf8");
  const marker = "window.MONITORING_DATA = ";
  const start = text.indexOf(marker);
  if (start === -1) throw new Error("MONITORING_DATA marker not found");
  return JSON.parse(text.slice(start + marker.length).trim().replace(/;$/, ""));
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(1)}%` : "-";
}

function fmtChange(value, digits = 0) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}` : "-";
}

function fmtNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function rankChange(delta) {
  if (!Number.isFinite(delta?.rankChange)) return "-";
  if (delta.rankChange === 0) return "0";
  return delta.rankChange > 0 ? `+${delta.rankChange}` : `${delta.rankChange}`;
}

const actionLabels = {
  WATCH_PULLBACK: "czekaj na cofniecie",
  REVIEW_BUY_ZONE: "sprawdz strefe kupna",
  REVIEW_RISK: "sprawdz ryzyko",
  REVIEW_FILING: "przeczytaj filing",
  DO_NOT_CHASE: "nie gon ceny",
  MONITOR: "zwykla obserwacja",
  NO_DATA: "brak danych"
};

const decisionLabels = {
  Candidate: "kandydat",
  Waiting: "czekamy",
  "Needs review": "wymaga sprawdzenia",
  "Needs filing": "wymaga przeczytania filing",
  Monitor: "obserwacja",
  "Spec rebound": "spekulacyjne odbicie"
};

function actionLabel(value) {
  return actionLabels[value] || value || "-";
}

function decisionLabel(value) {
  return decisionLabels[value] || value || "-";
}

function displayVerdictLabel(value) {
  return String(value || "-")
    .replace(/Kandydat do inwestycji po deep dive/g, "Kandydat po sprawdzeniu pakietu decyzji")
    .replace(/Kandydat do inwestycji/g, "Kandydat po sprawdzeniu pakietu decyzji");
}

function translateReason(text) {
  return String(text || "-")
    .replace(/Drawdown from 52w high below -20%/g, "spadek od maksimum 52 tyg. ponizej -20%")
    .replace(/Drawdown from 52w high below -12%/g, "spadek od maksimum 52 tyg. ponizej -12%")
    .replace(/20d momentum below -8%/g, "slabe momentum 20 dni ponizej -8%")
    .replace(/60d annualized volatility above 45%/g, "podwyzszona zmiennosc 60 dni")
    .replace(/60d annualized volatility above 55%/g, "wysoka zmiennosc 60 dni")
    .replace(/Beta above 1.6/g, "beta powyzej 1.6")
    .replace(/Operating margin below 10%/g, "marza operacyjna ponizej 10%")
    .replace(/Revenue growth below 3%/g, "wzrost przychodow ponizej 3%")
    .replace(/Net debt\/EBITDA above 3.5/g, "net debt/EBITDA powyzej 3.5")
    .replace(/High P\/E/g, "wysokie P/E")
    .replace(/High EV\/EBITDA/g, "wysokie EV/EBITDA")
    .replace(/High P\/FCF/g, "wysokie P/FCF")
    .replace(/Near 52w high/g, "blisko maksimum 52 tyg.")
    .replace(/No price data/g, "brak danych cenowych")
    .replace(/Fetch failed/g, "pobranie danych nieudane");
}

function blockerLabel(text) {
  return translateReason(String(text || "-").replace(/akcja systemowa ([A-Z_]+)/g, (_, action) => `akcja systemowa: ${actionLabel(action)}`));
}

function fmtRatioPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "-";
}

function latestFiling(row) {
  return row.sec?.newFilings?.[0] || row.secAnalysis?.filing || row.sec?.filings?.[0] || null;
}

function metricEvidence(row, limit = 6) {
  const metrics = row.metrics || {};
  const f = row.fundamentals || {};
  const items = [
    ["od high 52w", Number.isFinite(metrics.drawdown52w), fmtPct(metrics.drawdown52w)],
    ["20d", Number.isFinite(metrics.return20d), fmtPct(metrics.return20d)],
    ["60d", Number.isFinite(metrics.return60d), fmtPct(metrics.return60d)],
    ["P/E", Number.isFinite(f.peTTM), fmtNumber(f.peTTM, 1)],
    ["EV/EBITDA", Number.isFinite(f.evToEbitdaTTM), fmtNumber(f.evToEbitdaTTM, 1)],
    ["P/FCF", Number.isFinite(f.pfcfTTM), fmtNumber(f.pfcfTTM, 1)],
    ["net debt/EBITDA", Number.isFinite(f.netDebtToEbitdaTTM), fmtNumber(f.netDebtToEbitdaTTM, 1)],
    ["marza op.", Number.isFinite(f.operatingMarginTTM), fmtRatioPct(f.operatingMarginTTM)],
    ["revenue YoY", Number.isFinite(f.revenueGrowthYoY), fmtPct(f.revenueGrowthYoY)],
    ["Altman Z", Number.isFinite(f.altmanZScore), fmtNumber(f.altmanZScore, 1)],
    ["Piotroski", Number.isFinite(f.piotroskiScore), fmtNumber(f.piotroskiScore, 0)]
  ];
  return items.filter(([, ok]) => ok).slice(0, limit).map(([label, , value]) => `${label} ${value}`);
}

function readingLine(row) {
  const filing = latestFiling(row);
  const query = encodeURIComponent(`${row.ticker} ${row.name || ""} earnings guidance SEC`.trim());
  const parts = [];
  if (filing?.url) parts.push(`SEC ${filing.form || ""}: ${filing.url}`.trim());
  parts.push(`News: https://news.google.com/search?q=${query}`);
  return parts.join(" | ");
}

function memoLink(row) {
  const safeTicker = String(row.ticker || "").toUpperCase().replace(/[^A-Z0-9.-]/g, "_");
  return `${dashboardUrl}research/memos/${safeTicker}-memo.md`;
}

function decisionQuestions(row) {
  const blockers = row.investmentVerdict?.blockers || [];
  const action = row.signal?.action || "";
  if (action === "REVIEW_RISK" || action === "DO_NOT_CHASE" || blockers.length) {
    return "Pytania: czy filing pogarsza cash flow/bilans? czy jest rozwodnienie, delisting, covenant albo slabszy guidance?";
  }
  if ((row.researchScore?.total ?? 0) >= minScore) {
    return "Pytania: czy marze, wzrost i cash flow potwierdzaja teze? czy wycena nie jest zbyt rozciagnieta?";
  }
  return "Pytania: jaki trigger zmieni obserwacje w kandydata: wynik, filing, insider flow czy poprawa momentum?";
}

function filingEvidenceLine(row) {
  const evidence = row.secAnalysis?.filingBrief?.decisionEvidence || row.investmentVerdict?.filing?.brief?.decisionEvidence || [];
  const readable = (hit) => {
    const text = String(hit.context || "");
    const digitShare = text.length ? (text.match(/[0-9$%]/g) || []).length / text.length : 0;
    return text.length >= 80 && digitShare < 0.22 && !/[—]{2,}/.test(text);
  };
  const items = evidence.flatMap((group) => (group.hits || []).filter(readable).slice(0, 1).map((hit) => `${group.label}: ${hit.context}`));
  return items.length ? `Z filing: ${truncateLine(items.slice(0, 2).join(" | "), 360)}` : "";
}

function rankMoveText(delta) {
  if (!Number.isFinite(delta?.rankChange)) return "brak poprzedniego rankingu";
  if (delta.rankChange > 0) return `awans o ${delta.rankChange} miejsc`;
  if (delta.rankChange < 0) return `spadek o ${Math.abs(delta.rankChange)} miejsc`;
  return "bez zmiany";
}

function alertWeight(row) {
  const delta = row.historyDelta || {};
  const newFilings = row.sec?.newFilings?.length ? 120 : 0;
  const actionChange = delta.actionChanged ? 100 : 0;
  const decisionChange = delta.decisionChanged ? 90 : 0;
  const score = row.researchScore?.total ?? 0;
  const highScore = score >= minScore ? score : 0;
  const scoreMove = Math.abs(delta.scoreChange || 0) * 4;
  const rankMove = Math.abs(delta.rankChange || 0) * 0.4;
  const priceMove = Math.abs(delta.priceChangePct || 0);
  const alerts = (row.signal?.alerts?.length || 0) * 12;
  return newFilings + actionChange + decisionChange + highScore + scoreMove + rankMove + priceMove + alerts;
}

function reason(row) {
  const delta = row.historyDelta || {};
  const parts = [];
  if (row.sec?.newFilings?.length) {
    const brief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
    if (brief) parts.push(`SEC: ${brief.summary} Co sprawdzic: ${brief.researchAction}`);
    else parts.push(`SEC: ${[...new Set(row.sec.newFilings.map((filing) => filing.form))].join(", ")}`);
  }
  if (delta.actionChanged) parts.push(`zmiana akcji: ${actionLabel(delta.previousAction)} -> ${actionLabel(row.signal?.action)}`);
  if (delta.decisionChanged) parts.push(`zmiana decyzji: ${decisionLabel(delta.previousDecisionStatus)} -> ${decisionLabel(row.decision?.status)}`);
  const signalAlerts = (row.signal?.alerts || []).filter((alert) => !alert.startsWith("New SEC filing:"));
  if (signalAlerts.length) parts.push(signalAlerts.slice(0, 2).map(translateReason).join("; "));
  if (!parts.length) parts.push((row.researchScore?.positives || []).slice(0, 2).join("; ") || row.thesis || "monitoring");
  return parts.join(" | ");
}

function truncateLine(text, limit = 180) {
  const value = String(text || "-").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function truncateBlock(text, limit = 1200) {
  const value = String(text || "").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function pickAlerts(snapshot) {
  return (snapshot.rows || [])
    .map((row) => ({ row, weight: alertWeight(row) }))
    .filter(({ row, weight }) => weight > 0 && ((row.researchScore?.total ?? 0) >= minScore || row.historyDelta?.actionChanged || row.historyDelta?.decisionChanged || row.sec?.newFilings?.length || row.signal?.alerts?.length))
    .sort((a, b) => b.weight - a.weight || (b.row.researchScore?.total ?? 0) - (a.row.researchScore?.total ?? 0))
    .slice(0, maxAlerts)
    .map(({ row }) => row);
}

function moveMagnitude(row) {
  const delta = row.historyDelta || {};
  return Math.abs(delta.scoreChange || 0) * 5 + Math.abs(delta.rankChange || 0) * 0.5 + Math.abs(delta.priceChangePct || 0);
}

function hasRiskSignal(row) {
  const action = row.signal?.action;
  return action === "REVIEW_RISK" || action === "DO_NOT_CHASE" || (row.investmentVerdict?.blockers || []).length > 0 || row.status === "DISTRESSED";
}

function hasBigMove(row) {
  const delta = row.historyDelta || {};
  return Math.abs(delta.scoreChange || 0) >= 10 || Math.abs(delta.rankChange || 0) >= 20 || Math.abs(delta.priceChangePct || 0) >= 8;
}

function hasOpportunitySignal(row) {
  const score = row.researchScore?.total ?? 0;
  const action = row.signal?.action;
  return score >= minScore && !hasRiskSignal(row) && (row.decision?.status === "Candidate" || action === "REVIEW_BUY_ZONE" || action === "WATCH_PULLBACK");
}

function decisionEngineRows(rows, category) {
  const priority = { P1: 4, P2: 3, P3: 2, P4: 1 };
  return rows
    .filter((row) => row.decisionEngine?.category === category)
    .sort((a, b) => (priority[b.decisionEngine.priority] || 0) - (priority[a.decisionEngine.priority] || 0)
      || (b.decisionEngine.score || 0) - (a.decisionEngine.score || 0));
}

function changeDirectionWeight(value) {
  if (value === "deterioration") return 120;
  if (value === "improvement") return 100;
  return 60;
}

function changeDirectionLabel(value) {
  if (value === "improvement") return "POPRAWA";
  if (value === "deterioration") return "POGORSZENIE";
  return "ZMIANA";
}

function changeValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function changeLogWeight(item) {
  const typeWeight = {
    DECISION_ENGINE_CHANGE: 80,
    ACTION_CHANGE: 60,
    DECISION_STATUS_CHANGE: 55,
    SCORE_MOVE: 40,
    RANK_MOVE: 35
  }[item.type] || 20;
  return changeDirectionWeight(item.direction)
    + typeWeight
    + Math.abs(item.scoreChange || 0) * 2
    + Math.abs(item.rankChange || 0) * 0.4;
}

function pickChangeLogItems(snapshot, used) {
  const rowsByTicker = new Map((snapshot.rows || []).map((row) => [row.ticker, row]));
  const byTicker = new Map();
  for (const item of snapshot.decisionChangeLog?.changes || []) {
    const current = byTicker.get(item.ticker);
    if (!current || changeLogWeight(item) > changeLogWeight(current)) byTicker.set(item.ticker, item);
  }
  return [...byTicker.values()]
    .filter((item) => item.ticker && rowsByTicker.has(item.ticker))
    .sort((a, b) => changeLogWeight(b) - changeLogWeight(a) || String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")))
    .slice(0, maxChangeLogItems)
    .map((item) => ({ ...item, row: rowsByTicker.get(item.ticker) }))
    .filter((item) => {
      if (used.has(item.ticker)) return false;
      used.add(item.ticker);
      return true;
    });
}

function pickTriageItems(snapshot, used) {
  const rowsByTicker = new Map((snapshot.rows || []).map((row) => [row.ticker, row]));
  const today = snapshot.triageQueue?.today || snapshot.triageQueue?.buckets?.TODAY || [];
  const picked = [];
  for (const item of today.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0))) {
    if (picked.length >= maxTriageItems) break;
    if (!item.ticker || used.has(item.ticker)) continue;
    const row = rowsByTicker.get(item.ticker);
    if (!row) continue;
    used.add(item.ticker);
    picked.push({ ...item, row });
  }
  return picked;
}

function pickTodayDecisionItems(snapshot, used) {
  const rowsByTicker = new Map((snapshot.rows || []).map((row) => [row.ticker, row]));
  const picked = [];
  for (const item of snapshot.todayDecisionQueue?.items || []) {
    if (picked.length >= maxTodayDecisionItems) break;
    if (!item.ticker || used.has(item.ticker)) continue;
    used.add(item.ticker);
    picked.push({ ...item, row: rowsByTicker.get(item.ticker) });
  }
  return picked;
}

function pickDecisionPackageItems(snapshot, used) {
  const picked = [];
  for (const item of snapshot.decisionPackages?.items || []) {
    if (picked.length >= maxDecisionPackageItems) break;
    if (!item.ticker || used.has(`decision-package:${item.ticker}`)) continue;
    used.add(`decision-package:${item.ticker}`);
    picked.push(item);
  }
  return picked;
}

function pickTodayDecisionChangeItems(snapshot, used) {
  const changes = snapshot.todayDecisionChanges || {};
  const candidates = [
    ...(changes.readyNow || []).map((item) => ({ ...item, changeType: "gotowe teraz" })),
    ...(changes.added || []).map((item) => ({ ...item, changeType: "nowe w Dzisiaj" })),
    ...(changes.verdictChanged || []).map((item) => ({ ...item, changeType: "zmiana werdyktu" })),
    ...(changes.removed || []).map((item) => ({ ...item, changeType: "wypadlo z Dzisiaj" }))
  ];
  const picked = [];
  for (const item of candidates) {
    if (picked.length >= maxTodayChangeItems) break;
    if (!item.ticker || used.has(`today-change:${item.changeType}:${item.ticker}`)) continue;
    used.add(`today-change:${item.changeType}:${item.ticker}`);
    picked.push(item);
  }
  return picked;
}

function pickOpportunityItems(snapshot, used) {
  const rowsByTicker = new Map((snapshot.rows || []).map((row) => [row.ticker, row]));
  const picked = [];
  for (const item of snapshot.opportunityRanking?.top || []) {
    if (picked.length >= maxOpportunityItems) break;
    if (!item.ticker || used.has(item.ticker) || item.total < 70) continue;
    used.add(item.ticker);
    picked.push({ ...item, row: rowsByTicker.get(item.ticker) });
  }
  return picked;
}

function takeUnique(candidates, used, limit) {
  const picked = [];
  for (const row of candidates) {
    if (picked.length >= limit) break;
    const key = row.ticker || row.yahoo || row.name;
    if (!key || used.has(key)) continue;
    used.add(key);
    picked.push(row);
  }
  return picked;
}

function buildAlertSections(snapshot) {
  const rows = snapshot.rows || [];
  const used = new Set();
  const remaining = () => Math.max(0, maxAlerts - used.size);
  const sections = [];

  const todayDecisionChangeItems = pickTodayDecisionChangeItems(snapshot, used);
  if (todayDecisionChangeItems.length) {
    sections.push({
      kind: "todayDecisionChanges",
      title: "Zmiany w Dzisiaj",
      subtitle: `co sie zmienilo: ${dashboardUrl}#todayDecisionView`,
      rows: todayDecisionChangeItems
    });
  }

  const decisionPackageItems = pickDecisionPackageItems(snapshot, used);
  if (decisionPackageItems.length) {
    sections.push({
      kind: "decisionPackages",
      title: "Pakiety decyzji: top 3",
      subtitle: `pelne karty: ${dashboardUrl}#decisionPackagesView`,
      rows: decisionPackageItems
    });
  }

  const todayDecisionItems = pickTodayDecisionItems(snapshot, used);
  if (todayDecisionItems.length) {
    sections.push({
      kind: "todayDecision",
      title: "Dzisiaj do decyzji",
      subtitle: `najkrotsza kolejka: ${dashboardUrl}#todayDecisionView`,
      rows: todayDecisionItems
    });
  }

  const changeLogItems = pickChangeLogItems(snapshot, used);
  if (changeLogItems.length) {
    sections.push({
      kind: "changeLog",
      title: "Najwazniejsze zmiany decyzji",
      subtitle: `pelna historia: ${dashboardUrl}#changeLogView`,
      rows: changeLogItems
    });
  }

  const triageItems = pickTriageItems(snapshot, used);
  if (triageItems.length) {
    sections.push({
      kind: "triage",
      title: "Triage: dzisiaj",
      subtitle: `krotka lista pracy: ${dashboardUrl}#triageView`,
      rows: triageItems
    });
  }

  const opportunityItems = pickOpportunityItems(snapshot, used);
  if (opportunityItems.length) {
    sections.push({
      kind: "opportunity",
      title: "Szanse: top setupy",
      subtitle: `ranking obserwacji: ${dashboardUrl}#opportunityView`,
      rows: opportunityItems
    });
  }

  const definitions = [
    {
      title: "Decision v2: wejscie do rozwazenia",
      subtitle: "najmocniejsze setupy po filtrze czerwonych ryzyk",
      rows: decisionEngineRows(rows, "ROZWAZ_WEJSCIE")
    },
    {
      title: "Decision v2: odrzucic teraz",
      subtitle: "czerwone ryzyka: filing, dane, rozwodnienie, delisting albo brak danych",
      rows: decisionEngineRows(rows, "ODRZUC_TERAZ")
    },
    {
      title: "Top okazje",
      subtitle: "wysoki score i akcja do dalszego researchu",
      rows: rows
        .filter(hasOpportunitySignal)
        .sort((a, b) => (b.researchScore?.total ?? 0) - (a.researchScore?.total ?? 0) || alertWeight(b) - alertWeight(a))
    },
    {
      title: "Ryzyko",
      subtitle: "spolki, przy ktorych system widzi blokery albo ryzyko gonienia ceny",
      rows: rows
        .filter(hasRiskSignal)
        .sort((a, b) => alertWeight(b) - alertWeight(a) || (b.researchScore?.total ?? 0) - (a.researchScore?.total ?? 0))
    },
    {
      title: "Nowe filingi SEC",
      subtitle: "nowe 8-K, 10-Q, 10-K, Form 4 lub inne dokumenty do przeczytania",
      rows: rows
        .filter((row) => row.sec?.newFilings?.length)
        .sort((a, b) => (b.sec?.newFilings?.length || 0) - (a.sec?.newFilings?.length || 0) || alertWeight(b) - alertWeight(a))
    },
    {
      title: "Duze ruchy",
      subtitle: "najwieksze zmiany score, rankingu albo ceny od poprzedniego snapshotu",
      rows: rows
        .filter(hasBigMove)
        .sort((a, b) => moveMagnitude(b) - moveMagnitude(a) || alertWeight(b) - alertWeight(a))
    }
  ];

  for (const section of definitions) {
    if (remaining() <= 0) break;
    const picked = takeUnique(section.rows, used, Math.min(maxPerSection, remaining()));
    if (picked.length) sections.push({ title: section.title, subtitle: section.subtitle, rows: picked });
  }

  if (!sections.length) {
    const fallback = takeUnique(pickAlerts(snapshot), used, maxAlerts);
    if (fallback.length) sections.push({ title: "Pozostale alerty", subtitle: "najwyzszy laczny priorytet alertu", rows: fallback });
  }

  return sections;
}

function alertBlock(row, index) {
  const delta = row.historyDelta || {};
  const filingBrief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const filingDecision = filingBrief?.decisionBrief;
  const evidence = metricEvidence(row);
  const filingEvidence = filingEvidenceLine(row);
  const engine = row.decisionEngine;
  if (engine) {
    return [
      `${index + 1}. ${row.ticker} ${row.name || ""}`.trim(),
      `Decision v2: ${engine.label} | ${engine.priority} | score ${row.researchScore?.total ?? "-"}`,
      `Dane: ${evidence.length ? evidence.join(" | ") : "brak pelnych danych liczbowych"}`,
      engine.reasons?.length ? `Za: ${truncateLine(engine.reasons.slice(0, 2).map(blockerLabel).join("; "), 180)}` : "",
      engine.blockers?.length ? `Blokery: ${truncateLine(engine.blockers.slice(0, 2).map(blockerLabel).join("; "), 180)}` : "",
      filingDecision ? `Filing brief: ${filingDecision.label} | ${truncateLine(filingDecision.action, 160)}` : "",
      `Nastepny krok: ${truncateLine(engine.nextStep, 180)}`,
      ["ROZWAZ_WEJSCIE", "SPECULATIVE_ONLY"].includes(engine.category) ? `Memo: ${memoLink(row)}` : `Memo dashboard: ${dashboardUrl}#memoView`,
      truncateLine(`Czytaj: ${readingLine(row)}`, 260)
    ].filter(Boolean).join("\n");
  }
  const lines = [
    `${index + 1}. ${row.ticker} ${row.name || ""}`.trim(),
    engine ? `Decision v2: ${engine.label} | ${engine.priority} | ${engine.confidence}` : "",
    `Werdykt: ${displayVerdictLabel(row.investmentVerdict?.label || "Obserwowac")} (${row.investmentVerdict?.confidence || "medium"})`,
    `Score ${row.researchScore?.total ?? "-"} (${fmtChange(delta.scoreChange)}), ranking: ${rankMoveText(delta)}, cena ${fmtPct(delta.priceChangePct)}`,
    `Status ${row.status || "-"} | decyzja: ${decisionLabel(row.decision?.status)} | akcja: ${actionLabel(row.signal?.action)}`,
    truncateLine(reason(row), 220),
    `Dane: ${evidence.length ? evidence.join(" | ") : "brak pelnych danych liczbowych"}`,
    filingEvidence,
    truncateLine(decisionQuestions(row), 220),
    truncateLine(`Czytaj: ${readingLine(row)}`, 320)
  ];
  if (filingBrief) {
    const events = (filingBrief.eventTypes || []).slice(0, 2).map((event) => event.label).join("; ") || filingBrief.formMeaning;
    lines.push(`Filing: ${filingBrief.sentiment} | pilnosc ${filingBrief.urgency} | ${truncateLine(events, 120)}`);
    if (filingDecision) lines.push(`Wniosek filing: ${filingDecision.label} | ${truncateLine(filingDecision.action, 160)}`);
  }
  if (row.investmentVerdict?.blockers?.length) {
    lines.push(`Blokery: ${truncateLine(row.investmentVerdict.blockers.slice(0, 2).map(blockerLabel).join("; "), 180)}`);
  }
  if (engine?.nextStep) lines.push(`Nastepny krok: ${truncateLine(engine.nextStep, 180)}`);
  return lines.filter(Boolean).join("\n");
}

function changeLogBlock(item, index) {
  const row = item.row || {};
  const engine = row.decisionEngine || {};
  const evidence = metricEvidence(row, 5);
  const hasMemo = ["ROZWAZ_WEJSCIE", "SPECULATIVE_ONLY"].includes(engine.category);
  return [
    `${index + 1}. ${item.ticker} ${item.name || row.name || ""}`.trim(),
    `${changeDirectionLabel(item.direction)} | ${item.label || item.type || "zmiana"}`,
    `Przed: ${changeValue(item.previous)} -> teraz: ${changeValue(item.current)}`,
    `Score ${changeValue(item.previousScore)} -> ${changeValue(item.currentScore)} (${fmtChange(item.scoreChange)}), ranking ${changeValue(item.previousRank)} -> ${changeValue(item.currentRank)} (${fmtChange(item.rankChange)})`,
    engine.label ? `Obecnie: ${engine.label} | ${engine.priority || "-"} | akcja: ${actionLabel(row.signal?.action)}` : "",
    evidence.length ? `Dane: ${evidence.join(" | ")}` : "",
    engine.nextStep ? `Nastepny krok: ${truncateLine(engine.nextStep, 180)}` : "",
    hasMemo ? `Memo: ${memoLink(row)}` : "",
    `Historia: ${dashboardUrl}#changeLogView`
  ].filter(Boolean).join("\n");
}

function triageTaskLabel(value) {
  return {
    READ_FILING: "przeczytaj filing",
    REVIEW_RISK: "sprawdz ryzyko",
    REVIEW_MEMO: "sprawdz memo",
    WATCH_TRIGGER: "czekaj na trigger",
    MONITOR: "monitoring"
  }[value] || value || "-";
}

function triageBlock(item, index) {
  const row = item.row || {};
  const engine = row.decisionEngine || {};
  const filingDecision = row.secAnalysis?.filingBrief?.decisionBrief || row.investmentVerdict?.filing?.brief?.decisionBrief;
  const evidence = item.evidence?.length ? item.evidence : metricEvidence(row, 5);
  return [
    `${index + 1}. ${item.ticker} ${item.name || row.name || ""}`.trim(),
    `Zadanie: ${triageTaskLabel(item.task)} | ${item.priority || "-"} | score ${item.score ?? row.researchScore?.total ?? "-"}`,
    `Powod: ${truncateLine(item.triageReason || item.reason || reason(row), 220)}`,
    evidence.length ? `Dane: ${evidence.join(" | ")}` : "",
    item.blockers?.length ? `Blokery: ${truncateLine(item.blockers.slice(0, 2).map(blockerLabel).join("; "), 180)}` : "",
    filingDecision ? `Wniosek filing: ${filingDecision.label} | ${truncateLine(filingDecision.action, 160)}` : "",
    filingDecision?.readSections?.length ? `Czytaj: ${truncateLine(filingDecision.readSections.slice(0, 3).join("; "), 180)}` : "",
    `Nastepny krok: ${truncateLine(item.nextStep || engine.nextStep || "-", 180)}`,
    item.links?.memo ? `Memo: ${dashboardUrl}${item.links.memo}` : "",
    item.links?.sec ? `SEC: ${item.links.sec}` : "",
    `Triage: ${dashboardUrl}#triageView`
  ].filter(Boolean).join("\n");
}

function opportunityBucketLabel(value) {
  return {
    momentum: "momentum",
    qualityPullback: "dobry pullback",
    distressedRebound: "distressed rebound",
    filingCatalyst: "filing catalyst"
  }[value] || value || "-";
}

function opportunityBlock(item, index) {
  const row = item.row || {};
  const links = item.links || {};
  const plan = item.decisionPlan || {};
  const digest = item.todayDigest || {};
  const gate = plan.qualityGate || {};
  const evidence = item.evidence?.length ? item.evidence : metricEvidence(row, 5);
  const filing = item.filingDecision ? `Filing: ${item.filingDecision.label} | ${truncateLine(item.filingDecision.action, 140)}` : "";
  return [
    `${index + 1}. ${item.ticker} ${item.name || row.name || ""}`.trim(),
    `Score szansy ${item.total ?? "-"} | ${opportunityBucketLabel(item.bucket)} | ${item.priority || "-"}`,
    `Werdykt: ${plan.label || item.label || "-"} | ${truncateLine(plan.action || item.nextStep || "-", 150)}`,
    digest.whyNow?.length ? `Dlaczego teraz: ${truncateLine(digest.whyNow.slice(0, 3).join(" | "), 190)}` : "",
    digest.watchRisks?.length ? `Ryzyka: ${truncateLine(digest.watchRisks.slice(0, 3).map(blockerLabel).join(" | "), 180)}` : "",
    gate.status ? `Bramka jakosci: ${gate.status === "PASS" ? "PASS" : gate.status === "PASS_WARUNKOWY" ? "PASS WARUNKOWY" : "DO DOMKNIECIA"}${gate.blockers?.length ? ` | ${truncateLine(gate.blockers.slice(0, 2).join(" | "), 130)}` : ""}${gate.warnings?.length ? ` | ${truncateLine(gate.warnings.slice(0, 2).join(" | "), 130)}` : ""}` : "",
    `Powod: ${truncateLine(item.reason || "-", 190)}`,
    plan.checklist?.length ? `Dane: ${plan.checklist.slice(0, 4).join(" | ")}` : evidence.length ? `Dane: ${evidence.join(" | ")}` : "",
    plan.triggers?.length ? `Trigger: ${truncateLine(plan.triggers.slice(0, 2).join("; "), 180)}` : "",
    plan.riskGuards?.length ? `Ryzyka: ${truncateLine(plan.riskGuards.slice(0, 2).map(blockerLabel).join("; "), 160)}` : "",
    filing,
    item.blockers?.length ? `Blokery: ${truncateLine(item.blockers.slice(0, 2).map(blockerLabel).join("; "), 160)}` : "",
    plan.readFirst?.length ? `Czytaj: ${truncateLine(plan.readFirst.slice(0, 4).join("; "), 170)}` : "",
    links.memo ? `Memo: ${dashboardUrl}${links.memo}` : "",
    links.deepDive ? `Deep: ${dashboardUrl}${links.deepDive}` : "",
    `Szanse: ${dashboardUrl}#opportunityView`
  ].filter(Boolean).join("\n");
}

function todayDecisionBlock(item, index) {
  return opportunityBlock(item, index).replace(`Szanse: ${dashboardUrl}#opportunityView`, `Dzisiaj: ${dashboardUrl}#todayDecisionView`);
}

function todayDecisionChangeBlock(item, index) {
  const verdictChange = item.previousLabel ? ` | ${item.previousLabel} -> ${item.label || "-"}` : "";
  return [
    `${index + 1}. ${item.ticker} ${item.name || ""}`.trim(),
    `${item.changeType || "zmiana"}${verdictChange}`,
    `Score ${item.score ?? "-"} | waga dzis ${item.todayWeight ?? "-"}`,
    item.whyNow?.length ? `Dlaczego: ${truncateLine(item.whyNow.slice(0, 2).join(" | "), 170)}` : "",
    item.watchRisks?.length ? `Ryzyka: ${truncateLine(item.watchRisks.slice(0, 2).map(blockerLabel).join(" | "), 160)}` : "",
    `Dzisiaj: ${dashboardUrl}#todayDecisionView`
  ].filter(Boolean).join("\n");
}

function decisionPackageBlock(item, index) {
  const gate = item.qualityGate || {};
  const gateLabel = gate.status === "PASS" ? "PASS" : gate.status === "PASS_WARUNKOWY" ? "PASS WARUNKOWY" : "DO DOMKNIECIA";
  return [
    `${index + 1}. ${item.ticker} ${item.name || ""}`.trim(),
    `${item.decisionLabel || "-"} | score ${item.score ?? "-"} | ${gateLabel}`,
    `Interpretacja: ${truncateLine(item.interpretation || "-", 170)}`,
    item.bullCase?.length ? `Bull: ${truncateLine(item.bullCase.slice(0, 2).join(" | "), 170)}` : "",
    item.bearCase?.length ? `Bear: ${truncateLine(item.bearCase.slice(0, 2).map(blockerLabel).join(" | "), 170)}` : "",
    item.entryConditions?.length ? `Wejscie: ${truncateLine(item.entryConditions.slice(0, 2).join(" | "), 170)}` : "",
    item.rejectConditions?.length ? `Odrzuc: ${truncateLine(item.rejectConditions.slice(0, 2).map(blockerLabel).join(" | "), 170)}` : "",
    `Pakiet: ${dashboardUrl}#decisionPackagesView`
  ].filter(Boolean).join("\n");
}

function sectionBlock(section) {
  const header = [`[${section.title}]`, section.subtitle].join("\n");
  const rows = section.kind === "todayDecisionChanges"
    ? section.rows.map(todayDecisionChangeBlock).join("\n\n")
    : section.kind === "decisionPackages"
    ? section.rows.map(decisionPackageBlock).join("\n\n")
    : section.kind === "todayDecision"
    ? section.rows.map(todayDecisionBlock).join("\n\n")
    : section.kind === "changeLog"
    ? section.rows.map(changeLogBlock).join("\n\n")
    : section.kind === "triage"
      ? section.rows.map(triageBlock).join("\n\n")
      : section.kind === "opportunity"
        ? section.rows.map(opportunityBlock).join("\n\n")
      : section.rows.map(alertBlock).join("\n\n");
  return `${header}\n\n${rows}`;
}

function sectionRowBlocks(section) {
  const rows = section.kind === "todayDecisionChanges"
    ? section.rows.map(todayDecisionChangeBlock)
    : section.kind === "decisionPackages"
    ? section.rows.map(decisionPackageBlock)
    : section.kind === "todayDecision"
    ? section.rows.map(todayDecisionBlock)
    : section.kind === "changeLog"
    ? section.rows.map(changeLogBlock)
    : section.kind === "triage"
      ? section.rows.map(triageBlock)
      : section.kind === "opportunity"
        ? section.rows.map(opportunityBlock)
      : section.rows.map(alertBlock);
  return rows.map((row, index) => {
    const title = index === 0 ? `[${section.title}]` : `[${section.title} cd.]`;
    return `${[title, section.subtitle].filter(Boolean).join("\n")}\n\n${row}`;
  });
}

function paperActivityItems(snapshot) {
  return (snapshot.verdictPerformance?.paperPortfolio?.activity || [])
    .filter((item) => ["FILLED_BUY", "FILLED_SELL", "CANCELLED", "RISK_BREACH", "REVIEW_DUE"].includes(item.type));
}

function paperActivityLine(item, index) {
  if (item.type === "FILLED_BUY") {
    return `${index + 1}. ${item.ticker} WEJSCIE @ ${fmtNumber(item.price, 2)} | ${fmtNumber(item.allocationPct, 1)}% portfela | stop ${fmtNumber(item.stopPrice, 2)}`;
  }
  if (item.type === "FILLED_SELL") {
    const scope = item.fraction < 1 ? `redukcja ${Math.round(item.fraction * 100)}%` : "pelne wyjscie";
    return `${index + 1}. ${item.ticker} ${scope} @ ${fmtNumber(item.price, 2)} | wynik ${fmtPct(item.returnPct)} | ${item.reason || "-"}`;
  }
  if (item.type === "CANCELLED") {
    const gap = Number.isFinite(item.gapPct) ? ` | luka ${fmtPct(item.gapPct)}` : "";
    return `${index + 1}. ${item.ticker} ANULOWANE | ${item.reason || "limit ryzyka"}${gap}`;
  }
  if (item.type === "RISK_BREACH") {
    return `${index + 1}. ${item.ticker} STOP NARUSZONY | cena ${fmtNumber(item.currentPrice, 2)} <= ${fmtNumber(item.stopPrice, 2)} | wyjscie na kolejnym otwarciu`;
  }
  return `${index + 1}. ${item.ticker} PRZEGLAD | ${item.sessionsHeld || "-"} sesji od wejscia`;
}

function paperActivityBlock(snapshot, limit = 6) {
  const items = paperActivityItems(snapshot).slice(0, limit);
  if (!items.length) return "";
  return [
    "Paper portfolio - wykonanie",
    ...items.map(paperActivityLine),
    `${dashboardUrl}#riskView`
  ].join("\n");
}

function buildMessages(snapshot, sections) {
  const alertCount = sections.reduce((count, section) => count + section.rows.length, 0);
  const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "-";
  const guard = healthPrefix(snapshot, sections);
  const header = [
    "Stock Radar - alerty",
    `Aktualizacja: ${generated}`,
    `Universe: ${(snapshot.rows || []).length} spolek | ${alertCount} alertow w ${sections.length} sekcjach`,
    `Dashboard: ${dashboardUrl}#alertsView`
  ].join("\n");
  const footer = "Material researchowy, nie rekomendacja inwestycyjna.";
  const blocks = [guard, paperActivityBlock(snapshot), ...sections.flatMap(sectionRowBlocks)].filter(Boolean);
  const bodyLimit = Math.max(900, telegramChunkLimit - 160);
  const chunks = [];
  let current = header;

  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > bodyLimit && current !== header) {
      chunks.push(current);
      const next = `${header}\n\n${block}`;
      current = next.length > bodyLimit
        ? `${header}\n\n${truncateBlock(block, bodyLimit - header.length - 4)}`
        : next;
    } else if (candidate.length > bodyLimit) {
      chunks.push(`${header}\n\n${truncateBlock(block, bodyLimit - header.length - 4)}`);
      current = header;
    } else {
      current = candidate;
    }
  }
  if (current !== header || !chunks.length) chunks.push(current);

  return chunks.map((chunk, index) => {
    const part = chunks.length > 1 ? `Czesc ${index + 1}/${chunks.length}\n` : "";
    const suffix = index === chunks.length - 1 ? `\n\n${footer}` : "";
    return `${part}${chunk}${suffix}`;
  });
}

function verdictIcon(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("gotowe") || text.includes("kandydat")) return "OK";
  if (text.includes("wstrzymaj") || text.includes("czek")) return "WAIT";
  if (text.includes("odrzuc") || text.includes("nie wchodz")) return "NO";
  return "WATCH";
}

function ageHours(isoDate) {
  if (!isoDate) return NaN;
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return NaN;
  return (Date.now() - timestamp) / 36e5;
}

function fmtAge(hours) {
  if (!Number.isFinite(hours)) return "brak daty";
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`;
  return `${hours.toFixed(1)} h`;
}

function healthPrefix(snapshot, sections) {
  const rows = snapshot.rows || [];
  const coverage = snapshot.fmpCoverage || {};
  const loaded = coverage.loaded || {};
  const rowCount = rows.length;
  const snapshotAge = ageHours(snapshot.generatedAt);
  const priceErrors = rows.filter((row) => row.error || !Number.isFinite(row.metrics?.price)).length;
  const fmpProfile = loaded.profile || rows.filter((row) => row.fundamentalsProvider === "fmp" || row.fundamentals?.source === "fmp").length;
  const decisionItems = snapshot.decisionPackages?.items?.length
    || sections.find((section) => section.kind === "decisionPackages")?.rows?.length
    || 0;
  const disabled = [...new Set([...(coverage.disabledEndpoints || []), ...(coverage.likelyUnavailableEndpoints || [])])];
  const checks = [
    {
      bad: !Number.isFinite(snapshotAge) || snapshotAge > 54,
      warn: Number.isFinite(snapshotAge) && snapshotAge > 30,
      text: `Dane: ${fmtAge(snapshotAge)} od ostatniego snapshotu`
    },
    {
      bad: rowCount < 50,
      warn: rowCount < 200,
      text: `Universe: tylko ${rowCount} spolek`
    },
    {
      bad: priceErrors > 5,
      warn: priceErrors > 0,
      text: `Ceny: ${priceErrors} brakow/bledow`
    },
    {
      bad: !coverage.enabled || fmpProfile < rowCount * 0.65,
      warn: fmpProfile < rowCount * 0.9,
      text: `FMP profile: ${fmpProfile}/${rowCount}`
    },
    {
      bad: decisionItems === 0,
      warn: decisionItems > 0 && decisionItems < 3,
      text: `Pakiety decyzji: ${decisionItems}`
    },
    {
      bad: false,
      warn: disabled.length > 0,
      text: `FMP endpointy niedostepne: ${disabled.slice(0, 5).join(", ")}`
    }
  ];
  const bad = checks.filter((check) => check.bad);
  const warn = checks.filter((check) => !check.bad && check.warn);
  if (!bad.length && !warn.length) return "";
  const status = bad.length ? "PROBLEM" : "UWAGA";
  const lines = [
    `Status pipeline'u: ${status}`,
    ...bad.map((check) => `PROBLEM: ${check.text}`),
    ...warn.map((check) => `UWAGA: ${check.text}`),
    status === "PROBLEM" ? "Najpierw sprawdz status danych, dopiero potem ranking." : "",
    `Status: ${dashboardUrl}#statusView`
  ].filter(Boolean);
  return lines.join("\n");
}

function compactRiskLine(values, limit = 2) {
  return (values || [])
    .filter(Boolean)
    .slice(0, limit)
    .map(blockerLabel)
    .map((value) => truncateLine(value, 82))
    .join("; ");
}

function decisionBriefConfidence(row, bucket) {
  const score = row.researchScore?.total ?? 0;
  const blockers = row.investmentVerdict?.blockers || [];
  const filingBrief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const engineConfidence = row.decisionEngine?.confidence || row.investmentVerdict?.confidence || "medium";
  let value = 40;
  if (score >= 85) value += 22;
  else if (score >= 75) value += 16;
  else if (score >= 65) value += 10;
  else if (score < 45) value -= 10;
  if (engineConfidence === "high") value += 14;
  if (engineConfidence === "medium") value += 7;
  if (row.sec?.newFilings?.length) value += 8;
  if (row.decisionEngine?.priority === "P1") value += 8;
  if (row.decisionEngine?.priority === "P2") value += 4;
  if (bucket === "KANDYDAT" && blockers.length) value -= blockers.length * 12;
  if (bucket === "WSTRZYMAJ" && blockers.length) value += Math.min(14, blockers.length * 7);
  if (bucket === "ODRZUC" && blockers.length) value += Math.min(18, blockers.length * 9);
  if (bucket === "OBSERWUJ") value -= 4;
  if (filingBrief?.urgency === "high" && bucket === "KANDYDAT") value -= 14;
  if (filingBrief?.urgency === "high" && bucket !== "KANDYDAT") value += 8;
  const confidenceScore = Math.max(0, Math.min(100, Math.round(value)));
  const confidence = confidenceScore >= 75 ? "high" : confidenceScore >= 55 ? "medium" : "low";
  return { confidence, confidenceScore };
}

function decisionBriefVerdict(row) {
  if (row.concreteVerdict?.action) {
    const bucket = row.concreteVerdict.action === "INWESTUJ" ? "KANDYDAT"
      : row.concreteVerdict.action === "ODRZUC" ? "ODRZUC"
        : "WSTRZYMAJ";
    return {
      bucket,
      label: row.concreteVerdict.label || `MODEL: ${row.concreteVerdict.action}`,
      confidence: row.concreteVerdict.confidence || "medium",
      confidenceScore: row.concreteVerdict.confidenceScore ?? null,
      reason: blockerLabel(row.concreteVerdict.reason || "brak uzasadnienia"),
      next: blockerLabel(row.concreteVerdict.nextStep || "pozostaw w monitoringu")
    };
  }
  if (row.decisionBrief?.briefVerdict) {
    return {
      bucket: row.decisionBrief.briefVerdict,
      label: String(row.decisionBrief.briefLabel || row.decisionBrief.briefVerdict).toUpperCase(),
      confidence: row.decisionBrief.confidence || "medium",
      confidenceScore: row.decisionBrief.confidenceScore ?? null,
      reason: blockerLabel(row.decisionBrief.briefReason || "brak uzasadnienia"),
      next: blockerLabel(row.decisionBrief.briefNextStep || "pozostaw w monitoringu")
    };
  }
  const score = row.researchScore?.total ?? 0;
  const action = row.signal?.action || "";
  const verdict = row.investmentVerdict?.verdict || "";
  const blockers = row.investmentVerdict?.blockers || [];
  const filingBrief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const positives = row.investmentVerdict?.reasons || row.researchScore?.positives || [];
  if (verdict === "NIE_INWESTOWAC_TERAZ" || verdict === "ODRZUCIC") {
    const confidence = decisionBriefConfidence(row, "ODRZUC");
    return {
      bucket: "ODRZUC",
      label: "ODRZUC NA TERAZ",
      ...confidence,
      reason: blockers.slice(0, 2).map(blockerLabel).join("; ") || "blokery sa silniejsze niz setup",
      next: "wroc dopiero po poprawie filingow, bilansu albo momentum"
    };
  }
  if (action === "REVIEW_RISK" || action === "DO_NOT_CHASE" || blockers.length >= 2 || filingBrief?.urgency === "high") {
    const confidence = decisionBriefConfidence(row, "WSTRZYMAJ");
    return {
      bucket: "WSTRZYMAJ",
      label: "WSTRZYMAJ",
      ...confidence,
      reason: blockers.slice(0, 2).map(blockerLabel).join("; ") || filingBrief?.summary || "najpierw ryzyko",
      next: filingBrief?.researchAction || "sprawdz czerwone flagi: cash flow, zadluzenie, rozwodnienie, guidance"
    };
  }
  if ((verdict === "KANDYDAT" || verdict === "WARTO_ANALIZOWAC" || score >= 80) && blockers.length <= 1) {
    const confidence = decisionBriefConfidence(row, "KANDYDAT");
    return {
      bucket: "KANDYDAT",
      label: "KANDYDAT",
      ...confidence,
      reason: positives.slice(0, 2).map(blockerLabel).join("; ") || `wysoki score ${score}`,
      next: filingBrief?.researchAction || "sprawdz filing, marze, wzrost, cash flow i wycene"
    };
  }
  const confidence = decisionBriefConfidence(row, "OBSERWUJ");
  return {
    bucket: "OBSERWUJ",
    label: "OBSERWUJ",
    ...confidence,
    reason: filingBrief?.summary || (row.signal?.alerts || []).slice(0, 2).map(blockerLabel).join("; ") || row.thesis || "brak pilnej akcji",
    next: "czekaj na wynik, filing, trigger ceny albo poprawe momentum"
  };
}

function decisionBriefRows(snapshot, limit = 6) {
  const rows = snapshot.rows || [];
  const packageTickers = new Set((snapshot.decisionPackages?.items || []).map((item) => item.ticker));
  const todayTickers = new Set((snapshot.todayDecisionQueue?.items || []).map((item) => item.ticker));
  const triageTickers = new Set((snapshot.triageQueue?.today || snapshot.triageQueue?.buckets?.TODAY || []).map((item) => item.ticker));
  const bucketRank = { KANDYDAT: 4, WSTRZYMAJ: 3, OBSERWUJ: 2, ODRZUC: 1 };
  const ranked = rows
    .map((row) => {
      const verdict = decisionBriefVerdict(row);
      const score = row.researchScore?.total ?? 0;
      const weight = score
        + (packageTickers.has(row.ticker) ? 45 : 0)
        + (todayTickers.has(row.ticker) ? 35 : 0)
        + (triageTickers.has(row.ticker) ? 25 : 0)
        + (row.sec?.newFilings?.length ? 25 : 0)
        + (row.secAnalysis?.filingBrief?.urgency === "high" ? 20 : 0)
        + (row.catalystAssessment?.urgency === "high" ? 30 : 0)
        + (row.postEarnings?.status === "ANALYZED" ? 35 : row.postEarnings ? 20 : 0)
        + Math.min(12, Math.abs(row.catalystAssessment?.score || 0))
        + (bucketRank[verdict.bucket] || 0) * 8;
      return { row, verdict, weight };
    })
    .sort((a, b) => b.weight - a.weight || (b.row.researchScore?.total || 0) - (a.row.researchScore?.total || 0));
  const quotas = [
    ["KANDYDAT", 2],
    ["WSTRZYMAJ", 2],
    ["OBSERWUJ", 1],
    ["ODRZUC", 1]
  ];
  const picked = [];
  const used = new Set();
  for (const [bucket, quota] of quotas) {
    for (const item of ranked.filter((candidate) => candidate.verdict.bucket === bucket)) {
      if (picked.filter((candidate) => candidate.verdict.bucket === bucket).length >= quota || picked.length >= limit) break;
      if (used.has(item.row.ticker)) continue;
      used.add(item.row.ticker);
      picked.push(item);
    }
  }
  for (const item of ranked) {
    if (picked.length >= limit) break;
    if (used.has(item.row.ticker)) continue;
    used.add(item.row.ticker);
    picked.push(item);
  }
  return picked;
}

function compactDecisionBriefLine(item, index) {
  const row = item.row;
  const verdict = item.verdict;
  const facts = metricEvidence(row, 3).join(" | ");
  const filing = latestFiling(row);
  const catalyst = row.catalystAssessment;
  const catalystText = catalyst?.nextEvent || Math.abs(catalyst?.score || 0) >= 6
    ? [
      catalyst.nextEvent && Number.isFinite(catalyst.daysToEvent) ? `wyniki za ${catalyst.daysToEvent}d` : null,
      `score ${catalyst.score ?? 0}`,
      catalyst.risks?.[0] || catalyst.positives?.[0]
    ].filter(Boolean).join(" | ")
    : "";
  const post = row.postEarnings;
  const postText = post ? [
    `ocena ${post.score ?? "-"}/100`,
    Number.isFinite(post.result?.epsSurprisePct) ? `EPS ${fmtPct(post.result.epsSurprisePct)}` : null,
    Number.isFinite(post.result?.revenueSurprisePct) ? `rev ${fmtPct(post.result.revenueSurprisePct)}` : null,
    post.guidance?.label,
    Number.isFinite(post.priceReaction?.changePct) ? `kurs ${fmtPct(post.priceReaction.changePct)}` : null
  ].filter(Boolean).join(" | ") : "";
  return [
    `${index + 1}. ${row.ticker} ${verdictIcon(verdict.label)} ${verdict.label} | score ${row.researchScore?.total ?? "-"} | pewnosc ${verdict.confidence || "-"} ${verdict.confidenceScore ?? "-"}/100`,
    `   powod: ${truncateLine(verdict.reason, 92)}`,
    `   teraz: ${truncateLine(verdict.next, 92)}`,
    facts ? `   dane: ${facts}` : "",
    catalystText ? `   katalizator: ${truncateLine(catalystText, 92)}` : "",
    postText ? `   po wynikach: ${truncateLine(postText, 92)}` : "",
    filing ? `   filing: ${filing.form || "SEC"} ${filing.filingDate || ""}`.trimEnd() : ""
  ].filter(Boolean).join("\n");
}

function tightDecisionBriefLine(item, index) {
  const row = item.row;
  const catalyst = row.catalystAssessment;
  const event = catalyst?.nextEvent && Number.isFinite(catalyst.daysToEvent) ? ` | wyniki ${catalyst.daysToEvent}d` : "";
  return `${index + 1}. ${row.ticker} ${verdictIcon(item.verdict.label)} ${item.verdict.label} | ${row.researchScore?.total ?? "-"} | p ${item.verdict.confidenceScore ?? "-"}${event} | ${truncateLine(item.verdict.reason, 72)}`;
}

function compactDecisionLine(item, index) {
  const gate = item.qualityGate || item.decisionPlan?.qualityGate || {};
  const gateLabel = gate.status === "PASS" ? "PASS" : gate.status === "PASS_WARUNKOWY" ? "WARUNKOWO" : gate.status ? "DO DOMK." : "";
  const risks = compactRiskLine([...(item.bearCase || []), ...(gate.blockers || []), ...(gate.warnings || [])]);
  const label = item.decisionLabel || item.decisionPlan?.label || item.label || "-";
  return [
    `${index + 1}. ${item.ticker} ${verdictIcon(label)} ${label} | score ${item.score ?? item.total ?? "-"}${gateLabel ? ` | ${gateLabel}` : ""}`,
    item.entryConditions?.[0] ? `   trigger: ${truncateLine(item.entryConditions[0], 92)}` : "",
    risks ? `   ryzyko: ${risks}` : ""
  ].filter(Boolean).join("\n");
}

function tightDecisionLine(item, index) {
  const gate = item.qualityGate || item.decisionPlan?.qualityGate || {};
  const gateLabel = gate.status === "PASS" ? "PASS" : gate.status === "PASS_WARUNKOWY" ? "WARUNKOWO" : gate.status ? "DO DOMK." : "";
  const label = item.decisionLabel || item.decisionPlan?.label || item.label || "-";
  const risk = compactRiskLine([...(item.bearCase || []), ...(gate.blockers || []), ...(gate.warnings || [])], 1);
  return `${index + 1}. ${item.ticker} ${verdictIcon(label)} ${label} | ${item.score ?? item.total ?? "-"}${gateLabel ? ` | ${gateLabel}` : ""}${risk ? ` | ryzyko: ${risk}` : ""}`;
}

function compactTodayLine(item, index) {
  const risks = compactRiskLine(item.watchRisks || item.decisionPlan?.qualityGate?.warnings || []);
  const label = item.decisionPlan?.label || item.label || "-";
  return [
    `${index + 1}. ${item.ticker} ${verdictIcon(label)} ${label} | score ${item.total ?? item.score ?? "-"} | ${item.priority || "-"}`,
    item.todayDigest?.whyNow?.[0] || item.whyNow?.[0] ? `   powód: ${truncateLine(item.todayDigest?.whyNow?.[0] || item.whyNow?.[0], 96)}` : "",
    risks ? `   ryzyko: ${risks}` : ""
  ].filter(Boolean).join("\n");
}

function compactChangeLine(item, index) {
  const direction = changeDirectionLabel(item.direction);
  return `${index + 1}. ${item.ticker} ${direction} | score ${changeValue(item.previousScore)} -> ${changeValue(item.currentScore)} (${fmtChange(item.scoreChange)}) | rank ${changeValue(item.previousRank)} -> ${changeValue(item.currentRank)}`;
}

function compactTriageLine(item, index) {
  const risk = compactRiskLine(item.blockers || [], 1);
  return [
    `${index + 1}. ${item.ticker} ${triageTaskLabel(item.task)} | ${item.priority || "-"} | score ${item.score ?? "-"}`,
    risk ? `   blokada: ${risk}` : item.triageReason ? `   powód: ${truncateLine(item.triageReason, 96)}` : ""
  ].filter(Boolean).join("\n");
}

function buildTightBriefMessage(snapshot, sections) {
  const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "-";
  const findSection = (kind) => sections.find((section) => section.kind === kind)?.rows || [];
  const alertCount = sections.reduce((count, section) => count + section.rows.length, 0);
  const guard = healthPrefix(snapshot, sections);
  const paperActivity = paperActivityBlock(snapshot, 4);
  const packageRows = findSection("decisionPackages").slice(0, 3);
  const decisionRows = decisionBriefRows(snapshot, 6);
  const triageRows = findSection("triage").slice(0, 2);
  const changeRows = findSection("todayDecisionChanges").slice(0, 2);
  const opportunityRows = findSection("opportunity").slice(0, 2);
  const lines = [
    "Stock Radar - brief",
    `Aktualizacja: ${generated}`,
    `Universe: ${(snapshot.rows || []).length} spolek | sygnaly: ${alertCount}`,
    `Dashboard: ${dashboardUrl}`,
    guard,
    paperActivity,
    "",
    decisionRows.length ? "Do decyzji" : "",
    ...decisionRows.map(tightDecisionBriefLine),
    decisionRows.length ? `${dashboardUrl}#decisionBriefView` : "",
    "",
    packageRows.length ? "Pakiety decyzji" : "",
    ...packageRows.map(tightDecisionLine),
    packageRows.length ? `${dashboardUrl}#decisionPackagesView` : "",
    "",
    triageRows.length ? "Blokery / filing" : "",
    ...triageRows.map((item, index) => {
      const risk = compactRiskLine(item.blockers || [], 1);
      return `${index + 1}. ${item.ticker} ${triageTaskLabel(item.task)} | ${item.priority || "-"} | ${item.score ?? "-"}${risk ? ` | ${risk}` : ""}`;
    }),
    triageRows.length ? `${dashboardUrl}#triageView` : "",
    "",
    changeRows.length ? "Zmiany dzisiaj" : "",
    ...changeRows.map((item, index) => `${index + 1}. ${item.ticker} ${item.changeType || item.label || "zmiana"} | score ${item.score ?? "-"}`),
    changeRows.length ? `${dashboardUrl}#todayDecisionView` : "",
    "",
    opportunityRows.length ? "Top szanse" : "",
    ...opportunityRows.map((item, index) => {
      const label = item.decisionPlan?.label || item.label || "-";
      return `${index + 1}. ${item.ticker} ${verdictIcon(label)} ${label} | ${item.total ?? "-"} | ${item.priority || "-"}`;
    }),
    opportunityRows.length ? `${dashboardUrl}#opportunityView` : "",
    "",
    "Material researchowy, nie rekomendacja inwestycyjna."
  ].filter((line, index, all) => line || (all[index - 1] && all[index + 1]));
  return lines.join("\n");
}

function buildBriefMessages(snapshot, sections) {
  const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "-";
  const findSection = (kind) => sections.find((section) => section.kind === kind)?.rows || [];
  const changeRows = findSection("todayDecisionChanges").slice(0, 3);
  const packageRows = findSection("decisionPackages").slice(0, 3);
  const todayRows = findSection("todayDecision").slice(0, 3);
  const triageRows = findSection("triage").slice(0, 3);
  const changeLogRows = findSection("changeLog").slice(0, 2);
  const opportunityRows = findSection("opportunity").slice(0, 3);
  const alertCount = sections.reduce((count, section) => count + section.rows.length, 0);
  const guard = healthPrefix(snapshot, sections);
  const paperActivity = paperActivityBlock(snapshot);
  const decisionRows = decisionBriefRows(snapshot, 6);

  const blocks = [
    [
      "Stock Radar - brief",
      `Aktualizacja: ${generated}`,
      `Universe: ${(snapshot.rows || []).length} spolek | sygnaly: ${alertCount}`,
      `Dashboard: ${dashboardUrl}`
    ].join("\n"),
    guard,
    paperActivity,
    decisionRows.length ? ["Do decyzji", ...decisionRows.map(compactDecisionBriefLine), `${dashboardUrl}#decisionBriefView`].join("\n") : "",
    changeRows.length ? ["Dzisiaj - zmiany", ...changeRows.map(compactTodayLine)].join("\n") : "",
    packageRows.length ? ["Pakiety decyzji", ...packageRows.map(compactDecisionLine), `${dashboardUrl}#decisionPackagesView`].join("\n") : "",
    todayRows.length ? ["Kolejka na dzis", ...todayRows.map(compactTodayLine), `${dashboardUrl}#todayDecisionView`].join("\n") : "",
    triageRows.length ? ["Blokery / filing", ...triageRows.map(compactTriageLine), `${dashboardUrl}#triageView`].join("\n") : "",
    changeLogRows.length ? ["Duze zmiany", ...changeLogRows.map(compactChangeLine), `${dashboardUrl}#changeLogView`].join("\n") : "",
    opportunityRows.length ? ["Top szanse", ...opportunityRows.map(compactTodayLine), `${dashboardUrl}#opportunityView`].join("\n") : "",
    "Material researchowy, nie rekomendacja inwestycyjna."
  ].filter(Boolean);

  const message = blocks.join("\n\n");
  if (message.length <= telegramChunkLimit) return [message];
  const tight = buildTightBriefMessage(snapshot, sections);
  if (tight.length <= telegramChunkLimit) return [tight];
  const chunks = [];
  let current = blocks[0];
  const footer = blocks[blocks.length - 1];
  for (const block of blocks.slice(1, -1)) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > telegramChunkLimit && current) {
      chunks.push(current);
      current = block.length > telegramChunkLimit ? truncateBlock(block, telegramChunkLimit - 20) : block;
    } else {
      current = candidate;
    }
  }
  const finalCandidate = `${current}\n\n${footer}`;
  if (finalCandidate.length <= telegramChunkLimit) {
    chunks.push(finalCandidate);
  } else {
    chunks.push(current);
    chunks.push(footer);
  }
  return chunks.map((chunk, index) => chunks.length > 1 ? `Brief ${index + 1}/${chunks.length}\n${chunk}` : chunk);
}

async function sendTelegram(message) {
  if (process.env.TELEGRAM_DRY_RUN === "1") {
    console.log(message);
    return true;
  }
  if (!token || !chatId) {
    console.log("Telegram skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram send failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  console.log("Telegram alert sent");
  return true;
}

async function run() {
  const snapshot = parseMonitoringData();
  const sections = buildAlertSections(snapshot);
  const alertCount = sections.reduce((count, section) => count + section.rows.length, 0);
  const paperActivityCount = paperActivityItems(snapshot).length;
  if (!alertCount && !paperActivityCount) {
    console.log(`Telegram skipped: no alerts at min score ${minScore}`);
    return;
  }
  const messages = telegramMode === "full" ? buildMessages(snapshot, sections) : buildBriefMessages(snapshot, sections);
  let sent = 0;
  for (const message of messages) {
    if (await sendTelegram(message)) sent += 1;
  }
  console.log(`Telegram alert chunks sent: ${sent}/${messages.length}`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildAlertSections,
  buildBriefMessages,
  buildMessages,
  healthPrefix,
  parseMonitoringData
};

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minScore = Number.isFinite(Number(process.env.TELEGRAM_MIN_SCORE)) ? Number(process.env.TELEGRAM_MIN_SCORE) : 75;
const maxAlerts = Number.isFinite(Number(process.env.TELEGRAM_MAX_ALERTS)) ? Number(process.env.TELEGRAM_MAX_ALERTS) : 12;
const maxPerSection = Number.isFinite(Number(process.env.TELEGRAM_MAX_PER_SECTION)) ? Number(process.env.TELEGRAM_MAX_PER_SECTION) : Math.max(3, Math.ceil(maxAlerts / 4));
const maxChangeLogItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_CHANGE_LOG)) ? Number(process.env.TELEGRAM_MAX_CHANGE_LOG) : 4;
const maxTodayChangeItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_TODAY_CHANGES)) ? Number(process.env.TELEGRAM_MAX_TODAY_CHANGES) : 4;
const maxTodayDecisionItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_TODAY_DECISIONS)) ? Number(process.env.TELEGRAM_MAX_TODAY_DECISIONS) : 5;
const maxTriageItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_TRIAGE)) ? Number(process.env.TELEGRAM_MAX_TRIAGE) : 6;
const maxOpportunityItems = Number.isFinite(Number(process.env.TELEGRAM_MAX_OPPORTUNITIES)) ? Number(process.env.TELEGRAM_MAX_OPPORTUNITIES) : 4;
const telegramChunkLimit = Number.isFinite(Number(process.env.TELEGRAM_CHUNK_LIMIT)) ? Number(process.env.TELEGRAM_CHUNK_LIMIT) : 2800;

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

function sectionBlock(section) {
  const header = [`[${section.title}]`, section.subtitle].join("\n");
  const rows = section.kind === "todayDecisionChanges"
    ? section.rows.map(todayDecisionChangeBlock).join("\n\n")
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

function buildMessages(snapshot, sections) {
  const alertCount = sections.reduce((count, section) => count + section.rows.length, 0);
  const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "-";
  const header = [
    "Stock Radar - alerty",
    `Aktualizacja: ${generated}`,
    `Universe: ${(snapshot.rows || []).length} spolek | ${alertCount} alertow w ${sections.length} sekcjach`,
    `Dashboard: ${dashboardUrl}#alertsView`
  ].join("\n");
  const footer = "Material researchowy, nie rekomendacja inwestycyjna.";
  const blocks = sections.flatMap(sectionRowBlocks);
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
  if (!alertCount) {
    console.log(`Telegram skipped: no alerts at min score ${minScore}`);
    return;
  }
  const messages = buildMessages(snapshot, sections);
  let sent = 0;
  for (const message of messages) {
    if (await sendTelegram(message)) sent += 1;
  }
  console.log(`Telegram alert chunks sent: ${sent}/${messages.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

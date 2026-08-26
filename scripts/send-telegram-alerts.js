const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minScore = Number.isFinite(Number(process.env.TELEGRAM_MIN_SCORE)) ? Number(process.env.TELEGRAM_MIN_SCORE) : 75;
const maxAlerts = Number.isFinite(Number(process.env.TELEGRAM_MAX_ALERTS)) ? Number(process.env.TELEGRAM_MAX_ALERTS) : 12;
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

function translateReason(text) {
  return String(text || "-")
    .replace(/Drawdown from 52w high below -20%/g, "spadek od maksimum 52 tyg. ponizej -20%")
    .replace(/Drawdown from 52w high below -12%/g, "spadek od maksimum 52 tyg. ponizej -12%")
    .replace(/20d momentum below -8%/g, "slabe momentum 20 dni ponizej -8%")
    .replace(/60d annualized volatility above 45%/g, "podwyzszona zmiennosc 60 dni")
    .replace(/60d annualized volatility above 55%/g, "wysoka zmiennosc 60 dni")
    .replace(/Beta above 1.6/g, "beta powyzej 1.6")
    .replace(/Near 52w high/g, "blisko maksimum 52 tyg.")
    .replace(/No price data/g, "brak danych cenowych")
    .replace(/Fetch failed/g, "pobranie danych nieudane");
}

function blockerLabel(text) {
  return translateReason(String(text || "-").replace(/akcja systemowa ([A-Z_]+)/g, (_, action) => `akcja systemowa: ${actionLabel(action)}`));
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
  if (row.sec?.newFilings?.length) parts.push(`SEC: ${[...new Set(row.sec.newFilings.map((filing) => filing.form))].join(", ")}`);
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

function pickAlerts(snapshot) {
  return (snapshot.rows || [])
    .map((row) => ({ row, weight: alertWeight(row) }))
    .filter(({ row, weight }) => weight > 0 && ((row.researchScore?.total ?? 0) >= minScore || row.historyDelta?.actionChanged || row.historyDelta?.decisionChanged || row.sec?.newFilings?.length || row.signal?.alerts?.length))
    .sort((a, b) => b.weight - a.weight || (b.row.researchScore?.total ?? 0) - (a.row.researchScore?.total ?? 0))
    .slice(0, maxAlerts)
    .map(({ row }) => row);
}

function alertBlock(row, index) {
  const delta = row.historyDelta || {};
  const lines = [
    `${index + 1}. ${row.ticker} ${row.name || ""}`.trim(),
    `Werdykt: ${row.investmentVerdict?.label || "Obserwowac"} (${row.investmentVerdict?.confidence || "medium"})`,
    `Score ${row.researchScore?.total ?? "-"} (${fmtChange(delta.scoreChange)}), ranking: ${rankMoveText(delta)}, cena ${fmtPct(delta.priceChangePct)}`,
    `Status ${row.status || "-"} | decyzja: ${decisionLabel(row.decision?.status)} | akcja: ${actionLabel(row.signal?.action)}`,
    truncateLine(reason(row), 220)
  ];
  if (row.investmentVerdict?.blockers?.length) {
    lines.push(`Blokery: ${truncateLine(row.investmentVerdict.blockers.slice(0, 2).map(blockerLabel).join("; "), 180)}`);
  }
  return lines.join("\n");
}

function buildMessages(snapshot, alerts) {
  const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "-";
  const header = [
    "Stock Radar - alerty",
    `Aktualizacja: ${generated}`,
    `Universe: ${(snapshot.rows || []).length} spolek | wysylka top ${alerts.length}`,
    `Dashboard: ${dashboardUrl}#alertsView`
  ].join("\n");
  const footer = "Material researchowy, nie rekomendacja inwestycyjna.";
  const blocks = alerts.map(alertBlock);
  const chunks = [];
  let current = header;

  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > telegramChunkLimit && current !== header) {
      chunks.push(current);
      current = `${header}\n\n${block}`;
    } else if (candidate.length > telegramChunkLimit) {
      chunks.push(`${header}\n\n${truncateLine(block, telegramChunkLimit - header.length - 4)}`);
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
  const alerts = pickAlerts(snapshot);
  if (!alerts.length) {
    console.log(`Telegram skipped: no alerts at min score ${minScore}`);
    return;
  }
  const messages = buildMessages(snapshot, alerts);
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

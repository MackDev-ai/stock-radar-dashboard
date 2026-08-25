const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "monitoring-data.js");
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const minScore = Number.isFinite(Number(process.env.TELEGRAM_MIN_SCORE)) ? Number(process.env.TELEGRAM_MIN_SCORE) : 75;
const maxAlerts = Number.isFinite(Number(process.env.TELEGRAM_MAX_ALERTS)) ? Number(process.env.TELEGRAM_MAX_ALERTS) : 12;

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
  if (delta.actionChanged) parts.push(`akcja ${delta.previousAction} -> ${row.signal?.action || "-"}`);
  if (delta.decisionChanged) parts.push(`decyzja ${delta.previousDecisionStatus} -> ${row.decision?.status || "-"}`);
  const signalAlerts = (row.signal?.alerts || []).filter((alert) => !alert.startsWith("New SEC filing:"));
  if (signalAlerts.length) parts.push(signalAlerts.slice(0, 2).join("; "));
  if (!parts.length) parts.push((row.researchScore?.positives || []).slice(0, 2).join("; ") || row.thesis || "monitoring");
  return parts.join(" | ");
}

function pickAlerts(snapshot) {
  return (snapshot.rows || [])
    .map((row) => ({ row, weight: alertWeight(row) }))
    .filter(({ row, weight }) => weight > 0 && ((row.researchScore?.total ?? 0) >= minScore || row.historyDelta?.actionChanged || row.historyDelta?.decisionChanged || row.sec?.newFilings?.length || row.signal?.alerts?.length))
    .sort((a, b) => b.weight - a.weight || (b.row.researchScore?.total ?? 0) - (a.row.researchScore?.total ?? 0))
    .slice(0, maxAlerts)
    .map(({ row }) => row);
}

function buildMessage(snapshot, alerts) {
  const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "-";
  const lines = [
    `Stock Radar - alerty`,
    `Aktualizacja: ${generated}`,
    `Universe: ${(snapshot.rows || []).length} spolek | wysylka top ${alerts.length}`,
    `Dashboard: ${dashboardUrl}#alertsView`,
    ""
  ];

  alerts.forEach((row, index) => {
    const delta = row.historyDelta || {};
    lines.push(`${index + 1}. ${row.ticker} ${row.name || ""}`.trim());
    lines.push(`Werdykt: ${row.investmentVerdict?.label || "Obserwowac"} (${row.investmentVerdict?.confidence || "medium"})`);
    lines.push(`Score ${row.researchScore?.total ?? "-"} (${fmtChange(delta.scoreChange)}), rank ${rankChange(delta)}, cena ${fmtPct(delta.priceChangePct)}`);
    lines.push(`Status ${row.status || "-"} | decyzja ${row.decision?.status || "-"} | akcja ${row.signal?.action || "-"}`);
    lines.push(reason(row));
    if (row.investmentVerdict?.blockers?.length) lines.push(`Blokery: ${row.investmentVerdict.blockers.slice(0, 2).join("; ")}`);
    lines.push("");
  });

  lines.push("To jest material researchowy, nie rekomendacja inwestycyjna.");
  return lines.join("\n").slice(0, 3900);
}

async function sendTelegram(message) {
  if (process.env.TELEGRAM_DRY_RUN === "1") {
    console.log(message);
    return;
  }
  if (!token || !chatId) {
    console.log("Telegram skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
    return;
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
}

async function run() {
  const snapshot = parseMonitoringData();
  const alerts = pickAlerts(snapshot);
  if (!alerts.length) {
    console.log(`Telegram skipped: no alerts at min score ${minScore}`);
    return;
  }
  await sendTelegram(buildMessage(snapshot, alerts));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

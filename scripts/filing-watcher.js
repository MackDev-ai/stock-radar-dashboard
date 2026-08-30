const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "monitoring-config.json");
const dataDir = path.join(root, "data");
const statePath = path.join(root, "filing-watch-state.json");
const reportPath = path.join(root, "filing-watch.md");
const historyPath = path.join(dataDir, "filing-watch-history.json");
const analysisPath = path.join(dataDir, "filing-analysis.json");
const cikCachePath = path.join(dataDir, "sec-company-tickers.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const runtime = config.runtime || {};
const dashboardUrl = process.env.DASHBOARD_URL || "https://mackdev-ai.github.io/stock-radar-dashboard/";
const publicBaseUrl = dashboardUrl.replace(/\/?([?#].*)?$/, "/");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const maxFilingsToAnalyze = Number.isFinite(Number(process.env.FILING_WATCH_MAX_ANALYSIS)) ? Number(process.env.FILING_WATCH_MAX_ANALYSIS) : 40;
const maxTelegramItems = Number.isFinite(Number(process.env.FILING_WATCH_TELEGRAM_MAX)) ? Number(process.env.FILING_WATCH_TELEGRAM_MAX) : 8;
const telegramChunkLimit = Number.isFinite(Number(process.env.TELEGRAM_CHUNK_LIMIT)) ? Number(process.env.TELEGRAM_CHUNK_LIMIT) : 2800;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function loadJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, { ...options, headers: { accept: "application/json", ...(options.headers || {}) } }));
}

async function fetchOptionalJson(url, fallback) {
  try {
    return await fetchJson(url);
  } catch {
    return fallback;
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceAround(text, index, radius = 180) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordRegex(keyword) {
  if (/^[A-Za-z0-9-]+$/.test(keyword)) return new RegExp(`\\b${escapeRegex(keyword)}\\b`, "gi");
  return new RegExp(escapeRegex(keyword).replace(/\s+/g, "\\s+"), "gi");
}

function keywordHits(text, keywords) {
  return keywords
    .filter(Boolean)
    .map((keyword) => {
      const found = [...text.matchAll(keywordRegex(keyword))];
      return { keyword, count: found.length, context: found[0]?.index >= 0 ? sentenceAround(text, found[0].index) : "" };
    })
    .filter((match) => match.count > 0);
}

function filingKeywordHits(text, keywords) {
  return keywordHits(text, keywords).filter((match) => {
    const context = match.context || "";
    if (match.keyword === "event of default" && /\b(in the event of default|could result in an event of default|would result in an event of default|could constitute an event of default|would constitute an event of default)\b/i.test(context)) {
      return false;
    }
    if (/material weakness/i.test(match.keyword) && /\b(no material weakness|not identified (any )?material weakness|did not identify (any )?material weakness|assessing the risk that a material weakness exists)\b/i.test(context)) {
      return false;
    }
    return true;
  });
}

function normalizeEvidenceContext(value, limit = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function extractDecisionEvidence(text) {
  const groups = [
    { key: "revenue", label: "Przychody / popyt", keywords: ["revenue increased", "revenue decreased", "net sales increased", "net sales decreased", "demand", "orders", "backlog", "book-to-bill"] },
    { key: "margin", label: "Marze / rentownosc", keywords: ["gross margin", "operating margin", "operating income", "pricing pressure", "cost pressure", "profitability"] },
    { key: "cashFlow", label: "Cash flow", keywords: ["operating cash flow", "free cash flow", "cash flows from operating activities", "capital expenditures", "cash provided by operating activities"] },
    { key: "balance", label: "Bilans / plynnosc", keywords: ["cash and cash equivalents", "marketable securities", "liquidity", "debt", "net debt", "credit facility", "covenant", "going concern"] },
    { key: "guidance", label: "Guidance / outlook", keywords: ["guidance", "outlook", "forecast", "raised guidance", "lowered guidance"] },
    { key: "dilution", label: "Emisja / rozwodnienie", keywords: ["at the market offering", "ATM offering", "registered direct offering", "private placement", "warrants", "convertible notes", "dilution to existing stockholders"] },
    { key: "risk", label: "Ryzyka czerwone", keywords: ["material weakness", "impairment", "restructuring", "litigation", "investigation", "delisting", "notice of noncompliance", "material cybersecurity incident"] }
  ];

  return groups
    .map((group) => {
      const hits = filingKeywordHits(text, group.keywords).slice(0, 2);
      return hits.length ? {
        key: group.key,
        label: group.label,
        hits: hits.map((hit) => ({ keyword: hit.keyword, count: hit.count, context: normalizeEvidenceContext(hit.context) }))
      } : null;
    })
    .filter(Boolean);
}

function isConfirmedFilingRiskHit(hit, filing, eventType = "") {
  const context = String(hit?.context || "");
  const keyword = String(hit?.keyword || "");
  if (/substantial doubt|going concern/i.test(keyword)) {
    return !/no substantial doubt|does not raise substantial doubt|not a going concern|\b(?:if|could|would|may|might)\b.{0,180}\b(?:substantial doubt|going concern)/i.test(context);
  }
  if (/in default under|defaulted on|breach of covenant/i.test(keyword)) {
    return !/(?:if|unless)\b.{0,220}\b(?:default|breach)|\b(?:could|would|may|might)\b.{0,180}\b(?:default|breach)|\b(?:risk|possibility|potential)\b.{0,160}\b(?:default|breach)/i.test(context);
  }
  if (eventType === "DILUTION" && !["S-1", "S-3"].includes(filing?.form)) {
    return !/\b(?:could|would|may|might|potential|possible)\b.{0,180}\b(?:offering|dilution)/i.test(context);
  }
  return true;
}

function analyzeFilingVerdict(text, filing) {
  const positiveKeywords = [
    "revenue increased", "net sales increased", "operating income increased", "gross margin increased",
    "record revenue", "raised guidance", "backlog", "orders", "share repurchase", "cash equivalents",
    "marketable securities", "positive cash flow", "free cash flow"
  ];
  const riskKeywords = [
    "substantial doubt", "going concern", "material weakness", "in default under",
    "defaulted on", "breach of covenant", "impairment", "restructuring", "dilution to existing stockholders",
    "at the market offering", "ATM offering", "registered direct offering",
    "pricing pressure", "competition", "decreased", "declined", "litigation", "investigation",
    "cybersecurity incident"
  ];
  const eventRiskKeywords = [
    "departure of directors", "departure of certain officers", "termination", "filed for bankruptcy",
    "delisting", "notice of noncompliance", "material definitive agreement"
  ];
  const criticalRiskKeywords = [
    "substantial doubt", "going concern", "identified a material weakness", "material weakness in internal control",
    "breach of covenant", "notice of noncompliance", "filed for bankruptcy", "delisting",
    "material cybersecurity incident"
  ];

  const positives = keywordHits(text, positiveKeywords).slice(0, 5);
  const risks = filingKeywordHits(text, riskKeywords).filter((hit) => isConfirmedFilingRiskHit(hit, filing)).slice(0, 7);
  const eventRisks = filing?.form === "8-K" || filing?.form === "6-K" ? filingKeywordHits(text, eventRiskKeywords).slice(0, 5) : [];
  const criticalRisks = filingKeywordHits(text, criticalRiskKeywords).filter((hit) => isConfirmedFilingRiskHit(hit, filing)).slice(0, 5);
  const positiveScore = positives.reduce((sum, item) => sum + Math.min(item.count, 4), 0);
  const riskScore = risks.reduce((sum, item) => sum + Math.min(item.count, 5), 0)
    + eventRisks.reduce((sum, item) => sum + Math.min(item.count, 5), 0)
    + criticalRisks.reduce((sum, item) => sum + Math.min(item.count, 8), 0);
  const net = positiveScore - riskScore;

  let label = "neutralny filing";
  let action = "czytaj selektywnie";
  if (criticalRisks.length || (riskScore >= 18 && net <= -10)) {
    label = "negatywny filing";
    action = "nie inwestowac bez recznego wyjasnienia ryzyk";
  } else if (riskScore >= 10 && net < -3) {
    label = "filing z ryzykami";
    action = "wstrzymac decyzje i sprawdzic ryzyka";
  } else if (positiveScore >= 7 && net >= 3) {
    label = "pozytywny filing";
    action = "sprawdz pakiet decyzji: filing, marze, wzrost, zadluzenie, wycene i newsy";
  } else if (filing?.form === "8-K" || filing?.form === "6-K") {
    label = "filing zdarzeniowy";
    action = "sprawdzic powod publikacji";
  }

  return {
    label,
    action,
    score: net,
    positiveScore,
    riskScore,
    positives: positives.map((item) => ({ keyword: item.keyword, count: item.count, context: item.context })),
    risks: [...risks, ...eventRisks].map((item) => ({ keyword: item.keyword, count: item.count, context: item.context })),
    criticalRisks: criticalRisks.map((item) => ({ keyword: item.keyword, count: item.count, context: item.context }))
  };
}

function classifyFilingEvents(text, filing) {
  const definitions = [
    { type: "LIQUIDITY_RISK", label: "ryzyko plynnosci / going concern", severity: "high", keywords: ["substantial doubt", "going concern", "in default under", "defaulted on", "breach of covenant"] },
    { type: "DILUTION", label: "emisja akcji / mozliwe rozwodnienie", severity: "high", keywords: ["at the market offering", "ATM offering", "registered direct offering", "dilution to existing stockholders"] },
    { type: "BANKRUPTCY_OR_LISTING", label: "bankructwo / delisting / zgodnosc z gielda", severity: "high", keywords: ["filed for bankruptcy", "delisting", "notice of noncompliance", "nasdaq continued listing"] },
    { type: "GUIDANCE_OR_RESULTS", label: "wyniki / guidance / outlook", severity: "medium", keywords: ["raised guidance", "lowered guidance", "guidance", "outlook", "revenue increased", "revenue decreased", "net sales increased", "net sales decreased"] },
    { type: "MA_OR_STRATEGIC", label: "M&A / umowa strategiczna", severity: "medium", keywords: ["merger agreement", "acquisition", "asset sale", "material definitive agreement", "joint venture", "strategic partnership"] },
    { type: "MANAGEMENT", label: "zmiany w zarzadzie", severity: "medium", keywords: ["departure of directors", "departure of certain officers", "resignation", "appointed", "chief executive officer", "chief financial officer"] },
    { type: "LEGAL_OR_REGULATORY", label: "ryzyko prawne / regulacyjne", severity: "medium", keywords: ["litigation", "investigation", "subpoena", "regulatory", "settlement", "enforcement"] },
    { type: "CYBER", label: "materialny incydent cyber", severity: "high", keywords: ["material cybersecurity incident"] },
    { type: "CYBER_RISK_DISCLOSURE", label: "ujawnienia cyber / ryzyko operacyjne", severity: "medium", keywords: ["cybersecurity incident", "unauthorized access", "data breach"] },
    { type: "INSIDER_FLOW", label: "transakcje insiderow", severity: "medium", keywords: filing?.form === "4" ? ["transaction", "acquired", "disposed", "beneficial ownership"] : [] }
  ];

  return definitions
    .map((event) => {
      const rawHits = filingKeywordHits(text, event.keywords).slice(0, 4);
      if (!rawHits.length) return null;
      if (!["LIQUIDITY_RISK", "DILUTION"].includes(event.type)) return { ...event, hits: rawHits, confirmed: true };

      const confirmedHits = rawHits.filter((hit) => isConfirmedFilingRiskHit(hit, filing, event.type));
      return {
        ...event,
        label: confirmedHits.length ? event.label : `${event.label} - wzmianka warunkowa`,
        severity: confirmedHits.length ? event.severity : "medium",
        hits: confirmedHits.length ? confirmedHits : rawHits,
        confirmed: Boolean(confirmedHits.length)
      };
    })
    .filter(Boolean);
}

function filingFormMeaning(form) {
  return {
    "8-K": "zdarzenie biezace, czesto pilne",
    "10-Q": "raport kwartalny",
    "10-K": "raport roczny",
    "6-K": "raport biezacy emitenta zagranicznego",
    "20-F": "raport roczny emitenta zagranicznego",
    "4": "transakcje insiderow",
    "S-3": "rejestracja papierow wartosciowych",
    "S-1": "prospekt / oferta papierow wartosciowych"
  }[form] || "dokument SEC";
}

function buildFilingDecisionBrief(filing, verdict, events, evidence) {
  const hasHighEvent = events.some((event) => event.severity === "high");
  const hasCriticalRisk = Boolean(verdict.criticalRisks?.length);
  const riskScore = verdict.riskScore || 0;
  const positiveScore = verdict.positiveScore || 0;
  const isOffering = ["S-1", "S-3"].includes(filing?.form) || events.some((event) => event.type === "DILUTION");
  const isEventFiling = ["8-K", "6-K"].includes(filing?.form);

  let verdictCode = "MONITOR";
  let label = "Obserwowac";
  let action = "Nie ma wystarczajacego sygnalu do decyzji; zostaw w monitoringu.";
  let confidence = "medium";

  if (hasHighEvent || hasCriticalRisk || riskScore >= positiveScore + 10) {
    verdictCode = "AVOID_NOW";
    label = "Nie wchodzic teraz";
    action = "Najpierw wyjasnic czerwone flagi; bez tego setup jest odrzucony operacyjnie.";
    confidence = "high";
  } else if (isOffering || riskScore >= positiveScore + 3 || (isEventFiling && positiveScore < 4)) {
    verdictCode = "WAIT";
    label = "Wstrzymac sie";
    action = "Nie podejmowac decyzji po samym alertcie; sprawdz konkretny katalizator i ryzyko ceny.";
  } else if (positiveScore >= 7 && riskScore <= 5) {
    verdictCode = "CANDIDATE";
    label = "Kandydat po kontroli";
    action = "Mozna przeniesc do deep dive, jesli wycena, marze i cash flow nie psuja tezy.";
  } else if (/pozytywny/i.test(verdict.label || "") && riskScore <= 8) {
    verdictCode = "REVIEW";
    label = "Warto przeanalizowac";
    action = "Sprawdz pakiet decyzji przed ruchem: wycena, guidance, cash flow, zadluzenie i newsy.";
  }

  const materialWeakness = [...(verdict.risks || []), ...(verdict.criticalRisks || []), ...evidence.flatMap((group) => group.hits || [])]
    .some((item) => /material weakness/i.test(item.keyword || ""));
  const hasGuidance = evidence.some((group) => group.key === "guidance");
  const evidenceLabels = new Set(evidence.map((group) => group.label));
  const readSections = [
    "Management Discussion and Analysis / wyniki kwartalu",
    "Liquidity and Capital Resources / gotowka i zadluzenie",
    "Risk Factors / czerwone flagi",
    materialWeakness ? "Controls and Procedures / material weakness" : null,
    hasGuidance ? "Guidance, outlook albo backlog" : null,
    isOffering ? "Offering / dilution / use of proceeds" : null,
    isEventFiling ? "Item 2.02, 5.02, 7.01 lub 8.01 w 8-K/6-K" : null
  ].filter(Boolean);

  const reasons = [];
  if (hasHighEvent) reasons.push("wykryto zdarzenie wysokiego ryzyka");
  if (hasCriticalRisk) reasons.push(`krytyczne frazy: ${verdict.criticalRisks.slice(0, 2).map((item) => item.keyword).join(", ")}`);
  if (riskScore) reasons.push(`risk score ${riskScore}`);
  if (positiveScore) reasons.push(`positive score ${positiveScore}`);
  if (evidenceLabels.size) reasons.push(`sekcje z dowodami: ${[...evidenceLabels].slice(0, 3).join(", ")}`);

  return {
    verdict: verdictCode,
    label,
    action,
    confidence,
    score: positiveScore - riskScore,
    readSections,
    reasons: reasons.slice(0, 5),
    evidence: evidence
      .flatMap((group) => (group.hits || []).slice(0, 1).map((hit) => ({
        label: group.label,
        keyword: hit.keyword,
        context: normalizeEvidenceContext(hit.context, 220)
      })))
      .slice(0, 5)
  };
}

function buildFilingBrief(text, filing, verdict) {
  const events = classifyFilingEvents(text, filing);
  const decisionEvidence = extractDecisionEvidence(text);
  const topRisks = [...(verdict.criticalRisks || []), ...(verdict.risks || [])].slice(0, 3);
  const topPositives = (verdict.positives || []).slice(0, 3);
  const highestSeverity = events.some((event) => event.severity === "high") || verdict.criticalRisks?.length ? "high" : events.some((event) => event.severity === "medium") ? "medium" : "low";
  const focus = [];
  if (topRisks.length) focus.push(`ryzyka: ${topRisks.map((item) => item.keyword).join(", ")}`);
  if (topPositives.length) focus.push(`pozytywy: ${topPositives.map((item) => item.keyword).join(", ")}`);
  if (!focus.length && events.length) focus.push(`typ zdarzenia: ${events.slice(0, 3).map((event) => event.label).join(", ")}`);
  if (!focus.length) focus.push("brak mocnych slow-kluczy w automatycznym skanie");

  let researchAction = "czytaj selektywnie";
  if (highestSeverity === "high" || /negatywny|ryzykami/i.test(verdict.label)) researchAction = "najpierw sprawdz: plynnosc, zadluzenie, rozwodnienie, guidance i czy spadek ceny wynika z pogorszenia biznesu";
  else if (/pozytywny/i.test(verdict.label)) researchAction = "sprawdz liczby w pakiecie decyzji: marze, wzrost, cash flow, wycene i ostatnie newsy";
  else if (filing?.form === "8-K" || filing?.form === "6-K") researchAction = "sprawdz, co bylo powodem publikacji";

  return {
    formMeaning: filingFormMeaning(filing?.form),
    sentiment: verdict.label,
    urgency: highestSeverity,
    eventTypes: events.map((event) => ({ type: event.type, label: event.label, severity: event.severity, confirmed: event.confirmed !== false, keywords: event.hits.map((hit) => hit.keyword) })),
    summary: `${filing?.form || "SEC"}: ${filingFormMeaning(filing?.form)}. ${focus.join(" | ")}.`,
    researchAction,
    decisionBrief: buildFilingDecisionBrief(filing, verdict, events, decisionEvidence),
    decisionEvidence,
    riskKeywords: topRisks.map((item) => item.keyword),
    positiveKeywords: topPositives.map((item) => item.keyword)
  };
}

async function fetchSecTickerMap() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(cikCachePath)) return loadJsonFile(cikCachePath, {});
  const json = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  fs.writeFileSync(cikCachePath, JSON.stringify(json, null, 2));
  return json;
}

function findCik(tickerMap, item) {
  if (item.sec_cik) return String(item.sec_cik).padStart(10, "0");
  const normalized = String(item.sec_symbol || item.yahoo || item.ticker || "").split(".")[0].toUpperCase();
  const row = Object.values(tickerMap).find((entry) => String(entry.ticker || "").toUpperCase() === normalized);
  return row ? String(row.cik_str).padStart(10, "0") : null;
}

async function fetchRecentFilings(item, tickerMap) {
  const cik = findCik(tickerMap, item);
  if (!cik) return { cik: null, filings: [], error: "No SEC CIK match" };
  if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
  const json = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent = json.filings?.recent || {};
  const filings = [];
  for (let i = 0; i < Math.min(60, recent.form?.length || 0); i++) {
    const form = recent.form[i];
    if (!["10-K", "10-Q", "8-K", "20-F", "6-K", "4", "S-1", "S-3"].includes(form)) continue;
    const accession = recent.accessionNumber[i];
    const accessionCompact = String(accession).replace(/-/g, "");
    filings.push({
      ticker: item.ticker,
      name: item.name,
      status: item.status,
      themes: item.themes || [],
      cik,
      form,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate[i],
      accessionNumber: accession,
      primaryDocument: recent.primaryDocument[i],
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionCompact}/${recent.primaryDocument[i]}`
    });
    if (filings.length >= 8) break;
  }
  return { cik, filings, error: null };
}

async function analyzeSecDocument(filing) {
  if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
  const html = await fetchText(filing.url, { headers: { accept: "text/html,application/xhtml+xml,text/plain" } });
  const text = htmlToText(html);
  const verdict = analyzeFilingVerdict(text, filing);
  return {
    analyzedAt: new Date().toISOString(),
    documentChars: text.length,
    filingVerdict: verdict,
    filingBrief: buildFilingBrief(text, filing, verdict)
  };
}

function loadPreviousAccessions() {
  const state = loadJsonFile(statePath, { accessions: [] });
  return new Set(Array.isArray(state.accessions) ? state.accessions : []);
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function urgentWeight(entry) {
  const brief = entry.filingBrief || {};
  const high = brief.urgency === "high" ? 100 : brief.urgency === "medium" ? 40 : 0;
  const form = ["8-K", "6-K", "4", "S-1", "S-3"].includes(entry.form) ? 30 : 0;
  const negative = /negatywny|ryzykami/i.test(brief.sentiment || "") ? 35 : 0;
  return high + form + negative;
}

function truncateLine(text, limit = 220) {
  const value = String(text || "-").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function writeReport(snapshot) {
  const lines = [
    "# Filing Watch",
    "",
    `Aktualizacja: ${snapshot.generatedAt}`,
    "",
    "Lekki watcher SEC. To material researchowy, nie rekomendacja inwestycyjna.",
    "",
    `- Universe: ${snapshot.universeSize}`,
    `- Nowe filingi: ${snapshot.newFilings.length}`,
    `- Przeanalizowane dokumenty: ${snapshot.analyzedCount}`,
    ""
  ];

  if (!snapshot.newFilings.length) {
    lines.push("Brak nowych filingow od poprzedniego przebiegu watchera.");
  } else {
    for (const item of snapshot.newFilings.slice(0, 40)) {
      const events = (item.filingBrief?.eventTypes || []).slice(0, 4).map((event) => event.label).join("; ") || "-";
      lines.push(`## ${item.ticker} - ${item.name}`);
      lines.push("");
      lines.push(`- Dokument: ${item.form} z ${item.filingDate}`);
      lines.push(`- Link: ${item.url}`);
      lines.push(`- Werdykt filing: ${item.filingBrief?.sentiment || "-"}`);
      lines.push(`- Pilnosc: ${item.filingBrief?.urgency || "-"}`);
      lines.push(`- Skrot: ${item.filingBrief?.summary || "-"}`);
      lines.push(`- Co sprawdzic: ${item.filingBrief?.researchAction || "-"}`);
      if (item.filingBrief?.decisionBrief) {
        const decision = item.filingBrief.decisionBrief;
        lines.push(`- Wniosek systemu: ${decision.label} (${decision.confidence})`);
        lines.push(`- Akcja operacyjna: ${decision.action}`);
        if (decision.reasons?.length) lines.push(`- Dlaczego: ${decision.reasons.join("; ")}`);
        if (decision.readSections?.length) lines.push(`- Czytaj najpierw: ${decision.readSections.slice(0, 5).join("; ")}`);
      }
      lines.push(`- Kategorie: ${events}`);
      if (item.filingBrief?.decisionEvidence?.length) {
        lines.push("- Fragmenty decyzyjne:");
        for (const group of item.filingBrief.decisionEvidence.slice(0, 5)) {
          const hit = group.hits?.[0];
          if (hit?.context) lines.push(`  - ${group.label}: ${hit.context}`);
        }
      }
      lines.push("");
    }
  }

  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
}

function writeAnalysisJson(snapshot) {
  const payload = {
    generatedAt: snapshot.generatedAt,
    universeSize: snapshot.universeSize,
    newFilings: snapshot.newFilings.length,
    analyzedCount: snapshot.analyzedCount,
    items: snapshot.newFilings
      .slice()
      .sort((a, b) => urgentWeight(b) - urgentWeight(a) || String(b.filingDate || "").localeCompare(String(a.filingDate || "")))
      .map((item) => ({
        ticker: item.ticker,
        name: item.name,
        status: item.status,
        themes: item.themes || [],
        cik: item.cik,
        form: item.form,
        filingDate: item.filingDate,
        reportDate: item.reportDate,
        accessionNumber: item.accessionNumber,
        url: item.url,
        documentChars: item.documentChars,
        analyzedAt: item.analyzedAt,
        error: item.error,
        verdict: item.filingVerdict || null,
        brief: item.filingBrief || null
      }))
  };
  fs.writeFileSync(analysisPath, JSON.stringify(payload, null, 2));
}

function buildTelegramMessages(snapshot) {
  const items = snapshot.newFilings
    .slice()
    .sort((a, b) => urgentWeight(b) - urgentWeight(a) || b.filingDate.localeCompare(a.filingDate))
    .slice(0, maxTelegramItems);
  if (!items.length) return [];

  const header = [
    "Filing Watch - nowe SEC",
    `Aktualizacja: ${new Date(snapshot.generatedAt).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })}`,
    `Nowe filingi: ${snapshot.newFilings.length} | wysylka top ${items.length}`,
    `Dashboard: ${dashboardUrl}filing-watch.md`
  ].join("\n");
  const footer = "Material researchowy, nie rekomendacja inwestycyjna.";
  const blocks = items.map((item, index) => {
    const events = (item.filingBrief?.eventTypes || []).slice(0, 2).map((event) => event.label).join("; ") || item.filingBrief?.formMeaning || "-";
    const decision = item.filingBrief?.decisionBrief;
    const evidence = (item.filingBrief?.decisionEvidence || [])
      .flatMap((group) => (group.hits || []).slice(0, 1).map((hit) => `${group.label}: ${hit.context}`))
      .slice(0, 2)
      .join(" | ");
    return [
      `${index + 1}. ${item.ticker} ${item.name}`,
      `${item.form} ${item.filingDate} | pilnosc ${item.filingBrief?.urgency || "-"} | ${item.filingBrief?.sentiment || "-"}`,
      decision ? `Wniosek: ${decision.label} (${decision.confidence})` : "",
      decision?.action ? `Akcja: ${truncateLine(decision.action, 180)}` : "",
      truncateLine(item.filingBrief?.summary || "-", 220),
      evidence ? `Z filing: ${truncateLine(evidence, 320)}` : "",
      `Kategorie: ${truncateLine(events, 140)}`,
      decision?.readSections?.length ? `Czytaj: ${truncateLine(decision.readSections.slice(0, 3).join("; "), 180)}` : `Co sprawdzic: ${truncateLine(item.filingBrief?.researchAction || "-", 160)}`,
      item.url
    ].filter(Boolean).join("\n");
  });

  const chunks = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > telegramChunkLimit && current !== header) {
      chunks.push(current);
      current = `${header}\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  if (current !== header) chunks.push(current);
  return chunks.map((chunk, index) => `${chunks.length > 1 ? `Czesc ${index + 1}/${chunks.length}\n` : ""}${chunk}${index === chunks.length - 1 ? `\n\n${footer}` : ""}`);
}

async function sendTelegram(message) {
  if (process.env.TELEGRAM_DRY_RUN === "1") {
    console.log(message);
    return true;
  }
  if (!token || !chatId) {
    console.log("Filing Watch Telegram skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
    return false;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Telegram send failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  console.log("Filing Watch Telegram alert sent");
  return true;
}

async function run() {
  loadEnv();
  fs.mkdirSync(dataDir, { recursive: true });
  const tickerMap = await fetchSecTickerMap();
  const previousState = loadJsonFile(statePath, { accessions: [] });
  const previousAccessions = loadPreviousAccessions();
  const rows = config.watchlist || [];
  const allFilings = [];
  const errors = [];

  for (const item of rows) {
    try {
      const result = await fetchRecentFilings(item, tickerMap);
      if (result.error) errors.push({ ticker: item.ticker, error: result.error });
      allFilings.push(...result.filings);
      process.stdout.write(".");
    } catch (error) {
      errors.push({ ticker: item.ticker, error: error.message });
      process.stdout.write("x");
    }
  }
  process.stdout.write("\n");

  const allAccessions = [...new Set(allFilings.map((filing) => filing.accessionNumber).filter(Boolean))];
  const hasBaseline = previousAccessions.size > 0;
  const newFilings = hasBaseline ? allFilings.filter((filing) => filing.accessionNumber && !previousAccessions.has(filing.accessionNumber)) : [];
  const toAnalyze = newFilings.slice().sort((a, b) => b.filingDate.localeCompare(a.filingDate)).slice(0, maxFilingsToAnalyze);
  const analyzed = [];

  for (const filing of toAnalyze) {
    try {
      const analysis = await analyzeSecDocument(filing);
      analyzed.push({ ...filing, ...analysis });
      console.log(`Analyzed ${filing.ticker} ${filing.form} ${filing.filingDate}`);
    } catch (error) {
      analyzed.push({ ...filing, error: error.message });
      console.log(`Analyze failed ${filing.ticker}: ${error.message}`);
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    universeSize: rows.length,
    baselineCreated: !hasBaseline,
    allFilingCount: allFilings.length,
    analyzedCount: analyzed.length,
    errors,
    newFilings: analyzed
  };

  const stateChanged = !sameValues(allAccessions, Array.isArray(previousState.accessions) ? previousState.accessions : []);
  const shouldUpdateTrackedFiles = !hasBaseline || stateChanged || analyzed.length > 0;
  fs.writeFileSync(historyPath, JSON.stringify(snapshot, null, 2));
  if (shouldUpdateTrackedFiles) {
    fs.writeFileSync(statePath, JSON.stringify({ updatedAt: snapshot.generatedAt, accessions: allAccessions }, null, 2));
    writeReport(snapshot);
    writeAnalysisJson(snapshot);
  } else {
    console.log("Filing Watch tracked files unchanged.");
  }

  if (!hasBaseline) {
    console.log(`Filing Watch baseline created with ${allAccessions.length} accessions; no Telegram alert on first run.`);
    return;
  }
  if (!analyzed.length) {
    console.log("Filing Watch: no new filings.");
    return;
  }
  const messages = buildTelegramMessages(snapshot);
  let sent = 0;
  for (const message of messages) {
    if (await sendTelegram(message)) sent += 1;
  }
  console.log(`Filing Watch Telegram chunks sent: ${sent}/${messages.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "monitoring-config.json");
const dataDir = path.join(root, "data");
const outputPath = path.join(dataDir, "monitoring-data.js");
const historyPath = path.join(dataDir, "monitoring-history.json");
const alertsMdPath = path.join(root, "alerts.md");
const alertsJsonPath = path.join(dataDir, "alerts.json");
const decisionChangeLogPath = path.join(dataDir, "decision-change-log.json");
const actionQueuePath = path.join(dataDir, "action-queue.json");
const triageQueuePath = path.join(dataDir, "triage-queue.json");
const dailyReportPath = path.join(root, "daily-report.md");
const manualFundamentalsPath = path.join(root, "manual-fundamentals.csv");
const cikCachePath = path.join(dataDir, "sec-company-tickers.json");
const secStatePath = path.join(dataDir, "sec-filings-state.json");
const newFilingsPath = path.join(root, "new-filings.md");
const eventsPath = path.join(root, "monitoring-events.csv");
const decisionsPath = path.join(root, "research-decisions.csv");
const secAnalysisPath = path.join(root, "sec-analysis.md");
const fmpProfileCachePath = path.join(dataDir, "fmp-profile-cache.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const rules = config.rules || {};
const runtime = config.runtime || {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmpDisabledEndpointLabels = new Set();
let lastFmpRequestAt = 0;
let fmpRateLimited = false;
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] || ""]));
  });
}

function parseCsvFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = toNumber(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeRatio(value) {
  if (!Number.isFinite(value)) return null;
  return Math.abs(value) > 1.5 ? value / 100 : value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const manualFundamentals = new Map(parseCsvFile(manualFundamentalsPath).map((row) => {
  const symbol = String(row.ticker || row.symbol || "").toUpperCase();
  return [symbol, {
    symbol,
    peTTM: firstNumber(row.pe_ttm, row.pe, row.price_to_earnings),
    psTTM: firstNumber(row.ps_ttm, row.ps, row.price_to_sales),
    pbTTM: firstNumber(row.pb_ttm, row.pb, row.price_to_book),
    evToEbitdaTTM: firstNumber(row.ev_ebitda_ttm, row.ev_to_ebitda, row.ev_ebitda),
    roeTTM: normalizeRatio(firstNumber(row.roe_ttm, row.roe)),
    roicTTM: normalizeRatio(firstNumber(row.roic_ttm, row.roic)),
    operatingMarginTTM: normalizeRatio(firstNumber(row.operating_margin_ttm, row.operating_margin)),
    fcfMarginTTM: firstNumber(row.fcf_margin_ttm, row.fcf_margin),
    netDebtToEbitdaTTM: firstNumber(row.net_debt_ebitda_ttm, row.net_debt_to_ebitda),
    revenueGrowthYoY: firstNumber(row.revenue_growth_yoy, row.revenue_growth),
    epsGrowthYoY: firstNumber(row.eps_growth_yoy, row.eps_growth),
    source: "manual-fundamentals.csv"
  }];
}).filter(([symbol]) => symbol));

const monitoringEvents = parseCsvFile(eventsPath).map((row) => ({
  ticker: String(row.ticker || "").toUpperCase(),
  date: row.date || "",
  type: row.type || row.event || "",
  title: row.title || row.event || "",
  source: row.source || "",
  notes: row.notes || ""
})).filter((row) => row.ticker && row.date);

const researchDecisions = new Map(parseCsvFile(decisionsPath).map((row) => {
  const ticker = String(row.ticker || "").toUpperCase();
  return [ticker, {
    status: row.decision_status || "",
    priority: row.priority || "",
    owner: row.owner || "",
    nextReviewDate: row.next_review_date || "",
    note: row.decision_note || "",
    invalidationTrigger: row.invalidation_trigger || "",
    updatedAt: row.updated_at || ""
  }];
}).filter(([ticker]) => ticker));

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a / b) - 1) * 100;
}

function avg(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function stdev(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const mean = avg(valid);
  const variance = valid.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

async function fetchYahoo(symbol) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - (370 * 24 * 60 * 60);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;
  const response = await fetch(url, {
    headers: { "user-agent": "local-monitoring-dashboard/1.0" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(json.chart?.error?.description || "No price data returned");
  const quote = result.indicators?.quote?.[0];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  if (!quote || !Array.isArray(result.timestamp)) throw new Error("Malformed price data");
  return result.timestamp.map((time, i) => ({
    date: new Date(time * 1000).toISOString().slice(0, 10),
    open: quote.open?.[i] ?? null,
    high: quote.high?.[i] ?? null,
    low: quote.low?.[i] ?? null,
    close: adjusted[i] ?? quote.close?.[i] ?? null,
    volume: quote.volume?.[i] ?? null
  })).filter((row) => row.date && Number.isFinite(row.close));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-dashboard/1.0" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function loadJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function fetchFmpJson(pathname, params) {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error("Missing FMP_API_KEY");
  const query = new URLSearchParams(params || {});
  const minDelayMs = Number(config.data_providers?.fmp_request_delay_ms || 0);
  const elapsed = Date.now() - lastFmpRequestAt;
  if (minDelayMs > 0 && elapsed < minDelayMs) await sleep(minDelayMs - elapsed);
  lastFmpRequestAt = Date.now();
  const url = `https://financialmodelingprep.com${pathname}?${query.toString()}`;
  let response = await fetch(url, {
    headers: {
      "user-agent": "local-monitoring-dashboard/1.0",
      "apikey": key
    }
  });
  if (response.status === 429) {
    const retryMs = Number(config.data_providers?.fmp_retry_after_429_ms || 15000);
    await sleep(retryMs);
    lastFmpRequestAt = Date.now();
    response = await fetch(url, {
      headers: {
        "user-agent": "local-monitoring-dashboard/1.0",
        "apikey": key
      }
    });
    if (response.status === 429) {
      fmpRateLimited = true;
    }
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json?.["Error Message"]) throw new Error(json["Error Message"]);
  if (json?.error) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
  return json;
}

async function fetchFmpOptional(pathname, params, label) {
  if (fmpDisabledEndpointLabels.has(label)) {
    return { label, data: null, error: "Skipped after plan/access error" };
  }
  try {
    const rows = await fetchFmpJson(pathname, params);
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { label, data: row && Object.keys(row).length ? row : null, error: null };
  } catch (error) {
    if (/HTTP 402|not available|plan|subscription|upgrade|access/i.test(error.message)) {
      fmpDisabledEndpointLabels.add(label);
    }
    return { label, data: null, error: error.message };
  }
}

function nonNullObject(value) {
  return value && typeof value === "object" ? value : {};
}

async function fetchSecTickerMap() {
  if (fs.existsSync(cikCachePath)) {
    const stats = fs.statSync(cikCachePath);
    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    if (ageHours < 24 * 7) {
      return JSON.parse(fs.readFileSync(cikCachePath, "utf8"));
    }
  }

  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: {
      "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com",
      "accept": "application/json"
    }
  });
  if (!response.ok) throw new Error(`SEC ticker map HTTP ${response.status}`);
  const json = await response.json();
  fs.writeFileSync(cikCachePath, JSON.stringify(json, null, 2));
  return json;
}

function findCik(tickerMap, yahooSymbol) {
  const normalized = String(yahooSymbol || "").split(".")[0].toUpperCase();
  const row = Object.values(tickerMap).find((entry) => String(entry.ticker || "").toUpperCase() === normalized);
  return row ? String(row.cik_str).padStart(10, "0") : null;
}

async function fetchSecFilings(item, tickerMap) {
  const cik = item.sec_cik ? String(item.sec_cik).padStart(10, "0") : findCik(tickerMap, item.sec_symbol || item.yahoo || item.ticker);
  if (!cik) return { cik: null, filings: [], error: "No SEC CIK match" };

  try {
    if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
    const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: {
        "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com",
        "accept": "application/json"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const recent = json.filings?.recent || {};
    const filings = [];
    for (let i = 0; i < Math.min(80, recent.form?.length || 0); i++) {
      const form = recent.form[i];
      if (!["10-K", "10-Q", "8-K", "20-F", "6-K"].includes(form)) continue;
      const accession = recent.accessionNumber[i];
      const accessionCompact = String(accession).replace(/-/g, "");
      filings.push({
        form,
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate[i],
        accessionNumber: accession,
        primaryDocument: recent.primaryDocument[i],
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionCompact}/${recent.primaryDocument[i]}`
      });
      if (filings.length >= 6) break;
    }
    return { cik, filings, error: null };
  } catch (error) {
    return { cik, filings: [], error: error.message };
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

function sentenceAround(text, index, radius = 220) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordRegex(keyword) {
  if (/^[A-Za-z0-9-]+$/.test(keyword)) {
    return new RegExp(`\\b${escapeRegex(keyword)}\\b`, "gi");
  }
  return new RegExp(escapeRegex(keyword).replace(/\s+/g, "\\s+"), "gi");
}

function keywordHits(text, keywords) {
  return keywords
    .map((keyword) => {
      const found = [...text.matchAll(keywordRegex(keyword))];
      return {
        keyword,
        count: found.length,
        context: found[0]?.index >= 0 ? sentenceAround(text, found[0].index, 180) : ""
      };
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
    {
      key: "revenue",
      label: "Przychody / popyt",
      keywords: ["revenue increased", "revenue decreased", "net sales increased", "net sales decreased", "demand", "orders", "backlog", "book-to-bill"]
    },
    {
      key: "margin",
      label: "Marze / rentownosc",
      keywords: ["gross margin", "operating margin", "operating income", "pricing pressure", "cost pressure", "profitability"]
    },
    {
      key: "cashFlow",
      label: "Cash flow",
      keywords: ["operating cash flow", "free cash flow", "cash flows from operating activities", "capital expenditures", "cash provided by operating activities"]
    },
    {
      key: "balance",
      label: "Bilans / plynnosc",
      keywords: ["cash and cash equivalents", "marketable securities", "liquidity", "debt", "net debt", "credit facility", "covenant", "going concern"]
    },
    {
      key: "guidance",
      label: "Guidance / outlook",
      keywords: ["guidance", "outlook", "forecast", "raised guidance", "lowered guidance"]
    },
    {
      key: "dilution",
      label: "Emisja / rozwodnienie",
      keywords: ["at the market offering", "ATM offering", "registered direct offering", "private placement", "warrants", "convertible notes", "dilution to existing stockholders"]
    },
    {
      key: "risk",
      label: "Ryzyka czerwone",
      keywords: ["material weakness", "impairment", "restructuring", "litigation", "investigation", "delisting", "notice of noncompliance", "material cybersecurity incident"]
    }
  ];

  return groups
    .map((group) => {
      const hits = filingKeywordHits(text, group.keywords).slice(0, 2);
      return hits.length ? {
        key: group.key,
        label: group.label,
        hits: hits.map((hit) => ({
          keyword: hit.keyword,
          count: hit.count,
          context: normalizeEvidenceContext(hit.context)
        }))
      } : null;
    })
    .filter(Boolean);
}

function analyzeFilingVerdict(text, filing) {
  const positiveKeywords = [
    "revenue increased",
    "net sales increased",
    "operating income increased",
    "gross margin increased",
    "record revenue",
    "raised guidance",
    "backlog",
    "orders",
    "share repurchase",
    "cash equivalents",
    "marketable securities",
    "positive cash flow",
    "free cash flow"
  ];
  const riskKeywords = [
    "substantial doubt",
    "going concern",
    "material weakness",
    "in default under",
    "defaulted on",
    "breach of covenant",
    "impairment",
    "restructuring",
    "dilution to existing stockholders",
    "at the market offering",
    "ATM offering",
    "registered direct offering",
    "pricing pressure",
    "competition",
    "decreased",
    "declined",
    "litigation",
    "investigation",
    "cybersecurity incident"
  ];
  const eventRiskKeywords = [
    "departure of directors",
    "departure of certain officers",
    "termination",
    "filed for bankruptcy",
    "delisting",
    "notice of noncompliance",
    "material definitive agreement"
  ];
  const criticalRiskKeywords = [
    "substantial doubt",
    "going concern",
    "identified a material weakness",
    "material weakness in internal control",
    "breach of covenant",
    "notice of noncompliance",
    "filed for bankruptcy",
    "delisting",
    "material cybersecurity incident"
  ];

  const positives = keywordHits(text, positiveKeywords).slice(0, 5);
  const risks = filingKeywordHits(text, riskKeywords).slice(0, 7);
  const eventRisks = filing?.form === "8-K" || filing?.form === "6-K" ? filingKeywordHits(text, eventRiskKeywords).slice(0, 5) : [];
  const criticalRisks = filingKeywordHits(text, criticalRiskKeywords).slice(0, 5);
  const positiveScore = positives.reduce((sum, item) => sum + Math.min(item.count, 4), 0);
  const riskScore = risks.reduce((sum, item) => sum + Math.min(item.count, 5), 0) + eventRisks.reduce((sum, item) => sum + Math.min(item.count, 5), 0) + criticalRisks.reduce((sum, item) => sum + Math.min(item.count, 8), 0);
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
    criticalRisks: criticalRisks.map((item) => ({ keyword: item.keyword, count: item.count, context: item.context })),
    risks: [...risks, ...eventRisks].map((item) => ({ keyword: item.keyword, count: item.count, context: item.context }))
  };
}

function classifyFilingEvents(text, filing) {
  const eventDefinitions = [
    {
      type: "LIQUIDITY_RISK",
      label: "ryzyko plynnosci / going concern",
      severity: "high",
      keywords: ["substantial doubt", "going concern", "in default under", "defaulted on", "breach of covenant"]
    },
    {
      type: "DILUTION",
      label: "emisja akcji / mozliwe rozwodnienie",
      severity: "high",
      keywords: ["at the market offering", "ATM offering", "registered direct offering", "dilution to existing stockholders"]
    },
    {
      type: "BANKRUPTCY_OR_LISTING",
      label: "bankructwo / delisting / zgodnosc z gielda",
      severity: "high",
      keywords: ["filed for bankruptcy", "delisting", "notice of noncompliance", "nasdaq continued listing"]
    },
    {
      type: "GUIDANCE_OR_RESULTS",
      label: "wyniki / guidance / outlook",
      severity: "medium",
      keywords: ["raised guidance", "lowered guidance", "guidance", "outlook", "revenue increased", "revenue decreased", "net sales increased", "net sales decreased"]
    },
    {
      type: "MA_OR_STRATEGIC",
      label: "M&A / umowa strategiczna",
      severity: "medium",
      keywords: ["merger agreement", "acquisition", "asset sale", "material definitive agreement", "joint venture", "strategic partnership"]
    },
    {
      type: "MANAGEMENT",
      label: "zmiany w zarzadzie",
      severity: "medium",
      keywords: ["departure of directors", "departure of certain officers", "resignation", "appointed", "chief executive officer", "chief financial officer"]
    },
    {
      type: "LEGAL_OR_REGULATORY",
      label: "ryzyko prawne / regulacyjne",
      severity: "medium",
      keywords: ["litigation", "investigation", "subpoena", "regulatory", "settlement", "enforcement"]
    },
    {
      type: "CYBER",
      label: "materialny incydent cyber",
      severity: "high",
      keywords: ["material cybersecurity incident"]
    },
    {
      type: "CYBER_RISK_DISCLOSURE",
      label: "ujawnienia cyber / ryzyko operacyjne",
      severity: "medium",
      keywords: ["cybersecurity incident", "unauthorized access", "data breach"]
    },
    {
      type: "INSIDER_FLOW",
      label: "transakcje insiderow",
      severity: "medium",
      keywords: filing?.form === "4" ? ["transaction", "acquired", "disposed", "beneficial ownership"] : []
    }
  ];

  return eventDefinitions
    .map((event) => {
      const hits = filingKeywordHits(text, event.keywords).slice(0, 4);
      return hits.length ? { ...event, hits } : null;
    })
    .filter(Boolean);
}

function filingFormMeaning(form) {
  const meanings = {
    "8-K": "zdarzenie biezace, czesto pilne",
    "10-Q": "raport kwartalny",
    "10-K": "raport roczny",
    "6-K": "raport biezacy emitenta zagranicznego",
    "20-F": "raport roczny emitenta zagranicznego",
    "4": "transakcje insiderow",
    "S-3": "rejestracja papierow wartosciowych",
    "S-1": "prospekt / oferta papierow wartosciowych"
  };
  return meanings[form] || "dokument SEC";
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
  const eventLabels = events.slice(0, 3).map((event) => event.label);
  const focus = [];

  if (topRisks.length) focus.push(`ryzyka: ${topRisks.map((item) => item.keyword).join(", ")}`);
  if (topPositives.length) focus.push(`pozytywy: ${topPositives.map((item) => item.keyword).join(", ")}`);
  if (!focus.length && eventLabels.length) focus.push(`typ zdarzenia: ${eventLabels.join(", ")}`);
  if (!focus.length) focus.push("brak mocnych slow-kluczy w automatycznym skanie");

  let researchAction = "czytaj selektywnie";
  if (highestSeverity === "high" || /negatywny|ryzykami/i.test(verdict.label)) researchAction = "najpierw sprawdz: plynnosc, zadluzenie, rozwodnienie, guidance i czy spadek ceny wynika z pogorszenia biznesu";
  else if (/pozytywny/i.test(verdict.label)) researchAction = "sprawdz liczby w pakiecie decyzji: marze, wzrost, cash flow, wycene i ostatnie newsy";
  else if (filing?.form === "8-K" || filing?.form === "6-K") researchAction = "sprawdz, co bylo powodem publikacji";

  return {
    formMeaning: filingFormMeaning(filing?.form),
    sentiment: verdict.label,
    urgency: highestSeverity,
    eventTypes: events.map((event) => ({
      type: event.type,
      label: event.label,
      severity: event.severity,
      keywords: event.hits.map((hit) => hit.keyword)
    })),
    summary: `${filing?.form || "SEC"}: ${filingFormMeaning(filing?.form)}. ${focus.join(" | ")}.`,
    researchAction,
    decisionBrief: buildFilingDecisionBrief(filing, verdict, events, decisionEvidence),
    decisionEvidence,
    riskKeywords: topRisks.map((item) => item.keyword),
    positiveKeywords: topPositives.map((item) => item.keyword)
  };
}

async function analyzeSecDocument(filing) {
  if (!filing?.url) return null;
  const keywords = [
    "backlog",
    "orders",
    "book-to-bill",
    "data center",
    "datacenter",
    "artificial intelligence",
    "AI",
    "grid",
    "transmission",
    "margin",
    "guidance",
    "outlook",
    "supply chain",
    "capacity"
  ];

  try {
    if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
    const response = await fetch(filing.url, {
      headers: {
        "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com",
        "accept": "text/html,application/xhtml+xml,text/plain"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const text = htmlToText(html);
    const lower = text.toLowerCase();
    const matches = [];

    for (const keyword of keywords) {
      const re = keywordRegex(keyword);
      const found = [...text.matchAll(re)];
      const count = found.length;
      const firstIndex = found[0]?.index ?? -1;
      if (count > 0) {
        matches.push({
          keyword,
          count,
          context: sentenceAround(text, firstIndex)
        });
      }
    }

    const filingVerdict = analyzeFilingVerdict(text, filing);
    return {
      analyzedAt: new Date().toISOString(),
      filing: {
        form: filing.form,
        filingDate: filing.filingDate,
        url: filing.url
      },
      documentChars: text.length,
      filingVerdict,
      filingBrief: buildFilingBrief(text, filing, filingVerdict),
      matches: matches.sort((a, b) => b.count - a.count)
    };
  } catch (error) {
    return {
      analyzedAt: new Date().toISOString(),
      filing: {
        form: filing.form,
        filingDate: filing.filingDate,
        url: filing.url
      },
      documentChars: 0,
      matches: [],
      error: error.message
    };
  }
}

async function fetchFmpFundamentals(symbol, options = {}) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { enabled: false, data: null, error: null };

  const fmpSymbol = symbol;
  const cache = loadJsonFile(fmpProfileCachePath, {});
  const cached = cache[fmpSymbol];
  const maxAgeMs = (config.data_providers?.fmp_profile_cache_days || 7) * 24 * 60 * 60 * 1000;
  const allowDeep = options.deep !== false && config.data_providers?.fmp_deep_fundamentals !== false;
  const needsDeepRefresh = allowDeep
    && !cached?.data?.fundamentalsCoverage?.loaded?.some((label) => label !== "profile");
  if (fmpRateLimited) {
    if (cached?.data) return { enabled: true, data: cached.data, error: "FMP rate limited; using cached data", cached: true };
    return { enabled: true, data: null, error: "FMP rate limited" };
  }
  if (cached && !needsDeepRefresh && Date.now() - new Date(cached.fetchedAt).getTime() < maxAgeMs) {
    return { enabled: true, data: cached.data, error: null, cached: true };
  }

  try {
    const profileResult = await fetchFmpOptional("/stable/profile", { symbol: fmpSymbol }, "profile");
    const profile = nonNullObject(profileResult.data);
    if (!profile?.symbol && fmpRateLimited && cached?.data) {
      return { enabled: true, data: cached.data, error: "FMP rate limited; using cached data", cached: true };
    }
    if (!profile?.symbol) throw new Error("No FMP profile data");
    const endpointResults = [profileResult];

    if (allowDeep) {
      const optionalEndpoints = [
        ["/stable/ratios-ttm", "ratiosTTM"],
        ["/stable/key-metrics-ttm", "keyMetricsTTM"],
        ["/stable/income-statement-ttm", "incomeTTM"],
        ["/stable/balance-sheet-statement-ttm", "balanceTTM"],
        ["/stable/cash-flow-statement-ttm", "cashFlowTTM"],
        ["/stable/financial-growth", "growth"],
        ["/stable/enterprise-values", "enterpriseValue"],
        ["/stable/financial-scores", "financialScores"]
      ];
      for (const [pathname, label] of optionalEndpoints) {
        endpointResults.push(await fetchFmpOptional(pathname, { symbol: fmpSymbol, limit: 1 }, label));
      }
    }

    const byLabel = Object.fromEntries(endpointResults.map((result) => [result.label, nonNullObject(result.data)]));
    const endpointErrors = Object.fromEntries(endpointResults.filter((result) => result.error).map((result) => [result.label, result.error]));
    const ratios = byLabel.ratiosTTM || {};
    const keyMetrics = byLabel.keyMetricsTTM || {};
    const income = byLabel.incomeTTM || {};
    const balance = byLabel.balanceTTM || {};
    const cashFlow = byLabel.cashFlowTTM || {};
    const growth = byLabel.growth || {};
    const enterpriseValue = byLabel.enterpriseValue || {};
    const financialScores = byLabel.financialScores || {};

    const data = {
      symbol: profile.symbol,
      companyName: profile.companyName,
      price: firstNumber(profile.price),
      marketCap: firstNumber(profile.marketCap, keyMetrics.marketCapTTM, keyMetrics.marketCap, enterpriseValue.marketCapitalization),
      beta: firstNumber(profile.beta),
      lastDividend: firstNumber(profile.lastDividend),
      averageVolume: firstNumber(profile.averageVolume),
      volume: firstNumber(profile.volume),
      range: profile.range || null,
      sector: profile.sector || null,
      industry: profile.industry || null,
      exchange: profile.exchange || null,
      exchangeFullName: profile.exchangeFullName || null,
      country: profile.country || null,
      currency: profile.currency || null,
      cik: profile.cik || null,
      website: profile.website || null,
      employees: firstNumber(profile.fullTimeEmployees),
      peTTM: firstNumber(ratios.priceToEarningsRatioTTM, ratios.peRatioTTM, keyMetrics.peRatioTTM, keyMetrics.peRatio),
      psTTM: firstNumber(ratios.priceToSalesRatioTTM, keyMetrics.priceToSalesRatioTTM, keyMetrics.priceToSalesRatio),
      pbTTM: firstNumber(ratios.priceToBookRatioTTM, keyMetrics.pbRatioTTM, keyMetrics.pbRatio),
      evToEbitdaTTM: firstNumber(keyMetrics.enterpriseValueOverEBITDATTM, keyMetrics.evToEBITDATTM, keyMetrics.enterpriseValueOverEBITDA, enterpriseValue.evToEbitda),
      evToSalesTTM: firstNumber(keyMetrics.evToSalesTTM, keyMetrics.enterpriseValueOverRevenueTTM),
      pfcfTTM: firstNumber(ratios.priceToFreeCashFlowsRatioTTM, keyMetrics.pfcfRatioTTM, keyMetrics.pfcfRatio),
      pocfTTM: firstNumber(ratios.priceToOperatingCashFlowsRatioTTM, keyMetrics.pocfratioTTM, keyMetrics.pocfratio),
      roeTTM: normalizeRatio(firstNumber(ratios.returnOnEquityTTM, keyMetrics.roeTTM, keyMetrics.roe)),
      roicTTM: normalizeRatio(firstNumber(ratios.returnOnInvestedCapitalTTM, keyMetrics.roicTTM, keyMetrics.roic)),
      roaTTM: normalizeRatio(firstNumber(ratios.returnOnAssetsTTM, keyMetrics.roaTTM, keyMetrics.roa)),
      grossMarginTTM: normalizeRatio(firstNumber(ratios.grossProfitMarginTTM, income.grossProfitRatioTTM)),
      operatingMarginTTM: normalizeRatio(firstNumber(ratios.operatingProfitMarginTTM, ratios.operatingMarginTTM, income.operatingIncomeRatioTTM)),
      netMarginTTM: normalizeRatio(firstNumber(ratios.netProfitMarginTTM, income.netIncomeRatioTTM)),
      fcfMarginTTM: normalizeRatio(firstNumber(ratios.freeCashFlowOperatingCashFlowRatioTTM, cashFlow.freeCashFlowTTM && income.revenueTTM ? cashFlow.freeCashFlowTTM / income.revenueTTM : null)),
      currentRatioTTM: firstNumber(ratios.currentRatioTTM, keyMetrics.currentRatioTTM),
      debtToEquityTTM: firstNumber(ratios.debtEquityRatioTTM, keyMetrics.debtToEquityTTM),
      netDebtToEbitdaTTM: firstNumber(keyMetrics.netDebtToEBITDATTM, keyMetrics.netDebtToEBITDA, ratios.netDebtToEBITDATTM),
      revenueTTM: firstNumber(income.revenueTTM, keyMetrics.revenuePerShareTTM && profile.sharesOutstanding ? keyMetrics.revenuePerShareTTM * profile.sharesOutstanding : null),
      ebitdaTTM: firstNumber(income.ebitdaTTM, keyMetrics.ebitdaTTM),
      netIncomeTTM: firstNumber(income.netIncomeTTM),
      operatingCashFlowTTM: firstNumber(cashFlow.operatingCashFlowTTM, cashFlow.netCashProvidedByOperatingActivitiesTTM),
      freeCashFlowTTM: firstNumber(cashFlow.freeCashFlowTTM),
      revenueGrowthYoY: firstNumber(growth.growthRevenue, growth.revenueGrowth, growth.revenueGrowthTTM),
      epsGrowthYoY: firstNumber(growth.growthEPS, growth.epsgrowth, growth.epsGrowth),
      fcfGrowthYoY: firstNumber(growth.growthFreeCashFlow, growth.freeCashFlowGrowth),
      altmanZScore: firstNumber(financialScores.altmanZScore, financialScores.altmanZScoreTTM),
      piotroskiScore: firstNumber(financialScores.piotroskiScore, financialScores.piotroskiScoreTTM),
      fundamentalsCoverage: {
        loaded: endpointResults.filter((result) => result.data).map((result) => result.label),
        failed: endpointErrors
      },
      source: endpointResults.some((result) => result.label !== "profile" && result.data) ? "FMP fundamentals" : "FMP profile"
    };
    cache[fmpSymbol] = { fetchedAt: new Date().toISOString(), data };
    saveJsonFile(fmpProfileCachePath, cache);

    return { enabled: true, data, error: null, cached: false };
  } catch (error) {
    return { enabled: true, data: null, error: error.message };
  }
}

async function fetchFundamentals(item, options = {}) {
  const manual = manualFundamentals.get(item.ticker.toUpperCase());
  if (manual) return { enabled: true, provider: "manual", data: manual, error: null };
  const fmp = await fetchFmpFundamentals(item.fmp_symbol || item.yahoo || item.ticker, options);
  if (!fmp.data && options.previousFundamentals) {
    return {
      enabled: true,
      provider: "previous-fmp-cache",
      data: options.previousFundamentals,
      error: fmp.error ? `${fmp.error}; using previous published fundamentals` : null
    };
  }
  return { ...fmp, provider: "fmp" };
}

function hasDeepFmpCoverage(fundamentals) {
  return !!fundamentals?.fundamentalsCoverage?.loaded?.some((label) => label !== "profile");
}

function watchlistIndexByTicker(watchlist) {
  return new Map(watchlist.map((item, index) => [item.ticker, index]));
}

function utcDayOfYear(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000) + 1;
}

function circularSlice(items, start, count) {
  if (!items.length || count <= 0) return [];
  const result = [];
  for (let i = 0; i < Math.min(count, items.length); i += 1) {
    result.push(items[(start + i) % items.length]);
  }
  return result;
}

function buildFmpDeepPlan(watchlist, previousFundamentalsByTicker) {
  const limit = Number.isFinite(Number(config.data_providers?.fmp_deep_fundamentals_limit))
    ? Math.max(0, Number(config.data_providers.fmp_deep_fundamentals_limit))
    : 80;
  if (!limit || config.data_providers?.fmp_deep_fundamentals === false) {
    return { limit, prioritySlots: 0, rotationSlots: 0, selectedSymbols: [], prioritySymbols: [], rotationSymbols: [] };
  }

  const rotationSlots = Math.min(limit, Math.max(0, Number(config.data_providers?.fmp_deep_rotation_slots ?? Math.floor(limit / 2))));
  const prioritySlots = Math.min(limit - rotationSlots, Math.max(0, Number(config.data_providers?.fmp_deep_priority_slots ?? (limit - rotationSlots))));
  const indexByTicker = watchlistIndexByTicker(watchlist);
  const priorityThemes = new Set(["AI-INFRA", "DATA-POWER", "POWER-GRID", "RECYCLING", "BIOFUELS"]);
  const priorityItems = watchlist
    .slice()
    .sort((a, b) => {
      const score = (item) => {
        const previous = previousFundamentalsByTicker.get(item.ticker);
        const missingDeep = hasDeepFmpCoverage(previous) ? 0 : 1000;
        const statusScore = item.status === "CORE" ? 160
          : item.status === "WATCH" ? 110
            : item.status === "DISTRESSED" ? 90
              : item.status === "SPEC" ? 60
                : 30;
        const themeScore = (item.themes || []).reduce((sum, theme) => sum + (priorityThemes.has(theme) ? 25 : 5), 0);
        return missingDeep + statusScore + themeScore;
      };
      return score(b) - score(a) || (indexByTicker.get(a.ticker) ?? 0) - (indexByTicker.get(b.ticker) ?? 0);
    });

  const prioritySymbols = priorityItems.slice(0, prioritySlots).map((item) => item.ticker);
  const rotationStart = (utcDayOfYear() * Math.max(1, rotationSlots)) % watchlist.length;
  const rotationSymbols = circularSlice(watchlist, rotationStart, rotationSlots).map((item) => item.ticker);
  const selected = new Set([...prioritySymbols, ...rotationSymbols]);
  for (const item of priorityItems) {
    if (selected.size >= limit) break;
    selected.add(item.ticker);
  }

  return {
    limit,
    prioritySlots,
    rotationSlots,
    selectedSymbols: [...selected],
    prioritySymbols,
    rotationSymbols
  };
}

function buildFmpCoverage(rows, deepPlan) {
  const labels = ["profile", "ratiosTTM", "keyMetricsTTM", "growth", "enterpriseValue", "financialScores", "incomeTTM", "balanceTTM", "cashFlowTTM"];
  const countLoaded = (label) => rows.filter((row) => row.fundamentals?.fundamentalsCoverage?.loaded?.includes(label)).length;
  const loaded = Object.fromEntries(labels.map((label) => [label, countLoaded(label)]));
  const likelyUnavailableEndpoints = ["incomeTTM", "balanceTTM", "cashFlowTTM"].filter((label) => (deepPlan.selectedSymbols?.length || 0) > 0 && !loaded[label]);
  const missingDeep = rows
    .filter((row) => row.fundamentalsProvider !== "manual" && !hasDeepFmpCoverage(row.fundamentals))
    .map((row) => row.ticker);
  const errors = rows
    .filter((row) => row.fundamentalsError)
    .map((row) => ({ ticker: row.ticker, error: row.fundamentalsError }))
    .slice(0, 60);

  return {
    enabled: !!process.env.FMP_API_KEY,
    deepPlan,
    rateLimited: fmpRateLimited,
    disabledEndpoints: [...fmpDisabledEndpointLabels],
    likelyUnavailableEndpoints,
    loaded,
    rows: rows.length,
    missingDeep,
    errors
  };
}

function computeMetrics(prices) {
  if (!prices.length) return {};
  const latest = prices[prices.length - 1];
  const closes = prices.map((p) => p.close);
  const last = latest.close;
  const oneYear = prices.slice(-252);
  const high52w = Math.max(...oneYear.map((p) => p.high ?? p.close));
  const low52w = Math.min(...oneYear.map((p) => p.low ?? p.close));
  const returns = closes.slice(1).map((close, i) => pct(close, closes[i]));
  const vol = stdev(returns.slice(-60));

  return {
    date: latest.date,
    price: last,
    volume: latest.volume,
    high52w,
    low52w,
    drawdown52w: pct(last, high52w),
    fromLow52w: pct(last, low52w),
    return5d: closes.length > 5 ? pct(last, closes[closes.length - 6]) : null,
    return20d: closes.length > 20 ? pct(last, closes[closes.length - 21]) : null,
    return60d: closes.length > 60 ? pct(last, closes[closes.length - 61]) : null,
    return120d: closes.length > 120 ? pct(last, closes[closes.length - 121]) : null,
    return252d: closes.length > 252 ? pct(last, closes[closes.length - 253]) : null,
    volatility60dAnnualized: Number.isFinite(vol) ? vol * Math.sqrt(252) : null,
    sparkline: prices.slice(-90).map((p) => ({ date: p.date, close: p.close }))
  };
}

function classify(metrics, item) {
  const alerts = [];
  let action = "MONITOR";

  if (!Number.isFinite(metrics.price)) {
    return { action: "NO_DATA", alerts: ["No price data"] };
  }

  if (metrics.drawdown52w <= rules.drawdown_alert) {
    alerts.push(`Drawdown from 52w high below ${rules.drawdown_alert}%`);
    action = item.status === "CORE" ? "REVIEW_BUY_ZONE" : "REVIEW_RISK";
  } else if (metrics.drawdown52w <= rules.drawdown_watch) {
    alerts.push(`Drawdown from 52w high below ${rules.drawdown_watch}%`);
    action = "WATCH_PULLBACK";
  }

  if (metrics.return20d <= rules.momentum_watch) {
    alerts.push(`20d momentum below ${rules.momentum_watch}%`);
  }

  if (metrics.volatility60dAnnualized >= rules.volatility_alert) {
    alerts.push(`60d annualized volatility above ${rules.volatility_alert}%`);
  }

  if (metrics.drawdown52w >= rules.near_high) {
    alerts.push("Near 52w high");
    if (item.status === "SPEC") action = "DO_NOT_CHASE";
  }

  return { action, alerts };
}

function classifyFundamentals(fundamentals) {
  const alerts = [];
  if (!fundamentals) return alerts;
  if (fundamentals.beta >= 1.6) {
    alerts.push("Beta above 1.6");
  }
  if (fundamentals.peTTM >= rules.pe_stretched) {
    alerts.push(`PE TTM above ${rules.pe_stretched}`);
  }
  if (fundamentals.evToEbitdaTTM >= rules.ev_ebitda_stretched) {
    alerts.push(`EV/EBITDA TTM above ${rules.ev_ebitda_stretched}`);
  }
  if (fundamentals.netDebtToEbitdaTTM >= rules.net_debt_ebitda_risk) {
    alerts.push(`Net debt/EBITDA above ${rules.net_debt_ebitda_risk}`);
  }
  if (fundamentals.pfcfTTM >= 40) {
    alerts.push("P/FCF above 40");
  }
  if (fundamentals.altmanZScore !== null && fundamentals.altmanZScore < 1.8) {
    alerts.push("Altman Z-Score distress zone");
  }
  if (fundamentals.piotroskiScore !== null && fundamentals.piotroskiScore <= 3) {
    alerts.push("Low Piotroski score");
  }
  if (fundamentals.operatingMarginTTM <= rules.operating_margin_pressure) {
    alerts.push(`Operating margin below ${rules.operating_margin_pressure}%`);
  }
  if (fundamentals.revenueGrowthYoY <= rules.revenue_growth_weak) {
    alerts.push(`Revenue growth below ${rules.revenue_growth_weak}%`);
  }
  return alerts;
}

function buildResearchScore(row) {
  const score = {
    total: 50,
    grade: "C",
    positives: [],
    negatives: [],
    nextStep: "MONITOR",
    components: {}
  };
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const themes = row.themes || [];

  const add = (key, points, reason) => {
    score.components[key] = (score.components[key] || 0) + points;
    score.total += points;
    if (points > 0 && reason) score.positives.push(reason);
    if (points < 0 && reason) score.negatives.push(reason);
  };

  add("status", row.status === "CORE" ? 8 : row.status === "WATCH" ? 4 : 0, `${row.status} na liscie`);
  add("themes", Math.min(15, themes.length * 5), `ekspozycja: ${themes.join(", ")}`);

  if (Number.isFinite(metrics.return20d)) {
    add("momentum20d", clamp(metrics.return20d / 2, -8, 8), `momentum 20d ${formatPct(metrics.return20d)}`);
  }
  if (Number.isFinite(metrics.return60d)) {
    add("momentum60d", clamp(metrics.return60d / 4, -8, 8), `momentum 60d ${formatPct(metrics.return60d)}`);
  }

  if (Number.isFinite(metrics.drawdown52w)) {
    if (metrics.drawdown52w <= -12 && metrics.drawdown52w >= -35) {
      add("pullback", row.status === "CORE" ? 10 : 6, `sensowny pullback od high 52w ${formatPct(metrics.drawdown52w)}`);
    } else if (metrics.drawdown52w < -45) {
      add("deepDrawdown", -8, `bardzo gleboki drawdown ${formatPct(metrics.drawdown52w)}`);
    } else if (metrics.drawdown52w > -5 && row.status === "SPEC") {
      add("chaseRisk", -8, "SPEC blisko high 52w");
    }
  }

  if (Number.isFinite(metrics.volatility60dAnnualized)) {
    if (metrics.volatility60dAnnualized > 55) add("volatility", -10, `wysoka zmiennosc ${formatPct(metrics.volatility60dAnnualized)}`);
    else if (metrics.volatility60dAnnualized > 45) add("volatility", -6, `podwyzszona zmiennosc ${formatPct(metrics.volatility60dAnnualized)}`);
    else if (metrics.volatility60dAnnualized < 32) add("volatility", 4, `umiarkowana zmiennosc ${formatPct(metrics.volatility60dAnnualized)}`);
  }

  if (Number.isFinite(fundamentals.beta)) {
    if (fundamentals.beta > 2) add("beta", -10, `beta ${formatNumber(fundamentals.beta, 2)}`);
    else if (fundamentals.beta > 1.6) add("beta", -6, `beta ${formatNumber(fundamentals.beta, 2)}`);
    else if (fundamentals.beta <= 1.25) add("beta", 4, `beta ${formatNumber(fundamentals.beta, 2)}`);
  }

  if (Number.isFinite(fundamentals.peTTM)) {
    if (fundamentals.peTTM <= 25) add("valuationPe", 8, `P/E ${formatNumber(fundamentals.peTTM, 1)}`);
    else if (fundamentals.peTTM <= 45) add("valuationPe", 3, `P/E ${formatNumber(fundamentals.peTTM, 1)}`);
    else add("valuationPe", -8, `wysokie P/E ${formatNumber(fundamentals.peTTM, 1)}`);
  }
  if (Number.isFinite(fundamentals.evToEbitdaTTM)) {
    if (fundamentals.evToEbitdaTTM <= 18) add("valuationEv", 6, `EV/EBITDA ${formatNumber(fundamentals.evToEbitdaTTM, 1)}`);
    else if (fundamentals.evToEbitdaTTM > 30) add("valuationEv", -8, `wysokie EV/EBITDA ${formatNumber(fundamentals.evToEbitdaTTM, 1)}`);
  }
  if (Number.isFinite(fundamentals.pfcfTTM)) {
    if (fundamentals.pfcfTTM <= 25) add("valuationFcf", 5, `P/FCF ${formatNumber(fundamentals.pfcfTTM, 1)}`);
    else if (fundamentals.pfcfTTM > 45) add("valuationFcf", -7, `wysokie P/FCF ${formatNumber(fundamentals.pfcfTTM, 1)}`);
  }
  if (Number.isFinite(fundamentals.netDebtToEbitdaTTM) && fundamentals.netDebtToEbitdaTTM > rules.net_debt_ebitda_risk) {
    add("leverage", -8, `zadluzenie ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x EBITDA`);
  }
  if (Number.isFinite(fundamentals.operatingMarginTTM) && fundamentals.operatingMarginTTM >= 0.18) {
    add("margin", 5, `marza operacyjna ${formatPct(fundamentals.operatingMarginTTM * 100)}`);
  }
  if (Number.isFinite(fundamentals.revenueGrowthYoY) && fundamentals.revenueGrowthYoY >= 8) {
    add("growth", 6, `wzrost przychodow ${formatPct(fundamentals.revenueGrowthYoY)}`);
  }
  if (Number.isFinite(fundamentals.fcfGrowthYoY) && fundamentals.fcfGrowthYoY >= 10) {
    add("fcfGrowth", 4, `wzrost FCF ${formatPct(fundamentals.fcfGrowthYoY)}`);
  }
  if (Number.isFinite(fundamentals.piotroskiScore)) {
    if (fundamentals.piotroskiScore >= 7) add("piotroski", 5, `Piotroski ${fundamentals.piotroskiScore}`);
    else if (fundamentals.piotroskiScore <= 3) add("piotroski", -7, `niski Piotroski ${fundamentals.piotroskiScore}`);
  }
  if (Number.isFinite(fundamentals.altmanZScore) && fundamentals.altmanZScore < 1.8) {
    add("altman", -8, `Altman Z ${formatNumber(fundamentals.altmanZScore, 1)}`);
  }

  const keywordHits = (row.secAnalysis?.matches || [])
    .filter((match) => ["orders", "backlog", "book-to-bill", "data center", "datacenter", "artificial intelligence", "AI", "grid", "transmission", "capacity"].includes(match.keyword))
    .reduce((sum, match) => sum + Math.min(match.count, 5), 0);
  if (keywordHits) add("secKeywords", Math.min(10, keywordHits), `SEC keywords: ${keywordHits}`);
  if (row.sec?.newFilings?.length) add("newFiling", 6, "nowy filing SEC");

  const riskAlerts = (row.signal?.alerts || []).filter((alert) => /volatility|above|risk|No price|Fetch failed/i.test(alert)).length;
  if (riskAlerts) add("alerts", -Math.min(12, riskAlerts * 4), `${riskAlerts} alertow ryzyka`);

  score.total = Math.round(clamp(score.total, 0, 100));
  score.grade = score.total >= 80 ? "A" : score.total >= 65 ? "B" : score.total >= 50 ? "C" : score.total >= 35 ? "D" : "E";
  if (row.sec?.newFilings?.length) score.nextStep = "READ_FILING";
  else if (score.total >= 75) score.nextStep = "DEEP_DIVE";
  else if (["REVIEW_BUY_ZONE", "WATCH_PULLBACK"].includes(row.signal?.action)) score.nextStep = "CHECK_PULLBACK";
  else if (["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(row.signal?.action)) score.nextStep = "RISK_REVIEW";
  else score.nextStep = "TRACK";

  score.positives = score.positives.slice(0, 5);
  score.negatives = score.negatives.slice(0, 5);
  return score;
}

function buildReboundScore(row) {
  if (row.status !== "DISTRESSED") return null;
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const score = {
    total: 30,
    grade: "D",
    positives: [],
    negatives: [],
    nextStep: "SURVIVAL_CHECK",
    components: {}
  };
  const add = (key, points, reason) => {
    score.components[key] = (score.components[key] || 0) + points;
    score.total += points;
    if (points > 0 && reason) score.positives.push(reason);
    if (points < 0 && reason) score.negatives.push(reason);
  };

  if (Number.isFinite(metrics.drawdown52w)) {
    if (metrics.drawdown52w <= -70) add("crashDepth", 20, `kapitulacja od high 52w ${formatPct(metrics.drawdown52w)}`);
    else if (metrics.drawdown52w <= -50) add("crashDepth", 14, `duzy drawdown ${formatPct(metrics.drawdown52w)}`);
    else if (metrics.drawdown52w <= -30) add("crashDepth", 8, `umiarkowany drawdown ${formatPct(metrics.drawdown52w)}`);
  }
  if (Number.isFinite(metrics.return20d)) {
    if (metrics.return20d > 20) add("shortMomentum", 14, `mocne odbicie 20d ${formatPct(metrics.return20d)}`);
    else if (metrics.return20d > 8) add("shortMomentum", 8, `pozytywne odbicie 20d ${formatPct(metrics.return20d)}`);
    else if (metrics.return20d < -20) add("shortMomentum", -10, `dalsza wyprzedaz 20d ${formatPct(metrics.return20d)}`);
  }
  if (Number.isFinite(metrics.return60d)) {
    if (metrics.return60d > 25) add("trendRepair", 12, `naprawa trendu 60d ${formatPct(metrics.return60d)}`);
    else if (metrics.return60d > 5) add("trendRepair", 6, `stabilizacja 60d ${formatPct(metrics.return60d)}`);
    else if (metrics.return60d < -30) add("trendRepair", -12, `trend nadal peka ${formatPct(metrics.return60d)}`);
  }
  if (Number.isFinite(metrics.volatility60dAnnualized)) {
    if (metrics.volatility60dAnnualized > 120) add("volatility", -14, `ekstremalna zmiennosc ${formatPct(metrics.volatility60dAnnualized)}`);
    else if (metrics.volatility60dAnnualized > 80) add("volatility", -8, `bardzo wysoka zmiennosc ${formatPct(metrics.volatility60dAnnualized)}`);
    else if (metrics.volatility60dAnnualized < 55) add("volatility", 5, `zmiennosc pod kontrola ${formatPct(metrics.volatility60dAnnualized)}`);
  }
  if (Number.isFinite(fundamentals.marketCap)) {
    if (fundamentals.marketCap < 250_000_000) add("sizeRisk", -10, "microcap survival risk");
    else if (fundamentals.marketCap > 2_000_000_000) add("sizeRisk", 5, "skala bilansowa powyzej microcap");
  }
  if (Number.isFinite(fundamentals.altmanZScore) && fundamentals.altmanZScore < 1.8) {
    add("altman", -12, `Altman Z distress ${formatNumber(fundamentals.altmanZScore, 1)}`);
  }
  if (Number.isFinite(fundamentals.piotroskiScore) && fundamentals.piotroskiScore <= 3) {
    add("piotroski", -8, `slaby Piotroski ${fundamentals.piotroskiScore}`);
  }
  if (Number.isFinite(fundamentals.beta) && fundamentals.beta > 2.5) {
    add("beta", -8, `beta ${formatNumber(fundamentals.beta, 2)}`);
  }

  const alerts = row.signal?.alerts?.length || 0;
  if (alerts >= 3) add("alerts", -10, `${alerts} alertow`);

  score.total = Math.round(clamp(score.total, 0, 100));
  score.grade = score.total >= 75 ? "A" : score.total >= 60 ? "B" : score.total >= 45 ? "C" : score.total >= 30 ? "D" : "E";
  if (score.total >= 70) score.nextStep = "TURNAROUND_DD";
  else if (score.total >= 50) score.nextStep = "SURVIVAL_CHECK";
  else score.nextStep = "AVOID_OR_WATCH";
  score.positives = score.positives.slice(0, 5);
  score.negatives = score.negatives.slice(0, 5);
  return score;
}

function inferDecision(row) {
  const score = row.researchScore?.total ?? 0;
  const nextStep = row.researchScore?.nextStep || "TRACK";
  const manual = researchDecisions.get(String(row.ticker || "").toUpperCase());
  const inferredStatus = nextStep === "READ_FILING"
    ? "Needs filing"
    : score >= 75
      ? "Candidate"
      : nextStep === "CHECK_PULLBACK"
        ? "Waiting"
        : nextStep === "RISK_REVIEW"
          ? "Needs review"
          : "Monitor";
  const inferredPriority = score >= 80 ? "P1" : score >= 65 ? "P2" : score >= 50 ? "P3" : "P4";

  return {
    status: manual?.status || inferredStatus,
    priority: manual?.priority || inferredPriority,
    owner: manual?.owner || "",
    nextReviewDate: manual?.nextReviewDate || "",
    note: manual?.note || "",
    invalidationTrigger: manual?.invalidationTrigger || "",
    updatedAt: manual?.updatedAt || "",
    source: manual ? "research-decisions.csv" : "auto"
  };
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function historyRowsFromSnapshot(snapshot) {
  return (snapshot.rows || []).map((row) => ({
    ticker: row.ticker,
    name: row.name ?? null,
    themes: row.themes ?? [],
    price: row.metrics?.price ?? row.price ?? null,
    drawdown52w: row.metrics?.drawdown52w ?? row.drawdown52w ?? null,
    return20d: row.metrics?.return20d ?? row.return20d ?? null,
    peTTM: row.fundamentals?.peTTM ?? row.peTTM ?? null,
    evToEbitdaTTM: row.fundamentals?.evToEbitdaTTM ?? row.evToEbitdaTTM ?? null,
    researchScore: row.researchScore?.total ?? row.researchScore ?? null,
    reboundScore: row.reboundScore?.total ?? row.reboundScore ?? null,
    nextStep: row.researchScore?.nextStep ?? row.nextStep ?? null,
    decisionStatus: row.decision?.status ?? row.decisionStatus ?? null,
    decisionEngine: row.decisionEngine ? {
      category: row.decisionEngine.category,
      label: row.decisionEngine.label,
      priority: row.decisionEngine.priority,
      confidence: row.decisionEngine.confidence,
      score: row.decisionEngine.score
    } : null,
    action: row.signal?.action ?? row.action ?? null
  }));
}

function parseMonitoringDataScript(text) {
  const marker = "window.MONITORING_DATA = ";
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const body = text.slice(start + marker.length).replace(/;\s*$/, "");
  return JSON.parse(body);
}

let previousPublishedSnapshotCache;

async function fetchPreviousPublishedSnapshot() {
  if (previousPublishedSnapshotCache !== undefined) return previousPublishedSnapshotCache;
  const url = config.data_providers?.previous_published_data_url || process.env.PREVIOUS_MONITORING_DATA_URL;
  if (!url) {
    previousPublishedSnapshotCache = null;
    return previousPublishedSnapshotCache;
  }
  try {
    const response = await fetch(url, { headers: { "user-agent": "local-monitoring-dashboard/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    previousPublishedSnapshotCache = parseMonitoringDataScript(await response.text());
    return previousPublishedSnapshotCache;
  } catch (error) {
    console.log(`Previous published snapshot unavailable: ${error.message}`);
    previousPublishedSnapshotCache = null;
    return previousPublishedSnapshotCache;
  }
}

async function loadPreviousHistory() {
  if (fs.existsSync(historyPath)) {
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      if (Array.isArray(history) && history.length) return history;
    } catch (error) {
      console.log(`Local history unavailable: ${error.message}`);
    }
  }
  const snapshot = await fetchPreviousPublishedSnapshot();
  if (!snapshot?.rows?.length) return [];
  return [{
    generatedAt: snapshot.generatedAt || null,
    rows: historyRowsFromSnapshot(snapshot)
  }];
}

function applyHistoryDeltas(rows, previousHistory) {
  const previous = previousHistory?.[previousHistory.length - 1];
  const currentRanks = new Map(rows
    .slice()
    .sort((a, b) => (b.researchScore?.total ?? -1) - (a.researchScore?.total ?? -1))
    .map((row, index) => [row.ticker, index + 1]));

  if (!previous?.rows?.length) {
    for (const row of rows) {
      row.historyDelta = {
        rank: currentRanks.get(row.ticker) ?? null,
        isNew: true,
        previousRun: null
      };
    }
    return;
  }

  const previousRows = previous.rows || [];
  const previousByTicker = new Map(previousRows.map((row) => [row.ticker, row]));
  const previousRanks = new Map(previousRows
    .slice()
    .sort((a, b) => (b.researchScore ?? -1) - (a.researchScore ?? -1))
    .map((row, index) => [row.ticker, index + 1]));

  for (const row of rows) {
    const previousRow = previousByTicker.get(row.ticker);
    const rank = currentRanks.get(row.ticker) ?? null;
    if (!previousRow) {
      row.historyDelta = {
        rank,
        isNew: true,
        previousRun: previous.generatedAt || null
      };
      continue;
    }

    const score = row.researchScore?.total ?? null;
    const previousScore = previousRow.researchScore ?? null;
    const previousRank = previousRanks.get(row.ticker) ?? null;
    const rankChange = Number.isFinite(rank) && Number.isFinite(previousRank) ? previousRank - rank : null;
    const scoreChange = Number.isFinite(score) && Number.isFinite(previousScore) ? score - previousScore : null;
    const priceChangePct = pctChange(row.metrics?.price, previousRow.price);
    const action = row.signal?.action || null;
    const decisionStatus = row.decision?.status || null;

    row.historyDelta = {
      rank,
      previousRank,
      rankChange,
      previousScore,
      scoreChange,
      previousPrice: previousRow.price ?? null,
      priceChangePct,
      previousAction: previousRow.action || null,
      actionChanged: Boolean(previousRow.action && action && previousRow.action !== action),
      previousDecisionStatus: previousRow.decisionStatus || null,
      decisionChanged: Boolean(previousRow.decisionStatus && decisionStatus && previousRow.decisionStatus !== decisionStatus),
      previousRun: previous.generatedAt || null,
      isNew: false
    };
  }
}

function decisionCategoryWeight(value) {
  return {
    ROZWAZ_WEJSCIE: 5,
    SPECULATIVE_ONLY: 4,
    CZEKAC: 3,
    OBSERWUJ: 2,
    ODRZUC_TERAZ: 1
  }[value] || 0;
}

function rankMap(rows) {
  return new Map((rows || [])
    .slice()
    .sort((a, b) => (b.researchScore ?? -1) - (a.researchScore ?? -1))
    .map((row, index) => [row.ticker, index + 1]));
}

function changeDirection(previousValue, currentValue) {
  const previousWeight = decisionCategoryWeight(previousValue);
  const currentWeight = decisionCategoryWeight(currentValue);
  if (currentWeight > previousWeight) return "improvement";
  if (currentWeight < previousWeight) return "deterioration";
  return "neutral";
}

function buildDecisionChangeLog(history) {
  const events = [];
  for (let i = 1; i < (history || []).length; i += 1) {
    const previous = history[i - 1];
    const current = history[i];
    const previousRows = previous.rows || [];
    const currentRows = current.rows || [];
    const previousByTicker = new Map(previousRows.map((row) => [row.ticker, row]));
    const previousRanks = rankMap(previousRows);
    const currentRanks = rankMap(currentRows);

    for (const row of currentRows) {
      const before = previousByTicker.get(row.ticker);
      if (!before) continue;
      const scoreChange = Number.isFinite(row.researchScore) && Number.isFinite(before.researchScore) ? row.researchScore - before.researchScore : null;
      const previousRank = previousRanks.get(row.ticker) ?? null;
      const currentRank = currentRanks.get(row.ticker) ?? null;
      const rankChange = Number.isFinite(previousRank) && Number.isFinite(currentRank) ? previousRank - currentRank : null;
      const previousCategory = before.decisionEngine?.category || null;
      const currentCategory = row.decisionEngine?.category || null;
      const changes = [];

      if (previousCategory && currentCategory && previousCategory !== currentCategory) {
        changes.push({
          type: "DECISION_ENGINE_CHANGE",
          label: "Zmiana kategorii",
          previous: before.decisionEngine?.label || previousCategory,
          current: row.decisionEngine?.label || currentCategory,
          direction: changeDirection(previousCategory, currentCategory)
        });
      }
      if (before.action && row.action && before.action !== row.action) {
        changes.push({
          type: "ACTION_CHANGE",
          label: "Zmiana akcji",
          previous: before.action,
          current: row.action,
          direction: "neutral"
        });
      }
      if (before.decisionStatus && row.decisionStatus && before.decisionStatus !== row.decisionStatus) {
        changes.push({
          type: "DECISION_STATUS_CHANGE",
          label: "Zmiana statusu",
          previous: before.decisionStatus,
          current: row.decisionStatus,
          direction: "neutral"
        });
      }
      if (Number.isFinite(scoreChange) && Math.abs(scoreChange) >= 10) {
        changes.push({
          type: "SCORE_MOVE",
          label: "Duza zmiana score",
          previous: before.researchScore,
          current: row.researchScore,
          direction: scoreChange > 0 ? "improvement" : "deterioration"
        });
      }
      if (Number.isFinite(rankChange) && Math.abs(rankChange) >= 20) {
        changes.push({
          type: "RANK_MOVE",
          label: "Duzy ruch rankingu",
          previous: previousRank,
          current: currentRank,
          direction: rankChange > 0 ? "improvement" : "deterioration"
        });
      }

      for (const change of changes) {
        events.push({
          generatedAt: current.generatedAt,
          previousRun: previous.generatedAt,
          ticker: row.ticker,
          name: row.name,
          themes: row.themes || [],
          type: change.type,
          label: change.label,
          direction: change.direction,
          previous: change.previous,
          current: change.current,
          previousCategory,
          currentCategory,
          previousDecisionLabel: before.decisionEngine?.label || before.decisionStatus || null,
          currentDecisionLabel: row.decisionEngine?.label || row.decisionStatus || null,
          previousAction: before.action || null,
          currentAction: row.action || null,
          previousScore: before.researchScore ?? null,
          currentScore: row.researchScore ?? null,
          scoreChange,
          previousRank,
          currentRank,
          rankChange
        });
      }
    }
  }

  const latestEvents = events
    .sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")))
    .slice(0, 500);
  return {
    generatedAt: new Date().toISOString(),
    historyRuns: history?.length || 0,
    changes: latestEvents
  };
}

function safeTickerPath(ticker) {
  return String(ticker || "").toUpperCase().replace(/[^A-Z0-9.-]/g, "_");
}

function queueTaskForRow(row) {
  const engine = row.decisionEngine || {};
  const brief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const action = row.signal?.action || "";
  const decision = row.decision?.status || "";
  if (row.sec?.newFilings?.length || action === "REVIEW_FILING" || decision === "Needs filing" || brief?.urgency === "high") {
    return "READ_FILING";
  }
  if (engine.category === "ODRZUC_TERAZ" || action === "REVIEW_RISK" || action === "DO_NOT_CHASE") {
    return "REVIEW_RISK";
  }
  if (engine.category === "ROZWAZ_WEJSCIE" || engine.category === "SPECULATIVE_ONLY") {
    return "REVIEW_MEMO";
  }
  if (engine.category === "CZEKAC" || action === "WATCH_PULLBACK" || action === "REVIEW_BUY_ZONE") {
    return "WATCH_TRIGGER";
  }
  return "MONITOR";
}

function queuePriority(row) {
  const taskWeight = {
    READ_FILING: 500,
    REVIEW_RISK: 430,
    REVIEW_MEMO: 360,
    WATCH_TRIGGER: 240,
    MONITOR: 80
  };
  const priorityWeight = { P1: 120, P2: 80, P3: 40, P4: 10 };
  const delta = row.historyDelta || {};
  const brief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const task = queueTaskForRow(row);
  return (taskWeight[task] || 0)
    + (priorityWeight[row.decisionEngine?.priority] || 0)
    + Math.min(120, row.researchScore?.total || 0)
    + (brief?.urgency === "high" ? 80 : brief?.urgency === "medium" ? 30 : 0)
    + (row.sec?.newFilings?.length ? 90 : 0)
    + (delta.actionChanged ? 55 : 0)
    + (delta.decisionChanged ? 50 : 0)
    + Math.min(60, Math.abs(delta.scoreChange || 0) * 2)
    + Math.min(40, Math.abs(delta.rankChange || 0) * 0.4);
}

function queueReason(row) {
  const engine = row.decisionEngine || {};
  const brief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const reasons = [];
  if (row.sec?.newFilings?.length) reasons.push(`nowy filing SEC: ${row.sec.newFilings.map((filing) => filing.form).join(", ")}`);
  if (brief?.summary) reasons.push(brief.summary);
  if (engine.label) reasons.push(`Decision v2: ${engine.label}`);
  if (row.historyDelta?.actionChanged) reasons.push(`zmiana akcji: ${row.historyDelta.previousAction} -> ${row.signal?.action}`);
  if (row.historyDelta?.decisionChanged) reasons.push(`zmiana decyzji: ${row.historyDelta.previousDecisionStatus} -> ${row.decision?.status}`);
  if (!reasons.length && row.signal?.alerts?.length) reasons.push(row.signal.alerts.slice(0, 2).join("; "));
  return reasons.slice(0, 3).join(" | ") || row.thesis || "monitoring bez pilnej zmiany";
}

function queueEvidence(row) {
  const metrics = row.metrics || {};
  const f = row.fundamentals || {};
  const items = [
    Number.isFinite(metrics.drawdown52w) ? `drawdown52w ${formatPct(metrics.drawdown52w)}` : null,
    Number.isFinite(metrics.return20d) ? `20d ${formatPct(metrics.return20d)}` : null,
    Number.isFinite(metrics.return60d) ? `60d ${formatPct(metrics.return60d)}` : null,
    Number.isFinite(f.peTTM) ? `P/E ${formatNumber(f.peTTM, 1)}` : null,
    Number.isFinite(f.evToEbitdaTTM) ? `EV/EBITDA ${formatNumber(f.evToEbitdaTTM, 1)}` : null,
    Number.isFinite(f.netDebtToEbitdaTTM) ? `net debt/EBITDA ${formatNumber(f.netDebtToEbitdaTTM, 1)}` : null,
    Number.isFinite(f.operatingMarginTTM) ? `marza op. ${formatPct(f.operatingMarginTTM * 100)}` : null,
    Number.isFinite(f.revenueGrowthYoY) ? `revenue YoY ${formatPct(f.revenueGrowthYoY)}` : null
  ];
  return items.filter(Boolean).slice(0, 6);
}

function buildActionQueue(rows) {
  const items = (rows || [])
    .filter((row) => row.decisionEngine || row.secAnalysis?.filingBrief || row.signal?.alerts?.length || row.historyDelta)
    .map((row) => {
      const task = queueTaskForRow(row);
      const safeTicker = safeTickerPath(row.ticker);
      const latest = row.sec?.newFilings?.[0] || row.secAnalysis?.filing || row.sec?.filings?.[0] || null;
      const filingBrief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief || null;
      const filingDecision = filingBrief?.decisionBrief || null;
      const hasMemo = ["ROZWAZ_WEJSCIE", "SPECULATIVE_ONLY"].includes(row.decisionEngine?.category);
      return {
        ticker: row.ticker,
        name: row.name,
        status: row.status,
        themes: row.themes || [],
        task,
        priority: row.decisionEngine?.priority || "P4",
        score: row.researchScore?.total ?? null,
        category: row.decisionEngine?.category || null,
        label: row.decisionEngine?.label || row.investmentVerdict?.label || row.decision?.status || null,
        confidence: row.decisionEngine?.confidence || row.investmentVerdict?.confidence || null,
        reason: queueReason(row),
        nextStep: row.decisionEngine?.nextStep || row.investmentVerdict?.filing?.action || row.researchScore?.nextStep || null,
        blockers: row.decisionEngine?.blockers || row.investmentVerdict?.blockers || [],
        evidence: queueEvidence(row),
        delta: row.historyDelta || null,
        filing: latest ? {
          form: latest.form,
          filingDate: latest.filingDate,
          url: latest.url,
          urgency: filingBrief?.urgency || null,
          sentiment: filingBrief?.sentiment || null,
          decision: filingDecision ? {
            verdict: filingDecision.verdict,
            label: filingDecision.label,
            action: filingDecision.action,
            confidence: filingDecision.confidence,
            readSections: filingDecision.readSections || [],
            reasons: filingDecision.reasons || []
          } : null
        } : null,
        links: {
          dashboard: "#detailsView",
          memo: hasMemo ? `research/memos/${safeTicker}-memo.md` : null,
          deepDive: ["ROZWAZ_WEJSCIE", "CZEKAC", "SPECULATIVE_ONLY", "ODRZUC_TERAZ"].includes(row.decisionEngine?.category) ? `research/deep-dives/${safeTicker}-deep-dive.md` : null,
          sec: latest?.url || null
        },
        weight: queuePriority(row)
      };
    })
    .sort((a, b) => b.weight - a.weight || (b.score || 0) - (a.score || 0))
    .slice(0, 200);

  const byTask = items.reduce((acc, item) => {
    acc[item.task] = (acc[item.task] || 0) + 1;
    return acc;
  }, {});

  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    byTask,
    items
  };
}

function triageBucket(item) {
  const task = item.task;
  const priority = item.priority;
  const score = item.score || 0;
  const delta = item.delta || {};
  const filingDecision = item.filing?.decision?.verdict || "";
  const urgentFiling = task === "READ_FILING";
  const changed = Boolean(delta.actionChanged || delta.decisionChanged || Math.abs(delta.scoreChange || 0) >= 15 || Math.abs(delta.rankChange || 0) >= 35);
  const strongMemo = task === "REVIEW_MEMO" && (priority === "P1" || score >= 85);
  const hardRisk = task === "REVIEW_RISK" && (priority === "P1" || item.filing?.urgency === "high" || changed);

  if (["AVOID_NOW", "CANDIDATE", "REVIEW"].includes(filingDecision) || urgentFiling || hardRisk || strongMemo) return "TODAY";
  if (task === "REVIEW_MEMO" || task === "WATCH_TRIGGER" || changed || priority === "P2") return "THIS_WEEK";
  if (task === "REVIEW_RISK" && score < 55) return "DEFERRED";
  return "PARKING";
}

function triageReason(item, bucket) {
  const delta = item.delta || {};
  const scoreMove = Math.abs(delta.scoreChange || 0);
  const rankMove = Math.abs(delta.rankChange || 0);
  if (bucket === "TODAY" && item.filing?.decision?.verdict === "AVOID_NOW") return "filing wskazuje czerwone flagi: nie eskalowac bez wyjasnienia";
  if (bucket === "TODAY" && ["CANDIDATE", "REVIEW"].includes(item.filing?.decision?.verdict)) return "filing daje potencjalny katalizator do deep dive";
  if (bucket === "TODAY" && item.task === "READ_FILING") return "nowy filing SEC do przeczytania przed decyzja";
  if (bucket === "TODAY" && item.task === "REVIEW_RISK") return "wysokie ryzyko albo mocny spadek wymaga interpretacji";
  if (bucket === "TODAY" && item.task === "REVIEW_MEMO") return "mocny kandydat, ale wymaga memo przed decyzja";
  if (bucket === "TODAY" && (scoreMove >= 15 || rankMove >= 35)) return "duza zmiana score albo rankingu wymaga kontroli";
  if (bucket === "THIS_WEEK") return "istotne, ale nie wymaga natychmiastowej decyzji dzisiaj";
  if (bucket === "DEFERRED") return "duzo ryzyka albo slaby setup; wraca tylko po poprawie danych";
  return "monitorowane bez pilnej akcji";
}

function buildTriageQueue(actionQueue) {
  const limits = { TODAY: 18, THIS_WEEK: 45, PARKING: 90, DEFERRED: 80 };
  const buckets = { TODAY: [], THIS_WEEK: [], PARKING: [], DEFERRED: [] };
  for (const item of actionQueue.items || []) {
    const bucket = triageBucket(item);
    if (buckets[bucket].length >= limits[bucket]) continue;
    buckets[bucket].push({
      ...item,
      bucket,
      triageReason: triageReason(item, bucket)
    });
  }
  const byBucket = Object.fromEntries(Object.entries(buckets).map(([key, items]) => [key, items.length]));
  return {
    generatedAt: new Date().toISOString(),
    byBucket,
    buckets,
    today: buckets.TODAY,
    thisWeek: buckets.THIS_WEEK,
    parking: buckets.PARKING,
    deferred: buckets.DEFERRED
  };
}

function buildAlerts(snapshot) {
  const onlyActions = new Set(config.notifications?.only_actions || []);
  return snapshot.rows
    .filter((row) => row.signal?.alerts?.length || onlyActions.has(row.signal?.action) || row.historyDelta?.actionChanged || row.historyDelta?.decisionChanged)
    .map((row) => ({
      ticker: row.ticker,
      name: row.name,
      status: row.status,
      action: row.signal?.action || "MONITOR",
      price: row.metrics?.price ?? null,
      drawdown52w: row.metrics?.drawdown52w ?? null,
      return20d: row.metrics?.return20d ?? null,
      return60d: row.metrics?.return60d ?? null,
      volatility60dAnnualized: row.metrics?.volatility60dAnnualized ?? null,
      researchScore: row.researchScore?.total ?? null,
      reboundScore: row.reboundScore?.total ?? null,
      nextStep: row.researchScore?.nextStep || null,
      latestFiling: row.sec?.filings?.[0] || null,
      newFilings: row.sec?.newFilings || [],
      filingBrief: row.secAnalysis?.filingBrief || null,
      decision: row.decision || null,
      historyDelta: row.historyDelta || null,
      alerts: row.signal?.alerts || [],
      thesis: row.thesis,
      watch: row.watch,
      risk: row.risk
    }));
}

function upcomingEvents(days = 30) {
  const today = new Date();
  const max = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  return monitoringEvents
    .filter((event) => {
      const date = new Date(`${event.date}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date >= new Date(today.toISOString().slice(0, 10)) && date <= max;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function loadSecState() {
  if (!fs.existsSync(secStatePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(secStatePath, "utf8"));
  } catch {
    return {};
  }
}

function secStateFromSnapshot(snapshot) {
  const state = {};
  for (const row of snapshot?.rows || []) {
    const filings = row.sec?.filings || [];
    state[row.ticker] = filings.map((filing) => filing.accessionNumber).filter(Boolean);
  }
  return state;
}

function applyNewFilingDetection(rows, previousState) {
  const hasPreviousState = Object.keys(previousState).length > 0;
  const nextState = {};

  for (const row of rows) {
    const filings = row.sec?.filings || [];
    const previous = new Set(previousState[row.ticker] || []);
    const current = filings.map((filing) => filing.accessionNumber).filter(Boolean);
    row.sec = {
      ...(row.sec || {}),
      newFilings: hasPreviousState ? filings.filter((filing) => filing.accessionNumber && !previous.has(filing.accessionNumber)) : []
    };
    nextState[row.ticker] = current;
    if (row.sec.newFilings.length) {
      row.signal.alerts.push(`New SEC filing: ${row.sec.newFilings.map((f) => f.form).join(", ")}`);
      if (row.signal.action === "MONITOR") row.signal.action = "REVIEW_FILING";
    }
  }

  fs.writeFileSync(secStatePath, JSON.stringify(nextState, null, 2));
}

function writeNewFilingsMarkdown(snapshot) {
  const rows = snapshot.rows.filter((row) => row.sec?.newFilings?.length);
  const lines = [
    "# Nowe raporty SEC",
    "",
    `Aktualizacja: ${snapshot.generatedAt}`,
    ""
  ];

  if (!rows.length) {
    lines.push("Brak nowych filingow wzgledem poprzedniego przebiegu.");
  } else {
    for (const row of rows) {
      lines.push(`## ${row.ticker} - ${row.name}`);
      lines.push("");
      for (const filing of row.sec.newFilings) {
        lines.push(`- ${filing.form} z ${filing.filingDate}: ${filing.url}`);
      }
      lines.push("");
    }
  }

  fs.writeFileSync(newFilingsPath, `${lines.join("\n")}\n`);
}

function writeSecAnalysisMarkdown(snapshot) {
  const rows = snapshot.rows.filter((row) => row.secAnalysis);
  const lines = [
    "# Analiza tresci SEC",
    "",
    `Aktualizacja: ${snapshot.generatedAt}`,
    "",
    "Parser liczy wystapienia slow-kluczy i pokazuje krotki kontekst. To filtr do recznego czytania raportow, nie pelna interpretacja filingow.",
    ""
  ];

  if (!rows.length) {
    lines.push("Brak przeanalizowanych dokumentow SEC.");
  } else {
    for (const row of rows) {
      const analysis = row.secAnalysis;
      lines.push(`## ${row.ticker} - ${row.name}`);
      lines.push("");
      lines.push(`- Dokument: ${analysis.filing.form} z ${analysis.filing.filingDate}`);
      lines.push(`- Link: ${analysis.filing.url}`);
      if (analysis.filingVerdict) {
        lines.push(`- Werdykt filing: ${analysis.filingVerdict.label}`);
        lines.push(`- Akcja: ${analysis.filingVerdict.action}`);
        lines.push(`- Bilans slow: pozytywne ${analysis.filingVerdict.positiveScore}, ryzyka ${analysis.filingVerdict.riskScore}`);
      }
      if (analysis.filingBrief) {
        const decisionBrief = analysis.filingBrief.decisionBrief;
        lines.push(`- Typ dokumentu: ${analysis.filingBrief.formMeaning}`);
        lines.push(`- Pilnosc: ${analysis.filingBrief.urgency}`);
        lines.push(`- Skrot: ${analysis.filingBrief.summary}`);
        lines.push(`- Co sprawdzic: ${analysis.filingBrief.researchAction}`);
        if (decisionBrief) {
          lines.push(`- Wniosek systemu: ${decisionBrief.label} (${decisionBrief.confidence})`);
          lines.push(`- Akcja operacyjna: ${decisionBrief.action}`);
          if (decisionBrief.reasons?.length) lines.push(`- Dlaczego: ${decisionBrief.reasons.join("; ")}`);
          if (decisionBrief.readSections?.length) lines.push(`- Czytaj najpierw: ${decisionBrief.readSections.slice(0, 5).join("; ")}`);
        }
        if (analysis.filingBrief.eventTypes?.length) {
          lines.push(`- Kategorie: ${analysis.filingBrief.eventTypes.map((event) => event.label).join("; ")}`);
        }
        if (analysis.filingBrief.decisionEvidence?.length) {
          lines.push("- Fragmenty decyzyjne:");
          for (const group of analysis.filingBrief.decisionEvidence.slice(0, 5)) {
            const hit = group.hits?.[0];
            if (hit?.context) lines.push(`  - ${group.label}: ${hit.context}`);
          }
        }
      }
      if (analysis.error) {
        lines.push(`- Blad: ${analysis.error}`);
        lines.push("");
        continue;
      }
      const top = analysis.matches.slice(0, 8);
      if (!top.length) {
        lines.push("- Brak trafien slow-kluczy.");
      } else {
        for (const match of top) {
          lines.push(`- ${match.keyword}: ${match.count} wystapien`);
        }
      }
      lines.push("");
    }
  }

  fs.writeFileSync(secAnalysisPath, `${lines.join("\n")}\n`);
}

function writeAlertsMarkdown(snapshot, alerts) {
  const generated = snapshot.generatedAt;
  const lines = [
    "# Alerty monitoringu",
    "",
    `Ostatnia aktualizacja: ${generated}`,
    "",
    "To nie sa rekomendacje inwestycyjne. To lista sygnalow do recznego sprawdzenia.",
    "",
    "## Priorytety",
    ""
  ];

  if (!alerts.length) {
    lines.push("Brak aktywnych alertow.");
  } else {
    for (const alert of alerts) {
      lines.push(`### ${alert.ticker} - ${alert.name}`);
      lines.push("");
      lines.push(`- Status: ${alert.status}`);
      lines.push(`- Akcja: ${alert.action}`);
      lines.push(`- Cena: ${formatNumber(alert.price)}`);
      lines.push(`- Od high 52w: ${formatPct(alert.drawdown52w)}`);
      lines.push(`- Momentum 20d: ${formatPct(alert.return20d)}`);
      lines.push(`- Momentum 60d: ${formatPct(alert.return60d)}`);
      lines.push(`- Vol 60d annualized: ${formatPct(alert.volatility60dAnnualized)}`);
      lines.push(`- Alerty: ${alert.alerts.join("; ") || "brak"}`);
      lines.push(`- Sprawdz: ${alert.watch || "-"}`);
      lines.push("");
    }
  }

  lines.push("## Kolejka recznego researchu");
  lines.push("");
  lines.push("1. Sprawdz ostatni raport kwartalny i guidance.");
  lines.push("2. Porownaj wycene z 3-letnia srednia i konkurentami.");
  lines.push("3. Zweryfikuj, czy alert wynika z pogorszenia biznesu czy tylko z korekty ceny.");
  lines.push("4. Zmien status w `monitoring-config.json`, jesli teza lub ryzyko ulegly zmianie.");
  fs.writeFileSync(alertsMdPath, `${lines.join("\n")}\n`);
}

function writeDailyReport(snapshot) {
  const rows = snapshot.rows.slice();
  const ranked = rows.slice().sort((a, b) => (b.researchScore?.total ?? -1) - (a.researchScore?.total ?? -1));
  const candidates = rows.filter((row) => row.decision?.status === "Candidate");
  const waiting = rows.filter((row) => row.decision?.status === "Waiting");
  const needsReview = rows.filter((row) => ["Needs review", "Needs filing"].includes(row.decision?.status));
  const opportunities = rows.filter((row) => ["REVIEW_BUY_ZONE", "WATCH_PULLBACK"].includes(row.signal?.action));
  const risks = rows.filter((row) => ["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(row.signal?.action));
  const quiet = rows.filter((row) => !opportunities.includes(row) && !risks.includes(row));
  const fundamentalErrors = rows.filter((row) => row.fundamentalsError);
  const fmpCoverage = (label) => rows.filter((row) => row.fundamentals?.fundamentalsCoverage?.loaded?.includes(label)).length;
  const fmpLoaded = snapshot.fmpCoverage?.loaded || {};
  const secRows = rows.filter((row) => row.sec?.filings?.length);
  const secErrors = rows.filter((row) => row.sec?.error);
  const newFilings = rows.flatMap((row) => (row.sec?.newFilings || []).map((filing) => ({ row, filing })));
  const events = upcomingEvents(30);

  const section = (title, items) => {
    const lines = [`## ${title}`, ""];
    if (!items.length) {
      lines.push("Brak pozycji.");
      lines.push("");
      return lines;
    }
    for (const row of items) {
      lines.push(`- ${row.ticker} (${row.name}) - ${row.signal?.action || "MONITOR"}; cena ${formatNumber(row.metrics?.price)}, od high 52w ${formatPct(row.metrics?.drawdown52w)}, 20d ${formatPct(row.metrics?.return20d)}`);
    }
    lines.push("");
    return lines;
  };

  const lines = [
    "# Dzienny raport monitoringu",
    "",
    `Aktualizacja: ${snapshot.generatedAt}`,
    "",
    "## Szybki odczyt",
    "",
    `- Liczba spolek: ${rows.length}`,
    `- Aktywne alerty: ${rows.reduce((sum, row) => sum + (row.signal?.alerts?.length || 0), 0)}`,
    `- FMP key: ${process.env.FMP_API_KEY ? "ustawiony" : "brak"}`,
    `- FMP deep fundamentals limit: ${config.data_providers?.fmp_deep_fundamentals_limit ?? "brak limitu"}`,
    `- FMP deep rotation: ${snapshot.fmpCoverage?.deepPlan?.prioritySlots ?? 0} priority + ${snapshot.fmpCoverage?.deepPlan?.rotationSlots ?? 0} rotation; today ${snapshot.fmpCoverage?.deepPlan?.selectedSymbols?.join(", ") || "-"}`,
    `- FMP profile loaded: ${fmpLoaded.profile ?? fmpCoverage("profile")}/${rows.length}`,
    `- Full fundamentals loaded: ${fmpLoaded.ratiosTTM ?? fmpCoverage("ratiosTTM")}/${rows.length}`,
    `- FMP ratios/key metrics: ${fmpCoverage("ratiosTTM")}/${rows.length} ratios, ${fmpCoverage("keyMetricsTTM")}/${rows.length} key metrics`,
    `- FMP statements: ${fmpCoverage("incomeTTM")}/${rows.length} income, ${fmpCoverage("balanceTTM")}/${rows.length} balance, ${fmpCoverage("cashFlowTTM")}/${rows.length} cash flow`,
    `- FMP scores/growth: ${fmpCoverage("financialScores")}/${rows.length} scores, ${fmpCoverage("growth")}/${rows.length} growth`,
    `- Fundamentals errors: ${fundamentalErrors.length}`,
    `- Manual fundamentals: ${manualFundamentals.size ? `${manualFundamentals.size} pozycji` : "brak pliku manual-fundamentals.csv"}`,
    `- Manual decisions: ${researchDecisions.size ? `${researchDecisions.size} pozycji` : "brak pliku research-decisions.csv"}`,
    `- SEC filings loaded: ${secRows.length}/${rows.length}`,
    `- SEC errors/no match: ${secErrors.length}`,
    `- New SEC filings: ${newFilings.length}`,
    `- Upcoming events 30d: ${events.length}`,
    "",
    "## Top radar",
    "",
    ...ranked.slice(0, 8).map((row, index) => `- ${index + 1}. ${row.ticker} (${row.name}) - score ${row.researchScore?.total ?? "-"} / ${row.researchScore?.grade || "-"}; next ${row.researchScore?.nextStep || "-"}; plusy: ${(row.researchScore?.positives || []).slice(0, 2).join("; ") || "-"}`),
    "",
    "## Watchlista decyzji",
    "",
    ...[
      ["Candidate", candidates],
      ["Waiting", waiting],
      ["Needs review / filing", needsReview]
    ].flatMap(([title, items]) => [
      `### ${title}`,
      "",
      ...(items.length ? items
        .sort((a, b) => (b.researchScore?.total ?? 0) - (a.researchScore?.total ?? 0))
        .map((row) => `- ${row.ticker} - ${row.decision.priority || "-"}; score ${row.researchScore?.total ?? "-"}; ${row.decision.note || row.researchScore?.nextStep || "-"}`)
        : ["Brak pozycji."]),
      ""
    ]),
    ...section("Okazje / pullback do sprawdzenia", opportunities),
    ...section("Ryzyka do kontroli", risks),
    ...section("Bez pilnej akcji", quiet),
    "## Nowe raporty SEC",
    "",
    ...(newFilings.length ? newFilings.map(({ row, filing }) => `- ${row.ticker}: ${filing.form} z ${filing.filingDate} - ${filing.url}`) : ["Brak nowych filingow wzgledem poprzedniego przebiegu."]),
    "",
    "## Nadchodzace zdarzenia",
    "",
    ...(events.length ? events.map((event) => `- ${event.date} ${event.ticker}: ${event.title}${event.notes ? ` - ${event.notes}` : ""}`) : ["Brak zdarzen w `monitoring-events.csv` na kolejne 30 dni."]),
    "",
    "## Sygnały z tresci SEC",
    "",
    ...rows.filter((row) => row.secAnalysis?.matches?.length).map((row) => {
      const top = row.secAnalysis.matches.slice(0, 5).map((match) => `${match.keyword}=${match.count}`).join(", ");
      return `- ${row.ticker}: ${top}`;
    }),
    rows.some((row) => row.secAnalysis?.matches?.length) ? "" : "Brak trafien slow-kluczy.",
    "",
    "## Najnowsze raporty SEC",
    "",
    ...rows.filter((row) => row.sec?.filings?.[0]).map((row) => {
      const filing = row.sec.filings[0];
      return `- ${row.ticker}: ${filing.form} z ${filing.filingDate} - ${filing.url}`;
    }),
    rows.some((row) => row.sec?.filings?.[0]) ? "" : "Brak danych SEC.",
    "",
    "## Checklist przed decyzja",
    "",
    "- Czy spadek ceny wynika z pogorszenia tezy czy tylko z korekty rynku?",
    "- Czy ostatni raport potwierdza backlog, marze i guidance?",
    "- Czy wycena jest akceptowalna wobec wzrostu i ryzyka?",
    "- Czy pozycja nie dubluje za mocno tej samej ekspozycji tematycznej?"
  ];

  fs.writeFileSync(dailyReportPath, `${lines.join("\n")}\n`);
}

function sendWindowsToast(alerts) {
  if (!alerts.length || process.platform !== "win32") return;
  const top = alerts.slice(0, 3).map((a) => `${a.ticker}: ${a.action}`).join(" | ");
  const title = "Stock monitor";
  const body = `${alerts.length} alertow. ${top}`;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = ${JSON.stringify(title)}
$notify.BalloonTipText = ${JSON.stringify(body)}
$notify.Visible = $true
$notify.ShowBalloonTip(8000)
Start-Sleep -Seconds 9
$notify.Dispose()
`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  } catch {
    // Notification failure should not break data updates.
  }
}

function buildInvestmentVerdict(row) {
  const score = row.researchScore?.total ?? 0;
  const filingVerdict = row.secAnalysis?.filingVerdict || null;
  const action = row.signal?.action || "MONITOR";
  const decision = row.decision?.status || "";
  const alerts = row.signal?.alerts || [];
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const reasons = [];
  const blockers = [];

  if (filingVerdict) {
    if (filingVerdict.label === "pozytywny filing") reasons.push(`filing pozytywny: ${filingVerdict.positives.slice(0, 2).map((item) => item.keyword).join(", ")}`);
    if (filingVerdict.criticalRisks?.length) blockers.push(`krytyczne ryzyko w filing: ${filingVerdict.criticalRisks.slice(0, 2).map((item) => item.keyword).join(", ")}`);
    else if (filingVerdict.label === "filing z ryzykami" || filingVerdict.label === "negatywny filing") blockers.push(`filing ma ryzyka: ${filingVerdict.risks.slice(0, 2).map((item) => item.keyword).join(", ")}`);
    if (row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === "DILUTION")) blockers.push("filing sugeruje mozliwe rozwodnienie");
    if (row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === "BANKRUPTCY_OR_LISTING")) blockers.push("filing sugeruje ryzyko bankructwa/delistingu");
  }
  if (score >= 80) reasons.push(`wysoki score researchowy ${score}`);
  if (Number.isFinite(metrics.return60d) && metrics.return60d > 10) reasons.push(`momentum 60d ${formatPct(metrics.return60d)}`);
  if (Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w > -5) blockers.push("blisko high 52w - nie gonic ceny");
  if (["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(action)) blockers.push(`akcja systemowa ${action}`);
  if (decision === "Needs filing") blockers.push("najpierw przeczytac filing");
  if (alerts.some((alert) => /Fetch failed|No price data|No valid close/i.test(alert))) blockers.push("brak kompletnych danych cenowych");
  if (Number.isFinite(fundamentals.netDebtToEbitdaTTM) && fundamentals.netDebtToEbitdaTTM > rules.net_debt_ebitda_risk) blockers.push(`zadluzenie ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x EBITDA`);
  if (Number.isFinite(fundamentals.peTTM) && fundamentals.peTTM > rules.pe_stretched) blockers.push(`wysokie P/E ${formatNumber(fundamentals.peTTM, 1)}`);

  let verdict = "OBSERWOWAC";
  let label = "Obserwowac";
  let confidence = "medium";
  if (blockers.some((item) => /brak kompletnych danych|krytyczne ryzyko|DO_NOT_CHASE/i.test(item))) {
    verdict = "NIE_INWESTOWAC_TERAZ";
    label = "Nie inwestowac teraz";
    confidence = "high";
  } else if (blockers.length >= 2) {
    verdict = "WSTRZYMAC";
    label = "Wstrzymac sie";
    confidence = "medium";
  } else if (score >= 80 && filingVerdict?.label === "pozytywny filing" && blockers.length === 0) {
    verdict = "WARTO_ANALIZOWAC";
    label = "Warto analizowac";
    confidence = "medium";
  } else if (score >= 75 && blockers.length <= 1) {
    verdict = "KANDYDAT";
    label = "Kandydat po sprawdzeniu pakietu decyzji";
    confidence = "medium";
  } else if (row.status === "DISTRESSED" && (row.reboundScore?.total ?? 0) < 50) {
    verdict = "ODRZUCIC";
    label = "Odrzucic na teraz";
    confidence = "medium";
    blockers.push(`slaby rebound score ${row.reboundScore?.total ?? "-"}`);
  }

  return {
    verdict,
    label,
    confidence,
    reasons: reasons.slice(0, 4),
    blockers: [...new Set(blockers)].slice(0, 5),
    filing: filingVerdict ? {
      label: filingVerdict.label,
      action: filingVerdict.action,
      score: filingVerdict.score,
      positiveScore: filingVerdict.positiveScore,
      riskScore: filingVerdict.riskScore,
      brief: row.secAnalysis?.filingBrief || null
    } : null
  };
}

function hasFilingEvent(row, type) {
  return row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === type);
}

function buildDecisionEngine(row) {
  const score = row.researchScore?.total ?? 0;
  const rebound = row.reboundScore?.total ?? 0;
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const verdict = row.investmentVerdict || {};
  const blockers = new Set(verdict.blockers || []);
  const reasons = new Set(verdict.reasons || []);
  const delta = row.historyDelta || {};
  const action = row.signal?.action || "MONITOR";
  const filingUrgency = row.secAnalysis?.filingBrief?.urgency || "none";
  const filingSentiment = row.secAnalysis?.filingBrief?.sentiment || "";

  if (hasFilingEvent(row, "LIQUIDITY_RISK")) blockers.add("SEC: ryzyko plynnosci / going concern");
  if (hasFilingEvent(row, "DILUTION")) blockers.add("SEC: emisja lub mozliwe rozwodnienie");
  if (hasFilingEvent(row, "BANKRUPTCY_OR_LISTING")) blockers.add("SEC: bankructwo, delisting albo zgodnosc z gielda");
  if (/negatywny filing/i.test(filingSentiment)) blockers.add("SEC: negatywny filing");
  if (Number.isFinite(fundamentals.netDebtToEbitdaTTM) && fundamentals.netDebtToEbitdaTTM > rules.net_debt_ebitda_risk) blockers.add(`zadluzenie ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x EBITDA`);
  if (Number.isFinite(fundamentals.altmanZScore) && fundamentals.altmanZScore < 1.8) blockers.add(`Altman Z ${formatNumber(fundamentals.altmanZScore, 1)}`);
  if (Number.isFinite(fundamentals.piotroskiScore) && fundamentals.piotroskiScore <= 3) blockers.add(`Piotroski ${formatNumber(fundamentals.piotroskiScore, 0)}`);
  if (action === "NO_DATA") blockers.add("brak danych cenowych");

  if (score >= 80) reasons.add(`wysoki radar score ${score}`);
  if (Number.isFinite(metrics.return20d) && metrics.return20d > 6) reasons.add(`momentum 20d ${formatPct(metrics.return20d)}`);
  if (Number.isFinite(metrics.return60d) && metrics.return60d > 8) reasons.add(`momentum 60d ${formatPct(metrics.return60d)}`);
  if (Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w <= -12 && metrics.drawdown52w >= -35) reasons.add(`pullback od high 52w ${formatPct(metrics.drawdown52w)}`);
  if (Number.isFinite(fundamentals.peTTM) && fundamentals.peTTM > 0 && fundamentals.peTTM <= 30) reasons.add(`P/E ${formatNumber(fundamentals.peTTM, 1)}`);
  if (Number.isFinite(fundamentals.evToEbitdaTTM) && fundamentals.evToEbitdaTTM > 0 && fundamentals.evToEbitdaTTM <= 18) reasons.add(`EV/EBITDA ${formatNumber(fundamentals.evToEbitdaTTM, 1)}`);
  if (filingUrgency === "low" || /pozytywny|neutralny/i.test(filingSentiment)) reasons.add(`filing ${filingSentiment || filingUrgency}`);

  const redFlags = [...blockers].filter((item) => /going concern|plynnosci|rozwodnienie|bankructwo|delisting|brak danych/i.test(item));
  const chased = action === "DO_NOT_CHASE" || (Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w > -5) || (Number.isFinite(metrics.return20d) && metrics.return20d > 35);
  const improving = Number.isFinite(metrics.return20d) && metrics.return20d > 5 && Number.isFinite(metrics.return60d) && metrics.return60d > -10;
  const distressed = row.status === "DISTRESSED" || (row.themes || []).includes("DISTRESSED-REBOUND");

  let category = "OBSERWUJ";
  let label = "OBSERWUJ";
  let priority = "P4";
  let confidence = "medium";
  let nextStep = "Czekaj na nowy filing, wyniki albo poprawe momentum.";

  if (redFlags.length) {
    category = "ODRZUC_TERAZ";
    label = "ODRZUCIC NA TERAZ";
    priority = "P1";
    confidence = "high";
    nextStep = "Nie eskaluj do decyzji, dopoki czerwone ryzyka nie zostana wyjasnione w filingach i liczbach.";
  } else if (distressed && rebound >= 50 && improving && redFlags.length === 0) {
    category = "SPECULATIVE_ONLY";
    label = "SPECULATIVE ONLY";
    priority = "P2";
    confidence = "medium";
    nextStep = "Tylko koszyk spekulacyjny: sprawdz runway gotowki, emisje, zadluzenie i najblizsze katalizatory.";
  } else if (chased) {
    category = "CZEKAC";
    label = "CZEKAC NA CENE / POTWIERDZENIE";
    priority = score >= 75 ? "P2" : "P3";
    confidence = "medium";
    nextStep = "Nie gonic ruchu; czekaj na pullback, lepszy risk/reward albo potwierdzenie w kolejnym raporcie.";
  } else if (score >= 80 && blockers.size <= 1 && reasons.size >= 3) {
    category = "ROZWAZ_WEJSCIE";
    label = "WEJSCIE DO ROZWAZENIA";
    priority = "P1";
    confidence = "medium";
    nextStep = "Przejdz do decyzji po sprawdzeniu pakietu: filing, wycena, marze, cash flow i najnowsze newsy.";
  } else if (score >= 65 || Math.abs(delta.rankChange || 0) >= 20 || row.sec?.newFilings?.length) {
    category = "CZEKAC";
    label = "CZEKAC NA CENE / POTWIERDZENIE";
    priority = score >= 75 || row.sec?.newFilings?.length ? "P2" : "P3";
    confidence = "medium";
    nextStep = "Obserwuj setup; decyzja dopiero po potwierdzeniu ceny, filingow albo fundamentow.";
  }

  return {
    version: "v2",
    category,
    label,
    priority,
    confidence,
    score,
    reasons: [...reasons].slice(0, 5),
    blockers: [...blockers].slice(0, 5),
    nextStep,
    flags: {
      redFlags: redFlags.slice(0, 4),
      chased,
      distressed,
      improving,
      filingUrgency
    }
  };
}

function daysBetween(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function buildSignalPerformance(rows, previousHistory, generatedAt) {
  const currentByTicker = new Map(rows.map((row) => [row.ticker, row]));
  const windows = [5, 20, 60];
  const categories = ["ROZWAZ_WEJSCIE", "CZEKAC", "SPECULATIVE_ONLY", "ODRZUC_TERAZ"];
  const currentByCategory = categories.map((category) => {
    const items = rows.filter((row) => row.decisionEngine?.category === category);
    return {
      category,
      count: items.length,
      top: items
        .slice()
        .sort((a, b) => (b.researchScore?.total || 0) - (a.researchScore?.total || 0))
        .slice(0, 5)
        .map((row) => ({ ticker: row.ticker, score: row.researchScore?.total ?? null }))
    };
  });
  const signals = [];

  for (const entry of previousHistory || []) {
    const ageDays = daysBetween(entry.generatedAt, generatedAt);
    if (!Number.isFinite(ageDays) || ageDays < 1) continue;
    for (const historic of entry.rows || []) {
      const engine = historic.decisionEngine || {};
      const category = engine.category || (historic.decisionStatus === "Candidate" ? "ROZWAZ_WEJSCIE" : "");
      if (!["ROZWAZ_WEJSCIE", "CZEKAC", "SPECULATIVE_ONLY", "ODRZUC_TERAZ"].includes(category)) continue;
      const current = currentByTicker.get(historic.ticker);
      const startPrice = Number(historic.price);
      const currentPrice = Number(current?.metrics?.price);
      if (!current || !Number.isFinite(startPrice) || !Number.isFinite(currentPrice) || startPrice <= 0) continue;
      const returnPct = pctChange(currentPrice, startPrice);
      signals.push({
        ticker: historic.ticker,
        name: historic.name || current.name || "",
        category,
        label: engine.label || historic.decisionStatus || category,
        priority: engine.priority || null,
        signalDate: entry.generatedAt,
        ageDays,
        startPrice,
        currentPrice,
        returnPct,
        startScore: historic.researchScore,
        currentScore: current.researchScore?.total ?? null,
        themes: historic.themes?.length ? historic.themes : current.themes || []
      });
    }
  }

  function aggregate(items) {
    const returns = items.map((item) => item.returnPct).filter(Number.isFinite);
    const winners = returns.filter((value) => value > 0).length;
    const avgReturn = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
    return { count: items.length, avgReturn, winRate: returns.length ? (winners / returns.length) * 100 : null };
  }

  const byCategory = categories.map((category) => {
    const categorySignals = signals.filter((item) => item.category === category);
    const result = { category, active: categorySignals.length };
    for (const window of windows) {
      result[`${window}d`] = aggregate(categorySignals.filter((item) => item.ageDays >= window));
    }
    return result;
  });

  const themeMap = new Map();
  for (const signal of signals) {
    for (const theme of signal.themes || ["OTHER"]) {
      if (!themeMap.has(theme)) themeMap.set(theme, []);
      themeMap.get(theme).push(signal);
    }
  }
  const byTheme = [...themeMap.entries()]
    .map(([theme, items]) => ({ theme, active: items.length, result20d: aggregate(items.filter((item) => item.ageDays >= 20)) }))
    .sort((a, b) => (b.result20d.avgReturn ?? -999) - (a.result20d.avgReturn ?? -999) || b.active - a.active)
    .slice(0, 20);

  const latestSignals = signals
    .sort((a, b) => new Date(b.signalDate).getTime() - new Date(a.signalDate).getTime() || (b.startScore || 0) - (a.startScore || 0))
    .slice(0, 80);

  return {
    generatedAt,
    windows,
    historyRuns: previousHistory?.length || 0,
    signalCount: signals.length,
    currentByCategory,
    byCategory,
    byTheme,
    latestSignals
  };
}

async function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  let previousSecState = loadSecState();
  const previousPublishedSnapshot = await fetchPreviousPublishedSnapshot();
  const previousFundamentalsByTicker = new Map((previousPublishedSnapshot?.rows || [])
    .filter((row) => row.fundamentals)
    .map((row) => [row.ticker, row.fundamentals]));
  if (!Object.keys(previousSecState).length) {
    previousSecState = secStateFromSnapshot(previousPublishedSnapshot);
  }
  let secTickerMap = {};
  try {
    secTickerMap = await fetchSecTickerMap();
  } catch (error) {
    console.log(`SEC ticker map failed: ${error.message}`);
  }

  const previousHistory = await loadPreviousHistory();
  const secAnalysisLimit = Number.isFinite(Number(runtime.max_sec_analysis_per_run))
    ? Number(runtime.max_sec_analysis_per_run)
    : 40;
  let secAnalysesUsed = 0;
  const fmpDeepPlan = buildFmpDeepPlan(config.watchlist, previousFundamentalsByTicker);
  const fmpDeepSymbols = new Set(fmpDeepPlan.selectedSymbols);

  const rows = [];
  for (const item of config.watchlist) {
    process.stdout.write(`Fetching ${item.ticker} (${item.yahoo || item.stooq})... `);
    try {
      const prices = await fetchYahoo(item.yahoo || item.ticker);
      const metrics = computeMetrics(prices);
      const signal = classify(metrics, item);
      const allowDeepFmp = fmpDeepSymbols.has(item.ticker);
      const fundamentals = await fetchFundamentals(item, {
        deep: allowDeepFmp,
        previousFundamentals: previousFundamentalsByTicker.get(item.ticker)
      });
      const sec = Object.keys(secTickerMap).length ? await fetchSecFilings(item, secTickerMap) : { cik: null, filings: [], error: "SEC ticker map unavailable" };
      const fundamentalAlerts = classifyFundamentals(fundamentals.data);
      rows.push({
        ...item,
        metrics,
        fundamentals: fundamentals.data,
        fundamentalsProvider: fundamentals.provider,
        fundamentalsError: fundamentals.error,
        sec,
        secAnalysis: null,
        signal: { ...signal, alerts: [...signal.alerts, ...fundamentalAlerts] },
        error: null
      });
      rows[rows.length - 1].researchScore = buildResearchScore(rows[rows.length - 1]);
      console.log("ok");
    } catch (error) {
      rows.push({
        ...item,
        metrics: {},
        fundamentals: null,
        fundamentalsProvider: null,
        fundamentalsError: null,
        sec: { cik: null, filings: [], error: null },
        secAnalysis: null,
        signal: { action: "NO_DATA", alerts: ["Fetch failed"] },
        error: error.message
      });
      rows[rows.length - 1].researchScore = buildResearchScore(rows[rows.length - 1]);
      console.log(`failed: ${error.message}`);
    }
  }

  applyNewFilingDetection(rows, previousSecState);
  const secCandidates = rows
    .filter((row) => row.sec?.filings?.[0])
    .sort((a, b) => {
      const priorityA = (a.sec?.newFilings?.length ? 1000 : 0)
        + (a.status === "CORE" ? 150 : 0)
        + (a.status === "WATCH" ? 80 : 0)
        + (["REVIEW_RISK", "REVIEW_FILING", "WATCH_PULLBACK", "REVIEW_BUY_ZONE"].includes(a.signal?.action) ? 120 : 0)
        + (a.researchScore?.total ?? 0);
      const priorityB = (b.sec?.newFilings?.length ? 1000 : 0)
        + (b.status === "CORE" ? 150 : 0)
        + (b.status === "WATCH" ? 80 : 0)
        + (["REVIEW_RISK", "REVIEW_FILING", "WATCH_PULLBACK", "REVIEW_BUY_ZONE"].includes(b.signal?.action) ? 120 : 0)
        + (b.researchScore?.total ?? 0);
      return priorityB - priorityA;
    })
    .slice(0, secAnalysisLimit);

  for (const row of secCandidates) {
    row.secAnalysis = await analyzeSecDocument(row.sec.filings[0]);
    secAnalysesUsed += 1;
  }

  for (const row of rows) {
    row.researchScore = buildResearchScore(row);
    row.reboundScore = buildReboundScore(row);
    row.decision = inferDecision(row);
    row.investmentVerdict = buildInvestmentVerdict(row);
  }
  applyHistoryDeltas(rows, previousHistory);
  for (const row of rows) {
    row.decisionEngine = buildDecisionEngine(row);
  }

  const generatedAt = new Date().toISOString();
  const actionQueue = buildActionQueue(rows);
  const triageQueue = buildTriageQueue(actionQueue);
  const snapshot = {
    generatedAt,
    source: "Yahoo Chart daily prices",
    rules,
    upcomingEvents: upcomingEvents(30),
    fmpCoverage: buildFmpCoverage(rows, fmpDeepPlan),
    signalPerformance: buildSignalPerformance(rows, previousHistory, generatedAt),
    actionQueue,
    triageQueue,
    rows
  };

  const alerts = buildAlerts(snapshot);

  const historyEntry = {
    generatedAt: snapshot.generatedAt,
    rows: historyRowsFromSnapshot(snapshot)
  };

  const history = [...previousHistory, historyEntry].slice(-180);
  const decisionChangeLog = buildDecisionChangeLog(history);
  snapshot.decisionChangeLog = decisionChangeLog;
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  fs.writeFileSync(decisionChangeLogPath, JSON.stringify(decisionChangeLog, null, 2));
  fs.writeFileSync(actionQueuePath, JSON.stringify(snapshot.actionQueue, null, 2));
  fs.writeFileSync(triageQueuePath, JSON.stringify(snapshot.triageQueue, null, 2));
  fs.writeFileSync(outputPath, `window.MONITORING_DATA = ${JSON.stringify(snapshot, null, 2)};\n`);
  if (config.notifications?.write_alerts_json !== false) {
    fs.writeFileSync(alertsJsonPath, JSON.stringify({ generatedAt: snapshot.generatedAt, alerts }, null, 2));
  }
  if (config.notifications?.write_alerts_markdown !== false) {
    writeAlertsMarkdown(snapshot, alerts);
  }
  writeNewFilingsMarkdown(snapshot);
  writeSecAnalysisMarkdown(snapshot);
  writeDailyReport(snapshot);
  if (config.notifications?.windows_toast === true) {
    sendWindowsToast(alerts);
  }
  console.log(`Wrote ${path.relative(root, outputPath)}`);
  console.log(`Alerts: ${alerts.length}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

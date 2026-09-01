const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildVerdictLedger } = require("./lib/verdict-performance");

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
const todayDecisionQueuePath = path.join(dataDir, "today-decision-queue.json");
const todayDecisionChangesPath = path.join(dataDir, "today-decision-changes.json");
const decisionPackagesPath = path.join(dataDir, "decision-packages.json");
const decisionRegistryPath = path.join(dataDir, "decision-registry.json");
const verdictLedgerPath = path.join(dataDir, "verdict-ledger.json");
const researchPriorityQueuePath = path.join(dataDir, "research-priority-queue.json");
const dailyReportPath = path.join(root, "daily-report.md");
const manualFundamentalsPath = path.join(root, "manual-fundamentals.csv");
const cikCachePath = path.join(dataDir, "sec-company-tickers.json");
const secCompanyFactsCachePath = path.join(dataDir, "sec-companyfacts-cache.json");
const secStatePath = path.join(dataDir, "sec-filings-state.json");
const newFilingsPath = path.join(root, "new-filings.md");
const eventsPath = path.join(root, "monitoring-events.csv");
const decisionsPath = path.join(root, "research-decisions.csv");
const secAnalysisPath = path.join(root, "sec-analysis.md");
const fmpProfileCachePath = path.join(dataDir, "fmp-profile-cache.json");
const secEarningsReleaseCachePath = path.join(dataDir, "sec-earnings-release-cache.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const rules = config.rules || {};
const runtime = config.runtime || {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmpDisabledEndpointLabels = new Set();
let lastFmpRequestAt = 0;
let fmpRateLimited = false;
let fmpRequestCount = 0;
let secEarningsReleaseRequests = 0;
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
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
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
  fmpRequestCount += 1;
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
    fmpRequestCount += 1;
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

async function fetchFmpRowsOptional(pathname, params, label) {
  if (fmpDisabledEndpointLabels.has(label)) {
    return { label, data: [], error: "Skipped after plan/access error" };
  }
  try {
    const result = await fetchFmpJson(pathname, params);
    const rows = Array.isArray(result) ? result : result && typeof result === "object" ? [result] : [];
    return { label, data: rows.filter((row) => row && typeof row === "object"), error: null };
  } catch (error) {
    if (/HTTP 402|not available|plan|subscription|upgrade|access/i.test(error.message)) {
      fmpDisabledEndpointLabels.add(label);
    }
    return { label, data: [], error: error.message };
  }
}

function factUnitRows(companyFacts, tag) {
  const units = companyFacts?.facts?.["us-gaap"]?.[tag]?.units || {};
  return units.USD || units.usd || [];
}

function factDurationDays(row) {
  const start = row?.start ? new Date(row.start).getTime() : NaN;
  const end = row?.end ? new Date(row.end).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / (24 * 60 * 60 * 1000);
}

function latestCashFlowFact(companyFacts, tags) {
  const candidates = tags
    .flatMap((tag) => factUnitRows(companyFacts, tag).map((row) => ({ ...row, tag, durationDays: factDurationDays(row) })))
    .filter((row) => Number.isFinite(row.val) && row.end && ["10-K", "10-Q", "20-F", "6-K"].includes(row.form))
    .filter((row) => !row.frame || !/CY\d{4}Q\dI/i.test(row.frame));
  const annual = candidates.filter((row) => (row.durationDays || 0) >= 300);
  const source = annual.length ? annual : candidates.filter((row) => (row.durationDays || 0) >= 70);
  return source
    .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime() || new Date(b.filed || 0).getTime() - new Date(a.filed || 0).getTime())[0] || null;
}

function extractSecCashFlowFallback(companyFacts) {
  const operating = latestCashFlowFact(companyFacts, [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"
  ]);
  const capex = latestCashFlowFact(companyFacts, [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsForProceedsFromProductiveAssets"
  ]);
  if (!operating && !capex) return null;
  const operatingCashFlow = firstNumber(operating?.val);
  const capitalExpenditures = firstNumber(capex?.val);
  const freeCashFlow = Number.isFinite(operatingCashFlow) && Number.isFinite(capitalExpenditures)
    ? operatingCashFlow - Math.abs(capitalExpenditures)
    : null;
  const basis = operating?.durationDays >= 300 ? "FY" : operating?.durationDays >= 70 ? "quarter" : "latest";
  return {
    source: "SEC companyfacts",
    basis,
    form: operating?.form || capex?.form || null,
    fiscalYear: operating?.fy || capex?.fy || null,
    fiscalPeriod: operating?.fp || capex?.fp || null,
    periodEnd: operating?.end || capex?.end || null,
    filed: operating?.filed || capex?.filed || null,
    operatingCashFlow,
    capitalExpenditures,
    freeCashFlow
  };
}

async function fetchSecCashFlowFallback(cik) {
  const normalizedCik = String(cik || "").replace(/\D/g, "").padStart(10, "0");
  if (!normalizedCik || normalizedCik === "0000000000") return { data: null, error: "No CIK" };
  const cache = loadJsonFile(secCompanyFactsCachePath, {});
  const cached = cache[normalizedCik];
  const maxAgeMs = (config.data_providers?.sec_companyfacts_cache_days || 14) * 24 * 60 * 60 * 1000;
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < maxAgeMs) return { data: cached.data, error: cached.error || null, cached: true };

  try {
    if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
    const facts = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${normalizedCik}.json`);
    const data = extractSecCashFlowFallback(facts);
    cache[normalizedCik] = { fetchedAt: new Date().toISOString(), data, error: data ? null : "No cash flow facts" };
    saveJsonFile(secCompanyFactsCachePath, cache);
    return { data, error: data ? null : "No cash flow facts", cached: false };
  } catch (error) {
    cache[normalizedCik] = { fetchedAt: new Date().toISOString(), data: null, error: error.message };
    saveJsonFile(secCompanyFactsCachePath, cache);
    return { data: null, error: error.message, cached: false };
  }
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
  const risks = filingKeywordHits(text, riskKeywords).filter((hit) => isConfirmedFilingRiskHit(hit, filing)).slice(0, 7);
  const eventRisks = filing?.form === "8-K" || filing?.form === "6-K" ? filingKeywordHits(text, eventRiskKeywords).slice(0, 5) : [];
  const criticalRisks = filingKeywordHits(text, criticalRiskKeywords).filter((hit) => isConfirmedFilingRiskHit(hit, filing)).slice(0, 5);
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
      label: "Form 4 - zmiana pozycji insidera",
      severity: "medium",
      keywords: filing?.form === "4" ? ["transaction", "acquired", "disposed", "beneficial ownership"] : []
    }
  ];

  return eventDefinitions
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
  const meanings = {
    "8-K": "zdarzenie biezace, czesto pilne",
    "10-Q": "raport kwartalny",
    "10-K": "raport roczny",
    "6-K": "raport biezacy emitenta zagranicznego",
    "20-F": "raport roczny emitenta zagranicznego",
    "4": "zgloszenie zmiany wlasnosci osoby powiazanej ze spolka",
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
  if (!focus.length && eventLabels.length && filing?.form !== "4") focus.push(`typ zdarzenia: ${eventLabels.join(", ")}`);
  if (!focus.length && filing?.form === "4") focus.push("sam formularz nie przesadza, czy byl to zakup, sprzedaz, grant albo realizacja opcji");
  if (!focus.length) focus.push("brak mocnych slow-kluczy w automatycznym skanie");

  let researchAction = "czytaj selektywnie";
  if (highestSeverity === "high" || /negatywny|ryzykami/i.test(verdict.label)) researchAction = "najpierw sprawdz: plynnosc, zadluzenie, rozwodnienie, guidance i czy spadek ceny wynika z pogorszenia biznesu";
  else if (/pozytywny/i.test(verdict.label)) researchAction = "sprawdz liczby w pakiecie decyzji: marze, wzrost, cash flow, wycene i ostatnie newsy";
  else if (filing?.form === "8-K" || filing?.form === "6-K") researchAction = "sprawdz, co bylo powodem publikacji";
  else if (filing?.form === "4") researchAction = "sprawdz sekcje Insiderzy: kod P oznacza zakup rynkowy, S sprzedaz, a grant lub opcja nie jest samodzielnym sygnalem kierunku";

  return {
    formMeaning: filingFormMeaning(filing?.form),
    sentiment: verdict.label,
    urgency: highestSeverity,
    eventTypes: events.map((event) => ({
      type: event.type,
      label: event.label,
      severity: event.severity,
      confirmed: event.confirmed !== false,
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

function secRequestHeaders(accept = "application/json") {
  return {
    "user-agent": config.data_providers?.sec_user_agent || "local-monitoring-pipeline contact@example.com",
    accept
  };
}

function secArchiveBase(cik, accessionNumber) {
  const normalizedCik = Number(String(cik || "").replace(/\D/g, ""));
  const accession = String(accessionNumber || "").replace(/-/g, "");
  return normalizedCik && accession ? `https://www.sec.gov/Archives/edgar/data/${normalizedCik}/${accession}` : null;
}

function earningsReleaseFileScore(file, filing) {
  const name = String(file?.name || "");
  const lower = name.toLowerCase();
  if (!/\.(?:htm|html|txt)$/.test(lower) || lower === String(filing?.primaryDocument || "").toLowerCase()) return -1;
  let score = 0;
  if (/(?:ex|exhibit)[-_]?(?:99|99[._-]?0?1)|ex991/.test(lower)) score += 120;
  if (/earnings|results|press.?release|news.?release/.test(lower)) score += 90;
  if (/99[._-]?0?1/.test(lower)) score += 40;
  if (/graphic|image|logo|chart/.test(lower)) score -= 80;
  score += Math.min(30, Math.log10(Math.max(1, Number(file?.size) || 1)) * 5);
  return score;
}

function selectEarningsReleaseFile(items, filing) {
  return (items || [])
    .map((file) => ({ file, score: earningsReleaseFileScore(file, filing) }))
    .filter((entry) => entry.score >= 80)
    .sort((a, b) => b.score - a.score || (Number(b.file?.size) || 0) - (Number(a.file?.size) || 0))[0]?.file || null;
}

function guidanceSignal(text) {
  const definitions = [
    { status: "WITHDRAWN", label: "guidance wycofany", pattern: /\b(?:withdraws?|withdrew|withdrawn|suspends?|suspended|no longer provides?)\b(?:\s+\S+){0,6}\s+\b(?:guidance|outlook|forecast)\b|\b(?:guidance|outlook|forecast)\b(?:\s+(?:range|expectations?))?\s+(?:has been|was|is)?\s*(?:withdrawn|suspended)/i },
    { status: "LOWERED", label: "guidance obnizony", pattern: /\b(?:lowers?|lowered|reduces?|reduced|cuts?|revised downward)\b(?:\s+\S+){0,6}\s+\b(?:guidance|outlook|forecast)\b|\b(?:guidance|outlook|forecast)\b(?:\s+(?:range|expectations?))?\s+(?:has been|was|is|were)?\s*(?:lowered|reduced|cut)/i },
    { status: "RAISED", label: "guidance podniesiony", pattern: /\b(?:raises?|raised|increases?|increased|revised upward)\b(?:\s+\S+){0,6}\s+\b(?:guidance|outlook|forecast)\b|\b(?:guidance|outlook|forecast)\b(?:\s+(?:range|expectations?))?\s+(?:has been|was|is|were)?\s*(?:raised|increased)/i },
    { status: "REAFFIRMED", label: "guidance podtrzymany", pattern: /\b(?:reaffirms?|reaffirmed|maintains?|maintained|reiterates?|reiterated)\b(?:\s+\S+){0,6}\s+\b(?:guidance|outlook|forecast)\b|\b(?:guidance|outlook|forecast)\b(?:\s+(?:range|expectations?))?\s+(?:has been|was|is|were)?\s*(?:reaffirmed|maintained|reiterated)/i },
    { status: "PROVIDED", label: "guidance opublikowany", pattern: /(?:guidance|outlook|forecast)[^.]{0,160}(?:expect|range|approximately|between)/i }
  ];
  for (const definition of definitions) {
    const match = definition.pattern.exec(text);
    if (!match) continue;
    const context = normalizeEvidenceContext(sentenceAround(text, match.index, 300), 420);
    const values = [...context.matchAll(/(?:\$|USD\s*)?\d+(?:\.\d+)?(?:\s*(?:%|million|billion|mn|bn))?/gi)]
      .map((item) => item[0].trim())
      .filter((value) => /\$|USD|%|million|billion|mn|bn/i.test(value))
      .slice(0, 6);
    return { status: definition.status, label: definition.label, context, values };
  }
  return { status: "NOT_FOUND", label: "brak jednoznacznego guidance", context: "", values: [] };
}

function earningsReleaseEvidence(text, fileName = "") {
  const heading = text.slice(0, 5000);
  const headingPattern = /(?:reports?|announces?|delivers?|posts?)[^.!?]{0,140}(?:quarter|fiscal|financial|earnings)[^.!?]{0,100}results|(?:quarter|fiscal)[^.!?]{0,100}financial results|earnings release/i;
  const patterns = [
    /financial results/i,
    /(?:quarter|year) ended/i,
    /(?:net|total) revenue/i,
    /(?:diluted|adjusted) (?:earnings|income|loss) per share/i,
    /business outlook/i,
    /gross margin/i,
    /cash flow from operations|free cash flow/i
  ];
  const matched = patterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  const headingMatched = headingPattern.test(heading);
  const fileNameMatched = /earnings|results/i.test(fileName);
  return { matched, count: matched.length, headingMatched, fileNameMatched, isEarningsRelease: (headingMatched || fileNameMatched) && matched.length >= 2 };
}

function submissionAttachmentNames(text) {
  return [...String(text || "").matchAll(/<FILENAME>\s*([^\r\n<]+)/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .map((name) => ({ name, size: 0 }));
}

function releaseFacts(text) {
  return extractDecisionEvidence(text)
    .filter((group) => ["revenue", "margin", "cashFlow", "balance", "guidance"].includes(group.key))
    .flatMap((group) => (group.hits || []).slice(0, 1).map((hit) => ({
      key: group.key,
      label: group.label,
      keyword: hit.keyword,
      context: normalizeEvidenceContext(hit.context, 320)
    })))
    .slice(0, 5);
}

async function fetchSecEarningsRelease(row, filing, cache) {
  if (!row?.sec?.cik || !filing?.accessionNumber) return { status: "NO_FILING", error: "Brak CIK lub accession number" };
  const cacheKey = filing.accessionNumber;
  const cached = cache[cacheKey];
  if (cached?.analyzerVersion === 4) return { ...cached, cacheHit: true };
  if (cached?.analyzerVersion === 3 && cached.status === "ANALYZED") {
    const guidanceText = [...(cached.facts || []).map((fact) => fact.context), cached.guidance?.context || ""].join(" ");
    const migrated = { ...cached, analyzerVersion: 4, guidance: guidanceSignal(guidanceText) };
    cache[cacheKey] = migrated;
    return { ...migrated, cacheHit: true };
  }
  if (cached?.analyzerVersion === 3 && cached.status === "NON_EARNINGS_EXHIBIT" && !/earnings|results/i.test(cached.document?.name || "")) {
    const migrated = { ...cached, analyzerVersion: 4 };
    cache[cacheKey] = migrated;
    return { ...migrated, cacheHit: true };
  }
  const base = secArchiveBase(row.sec.cik, filing.accessionNumber);
  if (!base) return { status: "NO_FILING", error: "Nie mozna zbudowac adresu archiwum SEC" };

  try {
    if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
    secEarningsReleaseRequests += 1;
    const indexResponse = await fetch(`${base}/index.json`, { headers: secRequestHeaders() });
    if (!indexResponse.ok) throw new Error(`SEC index HTTP ${indexResponse.status}`);
    const index = await indexResponse.json();
    let file = selectEarningsReleaseFile(index?.directory?.item, filing);
    if (!file) {
      if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
      secEarningsReleaseRequests += 1;
      const submissionResponse = await fetch(`${base}/${encodeURIComponent(filing.accessionNumber)}.txt`, { headers: secRequestHeaders("text/plain") });
      if (submissionResponse.ok) file = selectEarningsReleaseFile(submissionAttachmentNames(await submissionResponse.text()), filing);
    }
    if (!file) {
      const missing = {
        status: "NO_RELEASE",
        analyzerVersion: 4,
        checkedAt: new Date().toISOString(),
        filing: { form: filing.form, filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, url: filing.url }
      };
      cache[cacheKey] = missing;
      return missing;
    }

    const fileUrl = `${base}/${String(file.name).split("/").map(encodeURIComponent).join("/")}`;
    if (runtime.sec_request_delay_ms) await sleep(runtime.sec_request_delay_ms);
    secEarningsReleaseRequests += 1;
    const documentResponse = await fetch(fileUrl, { headers: secRequestHeaders("text/html,application/xhtml+xml,text/plain") });
    if (!documentResponse.ok) throw new Error(`SEC exhibit HTTP ${documentResponse.status}`);
    const text = htmlToText(await documentResponse.text());
    const releaseEvidence = earningsReleaseEvidence(text, file.name);
    if (!releaseEvidence.isEarningsRelease) {
      const rejected = {
        status: "NON_EARNINGS_EXHIBIT",
        analyzerVersion: 4,
        checkedAt: new Date().toISOString(),
        filing: { form: filing.form, filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, url: filing.url },
        document: { name: file.name, url: fileUrl, chars: text.length },
        releaseEvidence
      };
      cache[cacheKey] = rejected;
      return rejected;
    }
    const filingVerdict = analyzeFilingVerdict(text, filing);
    const release = {
      status: "ANALYZED",
      analyzerVersion: 4,
      analyzedAt: new Date().toISOString(),
      filing: { form: filing.form, filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, url: filing.url },
      document: { name: file.name, url: fileUrl, chars: text.length },
      releaseEvidence,
      guidance: guidanceSignal(text),
      facts: releaseFacts(text),
      filingVerdict,
      filingBrief: buildFilingBrief(text, filing, filingVerdict)
    };
    cache[cacheKey] = release;
    return release;
  } catch (error) {
    return {
      status: "ERROR",
      checkedAt: new Date().toISOString(),
      filing: { form: filing.form, filingDate: filing.filingDate, accessionNumber: filing.accessionNumber, url: filing.url },
      error: error.message
    };
  }
}

function recentEarningsResult(row, maxDays = 7) {
  const result = row.catalystAssessment?.latestEarnings;
  if (!result?.date) return null;
  const ageDays = Math.floor((new Date(`${isoDateOffset(0)}T23:59:59Z`).getTime() - new Date(`${result.date}T00:00:00Z`).getTime()) / 86400000);
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > maxDays) return null;
  if (!Number.isFinite(result.epsActual) && !Number.isFinite(result.revenueActual)) return null;
  return { ...result, ageDays };
}

function findEarningsFiling(row, result) {
  const filings = (row.sec?.filings || []).filter((filing) => ["8-K", "6-K"].includes(filing.form));
  if (!filings.length) return null;
  if (!result?.date) return filings[0];
  const resultTime = new Date(`${result.date}T00:00:00Z`).getTime();
  return filings
    .map((filing) => ({ filing, distance: (new Date(`${filing.filingDate}T00:00:00Z`).getTime() - resultTime) / 86400000 }))
    .filter((entry) => entry.distance >= -1 && entry.distance <= 10)
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0]?.filing || null;
}

function postEarningsPriceReaction(row, eventDate) {
  const points = (row.metrics?.sparkline || []).filter((point) => point.date && Number.isFinite(point.close));
  const before = points.filter((point) => point.date < eventDate).at(-1);
  const after = points.filter((point) => point.date >= eventDate).at(-1);
  if (!before || !after || before.close <= 0) return null;
  return {
    fromDate: before.date,
    toDate: after.date,
    fromPrice: before.close,
    toPrice: after.close,
    changePct: pctChange(after.close, before.close)
  };
}

function buildPostEarningsAssessment(row, result, release, queued = false) {
  if (!result) return null;
  const priceReaction = postEarningsPriceReaction(row, result.date);
  const positives = [];
  const risks = [];
  let score = 50;
  if (Number.isFinite(result.epsSurprisePct)) {
    if (result.epsSurprisePct >= 5) { score += 10; positives.push(`EPS powyzej konsensusu o ${formatPct(result.epsSurprisePct)}`); }
    if (result.epsSurprisePct <= -5) { score -= 12; risks.push(`EPS ponizej konsensusu o ${formatPct(Math.abs(result.epsSurprisePct))}`); }
  }
  if (Number.isFinite(result.revenueSurprisePct)) {
    if (result.revenueSurprisePct >= 3) { score += 10; positives.push(`przychody powyzej konsensusu o ${formatPct(result.revenueSurprisePct)}`); }
    if (result.revenueSurprisePct <= -3) { score -= 12; risks.push(`przychody ponizej konsensusu o ${formatPct(Math.abs(result.revenueSurprisePct))}`); }
  }
  const guidance = release?.guidance || { status: queued ? "QUEUED" : "NOT_FOUND", label: queued ? "oczekuje na analize" : "brak jednoznacznego guidance" };
  if (guidance.status === "RAISED") { score += 18; positives.push("spolka podniosla guidance"); }
  if (guidance.status === "REAFFIRMED") { score += 5; positives.push("spolka podtrzymala guidance"); }
  if (guidance.status === "LOWERED") { score -= 22; risks.push("spolka obnizyla guidance"); }
  if (guidance.status === "WITHDRAWN") { score -= 25; risks.push("spolka wycofala guidance"); }
  if (Number.isFinite(priceReaction?.changePct)) {
    if (priceReaction.changePct >= 4) { score += 5; positives.push(`kurs po wynikach ${formatPct(priceReaction.changePct)}`); }
    if (priceReaction.changePct <= -6) { score -= 6; risks.push(`kurs po wynikach ${formatPct(priceReaction.changePct)}`); }
  }
  if (release?.filingVerdict?.score) score += clamp(release.filingVerdict.score, -10, 10);
  const redFlags = [
    ...(release?.filingVerdict?.criticalRisks || []).map((item) => item.keyword),
    ...(release?.filingBrief?.eventTypes || []).filter((event) => event.severity === "high").map((event) => event.label)
  ];
  if (redFlags.length) {
    score -= 25;
    risks.unshift(`czerwona flaga SEC: ${redFlags[0]}`);
  }
  score = Math.round(clamp(score, 0, 100));
  const sourceComplete = release?.status === "ANALYZED" && release?.document?.url;
  const bothMiss = Number.isFinite(result.epsSurprisePct) && result.epsSurprisePct <= -5
    && Number.isFinite(result.revenueSurprisePct) && result.revenueSurprisePct <= -3;
  let modelAction = "CZEKAJ";
  if (redFlags.length || bothMiss || ["LOWERED", "WITHDRAWN"].includes(guidance.status) || (sourceComplete && score < 35)) modelAction = "ODRZUC";
  else if (sourceComplete && score >= 70 && positives.length >= 2 && !risks.length) modelAction = "INWESTUJ";
  const confidenceScore = sourceComplete
    ? clamp(48 + positives.length * 8 + risks.length * 8 + (guidance.status !== "NOT_FOUND" ? 10 : 0), 45, 92)
    : 35;
  return {
    status: queued ? "QUEUED" : sourceComplete ? "ANALYZED" : release?.status || "PENDING_RELEASE",
    modelAction,
    label: `MODEL: ${modelAction}`,
    score,
    confidence: confidenceScore >= 75 ? "high" : confidenceScore >= 55 ? "medium" : "low",
    confidenceScore: Math.round(confidenceScore),
    result,
    guidance,
    priceReaction,
    positives: positives.slice(0, 5),
    risks: risks.slice(0, 5),
    redFlags: [...new Set(redFlags)].slice(0, 5),
    facts: release?.facts || [],
    release: release ? {
      status: release.status,
      filing: release.filing || null,
      document: release.document || null,
      error: release.error || null
    } : null
  };
}

async function fetchFmpFundamentals(symbol, options = {}) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { enabled: false, data: null, error: null };

  const fmpSymbol = symbol;
  const cache = loadJsonFile(fmpProfileCachePath, {});
  const cached = cache[fmpSymbol];
  const previous = options.previousFundamentals || cached?.data || null;
  const maxAgeMs = (config.data_providers?.fmp_profile_cache_days || 7) * 24 * 60 * 60 * 1000;
  const allowDeep = options.deep !== false && config.data_providers?.fmp_deep_fundamentals !== false;
  const needsDeepRefresh = allowDeep
    && (!previous?.fundamentalsCoverage?.loaded?.some((label) => label !== "profile")
      || (!Number.isFinite(previous?.freeCashFlowTTM)
        && !Number.isFinite(previous?.operatingCashFlowTTM)
        && !previous?.cashFlowFallback
        && previous?.cik));
  if (fmpRateLimited) {
    if (previous) return { enabled: true, data: previous, error: "FMP rate limited; using cached data", cached: true };
    return { enabled: true, data: null, error: "FMP rate limited" };
  }
  if (!allowDeep && previous) {
    return { enabled: true, data: previous, error: null, cached: true };
  }
  if (cached && !needsDeepRefresh && Date.now() - new Date(cached.fetchedAt).getTime() < maxAgeMs) {
    return { enabled: true, data: cached.data, error: null, cached: true };
  }

  try {
    const profileResult = previous?.symbol
      ? { label: "profile", data: previous, error: null }
      : await fetchFmpOptional("/stable/profile", { symbol: fmpSymbol }, "profile");
    const profile = nonNullObject(profileResult.data);
    if (!profile?.symbol && fmpRateLimited && previous) {
      return { enabled: true, data: previous, error: "FMP rate limited; using cached data", cached: true };
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

    const currentData = {
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
      cashFlowFallback: null,
      source: endpointResults.some((result) => result.label !== "profile" && result.data)
        ? "FMP fundamentals"
        : previous?.source || "FMP profile"
    };
    const data = { ...(previous || {}) };
    for (const [keyName, value] of Object.entries(currentData)) {
      if (value !== null && value !== undefined) data[keyName] = value;
    }
    const successfulLabels = endpointResults.filter((result) => result.data).map((result) => result.label);
    const loadedLabels = new Set([...(previous?.fundamentalsCoverage?.loaded || []), ...successfulLabels]);
    const failedEndpoints = { ...(previous?.fundamentalsCoverage?.failed || {}), ...endpointErrors };
    for (const label of successfulLabels) delete failedEndpoints[label];
    data.fundamentalsCoverage = {
      loaded: [...loadedLabels],
      failed: failedEndpoints
    };
    if (allowDeep && !Number.isFinite(data.freeCashFlowTTM) && !Number.isFinite(data.operatingCashFlowTTM) && data.cik) {
      const fallback = await fetchSecCashFlowFallback(data.cik);
      if (fallback.data) {
        data.cashFlowFallback = fallback.data;
        data.fundamentalsCoverage.loaded.push("secCompanyFactsCashFlow");
      } else if (fallback.error) {
        data.fundamentalsCoverage.failed.secCompanyFactsCashFlow = fallback.error;
      }
    }
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
  if (options.deep === false && options.previousFundamentals) {
    return {
      enabled: true,
      provider: "previous-fmp-cache",
      data: options.previousFundamentals,
      error: null
    };
  }
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

function fmpSymbolFor(item) {
  return String(item.fmp_symbol || item.yahoo || item.ticker || "").toUpperCase();
}

function isoDateOffset(days, date = new Date()) {
  return new Date(date.getTime() + days * 86400000).toISOString().slice(0, 10);
}

function buildFmpCatalystPlan(watchlist, previousSnapshot) {
  const limit = Math.max(0, Number(config.data_providers?.fmp_catalyst_detail_limit ?? 20));
  if (!limit || config.data_providers?.fmp_catalysts === false || !process.env.FMP_API_KEY) {
    return { limit, prioritySlots: 0, rotationSlots: 0, selectedSymbols: [], prioritySymbols: [], rotationSymbols: [] };
  }
  const prioritySlots = Math.min(limit, Math.max(0, Number(config.data_providers?.fmp_catalyst_priority_slots ?? Math.ceil(limit / 2))));
  const rotationSlots = Math.min(limit - prioritySlots, Math.max(0, Number(config.data_providers?.fmp_catalyst_rotation_slots ?? (limit - prioritySlots))));
  const known = new Set(watchlist.map((item) => item.ticker));
  const priorityCandidates = [
    ...(previousSnapshot?.researchPriorityQueue || []),
    ...(previousSnapshot?.decisionPackages?.items || []),
    ...(previousSnapshot?.todayDecisionQueue?.items || []),
    ...(previousSnapshot?.rows || []).filter((row) => row.decisionEngine?.priority === "P1"),
    ...watchlist.filter((item) => item.status === "CORE")
  ];
  const prioritySymbols = [];
  for (const item of priorityCandidates) {
    const ticker = String(item?.ticker || "").toUpperCase();
    if (!known.has(ticker) || prioritySymbols.includes(ticker)) continue;
    prioritySymbols.push(ticker);
    if (prioritySymbols.length >= prioritySlots) break;
  }

  const rotationPool = watchlist.filter((item) => !prioritySymbols.includes(item.ticker));
  const rotationStart = rotationPool.length ? (utcDayOfYear() * Math.max(1, rotationSlots)) % rotationPool.length : 0;
  const rotationSymbols = circularSlice(rotationPool, rotationStart, rotationSlots).map((item) => item.ticker);
  const selected = new Set([...prioritySymbols, ...rotationSymbols]);
  for (const item of watchlist) {
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

function compactCatalystNews(row) {
  return {
    symbol: String(row.symbol || "").toUpperCase(),
    publishedDate: row.publishedDate || row.published_date || row.date || null,
    title: String(row.title || "").trim(),
    site: row.site || row.publisher || null,
    url: row.url || null,
    text: String(row.text || row.content || "").replace(/\s+/g, " ").slice(0, 420)
  };
}

async function fetchFmpCatalystSources(watchlist, plan) {
  const requestStart = fmpRequestCount;
  const symbolToTicker = new Map();
  for (const item of watchlist) {
    symbolToTicker.set(fmpSymbolFor(item), item.ticker);
    symbolToTicker.set(String(item.ticker).toUpperCase(), item.ticker);
  }
  const result = {
    enabled: config.data_providers?.fmp_catalysts !== false && !!process.env.FMP_API_KEY,
    calendarFetched: false,
    newsFetched: false,
    calendarByTicker: new Map(),
    newsByTicker: new Map(),
    detailsByTicker: new Map(),
    errors: [],
    requestsUsed: 0
  };
  if (!result.enabled) return result;

  const calendarDays = Math.max(7, Number(config.data_providers?.fmp_catalyst_calendar_days ?? 45));
  const today = isoDateOffset(0);
  const calendar = await fetchFmpRowsOptional("/stable/earnings-calendar", {
    from: isoDateOffset(-7),
    to: isoDateOffset(calendarDays)
  }, "earningsCalendar");
  result.calendarFetched = !calendar.error;
  if (calendar.error) result.errors.push({ source: calendar.label, error: calendar.error });
  for (const event of calendar.data) {
    const ticker = symbolToTicker.get(String(event.symbol || "").toUpperCase());
    if (!ticker) continue;
      const normalized = {
      ticker,
      symbol: String(event.symbol || "").toUpperCase(),
      date: event.date || null,
      time: event.time || null,
        epsEstimated: firstNumber(event.epsEstimated),
        epsActual: firstNumber(event.epsActual),
        revenueEstimated: firstNumber(event.revenueEstimated),
        revenueActual: firstNumber(event.revenueActual),
        fiscalDateEnding: event.fiscalDateEnding || null,
        lastUpdated: event.lastUpdated || null,
        updatedFromDate: today
    };
    if (!result.calendarByTicker.has(ticker)) result.calendarByTicker.set(ticker, []);
    result.calendarByTicker.get(ticker).push(normalized);
  }
  for (const events of result.calendarByTicker.values()) events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const batchSize = clamp(Number(config.data_providers?.fmp_catalyst_news_batch_size ?? 45), 10, 60);
  const newsDays = Math.max(1, Number(config.data_providers?.fmp_catalyst_news_days ?? 7));
  let newsFailures = 0;
  for (let index = 0; index < watchlist.length; index += batchSize) {
    const batch = watchlist.slice(index, index + batchSize);
    const news = await fetchFmpRowsOptional("/stable/news/stock", {
      symbols: batch.map(fmpSymbolFor).join(","),
      from: isoDateOffset(-newsDays),
      to: today,
      page: 0,
      limit: Math.max(100, batch.length * 4)
    }, "stockNews");
    if (news.error) {
      newsFailures += 1;
      result.errors.push({ source: news.label, batch: index / batchSize + 1, error: news.error });
      continue;
    }
    for (const item of news.data) {
      const ticker = symbolToTicker.get(String(item.symbol || "").toUpperCase());
      if (!ticker) continue;
      if (!result.newsByTicker.has(ticker)) result.newsByTicker.set(ticker, []);
      result.newsByTicker.get(ticker).push(compactCatalystNews(item));
    }
  }
  result.newsFetched = newsFailures === 0;
  for (const news of result.newsByTicker.values()) {
    news.sort((a, b) => new Date(b.publishedDate || 0).getTime() - new Date(a.publishedDate || 0).getTime());
  }

  const itemByTicker = new Map(watchlist.map((item) => [item.ticker, item]));
  for (const ticker of plan.selectedSymbols) {
    const item = itemByTicker.get(ticker);
    if (!item) continue;
    const symbol = fmpSymbolFor(item);
    const endpoints = [
      await fetchFmpRowsOptional("/stable/earnings", { symbol, limit: 8 }, "earnings"),
      await fetchFmpRowsOptional("/stable/analyst-estimates", { symbol, period: "annual", page: 0, limit: 5 }, "analystEstimates"),
      await fetchFmpRowsOptional("/stable/price-target-consensus", { symbol }, "priceTargetConsensus"),
      await fetchFmpRowsOptional("/stable/grades-consensus", { symbol }, "gradesConsensus")
    ];
    const [earnings, estimates, targets, grades] = endpoints;
    for (const endpoint of endpoints.filter((entry) => entry.error)) {
      result.errors.push({ ticker, source: endpoint.label, error: endpoint.error });
    }
    result.detailsByTicker.set(ticker, {
      updatedAt: new Date().toISOString(),
      earnings: earnings.data,
      analystEstimates: estimates.data,
      priceTargetConsensus: targets.data[0] || null,
      gradesConsensus: grades.data[0] || null,
      loaded: endpoints.filter((entry) => entry.data.length).map((entry) => entry.label),
      errors: Object.fromEntries(endpoints.filter((entry) => entry.error).map((entry) => [entry.label, entry.error]))
    });
  }
  result.requestsUsed = fmpRequestCount - requestStart;
  return result;
}

function buildRowCatalysts(item, sources, previousRow) {
  const previous = previousRow?.catalysts || {};
  const freshDetails = sources.detailsByTicker.get(item.ticker);
  const previousDetails = previous.details || {};
  const details = freshDetails ? {
    ...previousDetails,
    ...freshDetails,
    earnings: freshDetails.earnings.length ? freshDetails.earnings : (previousDetails.earnings || []),
    analystEstimates: freshDetails.analystEstimates.length ? freshDetails.analystEstimates : (previousDetails.analystEstimates || []),
    priceTargetConsensus: freshDetails.priceTargetConsensus || previousDetails.priceTargetConsensus || null,
    gradesConsensus: freshDetails.gradesConsensus || previousDetails.gradesConsensus || null
  } : previousDetails;
  return {
    source: "FMP Starter",
    symbol: fmpSymbolFor(item),
    calendar: sources.calendarFetched ? (sources.calendarByTicker.get(item.ticker) || []) : (previous.calendar || []),
    news: sources.newsFetched ? (sources.newsByTicker.get(item.ticker) || []).slice(0, 8) : (previous.news || []),
    details,
    refreshedToday: !!freshDetails
  };
}

function numericSurprise(actual, estimated) {
  if (!Number.isFinite(actual) || !Number.isFinite(estimated) || Math.abs(estimated) < 1e-9) return null;
  return ((actual - estimated) / Math.abs(estimated)) * 100;
}

function buildCatalystAssessment(row, previousRow) {
  const catalysts = row.catalysts || {};
  const details = catalysts.details || {};
  const today = isoDateOffset(0);
  const calendar = (catalysts.calendar || []).filter((event) => event.date);
  const nextEvent = calendar.find((event) => event.date >= today
    && !Number.isFinite(firstNumber(event.epsActual))
    && !Number.isFinite(firstNumber(event.revenueActual))) || null;
  const daysToEvent = nextEvent ? Math.ceil((new Date(`${nextEvent.date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000) : null;
  const earningsByDate = new Map();
  for (const item of [...(details.earnings || []), ...calendar]) {
    if (item.date) earningsByDate.set(item.date, item);
  }
  const earnings = [...earningsByDate.values()]
    .filter((item) => item.date && (Number.isFinite(toNumber(item.epsActual)) || Number.isFinite(toNumber(item.revenueActual))))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const latest = earnings[0] || null;
  const latestEarnings = latest ? {
    date: latest.date,
    epsActual: firstNumber(latest.epsActual),
    epsEstimated: firstNumber(latest.epsEstimated),
    epsSurprisePct: numericSurprise(firstNumber(latest.epsActual), firstNumber(latest.epsEstimated)),
    revenueActual: firstNumber(latest.revenueActual),
    revenueEstimated: firstNumber(latest.revenueEstimated),
    revenueSurprisePct: numericSurprise(firstNumber(latest.revenueActual), firstNumber(latest.revenueEstimated))
  } : null;

  const estimates = (details.analystEstimates || []).filter((item) => item.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const currentEstimate = estimates.find((item) => item.date >= today) || estimates.at(-1) || null;
  const previousEstimates = previousRow?.catalysts?.details?.analystEstimates || [];
  const previousEstimate = currentEstimate ? previousEstimates.find((item) => item.date === currentEstimate.date) : null;
  const estimateRevision = currentEstimate && previousEstimate && catalysts.refreshedToday ? {
    period: currentEstimate.date,
    epsPct: numericSurprise(firstNumber(currentEstimate.epsAvg), firstNumber(previousEstimate.epsAvg)),
    revenuePct: numericSurprise(firstNumber(currentEstimate.revenueAvg), firstNumber(previousEstimate.revenueAvg))
  } : null;

  const target = details.priceTargetConsensus || {};
  const targetConsensus = firstNumber(target.targetConsensus, target.targetMedian);
  const targetUpsidePct = numericSurprise(targetConsensus, row.metrics?.price);
  const grades = details.gradesConsensus || {};
  const gradeCounts = {
    strongBuy: firstNumber(grades.strongBuy) || 0,
    buy: firstNumber(grades.buy) || 0,
    hold: firstNumber(grades.hold) || 0,
    sell: firstNumber(grades.sell) || 0,
    strongSell: firstNumber(grades.strongSell) || 0
  };
  const gradeTotal = Object.values(gradeCounts).reduce((sum, value) => sum + value, 0);
  const buyRatio = gradeTotal ? (gradeCounts.strongBuy + gradeCounts.buy) / gradeTotal : null;
  const sellRatio = gradeTotal ? (gradeCounts.sell + gradeCounts.strongSell) / gradeTotal : null;

  const positiveNewsPattern = /raise[sd]? guidance|beats? (?:estimates|expectations)|contract award|wins? contract|approval|authoriz|buyback|share repurchase|strategic partnership/i;
  const negativeNewsPattern = /lower(?:s|ed)? guidance|cuts? outlook|miss(?:es|ed)? (?:estimates|expectations)|offering|dilution|investigation|default|bankrupt|delisting|recall|cyber(?:security)? (?:incident|breach|attack)|cyberattack|data breach/i;
  const news = (catalysts.news || []).map((item) => ({
    ...item,
    tone: positiveNewsPattern.test(`${item.title} ${item.text}`) ? "positive" : negativeNewsPattern.test(`${item.title} ${item.text}`) ? "negative" : "neutral"
  }));
  const positiveNews = news.filter((item) => item.tone === "positive");
  const negativeNews = news.filter((item) => item.tone === "negative");

  let score = 0;
  const positives = [];
  const risks = [];
  const earningsSurprises = [latestEarnings?.epsSurprisePct, latestEarnings?.revenueSurprisePct].filter(Number.isFinite);
  const averageSurprise = avg(earningsSurprises);
  if (Number.isFinite(averageSurprise) && averageSurprise >= 5) { score += 4; positives.push(`ostatnie wyniki pobily konsensus srednio o ${formatPct(averageSurprise)}`); }
  if (Number.isFinite(averageSurprise) && averageSurprise <= -5) { score -= 5; risks.push(`ostatnie wyniki byly ponizej konsensusu srednio o ${formatPct(Math.abs(averageSurprise))}`); }
  const revisions = [estimateRevision?.epsPct, estimateRevision?.revenuePct].filter(Number.isFinite);
  const averageRevision = avg(revisions);
  if (Number.isFinite(averageRevision) && averageRevision >= 2) { score += 4; positives.push(`prognozy analitykow wzrosly o ${formatPct(averageRevision)}`); }
  if (Number.isFinite(averageRevision) && averageRevision <= -2) { score -= 5; risks.push(`prognozy analitykow spadly o ${formatPct(Math.abs(averageRevision))}`); }
  if (Number.isFinite(targetUpsidePct) && targetUpsidePct >= 20) { score += 2; positives.push(`konsensus cen docelowych ${formatPct(targetUpsidePct)} powyzej kursu`); }
  if (Number.isFinite(targetUpsidePct) && targetUpsidePct <= -5) { score -= 3; risks.push(`konsensus cen docelowych ${formatPct(Math.abs(targetUpsidePct))} ponizej kursu`); }
  if (Number.isFinite(buyRatio) && buyRatio >= 0.65) { score += 2; positives.push(`${formatPct(buyRatio * 100)} ocen to kupuj`); }
  if (Number.isFinite(sellRatio) && sellRatio >= 0.35) { score -= 3; risks.push(`${formatPct(sellRatio * 100)} ocen to sprzedaj`); }
  if (positiveNews.length) { score += Math.min(3, positiveNews.length); positives.push(`pozytywne newsy: ${positiveNews[0].title}`); }
  if (negativeNews.length) { score -= Math.min(5, negativeNews.length * 2); risks.push(`negatywny news: ${negativeNews[0].title}`); }
  if (Number.isFinite(daysToEvent) && daysToEvent <= 3) risks.unshift(`wyniki za ${daysToEvent} dni - wysoka niepewnosc zdarzenia`);
  else if (Number.isFinite(daysToEvent) && daysToEvent <= 7) risks.unshift(`wyniki za ${daysToEvent} dni`);

  const urgency = Number.isFinite(daysToEvent) && daysToEvent <= 3 ? "high"
    : (Number.isFinite(daysToEvent) && daysToEvent <= 7) || negativeNews.length || Math.abs(score) >= 6 ? "medium"
      : "low";
  return {
    score: Math.round(clamp(score, -15, 15)),
    urgency,
    daysToEvent,
    nextEvent: nextEvent ? { type: "earnings", date: nextEvent.date, title: "Publikacja wynikow", time: nextEvent.time || null } : null,
    positives: positives.slice(0, 4),
    risks: risks.slice(0, 4),
    latestEarnings,
    estimateRevision,
    priceTarget: targetConsensus ? { consensus: targetConsensus, median: firstNumber(target.targetMedian), high: firstNumber(target.targetHigh), low: firstNumber(target.targetLow), upsidePct: targetUpsidePct } : null,
    grades: gradeTotal ? { ...gradeCounts, total: gradeTotal, buyRatio, sellRatio, consensus: grades.consensus || null } : null,
    news: news.slice(0, 5)
  };
}

function catalystSignalAlerts(assessment) {
  if (!assessment) return [];
  const alerts = [];
  if (assessment.nextEvent && Number.isFinite(assessment.daysToEvent) && assessment.daysToEvent <= 7) {
    alerts.push(`Earnings in ${assessment.daysToEvent} days`);
  }
  if (assessment.score >= 6) alerts.push(`Positive catalyst score ${assessment.score}`);
  if (assessment.score <= -6) alerts.push(`Negative catalyst score ${assessment.score}`);
  return alerts;
}

function buildCatalystCoverage(rows, sources, plan) {
  const withDetails = rows.filter((row) => row.catalysts?.details?.earnings?.length || row.catalysts?.details?.analystEstimates?.length).length;
  return {
    enabled: sources.enabled,
    requestsUsed: sources.requestsUsed,
    detailPlan: plan,
    detailCoverage: withDetails,
    calendarCoverage: rows.filter((row) => row.catalysts?.calendar?.length).length,
    newsCoverage: rows.filter((row) => row.catalysts?.news?.length).length,
    urgentEvents: rows.filter((row) => row.catalystAssessment?.urgency === "high").length,
    errors: sources.errors.slice(0, 40)
  };
}

function mergeUpcomingEvents(rows, days = 30) {
  const manual = upcomingEvents(days);
  const today = isoDateOffset(0);
  const max = isoDateOffset(days);
  const automatic = rows.flatMap((row) => (row.catalysts?.calendar || [])
    .filter((event) => event.date >= today && event.date <= max)
    .map((event) => ({
      ticker: row.ticker,
      date: event.date,
      type: "EARNINGS",
      title: "Publikacja wynikow",
      source: "FMP earnings calendar",
      notes: event.time ? `Pora: ${event.time}` : ""
    })));
  const deduplicated = new Map();
  for (const event of [...manual, ...automatic]) {
    const key = `${event.ticker}|${event.date}|${String(event.type).toUpperCase()}`;
    if (!deduplicated.has(key)) deduplicated.set(key, event);
  }
  return [...deduplicated.values()].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
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
    requestCount: fmpRequestCount,
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
  if (Number.isFinite(fundamentals.operatingMarginTTM) && percentLike(fundamentals.operatingMarginTTM) <= rules.operating_margin_pressure) {
    alerts.push(`Operating margin below ${rules.operating_margin_pressure}%`);
  }
  if (Number.isFinite(fundamentals.revenueGrowthYoY) && percentLike(fundamentals.revenueGrowthYoY) <= rules.revenue_growth_weak) {
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
  const catalystPoints = clamp(row.catalystAssessment?.score || 0, -8, 8);
  if (catalystPoints) {
    const catalystReason = catalystPoints > 0
      ? row.catalystAssessment?.positives?.[0] || `katalizatory ${catalystPoints}`
      : row.catalystAssessment?.risks?.[0] || `katalizatory ${catalystPoints}`;
    add("catalysts", catalystPoints, catalystReason);
  }
  if (Number.isFinite(row.postEarnings?.score)) {
    const postEarningsPoints = Math.round(clamp((row.postEarnings.score - 50) / 4, -8, 8));
    if (postEarningsPoints) {
      add(
        "postEarnings",
        postEarningsPoints,
        postEarningsPoints > 0
          ? row.postEarnings.positives?.[0] || `ocena wynikow ${row.postEarnings.score}/100`
          : row.postEarnings.risks?.[0] || `ocena wynikow ${row.postEarnings.score}/100`
      );
    }
  }

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
  if (Number.isFinite(fundamentals.revenueGrowthYoY) && percentLike(fundamentals.revenueGrowthYoY) >= 8) {
    add("growth", 6, `wzrost przychodow ${formatPercentLike(fundamentals.revenueGrowthYoY)}`);
  }
  if (Number.isFinite(fundamentals.fcfGrowthYoY) && percentLike(fundamentals.fcfGrowthYoY) >= 10) {
    add("fcfGrowth", 4, `wzrost FCF ${formatPercentLike(fundamentals.fcfGrowthYoY)}`);
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
  else if (row.catalystAssessment?.urgency === "high") score.nextStep = "CATALYST_REVIEW";
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
    decisionBrief: row.decisionBrief ? {
      briefVerdict: row.decisionBrief.briefVerdict,
      briefLabel: row.decisionBrief.briefLabel,
      confidence: row.decisionBrief.confidence,
      confidenceScore: row.decisionBrief.confidenceScore
    } : null,
    concreteVerdict: row.concreteVerdict ? {
      action: row.concreteVerdict.action,
      confidence: row.concreteVerdict.confidence,
      confidenceScore: row.concreteVerdict.confidenceScore
    } : null,
    catalyst: row.catalystAssessment ? {
      score: row.catalystAssessment.score,
      urgency: row.catalystAssessment.urgency,
      daysToEvent: row.catalystAssessment.daysToEvent,
      nextEvent: row.catalystAssessment.nextEvent
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
  const histories = [];
  if (fs.existsSync(historyPath)) {
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      if (Array.isArray(history)) histories.push(...history);
    } catch (error) {
      console.log(`Local history unavailable: ${error.message}`);
    }
  }

  const historyUrl = config.data_providers?.previous_history_url
    || process.env.PREVIOUS_MONITORING_HISTORY_URL;
  if (historyUrl) {
    try {
      const response = await fetch(historyUrl, { headers: { "user-agent": "local-monitoring-dashboard/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const publishedHistory = await response.json();
      if (Array.isArray(publishedHistory)) histories.push(...publishedHistory);
    } catch (error) {
      console.log(`Previous published history unavailable: ${error.message}`);
    }
  }

  const snapshot = await fetchPreviousPublishedSnapshot();
  if (snapshot?.rows?.length) {
    histories.push({
      generatedAt: snapshot.generatedAt || null,
      rows: historyRowsFromSnapshot(snapshot)
    });
  }

  const byGeneratedAt = new Map();
  for (const entry of histories) {
    const timestamp = new Date(entry?.generatedAt).getTime();
    if (!Number.isFinite(timestamp) || !Array.isArray(entry?.rows) || !entry.rows.length) continue;
    const existing = byGeneratedAt.get(entry.generatedAt);
    if (!existing || entry.rows.length > existing.rows.length) byGeneratedAt.set(entry.generatedAt, entry);
  }
  return [...byGeneratedAt.values()]
    .sort((a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime())
    .slice(-180);
}

function buildSnapshotQuality(rows, expectedRows) {
  const withPrice = rows.filter((row) => Number.isFinite(row.metrics?.price)).length;
  const staleRows = rows.filter((row) => row.staleData === true).length;
  const uniqueTickers = new Set(rows.map((row) => row.ticker).filter(Boolean)).size;
  const priceCoverage = rows.length ? withPrice / rows.length : 0;
  const staleShare = rows.length ? staleRows / rows.length : 1;
  const errors = [];
  if (rows.length < Math.ceil(expectedRows * 0.95)) errors.push(`row coverage ${rows.length}/${expectedRows}`);
  if (uniqueTickers !== rows.length) errors.push(`duplicate tickers: rows ${rows.length}, unique ${uniqueTickers}`);
  if (priceCoverage < 0.95) errors.push(`price coverage ${(priceCoverage * 100).toFixed(1)}%`);
  if (staleShare > 0.25) errors.push(`stale rows ${(staleShare * 100).toFixed(1)}%`);
  return {
    status: errors.length ? "FAIL" : staleRows ? "PASS_WITH_STALE_DATA" : "PASS",
    expectedRows,
    rows: rows.length,
    uniqueTickers,
    withPrice,
    priceCoverage,
    staleRows,
    staleShare,
    errors
  };
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
    Number.isFinite(f.cashFlowFallback?.freeCashFlow) ? `SEC FCF ${f.cashFlowFallback.basis || "latest"} ${formatNumber(f.cashFlowFallback.freeCashFlow / 1e9, 1)}B` : null,
    Number.isFinite(f.cashFlowFallback?.operatingCashFlow) ? `SEC OCF ${f.cashFlowFallback.basis || "latest"} ${formatNumber(f.cashFlowFallback.operatingCashFlow / 1e9, 1)}B` : null,
    Number.isFinite(f.revenueGrowthYoY) ? `revenue YoY ${formatPercentLike(f.revenueGrowthYoY)}` : null
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

function opportunitySignals(row) {
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const filingDecision = row.secAnalysis?.filingBrief?.decisionBrief?.verdict || "";
  const engine = row.decisionEngine || {};
  const score = row.researchScore?.total || 0;
  const rebound = row.reboundScore?.total || 0;
  const signals = {
    momentum: 0,
    qualityPullback: 0,
    distressedRebound: 0,
    filingCatalyst: 0
  };

  if (Number.isFinite(metrics.return20d)) signals.momentum += clamp(metrics.return20d, -20, 30) * 0.7;
  if (Number.isFinite(metrics.return60d)) signals.momentum += clamp(metrics.return60d, -25, 45) * 0.5;
  if (Number.isFinite(metrics.volatility60dAnnualized) && metrics.volatility60dAnnualized > 60) signals.momentum -= 10;
  signals.momentum += Math.max(0, score - 65) * 0.35;

  if (Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w <= -8 && metrics.drawdown52w >= -35) signals.qualityPullback += 22;
  if (Number.isFinite(metrics.return20d) && metrics.return20d > -8 && metrics.return20d < 18) signals.qualityPullback += 10;
  if (Number.isFinite(fundamentals.peTTM) && fundamentals.peTTM > 0 && fundamentals.peTTM <= 35) signals.qualityPullback += 8;
  if (Number.isFinite(fundamentals.evToEbitdaTTM) && fundamentals.evToEbitdaTTM > 0 && fundamentals.evToEbitdaTTM <= 20) signals.qualityPullback += 8;
  if (["CORE", "WATCH"].includes(row.status)) signals.qualityPullback += 8;

  if (row.status === "DISTRESSED" || (row.themes || []).includes("DISTRESSED-REBOUND")) signals.distressedRebound += 25;
  signals.distressedRebound += Math.max(0, rebound - 45) * 0.6;
  if (Number.isFinite(metrics.return20d) && metrics.return20d > 5) signals.distressedRebound += 10;
  if (Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w < -20 && metrics.drawdown52w > -75) signals.distressedRebound += 8;
  if (engine.category === "ODRZUC_TERAZ") signals.distressedRebound -= 25;

  if (filingDecision === "CANDIDATE") signals.filingCatalyst += 45;
  if (filingDecision === "REVIEW") signals.filingCatalyst += 35;
  if (filingDecision === "WAIT") signals.filingCatalyst += 10;
  if (filingDecision === "AVOID_NOW") signals.filingCatalyst -= 30;
  if (row.sec?.newFilings?.length) signals.filingCatalyst += 12;
  if (row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === "GUIDANCE_OR_RESULTS")) signals.filingCatalyst += 10;

  return Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, Math.round(clamp(value, -40, 100))]));
}

function opportunityBucket(signals) {
  return Object.entries(signals).sort((a, b) => b[1] - a[1])[0]?.[0] || "momentum";
}

function opportunityReason(row, signals, bucket) {
  const metrics = row.metrics || {};
  const parts = [];
  if (bucket === "momentum") {
    if (Number.isFinite(metrics.return20d)) parts.push(`20d ${formatPct(metrics.return20d)}`);
    if (Number.isFinite(metrics.return60d)) parts.push(`60d ${formatPct(metrics.return60d)}`);
  }
  if (bucket === "qualityPullback") {
    if (Number.isFinite(metrics.drawdown52w)) parts.push(`pullback ${formatPct(metrics.drawdown52w)} od high 52w`);
    if (row.status) parts.push(row.status);
  }
  if (bucket === "distressedRebound") {
    parts.push(`rebound score ${row.reboundScore?.total ?? "-"}`);
    if (Number.isFinite(metrics.drawdown52w)) parts.push(`drawdown ${formatPct(metrics.drawdown52w)}`);
  }
  if (bucket === "filingCatalyst") {
    const brief = row.secAnalysis?.filingBrief;
    if (brief?.decisionBrief?.label) parts.push(`filing: ${brief.decisionBrief.label}`);
    if (brief?.eventTypes?.length) parts.push(brief.eventTypes.slice(0, 2).map((event) => event.label).join(", "));
  }
  return parts.filter(Boolean).join(" | ") || row.decisionEngine?.nextStep || row.thesis || "monitoring";
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function percentLike(value) {
  if (!Number.isFinite(value)) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function formatPercentLike(value) {
  const pct = percentLike(value);
  return Number.isFinite(pct) ? formatPct(pct) : "-";
}

function buildDecisionQualityGate(row, riskGuards) {
  const fundamentals = row.fundamentals || {};
  const fallback = fundamentals.cashFlowFallback || {};
  const checks = [];
  const blockers = [];
  const warnings = [];
  const has = (value) => Number.isFinite(value);

  if (has(fundamentals.revenueGrowthYoY)) {
    const revenueGrowthPct = percentLike(fundamentals.revenueGrowthYoY);
    checks.push(`Revenue YoY ${formatPct(revenueGrowthPct)}`);
    if (revenueGrowthPct < 0) warnings.push("Spadajace przychody YoY");
  } else {
    blockers.push("Brak revenue growth YoY");
  }

  if (has(fundamentals.operatingMarginTTM)) {
    checks.push(`Marza op. ${formatPct(fundamentals.operatingMarginTTM * 100)}`);
    if (fundamentals.operatingMarginTTM < 0.05) warnings.push("Slaba marza operacyjna");
  } else {
    blockers.push("Brak marzy operacyjnej TTM");
  }

  if (has(fundamentals.freeCashFlowTTM)) {
    checks.push(`FCF TTM ${formatNumber(fundamentals.freeCashFlowTTM / 1e9, 1)}B`);
    if (fundamentals.freeCashFlowTTM < 0) warnings.push("Ujemny free cash flow TTM");
  } else if (has(fundamentals.operatingCashFlowTTM)) {
    checks.push(`OCF TTM ${formatNumber(fundamentals.operatingCashFlowTTM / 1e9, 1)}B`);
    if (fundamentals.operatingCashFlowTTM < 0) warnings.push("Ujemny operating cash flow TTM");
  } else if (has(fallback.freeCashFlow)) {
    checks.push(`SEC FCF ${fallback.basis || "latest"} ${formatNumber(fallback.freeCashFlow / 1e9, 1)}B`);
    if (fallback.freeCashFlow < 0) warnings.push("Ujemny SEC cash flow fallback");
    else warnings.push("Cash flow z SEC fallback, nie FMP TTM");
  } else if (has(fallback.operatingCashFlow)) {
    checks.push(`SEC OCF ${fallback.basis || "latest"} ${formatNumber(fallback.operatingCashFlow / 1e9, 1)}B`);
    if (fallback.operatingCashFlow < 0) warnings.push("Ujemny SEC operating cash flow fallback");
    else warnings.push("Cash flow z SEC fallback, nie FMP TTM");
  } else if (has(fundamentals.operatingMarginTTM) && fundamentals.operatingMarginTTM >= 0.12) {
    warnings.push("Cash flow TTM do recznego potwierdzenia");
  } else {
    blockers.push("Brak cash flow TTM");
  }

  if (has(fundamentals.netDebtToEbitdaTTM)) {
    checks.push(`Net debt/EBITDA ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x`);
    if (fundamentals.netDebtToEbitdaTTM > rules.net_debt_ebitda_risk) warnings.push("Wysokie zadluzenie vs EBITDA");
  } else {
    warnings.push("Brak net debt/EBITDA");
  }

  if (has(fundamentals.peTTM) || has(fundamentals.evToEbitdaTTM) || has(fundamentals.pfcfTTM)) {
    if (has(fundamentals.peTTM)) checks.push(`P/E ${formatNumber(fundamentals.peTTM, 1)}`);
    if (has(fundamentals.evToEbitdaTTM)) checks.push(`EV/EBITDA ${formatNumber(fundamentals.evToEbitdaTTM, 1)}`);
    if (has(fundamentals.pfcfTTM)) checks.push(`P/FCF ${formatNumber(fundamentals.pfcfTTM, 1)}`);
  } else {
    blockers.push("Brak podstawowej wyceny");
  }

  const critical = [...riskGuards, ...warnings, ...blockers].filter((item) => /going concern|bankructwo|delisting|rozwodnienie|brak danych cenowych|ujemny free cash flow|ujemny operating cash flow|ujemny SEC|brak cash flow|brak revenue|brak marzy|brak podstawowej wyceny/i.test(item));
  const readyForDecision = blockers.length === 0 && critical.length === 0 && warnings.length <= 1 && checks.length >= 4;
  return {
    status: readyForDecision ? (warnings.length ? "PASS_WARUNKOWY" : "PASS") : "NEEDS_REVIEW",
    readyForDecision,
    checks: uniqueText(checks, 6),
    warnings: uniqueText(warnings, 4),
    blockers: uniqueText(blockers, 4)
  };
}

function opportunityDecision(row, bucket, total) {
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const engine = row.decisionEngine || {};
  const filing = row.secAnalysis?.filingBrief?.decisionBrief || null;
  const blockers = new Set(engine.blockers || row.investmentVerdict?.blockers || []);
  const triggers = [];
  const checklist = [];
  const riskGuards = [];
  const readFirst = [];

  if (Number.isFinite(metrics.price)) checklist.push(`Cena teraz ${formatPrice(metrics.price)}`);
  if (Number.isFinite(metrics.drawdown52w)) checklist.push(`Od high 52w ${formatPct(metrics.drawdown52w)}`);
  if (Number.isFinite(metrics.return20d)) checklist.push(`Momentum 20d ${formatPct(metrics.return20d)}`);
  if (Number.isFinite(metrics.return60d)) checklist.push(`Momentum 60d ${formatPct(metrics.return60d)}`);
  if (Number.isFinite(fundamentals.revenueGrowthYoY)) checklist.push(`Revenue YoY ${formatPercentLike(fundamentals.revenueGrowthYoY)}`);
  if (Number.isFinite(fundamentals.operatingMarginTTM)) checklist.push(`Marza op. ${(fundamentals.operatingMarginTTM * 100).toFixed(1)}%`);
  if (Number.isFinite(fundamentals.freeCashFlowTTM)) checklist.push(`FCF TTM ${formatNumber(fundamentals.freeCashFlowTTM / 1e9, 1)}B`);
  if (!Number.isFinite(fundamentals.freeCashFlowTTM) && Number.isFinite(fundamentals.cashFlowFallback?.freeCashFlow)) checklist.push(`SEC FCF ${fundamentals.cashFlowFallback.basis || "latest"} ${formatNumber(fundamentals.cashFlowFallback.freeCashFlow / 1e9, 1)}B`);
  if (Number.isFinite(fundamentals.netDebtToEbitdaTTM)) checklist.push(`Net debt/EBITDA ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x`);
  if (Number.isFinite(fundamentals.peTTM)) checklist.push(`P/E ${formatNumber(fundamentals.peTTM, 1)}`);
  if (Number.isFinite(fundamentals.evToEbitdaTTM)) checklist.push(`EV/EBITDA ${formatNumber(fundamentals.evToEbitdaTTM, 1)}`);

  if (Number.isFinite(metrics.high52w)) {
    triggers.push(`Potwierdzenie sily: powrot w okolice high 52w ${formatPrice(metrics.high52w)} albo wybicie z wolumenem`);
  }
  if (Number.isFinite(metrics.high52w)) {
    const pullback = metrics.high52w * 0.88;
    triggers.push(`Lepszy risk/reward: obserwuj pullback w okolice ${formatPrice(pullback)} lub stabilizacje po spadku`);
  }
  if (bucket === "distressedRebound") {
    triggers.push("Warunek odbicia: poprawa cash flow, brak rozwodnienia i brak nowych ostrzezen going concern/delisting");
  }
  if (bucket === "filingCatalyst") {
    triggers.push("Warunek katalizatora: filing musi potwierdzac wyniki, guidance, plynnosc albo brak czerwonych flag");
  }
  if (bucket === "momentum") {
    triggers.push("Nie gonic ruchu: po bardzo mocnym 20d wymagaj cofniecia albo konsolidacji");
  }

  if (Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w > -5) riskGuards.push("Blisko high 52w: ryzyko gonienia ceny");
  if (Number.isFinite(metrics.volatility60dAnnualized) && metrics.volatility60dAnnualized > 55) riskGuards.push(`Wysoka zmiennosc 60d ${formatPct(metrics.volatility60dAnnualized)}`);
  if (Number.isFinite(fundamentals.netDebtToEbitdaTTM) && fundamentals.netDebtToEbitdaTTM > rules.net_debt_ebitda_risk) riskGuards.push(`Zadluzenie powyzej progu: ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x EBITDA`);
  if (Number.isFinite(fundamentals.operatingMarginTTM) && fundamentals.operatingMarginTTM < 0.1) riskGuards.push("Marza operacyjna ponizej 10%");
  if (Number.isFinite(fundamentals.revenueGrowthYoY) && percentLike(fundamentals.revenueGrowthYoY) < 3) riskGuards.push("Wzrost przychodow ponizej 3%");
  if (filing?.verdict === "AVOID_NOW") riskGuards.push(`Filing ostrzega: ${filing.label || "ryzyko"}`);
  for (const blocker of blockers) riskGuards.push(blocker);

  if (filing?.readSections?.length) readFirst.push(...filing.readSections.slice(0, 4));
  else if (row.sec?.newFilings?.length) readFirst.push(`SEC ${[...new Set(row.sec.newFilings.map((item) => item.form))].join(", ")}`);
  readFirst.push("ostatnie wyniki i guidance", "marze, cash flow, zadluzenie", "najnowsze newsy i reakcja ceny");
  const qualityGate = buildDecisionQualityGate(row, riskGuards);

  let verdict = "MONITORUJ";
  let label = "Monitoruj";
  let action = "Czekaj na trigger albo nowe dane.";
  if (riskGuards.some((item) => /going concern|bankructwo|delisting|rozwodnienie|AVOID|brak danych/i.test(item))) {
    verdict = "ODRZUC_NA_TERAZ";
    label = "Odrzuc na teraz";
    action = "Nie eskaluj bez wyjasnienia czerwonych ryzyk.";
  } else if (riskGuards.length >= 3 || filing?.verdict === "WAIT") {
    verdict = "WSTRZYMAJ";
    label = "Wstrzymaj sie";
    action = "Najpierw sprawdz ryzyka i filing, potem wracaj do decyzji.";
  } else if (total >= 85 && riskGuards.length <= 1 && qualityGate.readyForDecision) {
    verdict = "GOTOWE_DO_DECYZJI";
    label = "Gotowe do decyzji";
    action = "Zrob finalny pakiet: filing, wycena, cash flow, newsy, poziom ceny.";
  } else if (total >= 85 && !qualityGate.readyForDecision) {
    verdict = "DEEP_DIVE";
    label = "Deep dive";
    action = "Najpierw domknij bramke jakosci: cash flow, marze, zadluzenie, wycena i filing.";
  } else if (total >= 75) {
    verdict = "DEEP_DIVE";
    label = "Deep dive";
    action = "Zbierz brakujace dane i sprawdz warunki wejscia.";
  }

  return {
    verdict,
    label,
    action,
    checklist: [...new Set(checklist)].slice(0, 8),
    triggers: [...new Set(triggers)].slice(0, 4),
    riskGuards: [...new Set(riskGuards)].slice(0, 5),
    readFirst: [...new Set(readFirst)].slice(0, 6),
    qualityGate
  };
}

function buildOpportunityRanking(rows) {
  const blockedCategories = new Set(["ODRZUC_TERAZ"]);
  const items = rows.map((row) => {
    const signals = opportunitySignals(row);
    const bucket = opportunityBucket(signals);
    const engine = row.decisionEngine || {};
    const filingDecision = row.secAnalysis?.filingBrief?.decisionBrief || null;
    const redPenalty = blockedCategories.has(engine.category) || filingDecision?.verdict === "AVOID_NOW" ? 25 : 0;
    const total = Math.round(clamp(
      35
        + Math.max(signals.momentum, signals.qualityPullback, signals.distressedRebound, signals.filingCatalyst) * 0.55
        + (row.researchScore?.total || 0) * 0.25
        + (engine.priority === "P1" ? 8 : engine.priority === "P2" ? 4 : 0)
        - redPenalty,
      0,
      100
    ));
    const decisionPlan = opportunityDecision(row, bucket, total);
    const canonicalVerdict = row.concreteVerdict || null;
    const safeTicker = safeTickerPath(row.ticker);
    return {
      ticker: row.ticker,
      name: row.name,
      status: row.status,
      themes: row.themes || [],
      bucket,
      total,
      signals,
      label: canonicalVerdict?.label || engine.label || row.investmentVerdict?.label || "CZEKAJ",
      priority: engine.priority || "P4",
      confidence: canonicalVerdict?.confidence || engine.confidence || "medium",
      reason: opportunityReason(row, signals, bucket),
      decisionPlan,
      canonicalVerdict,
      nextStep: canonicalVerdict?.nextStep || engine.nextStep || row.investmentVerdict?.filing?.action || "monitoring",
      blockers: engine.blockers || row.investmentVerdict?.blockers || [],
      filingDecision: filingDecision ? {
        verdict: filingDecision.verdict,
        label: filingDecision.label,
        action: filingDecision.action
      } : null,
      evidence: queueEvidence(row),
      links: {
        dashboard: "#detailsView",
        memo: ["ROZWAZ_WEJSCIE", "SPECULATIVE_ONLY"].includes(engine.category) ? `research/memos/${safeTicker}-memo.md` : null,
        deepDive: ["ROZWAZ_WEJSCIE", "CZEKAC", "SPECULATIVE_ONLY", "ODRZUC_TERAZ"].includes(engine.category) ? `research/deep-dives/${safeTicker}-deep-dive.md` : null,
        sec: (row.sec?.newFilings?.[0] || row.secAnalysis?.filing || row.sec?.filings?.[0])?.url || null
      }
    };
  }).sort((a, b) => b.total - a.total || (b.signals[a.bucket] || 0) - (a.signals[b.bucket] || 0));

  const buckets = {
    momentum: items.filter((item) => item.bucket === "momentum").slice(0, 25),
    qualityPullback: items.filter((item) => item.bucket === "qualityPullback").slice(0, 25),
    distressedRebound: items.filter((item) => item.bucket === "distressedRebound").slice(0, 25),
    filingCatalyst: items.filter((item) => item.bucket === "filingCatalyst").slice(0, 25)
  };
  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    top: items.slice(0, 60),
    buckets,
    byBucket: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]))
  };
}

function todayDecisionWeight(item) {
  const plan = item.decisionPlan || {};
  const canonical = item.canonicalVerdict || {};
  const verdictWeight = canonical.action === "INWESTUJ" ? 140
    : canonical.action === "ODRZUC" ? 0
      : canonical.label === "BRAK WYSTARCZAJACYCH DANYCH" ? 35
        : 75;
  const riskPenalty = Math.min(35, (plan.riskGuards || []).length * 8 + (item.blockers || []).length * 6);
  const filingBoost = item.filingDecision?.verdict === "CANDIDATE" ? 18 : item.filingDecision?.verdict === "REVIEW" ? 10 : 0;
  const priorityBoost = item.priority === "P1" ? 14 : item.priority === "P2" ? 8 : 0;
  return Math.round(verdictWeight + (item.total || 0) + filingBoost + priorityBoost - riskPenalty);
}

function uniqueText(items, limit) {
  const seen = new Set();
  const result = [];
  for (const item of items.flat().filter(Boolean)) {
    const text = String(item).trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function todayDecisionDigest(item) {
  const plan = item.decisionPlan || {};
  const canonical = item.canonicalVerdict || {};
  const evidence = item.evidence || [];
  const reasons = [
    item.reason,
    evidence[0],
    evidence[1],
    ...(plan.triggers || []),
    ...(plan.checklist || []),
    item.filingDecision?.verdict === "CANDIDATE" ? `Filing wspiera teze: ${item.filingDecision.label}` : null,
    item.filingDecision?.verdict === "REVIEW" ? `Nowy filing do sprawdzenia: ${item.filingDecision.label}` : null
  ];
  const risks = [
    ...(plan.riskGuards || []),
    ...(plan.qualityGate?.blockers || []),
    ...(plan.qualityGate?.warnings || []),
    ...(item.blockers || []),
    item.filingDecision?.verdict === "REVIEW" ? "Filing wymaga recznego sprawdzenia przed decyzja" : null,
    item.filingDecision?.verdict === "WAIT" ? "Filing nie daje jeszcze potwierdzenia tezy" : null
  ];
  const whyNow = uniqueText(reasons, 3);
  const watchRisks = uniqueText(risks, 3);
  return {
    summary: `${canonical.label || "CZEKAJ"}: ${canonical.nextStep || item.nextStep || "pozostaw w monitoringu"}`,
    whyNow,
    watchRisks,
    readFirst: uniqueText(plan.readFirst || [], 5)
  };
}

function buildTodayDecisionQueue(opportunityRanking) {
  const items = (opportunityRanking.top || [])
    .filter((item) => item.decisionPlan && item.canonicalVerdict?.action !== "ODRZUC")
    .map((item) => {
      const enriched = {
        ...item,
        todayWeight: todayDecisionWeight(item)
      };
      return {
        ...enriched,
        todayDigest: todayDecisionDigest(enriched)
      };
    })
    .sort((a, b) => b.todayWeight - a.todayWeight || (b.total || 0) - (a.total || 0))
    .slice(0, 10);
  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    ready: items.filter((item) => item.canonicalVerdict?.action === "INWESTUJ").length,
    deepDive: items.filter((item) => item.canonicalVerdict?.label === "BRAK WYSTARCZAJACYCH DANYCH").length,
    wait: items.filter((item) => item.canonicalVerdict?.action === "CZEKAJ" && item.canonicalVerdict?.label !== "BRAK WYSTARCZAJACYCH DANYCH").length,
    items
  };
}

function compactTodayDecisionItem(item) {
  const plan = item.decisionPlan || {};
  const canonical = item.canonicalVerdict || {};
  return {
    ticker: item.ticker,
    name: item.name || "",
    score: item.total ?? null,
    todayWeight: item.todayWeight ?? null,
    verdict: canonical.action || plan.verdict || null,
    label: canonical.label || item.label || null,
    action: canonical.nextStep || item.nextStep || null,
    bucket: item.bucket || null,
    priority: item.priority || null,
    whyNow: item.todayDigest?.whyNow || [],
    watchRisks: item.todayDigest?.watchRisks || []
  };
}

function buildTodayDecisionChanges(previousQueue, currentQueue, generatedAt) {
  const previousItems = previousQueue?.items || [];
  const currentItems = currentQueue?.items || [];
  const previousByTicker = new Map(previousItems.map((item) => [item.ticker, item]));
  const currentByTicker = new Map(currentItems.map((item) => [item.ticker, item]));
  const added = [];
  const removed = [];
  const verdictChanged = [];
  const readyNow = [];

  for (const item of currentItems) {
    if (!item.ticker) continue;
    const previous = previousByTicker.get(item.ticker);
    const currentPlan = item.canonicalVerdict || item.decisionPlan || {};
    const previousPlan = previous?.canonicalVerdict || previous?.decisionPlan || {};
    const currentVerdict = currentPlan.action || currentPlan.verdict || null;
    const previousVerdict = previousPlan.action || previousPlan.verdict || null;
    if (!previous) {
      added.push(compactTodayDecisionItem(item));
    } else if (previousVerdict !== currentVerdict) {
      verdictChanged.push({
        ...compactTodayDecisionItem(item),
        previousVerdict,
        previousLabel: previousPlan.label || previous.label || null
      });
    }
    if (currentVerdict === "INWESTUJ" && previousVerdict !== "INWESTUJ") {
      readyNow.push(compactTodayDecisionItem(item));
    }
  }

  for (const item of previousItems) {
    if (item.ticker && !currentByTicker.has(item.ticker)) removed.push(compactTodayDecisionItem(item));
  }

  return {
    generatedAt,
    previousGeneratedAt: previousQueue?.generatedAt || null,
    added,
    removed,
    verdictChanged,
    readyNow,
    totalChanges: added.length + removed.length + verdictChanged.length + readyNow.length
  };
}

function decisionModeForPackage(item, row) {
  const canonical = row?.concreteVerdict || item.canonicalVerdict || {};
  if (canonical.action === "INWESTUJ") return "WEJSCIE_TERAZ";
  if (canonical.action === "ODRZUC") return "ODRZUC";
  if (canonical.label === "BRAK WYSTARCZAJACYCH DANYCH") return "BRAK_DANYCH";
  if (canonical.action === "CZEKAJ") return "CZEKAJ";
  const plan = item.decisionPlan || {};
  const gate = plan.qualityGate || {};
  if (plan.verdict === "GOTOWE_DO_DECYZJI" && gate.status === "PASS") return "GOTOWE_DO_FINALNEJ_DECYZJI";
  if (plan.verdict === "GOTOWE_DO_DECYZJI" && gate.status === "PASS_WARUNKOWY") return "GOTOWE_WARUNKOWO";
  if (plan.verdict === "DEEP_DIVE") return "NAJPIERW_DEEP_DIVE";
  if (plan.verdict === "WSTRZYMAJ") return "WSTRZYMAJ_I_OBSERWUJ";
  return "OBSERWUJ";
}

function decisionModeLabel(mode) {
  return {
    WEJSCIE_TERAZ: "WEJSCIE TERAZ",
    CZEKAJ: "CZEKAJ",
    ODRZUC: "ODRZUC",
    BRAK_DANYCH: "BRAK WYSTARCZAJACYCH DANYCH",
    GOTOWE_DO_FINALNEJ_DECYZJI: "Gotowe do finalnej decyzji",
    GOTOWE_WARUNKOWO: "Gotowe warunkowo",
    NAJPIERW_DEEP_DIVE: "Najpierw deep dive",
    WSTRZYMAJ_I_OBSERWUJ: "Wstrzymaj i obserwuj",
    OBSERWUJ: "Obserwuj"
  }[mode] || mode || "Obserwuj";
}

function metricSnapshot(row) {
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  return uniqueText([
    Number.isFinite(metrics.price) ? `Cena ${formatPrice(metrics.price)}` : null,
    Number.isFinite(metrics.drawdown52w) ? `Od high 52w ${formatPct(metrics.drawdown52w)}` : null,
    Number.isFinite(metrics.return20d) ? `20d ${formatPct(metrics.return20d)}` : null,
    Number.isFinite(metrics.return60d) ? `60d ${formatPct(metrics.return60d)}` : null,
    Number.isFinite(fundamentals.revenueGrowthYoY) ? `Revenue YoY ${formatPercentLike(fundamentals.revenueGrowthYoY)}` : null,
    Number.isFinite(fundamentals.operatingMarginTTM) ? `Marza op. ${formatPct(fundamentals.operatingMarginTTM * 100)}` : null,
    !Number.isFinite(fundamentals.freeCashFlowTTM) && Number.isFinite(fundamentals.cashFlowFallback?.freeCashFlow) ? `SEC FCF ${fundamentals.cashFlowFallback.basis || "latest"} ${formatNumber(fundamentals.cashFlowFallback.freeCashFlow / 1e9, 1)}B` : null,
    !Number.isFinite(fundamentals.operatingCashFlowTTM) && Number.isFinite(fundamentals.cashFlowFallback?.operatingCashFlow) ? `SEC OCF ${fundamentals.cashFlowFallback.basis || "latest"} ${formatNumber(fundamentals.cashFlowFallback.operatingCashFlow / 1e9, 1)}B` : null,
    Number.isFinite(fundamentals.netDebtToEbitdaTTM) ? `Net debt/EBITDA ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x` : null,
    Number.isFinite(fundamentals.peTTM) ? `P/E ${formatNumber(fundamentals.peTTM, 1)}` : null,
    Number.isFinite(fundamentals.evToEbitdaTTM) ? `EV/EBITDA ${formatNumber(fundamentals.evToEbitdaTTM, 1)}` : null
  ], 9);
}

function buildDecisionPackageForItem(item, row, index) {
  const plan = item.decisionPlan || {};
  const gate = plan.qualityGate || {};
  const digest = item.todayDigest || {};
  const canonical = row?.concreteVerdict || item.canonicalVerdict || {};
  const mode = decisionModeForPackage(item, row);
  const filing = row?.secAnalysis?.filing || row?.sec?.newFilings?.[0] || row?.sec?.filings?.[0] || null;
  const filingBrief = row?.secAnalysis?.filingBrief || null;
  const bullCase = uniqueText([
    ...(digest.whyNow || []),
    ...(row?.decisionEngine?.reasons || []),
    ...(row?.researchScore?.positives || []),
    item.reason
  ], 5);
  const bearCase = uniqueText([
    ...(digest.watchRisks || []),
    ...(gate.blockers || []),
    ...(gate.warnings || []),
    ...(row?.decisionEngine?.blockers || []),
    ...(row?.researchScore?.negatives || []),
    filingBrief?.summary && /risk|ryzyk|going concern|delisting|dilution|debt|debt/i.test(filingBrief.summary) ? filingBrief.summary : null
  ], 5);
  const mustConfirm = uniqueText([
    ...(gate.blockers || []),
    ...(gate.warnings || []),
    ...(plan.readFirst || []),
    ...(filingBrief?.decisionBrief?.readSections || [])
  ], 6);
  const entryConditions = uniqueText([
    ...(plan.triggers || []),
    mode === "GOTOWE_WARUNKOWO" ? "Potwierdz cash flow w raporcie kwartalnym przed finalna decyzja" : null,
    "Sprawdz, czy reakcja ceny nie jest juz gonieniem ruchu"
  ], 5);
  const rejectConditions = uniqueText([
    ...(plan.riskGuards || []),
    ...(gate.blockers || []),
    "Nowy filing pokazuje pogorszenie plynnosci, duze rozwodnienie albo obnizenie guidance",
    "Cena wybija bez potwierdzenia wynikow i pogarsza risk/reward"
  ], 5);

  return {
    rank: index + 1,
    ticker: item.ticker,
    name: item.name || row?.name || "",
    generatedAt: new Date().toISOString(),
    decisionMode: mode,
    decisionLabel: canonical.label || decisionModeLabel(mode),
    score: item.total ?? null,
    todayWeight: item.todayWeight ?? null,
    bucket: item.bucket || null,
    priority: item.priority || null,
    confidence: canonical.confidence || item.confidence || row?.decisionEngine?.confidence || "medium",
    confidenceScore: canonical.confidenceScore ?? null,
    scores: canonical.scores || null,
    workingVerdict: canonical.label || null,
    interpretation: `${canonical.label || decisionModeLabel(mode)}: ${canonical.nextStep || item.nextStep || "pozostaw w monitoringu"}`,
    bullCase,
    bearCase,
    metrics: metricSnapshot(row || {}),
    qualityGate: gate,
    mustConfirm,
    entryConditions,
    rejectConditions,
    readFirst: uniqueText([
      ...(plan.readFirst || []),
      filing?.form ? `SEC ${filing.form}` : null,
      "ostatnie wyniki i guidance",
      "najnowsze newsy i reakcja ceny"
    ], 6),
    links: {
      dashboard: "#decisionPackagesView",
      details: "#detailsView",
      memo: item.links?.memo || null,
      deepDive: item.links?.deepDive || null,
      sec: item.links?.sec || filing?.url || null
    }
  };
}

function buildDecisionPackages(todayDecisionQueue, rows, generatedAt) {
  const rowsByTicker = new Map((rows || []).map((row) => [row.ticker, row]));
  const items = (todayDecisionQueue.items || [])
    .slice(0, 3)
    .map((item, index) => buildDecisionPackageForItem(item, rowsByTicker.get(item.ticker), index));
  return {
    generatedAt,
    total: items.length,
    items
  };
}

async function loadPreviousDecisionRegistry() {
  const candidates = [];
  if (fs.existsSync(decisionRegistryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(decisionRegistryPath, "utf8"));
      if (registry && Array.isArray(registry.items)) candidates.push({ registry, sourceRank: 0 });
    } catch (error) {
      console.log(`Local decision registry unavailable: ${error.message}`);
    }
  }

  const url = config.data_providers?.previous_decision_registry_url
    || process.env.PREVIOUS_DECISION_REGISTRY_URL
    || "https://mackdev-ai.github.io/stock-radar-dashboard/data/decision-registry.json";
  try {
    const response = await fetch(url, { headers: { "user-agent": "local-monitoring-dashboard/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const registry = await response.json();
    if (registry && Array.isArray(registry.items)) candidates.push({ registry, sourceRank: 1 });
  } catch (error) {
    console.log(`Previous decision registry unavailable: ${error.message}`);
  }
  if (!candidates.length) return { generatedAt: null, items: [] };
  candidates.sort((a, b) => {
    const timeDelta = new Date(b.registry.generatedAt || 0).getTime() - new Date(a.registry.generatedAt || 0).getTime();
    if (timeDelta) return timeDelta;
    const sizeDelta = b.registry.items.length - a.registry.items.length;
    return sizeDelta || b.sourceRank - a.sourceRank;
  });
  return candidates[0].registry;
}

async function loadPreviousVerdictLedger() {
  const candidates = [];
  if (fs.existsSync(verdictLedgerPath)) {
    try {
      const ledger = JSON.parse(fs.readFileSync(verdictLedgerPath, "utf8"));
      if (ledger && Array.isArray(ledger.events)) candidates.push({ ledger, sourceRank: 0 });
    } catch (error) {
      console.log(`Local verdict ledger unavailable: ${error.message}`);
    }
  }

  const url = config.data_providers?.previous_verdict_ledger_url
    || process.env.PREVIOUS_VERDICT_LEDGER_URL
    || "https://mackdev-ai.github.io/stock-radar-dashboard/data/verdict-ledger.json";
  try {
    const response = await fetch(url, { headers: { "user-agent": "local-monitoring-dashboard/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ledger = await response.json();
    if (ledger && Array.isArray(ledger.events)) candidates.push({ ledger, sourceRank: 1 });
  } catch (error) {
    console.log(`Previous verdict ledger unavailable: ${error.message}`);
  }
  if (!candidates.length) return { version: 1, generatedAt: null, events: [], paperPortfolio: null };
  candidates.sort((a, b) => {
    const timeDelta = new Date(b.ledger.generatedAt || 0).getTime() - new Date(a.ledger.generatedAt || 0).getTime();
    if (timeDelta) return timeDelta;
    const sizeDelta = b.ledger.events.length - a.ledger.events.length;
    return sizeDelta || b.sourceRank - a.sourceRank;
  });
  return candidates[0].ledger;
}

function decisionRegistryStatus(ageDays) {
  if (!Number.isFinite(ageDays)) return "OPEN";
  if (ageDays >= 60) return "MATURED_60D";
  if (ageDays >= 20) return "MATURED_20D";
  if (ageDays >= 5) return "MATURED_5D";
  return "OPEN";
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

function decisionBriefVerdictForRow(row) {
  const score = row.researchScore?.total ?? 0;
  const action = row.signal?.action || "";
  const verdict = row.investmentVerdict?.verdict || "";
  const blockers = row.investmentVerdict?.blockers || [];
  const filingBrief = row.secAnalysis?.filingBrief || row.investmentVerdict?.filing?.brief;
  const filingDecision = filingBrief?.decisionBrief || null;
  const engineCategory = row.decisionEngine?.category || "";
  const positives = row.investmentVerdict?.reasons || row.researchScore?.positives || [];
  if (filingDecision?.verdict === "AVOID_NOW" || engineCategory === "ODRZUC_TERAZ" || verdict === "NIE_INWESTOWAC_TERAZ" || verdict === "ODRZUCIC") {
    const confidence = decisionBriefConfidence(row, "ODRZUC");
    return {
      briefVerdict: "ODRZUC",
      briefLabel: "Odrzuc na teraz",
      ...confidence,
      briefReason: blockers.slice(0, 2).join("; ") || filingDecision?.reasons?.slice(0, 2).join("; ") || "blokery sa silniejsze niz setup",
      briefNextStep: filingDecision?.verdict === "AVOID_NOW" ? filingDecision.action : row.decisionEngine?.nextStep || "wroc dopiero po poprawie filingow, bilansu albo momentum"
    };
  }
  if (filingDecision?.verdict === "WAIT" || ["CZEKAC", "SPECULATIVE_ONLY"].includes(engineCategory) || action === "REVIEW_RISK" || action === "DO_NOT_CHASE" || blockers.length >= 2 || filingBrief?.urgency === "high") {
    const confidence = decisionBriefConfidence(row, "WSTRZYMAJ");
    return {
      briefVerdict: "WSTRZYMAJ",
      briefLabel: "Wstrzymaj",
      ...confidence,
      briefReason: blockers.slice(0, 2).join("; ") || filingDecision?.reasons?.slice(0, 2).join("; ") || filingBrief?.summary || "najpierw ryzyko",
      briefNextStep: filingDecision?.verdict === "WAIT" ? filingDecision.action : row.decisionEngine?.nextStep || filingBrief?.researchAction || "sprawdz czerwone flagi: cash flow, zadluzenie, rozwodnienie, guidance"
    };
  }
  if ((filingDecision?.verdict === "CANDIDATE" || engineCategory === "ROZWAZ_WEJSCIE" || verdict === "KANDYDAT" || verdict === "WARTO_ANALIZOWAC" || score >= 80) && blockers.length <= 1) {
    const confidence = decisionBriefConfidence(row, "KANDYDAT");
    return {
      briefVerdict: "KANDYDAT",
      briefLabel: "Kandydat",
      ...confidence,
      briefReason: positives.slice(0, 2).join("; ") || `wysoki score ${score}`,
      briefNextStep: filingDecision?.verdict === "CANDIDATE" ? filingDecision.action : row.decisionEngine?.nextStep || filingBrief?.researchAction || "sprawdz filing, marze, wzrost, cash flow i wycene"
    };
  }
  const confidence = decisionBriefConfidence(row, "OBSERWUJ");
  return {
    briefVerdict: "OBSERWUJ",
    briefLabel: "Obserwuj",
    ...confidence,
    briefReason: filingBrief?.summary || (row.signal?.alerts || []).slice(0, 2).join("; ") || row.thesis || "brak pilnej akcji",
    briefNextStep: "czekaj na wynik, filing, trigger ceny albo poprawe momentum"
  };
}

function concreteEvidence(row) {
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const earnings = row.postEarnings?.result || row.catalystAssessment?.latestEarnings || {};
  return {
    radarScore: row.researchScore?.total ?? null,
    price: metrics.price ?? null,
    return20d: metrics.return20d ?? null,
    return60d: metrics.return60d ?? null,
    drawdown52w: metrics.drawdown52w ?? null,
    peTTM: fundamentals.peTTM ?? null,
    evToEbitdaTTM: fundamentals.evToEbitdaTTM ?? null,
    netDebtToEbitdaTTM: fundamentals.netDebtToEbitdaTTM ?? null,
    revenueGrowthYoY: fundamentals.revenueGrowthYoY ?? null,
    epsSurprisePct: earnings.epsSurprisePct ?? null,
    revenueSurprisePct: earnings.revenueSurprisePct ?? null,
    guidance: row.postEarnings?.guidance?.status || null,
    postEarningsScore: row.postEarnings?.score ?? null
  };
}

function concreteSourceLinks(row) {
  const links = [];
  const release = row.postEarnings?.release?.document;
  const filing = row.postEarnings?.release?.filing || row.secAnalysis?.filing || row.sec?.filings?.[0];
  if (release?.url) links.push({ label: "Komunikat wynikowy SEC", url: release.url });
  if (filing?.url) links.push({ label: `${filing.form || "SEC"} ${filing.filingDate || ""}`.trim(), url: filing.url });
  for (const news of (row.catalystAssessment?.news || []).slice(0, 2)) {
    if (news.url) links.push({ label: String(news.title || news.site || "News").slice(0, 100), url: news.url });
  }
  return links.slice(0, 4);
}

function buildCanonicalDataQuality(row) {
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const fallback = fundamentals.cashFlowFallback || {};
  const metricDate = metrics.date ? new Date(`${metrics.date}T23:59:59Z`).getTime() : NaN;
  const ageDays = Number.isFinite(metricDate) ? Math.max(0, (Date.now() - metricDate) / 86400000) : null;
  const hasCashFlow = Number.isFinite(fundamentals.freeCashFlowTTM)
    || Number.isFinite(fundamentals.operatingCashFlowTTM)
    || Number.isFinite(fallback.freeCashFlow)
    || Number.isFinite(fallback.operatingCashFlow);
  const checks = [
    { key: "price", label: "aktualna cena", ok: Number.isFinite(metrics.price) && Number.isFinite(ageDays) && ageDays <= 5 },
    { key: "growth", label: "wzrost przychodow", ok: Number.isFinite(fundamentals.revenueGrowthYoY) },
    { key: "margin", label: "marza operacyjna", ok: Number.isFinite(fundamentals.operatingMarginTTM) },
    { key: "cashFlow", label: "cash flow", ok: hasCashFlow },
    {
      key: "valuation",
      label: "podstawowa wycena",
      ok: Number.isFinite(fundamentals.peTTM) || Number.isFinite(fundamentals.evToEbitdaTTM) || Number.isFinite(fundamentals.pfcfTTM)
    }
  ];
  const missing = checks.filter((check) => !check.ok).map((check) => check.label);
  const completeness = Math.round((checks.filter((check) => check.ok).length / checks.length) * 100);
  const warnings = [];
  if (hasCashFlow && !Number.isFinite(fundamentals.freeCashFlowTTM) && !Number.isFinite(fundamentals.operatingCashFlowTTM)) {
    warnings.push("cash flow pochodzi z SEC fallback zamiast FMP TTM");
  }
  if (!Number.isFinite(fundamentals.netDebtToEbitdaTTM)) warnings.push("brak net debt/EBITDA");
  const status = missing.length ? "INSUFFICIENT" : warnings.length ? "LIMITED" : "COMPLETE";
  return {
    status,
    completeness,
    ageDays: Number.isFinite(ageDays) ? Number(ageDays.toFixed(1)) : null,
    available: checks.filter((check) => check.ok).map((check) => check.label),
    missing,
    warnings
  };
}

function buildCanonicalEntrySetup(row) {
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const signalAction = row.signal?.action || "";
  if (!Number.isFinite(metrics.price) || !Number.isFinite(metrics.high52w)) {
    return {
      status: "NO_DATA",
      reason: "brak ceny lub maksimum 52 tygodni potrzebnego do oceny wejscia",
      trigger: "uzupelnij dane ceny",
      invalidation: "brak wiarygodnych danych cenowych"
    };
  }

  const volumeRatio = Number.isFinite(metrics.volume) && Number.isFinite(fundamentals.averageVolume) && fundamentals.averageVolume > 0
    ? metrics.volume / fundamentals.averageVolume
    : null;
  const breakout = metrics.price >= metrics.high52w * 0.98
    && Number.isFinite(metrics.return20d) && metrics.return20d > 0
    && Number.isFinite(volumeRatio) && volumeRatio >= 1.2;
  const pullbackZone = Number.isFinite(metrics.drawdown52w) && metrics.drawdown52w <= -8 && metrics.drawdown52w >= -25;
  const stabilized = pullbackZone
    && Number.isFinite(metrics.return5d) && metrics.return5d >= 1
    && Number.isFinite(metrics.return20d) && metrics.return20d > -10
    && (!Number.isFinite(metrics.volatility60dAnnualized) || metrics.volatility60dAnnualized < 55);
  const overheated = Number.isFinite(metrics.return20d) && metrics.return20d > 20;
  const blocked = ["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(signalAction);

  if (blocked) {
    return {
      status: "BLOCKED",
      reason: `aktywny sygnal ryzyka ${signalAction}`,
      trigger: "najpierw usun sygnal ryzyka i potwierdz stabilizacje ceny",
      invalidation: "dalsze pogorszenie ceny lub fundamentow"
    };
  }
  if (overheated) {
    return {
      status: "WAIT",
      reason: `kurs wzrosl ${formatPct(metrics.return20d)} w 20 sesji - ryzyko gonienia ruchu`,
      trigger: "poczekaj na cofniecie albo co najmniej kilkusesyjna konsolidacje",
      invalidation: "utrata momentum po mocnym ruchu bez wsparcia wynikow"
    };
  }
  if (breakout) {
    return {
      status: "MET",
      reason: `wybicie blisko high 52w z wolumenem ${formatNumber(volumeRatio, 1)}x sredniej`,
      trigger: "wybicie cenowe i wolumenowe jest aktywne",
      invalidation: `powrot ponizej ${formatPrice(metrics.high52w * 0.95)}`
    };
  }
  if (stabilized) {
    return {
      status: "MET",
      reason: `pullback ${formatPct(metrics.drawdown52w)} i dodatnia stabilizacja 5d ${formatPct(metrics.return5d)}`,
      trigger: "stabilizacja pullbacku jest aktywna",
      invalidation: `spadek ponizej ostatniego minimum lub momentum 20d ponizej -10%`
    };
  }

  const trigger = pullbackZone
    ? "czekaj na dodatni ruch 5d co najmniej +1% przy momentum 20d powyzej -10%"
    : `czekaj na potwierdzone wybicie w rejonie ${formatPrice(metrics.high52w)} z wolumenem co najmniej 1.2x sredniej`;
  return {
    status: "WAIT",
    reason: pullbackZone ? "pullback nie pokazal jeszcze wymaganej stabilizacji" : "brak aktywnego triggera ceny",
    trigger,
    invalidation: "pogorszenie filingow, plynnosci lub fundamentow"
  };
}

function canonicalDecisionScores(row, action, dataQuality, entrySetup, blockers, hardBlockers) {
  const attractiveness = Math.round(clamp(row.researchScore?.total ?? 0, 0, 100));
  const risk = Math.round(clamp(
    18
      + blockers.length * 10
      + hardBlockers.length * 22
      + (["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(row.signal?.action) ? 18 : 0)
      + (row.secAnalysis?.filingBrief?.urgency === "high" ? 20 : 0)
      + (Number.isFinite(row.metrics?.volatility60dAnnualized) && row.metrics.volatility60dAnnualized >= 55 ? 12 : 0),
    0,
    100
  ));
  let readiness = 15;
  if (row.decisionBrief?.briefVerdict === "KANDYDAT" && row.decisionEngine?.category === "ROZWAZ_WEJSCIE") readiness += 20;
  if (dataQuality.status === "COMPLETE") readiness += 25;
  else if (dataQuality.status === "LIMITED") readiness += 15;
  if (entrySetup.status === "MET") readiness += 35;
  if (!hardBlockers.length) readiness += 10;
  if (action === "ODRZUC") readiness = 0;
  if (action === "CZEKAJ") readiness = Math.min(readiness, 69);
  if (action === "INWESTUJ") readiness = Math.max(readiness, 80);
  if (dataQuality.status === "INSUFFICIENT") readiness = Math.min(readiness, 35);
  return {
    attractiveness,
    readiness: Math.round(clamp(readiness, 0, 100)),
    risk,
    dataCompleteness: dataQuality.completeness
  };
}

function buildConcreteVerdict(row) {
  const brief = row.decisionBrief || {};
  const engine = row.decisionEngine || {};
  const post = row.postEarnings || null;
  const score = row.researchScore?.total ?? 0;
  const signalAction = row.signal?.action || "";
  const blockers = [...new Set([...(row.investmentVerdict?.blockers || []), ...(engine.blockers || [])])];
  const hardBlockers = blockers.filter((item) => /going concern|plynnosc|rozwodnienie|bankructwo|delisting|brak danych|krytyczne ryzyko|default|material weakness/i.test(item));
  const upcomingBinaryEvent = row.catalystAssessment?.nextEvent?.type === "earnings"
    && Number.isFinite(row.catalystAssessment?.daysToEvent)
    && row.catalystAssessment.daysToEvent <= 3;
  const positiveReasons = [...new Set([
    ...(post?.positives || []),
    `radar score ${score}/100`,
    Number.isFinite(row.metrics?.return20d) ? `ruch 20d ${formatPct(row.metrics.return20d)}` : null,
    Number.isFinite(row.metrics?.return60d) ? `ruch 60d ${formatPct(row.metrics.return60d)}` : null,
    Number.isFinite(row.metrics?.drawdown52w) ? `od high 52w ${formatPct(row.metrics.drawdown52w)}` : null,
    Number.isFinite(row.fundamentals?.revenueGrowthYoY) ? `wzrost przychodow ${formatPercentLike(row.fundamentals.revenueGrowthYoY)}` : null,
    Number.isFinite(row.fundamentals?.netDebtToEbitdaTTM) ? `net debt/EBITDA ${formatNumber(row.fundamentals.netDebtToEbitdaTTM, 1)}x` : null,
    ...(row.investmentVerdict?.reasons || []),
    ...(row.researchScore?.positives || [])
  ].filter(Boolean))];
  const sourceLinks = concreteSourceLinks(row);
  const dataQuality = buildCanonicalDataQuality(row);
  const entrySetup = buildCanonicalEntrySetup(row);
  let action = "CZEKAJ";
  let label = "CZEKAJ";
  let reason = blockers.slice(0, 2).join("; ") || brief.briefReason || "brak wystarczajacego potwierdzenia do wejscia";
  let nextStep = brief.briefNextStep || "Czekaj na wynik, filing albo potwierdzenie ceny.";

  if (brief.briefVerdict === "ODRZUC" || engine.category === "ODRZUC_TERAZ" || post?.modelAction === "ODRZUC" || hardBlockers.length) {
    action = "ODRZUC";
    label = "ODRZUC";
    reason = post?.risks?.slice(0, 2).join("; ") || hardBlockers.slice(0, 2).join("; ") || brief.briefReason || "ryzyko jest silniejsze niz potencjal zwrotu";
    nextStep = "Nie otwieraj pozycji wedlug obecnego modelu. Wroc dopiero po usunieciu wskazanych czerwonych flag.";
  } else if (dataQuality.status === "INSUFFICIENT") {
    label = "BRAK WYSTARCZAJACYCH DANYCH";
    reason = `brakuje: ${dataQuality.missing.join(", ")}`;
    nextStep = "Uzupelnij brakujace dane; do tego czasu system nie ocenia wejscia.";
  } else if (post && post.status !== "ANALYZED") {
    reason = "wyniki sa opublikowane, ale komunikat wynikowy SEC nie zostal jeszcze kompletnie przeanalizowany";
    nextStep = "Pipeline ponowi lub dokonczy analize komunikatu wynikowego; do tego czasu model czeka.";
  } else if (upcomingBinaryEvent) {
    reason = `wyniki za ${row.catalystAssessment.daysToEvent} dni - ryzyko zdarzenia jest zbyt wysokie`;
    nextStep = "Poczekaj na liczby, guidance i pierwsza reakcje kursu po publikacji.";
  } else {
    const postConfirmed = !post || post.modelAction === "INWESTUJ";
    const canonicalCandidate = brief.briefVerdict === "KANDYDAT" && engine.category === "ROZWAZ_WEJSCIE";
    const noRiskAction = !["REVIEW_RISK", "DO_NOT_CHASE", "NO_DATA"].includes(signalAction);
    if (postConfirmed && canonicalCandidate && noRiskAction && score >= 80 && positiveReasons.length >= 2 && hardBlockers.length === 0 && entrySetup.status === "MET") {
      action = "INWESTUJ";
      label = "WEJSCIE TERAZ";
      reason = `${entrySetup.reason}; ${positiveReasons.slice(0, 2).join("; ")}`;
      nextStep = `Trigger spelniony. Przed zleceniem sprawdz cene i spread. Uniewaznienie: ${entrySetup.invalidation}.`;
    } else {
      const missing = [];
      if (score < 80) missing.push(`score ${score}/100, wymagane 80`);
      if (!canonicalCandidate) missing.push("brak zgodnego sygnalu kandydata i wejscia");
      if (!noRiskAction) missing.push(`akcja systemowa ${signalAction}`);
      if (post && post.modelAction !== "INWESTUJ") missing.push(`ocena po wynikach ${post.score}/100`);
      if (entrySetup.status !== "MET") missing.unshift(entrySetup.reason);
      reason = missing.slice(0, 3).join("; ") || reason;
      if (post?.risks?.length) {
        nextStep = `Czekaj, az zniknie: ${post.risks.slice(0, 2).join("; ")}.`;
      } else if (entrySetup.status !== "MET") {
        nextStep = entrySetup.trigger || nextStep;
      } else if (!canonicalCandidate) {
        nextStep = brief.briefNextStep || "Najpierw potwierdz zgodnosc oceny fundamentalnej i sygnalu wejscia.";
      } else if (!noRiskAction) {
        nextStep = "Najpierw usun aktywny sygnal ryzyka; dopiero potem ponownie ocen wejscie.";
      }
    }
  }

  const baseConfidence = Number(brief.confidenceScore) || Number(post?.confidenceScore) || 45;
  let confidenceScore = Math.round(clamp(baseConfidence + (sourceLinks.length ? 5 : -5) + (action === "INWESTUJ" ? 5 : 0), 25, 95));
  if (dataQuality.status === "LIMITED") confidenceScore = Math.min(confidenceScore, 74);
  if (dataQuality.status === "INSUFFICIENT") confidenceScore = Math.min(confidenceScore, 49);
  const scores = canonicalDecisionScores(row, action, dataQuality, entrySetup, blockers, hardBlockers);
  return {
    version: "v2",
    action,
    label,
    confidence: confidenceScore >= 75 ? "high" : confidenceScore >= 55 ? "medium" : "low",
    confidenceScore,
    reason,
    nextStep,
    scores,
    dataQuality,
    entrySetup,
    evidence: concreteEvidence(row),
    conditions: uniqueText([...blockers, ...dataQuality.missing, entrySetup.status !== "MET" ? entrySetup.trigger : null], 6),
    sourceLinks
  };
}

function decisionBriefRegistryRows(rows, limit = 60) {
  const bucketRank = { KANDYDAT: 4, WSTRZYMAJ: 3, OBSERWUJ: 2, ODRZUC: 1 };
  const ranked = (rows || [])
    .map((row) => {
      const brief = row.decisionBrief || decisionBriefVerdictForRow(row);
      const score = row.researchScore?.total ?? 0;
      const weight = score
        + (row.sec?.newFilings?.length ? 25 : 0)
        + (row.secAnalysis?.filingBrief?.urgency === "high" ? 20 : 0)
        + (row.decisionEngine?.priority === "P1" ? 18 : row.decisionEngine?.priority === "P2" ? 10 : 0)
        + (bucketRank[brief.briefVerdict] || 0) * 8;
      return { row, brief, weight };
    })
    .sort((a, b) => b.weight - a.weight || (b.row.researchScore?.total || 0) - (a.row.researchScore?.total || 0));
  const quotas = [
    ["KANDYDAT", 18],
    ["WSTRZYMAJ", 18],
    ["ODRZUC", 12],
    ["OBSERWUJ", 12]
  ];
  const picked = [];
  const used = new Set();
  for (const [bucket, quota] of quotas) {
    for (const item of ranked.filter((candidate) => candidate.brief.briefVerdict === bucket)) {
      if (picked.filter((candidate) => candidate.brief.briefVerdict === bucket).length >= quota || picked.length >= limit) break;
      if (!item.row.ticker || used.has(item.row.ticker)) continue;
      used.add(item.row.ticker);
      picked.push(item);
    }
  }
  for (const item of ranked) {
    if (picked.length >= limit) break;
    if (!item.row.ticker || used.has(item.row.ticker)) continue;
    used.add(item.row.ticker);
    picked.push(item);
  }
  return picked;
}

function buildDecisionRegistry(previousRegistry, todayDecisionQueue, rows, generatedAt) {
  const currentByTicker = new Map(rows.map((row) => [row.ticker, row]));
  const activeByTicker = new Map();
  const items = [];

  for (const entry of previousRegistry.items || []) {
    const current = currentByTicker.get(entry.ticker);
    const currentBrief = current ? (current.decisionBrief || decisionBriefVerdictForRow(current)) : null;
    const ageDays = daysBetween(entry.firstSeen, generatedAt);
    const startPrice = Number(entry.startPrice);
    const currentPrice = Number(current?.metrics?.price);
    const returnPct = Number.isFinite(startPrice) && startPrice > 0 && Number.isFinite(currentPrice)
      ? pctChange(currentPrice, startPrice)
      : entry.returnPct ?? null;
    const return5d = Number.isFinite(entry.return5d) ? entry.return5d : ageDays >= 5 ? returnPct : null;
    const return20d = Number.isFinite(entry.return20d) ? entry.return20d : ageDays >= 20 ? returnPct : null;
    const return60d = Number.isFinite(entry.return60d) ? entry.return60d : ageDays >= 60 ? returnPct : null;
    const updated = {
      ...entry,
      lastSeen: generatedAt,
      ageDays,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : entry.currentPrice ?? null,
      currentScore: current?.researchScore?.total ?? entry.currentScore ?? null,
      currentDecision: current?.decisionEngine?.label ?? entry.currentDecision ?? null,
      currentBriefVerdict: currentBrief?.briefVerdict ?? entry.currentBriefVerdict ?? null,
      currentBriefLabel: currentBrief?.briefLabel ?? entry.currentBriefLabel ?? null,
      currentBriefConfidence: currentBrief?.confidence ?? entry.currentBriefConfidence ?? null,
      currentBriefConfidenceScore: currentBrief?.confidenceScore ?? entry.currentBriefConfidenceScore ?? null,
      returnPct,
      return5d,
      return20d,
      return60d,
      status: decisionRegistryStatus(ageDays)
    };
    items.push(updated);
    if ((ageDays ?? 0) < 60 && !activeByTicker.has(updated.ticker)) activeByTicker.set(updated.ticker, updated);
  }

  for (const item of todayDecisionQueue.items || []) {
    if (!item.ticker || activeByTicker.has(item.ticker)) continue;
    const row = currentByTicker.get(item.ticker);
    const plan = item.decisionPlan || {};
    const brief = row ? (row.decisionBrief || decisionBriefVerdictForRow(row)) : null;
    const startPrice = row?.metrics?.price ?? null;
    const entry = {
      id: `${item.ticker}-${String(generatedAt).slice(0, 10).replace(/-/g, "")}`,
      ticker: item.ticker,
      name: item.name || row?.name || "",
      firstSeen: generatedAt,
      lastSeen: generatedAt,
      ageDays: 0,
      startPrice,
      currentPrice: startPrice,
      returnPct: 0,
      return5d: null,
      return20d: null,
      return60d: null,
      startVerdict: plan.verdict || null,
      startLabel: plan.label || item.label || null,
      startBriefVerdict: brief?.briefVerdict ?? null,
      startBriefLabel: brief?.briefLabel ?? null,
      startBriefConfidence: brief?.confidence ?? null,
      startBriefConfidenceScore: brief?.confidenceScore ?? null,
      currentBriefVerdict: brief?.briefVerdict ?? null,
      currentBriefLabel: brief?.briefLabel ?? null,
      currentBriefConfidence: brief?.confidence ?? null,
      currentBriefConfidenceScore: brief?.confidenceScore ?? null,
      briefReason: brief?.briefReason ?? null,
      briefNextStep: brief?.briefNextStep ?? null,
      registrySource: "todayQueue",
      currentDecision: row?.decisionEngine?.label || null,
      bucket: item.bucket,
      opportunityScore: item.total ?? null,
      todayWeight: item.todayWeight ?? null,
      priority: item.priority || null,
      themes: item.themes || row?.themes || [],
      trigger: plan.triggers?.[0] || null,
      riskGuards: plan.riskGuards || [],
      readFirst: plan.readFirst || [],
      status: "OPEN"
    };
    items.push(entry);
    activeByTicker.set(entry.ticker, entry);
  }

  for (const item of decisionBriefRegistryRows(rows)) {
    const row = item.row;
    if (!row?.ticker || activeByTicker.has(row.ticker)) continue;
    const brief = item.brief;
    const startPrice = row.metrics?.price ?? null;
    const entry = {
      id: `${row.ticker}-${String(generatedAt).slice(0, 10).replace(/-/g, "")}`,
      ticker: row.ticker,
      name: row.name || "",
      firstSeen: generatedAt,
      lastSeen: generatedAt,
      ageDays: 0,
      startPrice,
      currentPrice: startPrice,
      returnPct: 0,
      return5d: null,
      return20d: null,
      return60d: null,
      startVerdict: row.decisionEngine?.category || null,
      startLabel: row.decisionEngine?.label || brief.briefLabel,
      startBriefVerdict: brief.briefVerdict,
      startBriefLabel: brief.briefLabel,
      startBriefConfidence: brief.confidence,
      startBriefConfidenceScore: brief.confidenceScore,
      currentBriefVerdict: brief.briefVerdict,
      currentBriefLabel: brief.briefLabel,
      currentBriefConfidence: brief.confidence,
      currentBriefConfidenceScore: brief.confidenceScore,
      briefReason: brief.briefReason,
      briefNextStep: brief.briefNextStep,
      registrySource: "decisionBrief",
      currentDecision: row.decisionEngine?.label || null,
      bucket: "decisionBrief",
      opportunityScore: row.researchScore?.total ?? null,
      todayWeight: item.weight,
      priority: row.decisionEngine?.priority || null,
      themes: row.themes || [],
      trigger: row.decisionEngine?.nextStep || null,
      riskGuards: row.decisionEngine?.blockers || row.investmentVerdict?.blockers || [],
      readFirst: row.secAnalysis?.filingBrief?.decisionBrief?.readSections || [],
      status: "OPEN"
    };
    items.push(entry);
    activeByTicker.set(entry.ticker, entry);
  }

  function aggregate(entries, returnField = "returnPct") {
    const values = entries.map((entry) => entry[returnField]).filter(Number.isFinite);
    const winners = values.filter((value) => value > 0).length;
    return {
      count: entries.length,
      avgReturn: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      winRate: values.length ? (winners / values.length) * 100 : null
    };
  }

  const byWindow = {
    "5d": aggregate(items.filter((entry) => Number.isFinite(entry.return5d)), "return5d"),
    "20d": aggregate(items.filter((entry) => Number.isFinite(entry.return20d)), "return20d"),
    "60d": aggregate(items.filter((entry) => Number.isFinite(entry.return60d)), "return60d")
  };

  const byVerdict = [...new Set(items.map((entry) => entry.startVerdict).filter(Boolean))]
    .map((verdict) => ({ verdict, ...aggregate(items.filter((entry) => entry.startVerdict === verdict)) }))
    .sort((a, b) => (b.avgReturn ?? -999) - (a.avgReturn ?? -999) || b.count - a.count);

  const byBriefVerdict = [...new Set(items.map((entry) => entry.startBriefVerdict).filter(Boolean))]
    .map((verdict) => ({ verdict, ...aggregate(items.filter((entry) => entry.startBriefVerdict === verdict)) }))
    .sort((a, b) => (b.avgReturn ?? -999) - (a.avgReturn ?? -999) || b.count - a.count);

  const byBriefConfidence = ["high", "medium", "low"]
    .map((confidence) => ({
      confidence,
      ...aggregate(items.filter((entry) => entry.startBriefConfidence === confidence)),
      avgConfidenceScore: (() => {
        const values = items
          .filter((entry) => entry.startBriefConfidence === confidence)
          .map((entry) => entry.startBriefConfidenceScore)
          .filter(Number.isFinite);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      })()
    }))
    .filter((item) => item.count);

  const maturedForReview = items
    .filter((entry) => Number.isFinite(entry.return5d))
    .map((entry) => ({ ...entry, reviewReturn: entry.return5d }))
    .sort((a, b) => Math.abs(b.reviewReturn || 0) - Math.abs(a.reviewReturn || 0));
  const decisionLearning = {
    sampleStatus: maturedForReview.length ? "ACTIVE" : "TOO_EARLY",
    winners: maturedForReview
      .filter((entry) => (entry.reviewReturn || 0) > 0)
      .sort((a, b) => (b.reviewReturn || 0) - (a.reviewReturn || 0))
      .slice(0, 8),
    losers: maturedForReview
      .filter((entry) => (entry.reviewReturn || 0) < 0)
      .sort((a, b) => (a.reviewReturn || 0) - (b.reviewReturn || 0))
      .slice(0, 8),
    candidateFailures: maturedForReview
      .filter((entry) => entry.startBriefVerdict === "KANDYDAT" && (entry.reviewReturn || 0) <= -5)
      .sort((a, b) => (a.reviewReturn || 0) - (b.reviewReturn || 0))
      .slice(0, 8),
    missedUpside: maturedForReview
      .filter((entry) => ["WSTRZYMAJ", "ODRZUC"].includes(entry.startBriefVerdict) && (entry.reviewReturn || 0) >= 5)
      .sort((a, b) => (b.reviewReturn || 0) - (a.reviewReturn || 0))
      .slice(0, 8),
    calibrationNotes: [
      byBriefVerdict.find((item) => item.verdict === "KANDYDAT" && item.count >= 5 && Number.isFinite(item.avgReturn) && item.avgReturn < 0)
        ? "KANDYDAT ma ujemna srednia: zaostrz kryteria wejscia albo dodaj filtr momentum."
        : null,
      byBriefVerdict.find((item) => item.verdict === "WSTRZYMAJ" && item.count >= 5 && Number.isFinite(item.avgReturn) && item.avgReturn > 3)
        ? "WSTRZYMAJ odbija mocniej niz oczekiwano: sprawdz, czy filtr ryzyka nie jest zbyt konserwatywny."
        : null,
      byBriefVerdict.find((item) => item.verdict === "ODRZUC" && item.count >= 5 && Number.isFinite(item.avgReturn) && item.avgReturn > 3)
        ? "ODRZUC generuje dodatni zwrot: trzeba rozdzielic ryzyko fundamentalne od setupu spekulacyjnego."
        : null,
      byBriefConfidence.find((item) => item.confidence === "high" && item.count >= 8 && Number.isFinite(item.avgReturn) && item.avgReturn < 0)
        ? "HIGH confidence ma ujemna srednia: obniz wagi albo dodaj filtr ceny przed eskalacja."
        : null,
      byBriefConfidence.find((item) => item.confidence === "low" && item.count >= 8 && Number.isFinite(item.avgReturn) && item.avgReturn > 3)
        ? "LOW confidence odbija ponad oczekiwania: sprawdz, czy system nie ignoruje setupow spekulacyjnych."
        : null,
      items.some((entry) => (entry.ageDays ?? 0) >= 5)
        ? null
        : "Za malo historii: poczekaj na pierwsze sygnaly 5d przed zmiana wag."
    ].filter(Boolean)
  };

  return {
    generatedAt,
    total: items.length,
    open: items.filter((entry) => entry.status === "OPEN").length,
    matured5d: byWindow["5d"].count,
    matured20d: byWindow["20d"].count,
    matured60d: byWindow["60d"].count,
    byWindow,
    byVerdict,
    byBriefVerdict,
    byBriefConfidence,
    decisionLearning,
    items: items
      .sort((a, b) => new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime() || (b.opportunityScore || 0) - (a.opportunityScore || 0))
      .slice(0, 600)
  };
}

function buildResearchPriorityQueue(rows, decisionPackages, todayDecisionQueue, limit = 20) {
  const packageTickers = new Set((decisionPackages?.items || []).map((item) => item.ticker));
  const todayTickers = new Set((todayDecisionQueue?.items || []).map((item) => item.ticker));
  const bucketRank = { "WEJSCIE TERAZ": 60, CZEKAJ: 24, ODRZUC: 42, "BRAK WYSTARCZAJACYCH DANYCH": 34 };
  const taskLabel = {
    READ_FILING: "Przeczytaj filing",
    DECISION_PACK: "Pakiet decyzyjny",
    RISK_REVIEW: "Wyjasnij czerwone ryzyko",
    DATA_GAP: "Uzupelnij brakujace dane",
    TURNAROUND_CHECK: "Sprawdz odbicie",
    MONITOR_TRIGGER: "Czekaj na trigger"
  };

  function taskFor(row, canonical) {
    if (row.sec?.newFilings?.length || row.secAnalysis?.filingBrief?.urgency === "high") return "READ_FILING";
    if (canonical.label === "WEJSCIE TERAZ") return "DECISION_PACK";
    if (canonical.label === "BRAK WYSTARCZAJACYCH DANYCH") return "DATA_GAP";
    if (canonical.label === "ODRZUC" || row.signal?.action === "REVIEW_RISK") return "RISK_REVIEW";
    if ((row.metrics?.drawdown52w ?? 0) <= -20 && (row.reboundScore?.total ?? 0) >= 55) return "TURNAROUND_CHECK";
    return "MONITOR_TRIGGER";
  }

  return (rows || [])
    .map((row) => {
      const canonical = row.concreteVerdict || buildConcreteVerdict(row);
      const scores = canonical.scores || {};
      const task = taskFor(row, canonical);
      const priorityScore = Math.round(
        (scores.attractiveness ?? row.researchScore?.total ?? 0)
        + (scores.readiness ?? 0) * 0.45
        + (scores.risk ?? 0) * (canonical.action === "ODRZUC" ? 0.2 : 0.05)
        + (bucketRank[canonical.label] || 0)
        + (packageTickers.has(row.ticker) ? 35 : 0)
        + (todayTickers.has(row.ticker) ? 25 : 0)
        + (row.sec?.newFilings?.length ? 22 : 0)
        + (row.secAnalysis?.filingBrief?.urgency === "high" ? 18 : 0)
        + ((row.metrics?.drawdown52w ?? 0) <= -20 ? 8 : 0)
      );
      return {
        ticker: row.ticker,
        name: row.name || "",
        task,
        taskLabel: taskLabel[task],
        verdict: canonical.action,
        label: canonical.label,
        confidence: canonical.confidence,
        confidenceScore: canonical.confidenceScore,
        scores,
        priorityScore,
        priority: row.decisionEngine?.priority || null,
        action: row.signal?.action || null,
        reason: canonical.reason,
        nextStep: canonical.nextStep,
        latestFiling: row.sec?.newFilings?.[0] || row.sec?.filings?.[0] || null,
        metrics: {
          drawdown52w: row.metrics?.drawdown52w ?? null,
          return20d: row.metrics?.return20d ?? null,
          return60d: row.metrics?.return60d ?? null
        },
        riskGuards: row.decisionEngine?.blockers || row.investmentVerdict?.blockers || []
      };
    })
    .filter((item) => item.ticker)
    .sort((a, b) => b.priorityScore - a.priorityScore || (b.score || 0) - (a.score || 0))
    .slice(0, limit)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function buildAlerts(snapshot) {
  const onlyActions = new Set(config.notifications?.only_actions || []);
  return snapshot.rows
    .filter((row) => row.signal?.alerts?.length || onlyActions.has(row.signal?.action) || row.historyDelta?.actionChanged || row.historyDelta?.decisionChanged || row.catalystAssessment?.urgency === "high" || Math.abs(row.catalystAssessment?.score || 0) >= 6)
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
      catalystAssessment: row.catalystAssessment || null,
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
  const events = snapshot.upcomingEvents || [];

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
    `- FMP catalyst requests: ${snapshot.catalystCoverage?.requestsUsed ?? 0}`,
    `- Catalyst detail rotation: ${snapshot.catalystCoverage?.detailPlan?.prioritySlots ?? 0} priority + ${snapshot.catalystCoverage?.detailPlan?.rotationSlots ?? 0} rotation; today ${snapshot.catalystCoverage?.detailPlan?.selectedSymbols?.join(", ") || "-"}`,
    `- Catalyst coverage: ${snapshot.catalystCoverage?.detailCoverage ?? 0}/${rows.length} details, ${snapshot.catalystCoverage?.calendarCoverage ?? 0}/${rows.length} calendar, ${snapshot.catalystCoverage?.newsCoverage ?? 0}/${rows.length} news`,
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
  const filingDecision = row.secAnalysis?.filingBrief?.decisionBrief || null;
  const action = row.signal?.action || "MONITOR";
  const decision = row.decision?.status || "";
  const alerts = row.signal?.alerts || [];
  const metrics = row.metrics || {};
  const fundamentals = row.fundamentals || {};
  const catalyst = row.catalystAssessment || {};
  const reasons = [];
  const blockers = [];

  if (filingVerdict) {
    if (filingVerdict.label === "pozytywny filing") reasons.push(`filing pozytywny: ${filingVerdict.positives.slice(0, 2).map((item) => item.keyword).join(", ")}`);
    if (filingVerdict.criticalRisks?.length) blockers.push(`krytyczne ryzyko w filing: ${filingVerdict.criticalRisks.slice(0, 2).map((item) => item.keyword).join(", ")}`);
    else if (filingVerdict.label === "filing z ryzykami" || filingVerdict.label === "negatywny filing") blockers.push(`filing ma ryzyka: ${filingVerdict.risks.slice(0, 2).map((item) => item.keyword).join(", ")}`);
    if (row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === "DILUTION" && event.severity === "high")) blockers.push("filing sugeruje mozliwe rozwodnienie");
    if (row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === "BANKRUPTCY_OR_LISTING" && event.severity === "high")) blockers.push("filing sugeruje ryzyko bankructwa/delistingu");
  }
  if (filingDecision?.verdict === "AVOID_NOW") blockers.unshift(`SEC: ${filingDecision.label || "potwierdzone wysokie ryzyko"}`);
  else if (filingDecision?.verdict === "WAIT") blockers.push(`SEC: ${filingDecision.label || "wymaga wyjasnienia"}`);
  if (score >= 80) reasons.push(`wysoki score researchowy ${score}`);
  if (catalyst.score >= 6 && catalyst.positives?.length) reasons.push(`katalizatory: ${catalyst.positives[0]}`);
  if (catalyst.score <= -6 && catalyst.risks?.length) blockers.push(`negatywne katalizatory: ${catalyst.risks[0]}`);
  if (catalyst.nextEvent?.type === "earnings" && Number.isFinite(catalyst.daysToEvent) && catalyst.daysToEvent <= 3) {
    blockers.push(`wyniki za ${catalyst.daysToEvent} dni - ocen po publikacji`);
  }
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
  if (filingDecision?.verdict === "AVOID_NOW" || blockers.some((item) => /brak kompletnych danych|krytyczne ryzyko|DO_NOT_CHASE/i.test(item))) {
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

function hasFilingEvent(row, type, severity = null) {
  return row.secAnalysis?.filingBrief?.eventTypes?.some((event) => event.type === type && (!severity || event.severity === severity));
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
  const catalyst = row.catalystAssessment || {};

  if (hasFilingEvent(row, "LIQUIDITY_RISK", "high")) blockers.add("SEC: ryzyko plynnosci / going concern");
  if (hasFilingEvent(row, "DILUTION", "high")) blockers.add("SEC: emisja lub mozliwe rozwodnienie");
  if (hasFilingEvent(row, "BANKRUPTCY_OR_LISTING", "high")) blockers.add("SEC: bankructwo, delisting albo zgodnosc z gielda");
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
  if (catalyst.score >= 6 && catalyst.positives?.[0]) reasons.add(`katalizator: ${catalyst.positives[0]}`);
  if (catalyst.score <= -6 && catalyst.risks?.[0]) blockers.add(`katalizator: ${catalyst.risks[0]}`);

  const redFlags = [...blockers].filter((item) => /going concern|plynnosci|rozwodnienie|bankructwo|delisting|brak danych/i.test(item));
  const binaryCatalyst = catalyst.nextEvent?.type === "earnings" && Number.isFinite(catalyst.daysToEvent) && catalyst.daysToEvent <= 3;
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
  } else if (binaryCatalyst) {
    category = "CZEKAC";
    label = "CZEKAC NA WYNIKI";
    priority = "P1";
    confidence = "high";
    nextStep = `Wyniki za ${catalyst.daysToEvent} dni. Ocen przychody, EPS, marze i guidance po publikacji; nie otwieraj decyzji przed zdarzeniem.`;
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
      filingUrgency,
      binaryCatalyst,
      catalystUrgency: catalyst.urgency || "low",
      catalystScore: catalyst.score ?? 0
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
  const timeline = [...(previousHistory || []), { generatedAt, rows: historyRowsFromSnapshot({ rows }) }]
    .filter((entry) => Number.isFinite(new Date(entry?.generatedAt).getTime()) && Array.isArray(entry?.rows))
    .sort((a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime());
  const timelineWithMaps = timeline.map((entry) => ({
    ...entry,
    rowsByTicker: new Map(entry.rows.map((row) => [row.ticker, row]))
  }));

  function milestoneReturn(ticker, signalDate, startPrice, window) {
    const target = new Date(signalDate).getTime() + window * 86400000;
    const milestone = timelineWithMaps.find((entry) => new Date(entry.generatedAt).getTime() >= target && Number.isFinite(Number(entry.rowsByTicker.get(ticker)?.price)));
    const milestonePrice = Number(milestone?.rowsByTicker.get(ticker)?.price);
    return Number.isFinite(milestonePrice) && startPrice > 0 ? pctChange(milestonePrice, startPrice) : null;
  }
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
        return5d: milestoneReturn(historic.ticker, entry.generatedAt, startPrice, 5),
        return20d: milestoneReturn(historic.ticker, entry.generatedAt, startPrice, 20),
        return60d: milestoneReturn(historic.ticker, entry.generatedAt, startPrice, 60),
        startScore: historic.researchScore,
        currentScore: current.researchScore?.total ?? null,
        themes: historic.themes?.length ? historic.themes : current.themes || []
      });
    }
  }

  function aggregate(items, returnField = "returnPct") {
    const returns = items.map((item) => item[returnField]).filter(Number.isFinite);
    const winners = returns.filter((value) => value > 0).length;
    const avgReturn = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
    return { count: items.length, avgReturn, winRate: returns.length ? (winners / returns.length) * 100 : null };
  }

  const byCategory = categories.map((category) => {
    const categorySignals = signals.filter((item) => item.category === category);
    const result = { category, active: categorySignals.length };
    for (const window of windows) {
      const field = `return${window}d`;
      result[`${window}d`] = aggregate(categorySignals.filter((item) => Number.isFinite(item[field])), field);
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
    .map(([theme, items]) => ({ theme, active: items.length, result20d: aggregate(items.filter((item) => Number.isFinite(item.return20d)), "return20d") }))
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
  const secEarningsReleaseCache = loadJsonFile(secEarningsReleaseCachePath, {});
  let previousSecState = loadSecState();
  const previousPublishedSnapshot = await fetchPreviousPublishedSnapshot();
  const previousFundamentalsByTicker = new Map((previousPublishedSnapshot?.rows || [])
    .filter((row) => row.fundamentals)
    .map((row) => [row.ticker, row.fundamentals]));
  const previousRowsByTicker = new Map((previousPublishedSnapshot?.rows || []).map((row) => [row.ticker, row]));
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
  const previousDecisionRegistry = await loadPreviousDecisionRegistry();
  const previousVerdictLedger = await loadPreviousVerdictLedger();
  const secAnalysisLimit = Number.isFinite(Number(runtime.max_sec_analysis_per_run))
    ? Number(runtime.max_sec_analysis_per_run)
    : 40;
  let secAnalysesUsed = 0;
  const fmpDeepPlan = buildFmpDeepPlan(config.watchlist, previousFundamentalsByTicker);
  const fmpDeepSymbols = new Set(fmpDeepPlan.selectedSymbols);
  const fmpCatalystPlan = buildFmpCatalystPlan(config.watchlist, previousPublishedSnapshot);
  const fmpCatalystSources = await fetchFmpCatalystSources(config.watchlist, fmpCatalystPlan);

  let benchmarkPrices = [];
  try {
    benchmarkPrices = await fetchYahoo("SPY");
  } catch (error) {
    console.log(`Benchmark SPY failed: ${error.message}`);
  }
  const priceSeriesByTicker = new Map();
  const rows = [];
  for (const item of config.watchlist) {
    process.stdout.write(`Fetching ${item.ticker} (${item.yahoo || item.stooq})... `);
    try {
      const prices = await fetchYahoo(item.yahoo || item.ticker);
      priceSeriesByTicker.set(item.ticker, prices);
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
        postEarnings: null,
        signal: { ...signal, alerts: [...signal.alerts, ...fundamentalAlerts] },
        error: null
      });
      const currentRow = rows[rows.length - 1];
      currentRow.catalysts = buildRowCatalysts(item, fmpCatalystSources, previousRowsByTicker.get(item.ticker));
      currentRow.catalystAssessment = buildCatalystAssessment(currentRow, previousRowsByTicker.get(item.ticker));
      currentRow.signal.alerts = [...new Set([...currentRow.signal.alerts, ...catalystSignalAlerts(currentRow.catalystAssessment)])];
      currentRow.researchScore = buildResearchScore(currentRow);
      console.log("ok");
    } catch (error) {
      const previousRow = previousRowsByTicker.get(item.ticker);
      rows.push(previousRow?.metrics?.price ? {
        ...previousRow,
        ...item,
        staleData: true,
        signal: {
          ...(previousRow.signal || {}),
          alerts: [...new Set([...(previousRow.signal?.alerts || []), "Fetch failed; using previous published data"])]
        },
        error: error.message
      } : {
        ...item,
        metrics: {},
        fundamentals: null,
        fundamentalsProvider: null,
        fundamentalsError: null,
        sec: { cik: null, filings: [], error: null },
        secAnalysis: null,
        postEarnings: null,
        staleData: false,
        signal: { action: "NO_DATA", alerts: ["Fetch failed"] },
        error: error.message
      });
      const currentRow = rows[rows.length - 1];
      currentRow.catalysts = buildRowCatalysts(item, fmpCatalystSources, previousRowsByTicker.get(item.ticker));
      currentRow.catalystAssessment = buildCatalystAssessment(currentRow, previousRowsByTicker.get(item.ticker));
      currentRow.signal.alerts = [...new Set([...currentRow.signal.alerts, ...catalystSignalAlerts(currentRow.catalystAssessment)])];
      currentRow.researchScore = buildResearchScore(currentRow);
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

  const postEarningsLimit = Math.max(0, Number(runtime.max_post_earnings_per_run ?? 20));
  const postEarningsCandidates = rows
    .map((row) => {
      const result = recentEarningsResult(row, 7);
      const filing = findEarningsFiling(row, result);
      return result ? { row, result, filing } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.result.ageDays - b.result.ageDays
      || (b.row.status === "CORE") - (a.row.status === "CORE")
      || (b.row.researchScore?.total || 0) - (a.row.researchScore?.total || 0));
  let postEarningsAnalyzed = 0;
  let postEarningsErrors = 0;
  let postEarningsPending = 0;
  for (const [index, candidate] of postEarningsCandidates.entries()) {
    const { row, result, filing } = candidate;
    const previousPost = previousRowsByTicker.get(row.ticker)?.postEarnings;
    if (previousPost?.result?.date === result.date && previousPost.status === "ANALYZED" && previousPost.release?.document?.url) {
      row.postEarnings = previousPost;
      postEarningsAnalyzed += 1;
      continue;
    }
    if (index >= postEarningsLimit || !filing) {
      row.postEarnings = buildPostEarningsAssessment(row, result, null, true);
      postEarningsPending += 1;
      continue;
    }
    const release = await fetchSecEarningsRelease(row, filing, secEarningsReleaseCache);
    row.postEarnings = buildPostEarningsAssessment(row, result, release);
    if (row.postEarnings?.status === "ANALYZED") postEarningsAnalyzed += 1;
    else if (release?.status === "ERROR") postEarningsErrors += 1;
    else postEarningsPending += 1;
  }
  fs.writeFileSync(secEarningsReleaseCachePath, JSON.stringify(secEarningsReleaseCache, null, 2));

  for (const row of rows) {
    row.researchScore = buildResearchScore(row);
    row.reboundScore = buildReboundScore(row);
    row.decision = inferDecision(row);
    row.investmentVerdict = buildInvestmentVerdict(row);
  }
  applyHistoryDeltas(rows, previousHistory);
  for (const row of rows) {
    row.decisionEngine = buildDecisionEngine(row);
    row.decisionBrief = decisionBriefVerdictForRow(row);
    row.concreteVerdict = buildConcreteVerdict(row);
  }

  const generatedAt = new Date().toISOString();
  const verdictLedger = buildVerdictLedger(
    previousVerdictLedger,
    rows,
    priceSeriesByTicker,
    benchmarkPrices,
    generatedAt,
    {
      benchmarkSymbol: "SPY",
      initialCapital: Number(runtime.paper_portfolio_initial_capital ?? 100000),
      maxPositions: Number(runtime.paper_portfolio_max_positions ?? 10),
      maxPositionPct: Number(runtime.paper_max_position_pct ?? 10),
      maxPrimaryThemePct: Number(runtime.paper_max_primary_theme_pct ?? 20),
      maxPositionsPerTheme: Number(runtime.paper_max_positions_per_theme ?? 2),
      maxGapPct: Number(runtime.paper_max_gap_pct ?? 3),
      targetRiskPct: Number(runtime.paper_target_risk_per_position_pct ?? 0.75),
      minPositionPct: Number(runtime.paper_min_position_pct ?? 2),
      reviewSessions: Number(runtime.paper_review_sessions ?? 20),
      stopMinPct: Number(runtime.paper_stop_min_pct ?? 5),
      stopMaxPct: Number(runtime.paper_stop_max_pct ?? 12)
    }
  );
  const actionQueue = buildActionQueue(rows);
  const triageQueue = buildTriageQueue(actionQueue);
  const opportunityRanking = buildOpportunityRanking(rows);
  const todayDecisionQueue = buildTodayDecisionQueue(opportunityRanking);
  const todayDecisionChanges = buildTodayDecisionChanges(previousPublishedSnapshot?.todayDecisionQueue, todayDecisionQueue, generatedAt);
  const decisionPackages = buildDecisionPackages(todayDecisionQueue, rows, generatedAt);
  const decisionRegistry = buildDecisionRegistry(previousDecisionRegistry, todayDecisionQueue, rows, generatedAt);
  const researchPriorityQueue = buildResearchPriorityQueue(rows, decisionPackages, todayDecisionQueue);
  const quality = buildSnapshotQuality(rows, config.watchlist.length);
  if (quality.status === "FAIL") {
    throw new Error(`Snapshot quality gate failed: ${quality.errors.join("; ")}`);
  }
  const snapshot = {
    generatedAt,
    source: "Yahoo Chart daily prices",
    rules,
    upcomingEvents: mergeUpcomingEvents(rows, 30),
    fmpCoverage: buildFmpCoverage(rows, fmpDeepPlan),
    catalystCoverage: buildCatalystCoverage(rows, fmpCatalystSources, fmpCatalystPlan),
    postEarningsCoverage: {
      limit: postEarningsLimit,
      candidates: postEarningsCandidates.length,
      analyzed: postEarningsAnalyzed,
      pending: postEarningsPending,
      errors: postEarningsErrors,
      secRequestsUsed: secEarningsReleaseRequests
    },
    quality,
    signalPerformance: buildSignalPerformance(rows, previousHistory, generatedAt),
    verdictPerformance: verdictLedger.summary,
    actionQueue,
    triageQueue,
    opportunityRanking,
    todayDecisionQueue,
    todayDecisionChanges,
    decisionPackages,
    decisionRegistry,
    researchPriorityQueue,
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
  fs.writeFileSync(todayDecisionQueuePath, JSON.stringify(snapshot.todayDecisionQueue, null, 2));
  fs.writeFileSync(todayDecisionChangesPath, JSON.stringify(snapshot.todayDecisionChanges, null, 2));
  fs.writeFileSync(decisionPackagesPath, JSON.stringify(snapshot.decisionPackages, null, 2));
  fs.writeFileSync(decisionRegistryPath, JSON.stringify(snapshot.decisionRegistry, null, 2));
  fs.writeFileSync(verdictLedgerPath, JSON.stringify(verdictLedger, null, 2));
  fs.writeFileSync(researchPriorityQueuePath, JSON.stringify(snapshot.researchPriorityQueue, null, 2));
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

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildCanonicalDataQuality,
  buildCanonicalEntrySetup,
  buildConcreteVerdict,
  buildResearchPriorityQueue,
  canonicalDecisionScores,
  firstNumber
};

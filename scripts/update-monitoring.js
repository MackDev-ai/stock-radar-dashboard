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
  const response = await fetch(`https://financialmodelingprep.com${pathname}?${query.toString()}`, {
    headers: {
      "user-agent": "local-monitoring-dashboard/1.0",
      "apikey": key
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
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
  const cik = item.sec_cik ? String(item.sec_cik).padStart(10, "0") : findCik(tickerMap, item.yahoo || item.ticker);
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
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
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
    "default",
    "breach of covenant",
    "impairment",
    "restructuring",
    "dilution",
    "at-the-market",
    "securities offering",
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
    "chapter 11",
    "delisting",
    "notice of noncompliance",
    "material definitive agreement",
    "creation of a direct financial obligation"
  ];
  const criticalRiskKeywords = [
    "substantial doubt",
    "going concern",
    "identified a material weakness",
    "material weakness in internal control",
    "breach of covenant",
    "notice of noncompliance",
    "filed for bankruptcy",
    "chapter 11",
    "delisting",
    "material cybersecurity incident"
  ];

  const positives = keywordHits(text, positiveKeywords).slice(0, 5);
  const risks = keywordHits(text, riskKeywords).slice(0, 7);
  const eventRisks = filing?.form === "8-K" || filing?.form === "6-K" ? keywordHits(text, eventRiskKeywords).slice(0, 5) : [];
  const criticalRisks = keywordHits(text, criticalRiskKeywords).slice(0, 5);
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
    action = "warto przejsc do deep dive";
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

    return {
      analyzedAt: new Date().toISOString(),
      filing: {
        form: filing.form,
        filingDate: filing.filingDate,
        url: filing.url
      },
      documentChars: text.length,
      filingVerdict: analyzeFilingVerdict(text, filing),
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

async function fetchFmpFundamentals(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { enabled: false, data: null, error: null };

  const fmpSymbol = symbol;
  const cache = loadJsonFile(fmpProfileCachePath, {});
  const cached = cache[fmpSymbol];
  const maxAgeMs = (config.data_providers?.fmp_profile_cache_days || 7) * 24 * 60 * 60 * 1000;
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < maxAgeMs) {
    return { enabled: true, data: cached.data, error: null, cached: true };
  }

  try {
    const profileRows = await fetchFmpJson("/stable/profile", { symbol: fmpSymbol });
    const profile = Array.isArray(profileRows) ? profileRows[0] : profileRows;
    if (!profile?.symbol) throw new Error("No FMP profile data");

    const data = {
      symbol: profile.symbol,
      companyName: profile.companyName,
      price: firstNumber(profile.price),
      marketCap: firstNumber(profile.marketCap),
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
      source: "FMP profile"
    };
    cache[fmpSymbol] = { fetchedAt: new Date().toISOString(), data };
    saveJsonFile(fmpProfileCachePath, cache);

    return { enabled: true, data, error: null, cached: false };
  } catch (error) {
    return { enabled: true, data: null, error: error.message };
  }
}

async function fetchFundamentals(item) {
  const manual = manualFundamentals.get(item.ticker.toUpperCase());
  if (manual) return { enabled: true, provider: "manual", data: manual, error: null };
  const fmp = await fetchFmpFundamentals(item.fmp_symbol || item.yahoo || item.ticker);
  return { ...fmp, provider: "fmp" };
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
  if (Number.isFinite(fundamentals.netDebtToEbitdaTTM) && fundamentals.netDebtToEbitdaTTM > rules.net_debt_ebitda_risk) {
    add("leverage", -8, `zadluzenie ${formatNumber(fundamentals.netDebtToEbitdaTTM, 1)}x EBITDA`);
  }
  if (Number.isFinite(fundamentals.operatingMarginTTM) && fundamentals.operatingMarginTTM >= 0.18) {
    add("margin", 5, `marza operacyjna ${formatPct(fundamentals.operatingMarginTTM * 100)}`);
  }
  if (Number.isFinite(fundamentals.revenueGrowthYoY) && fundamentals.revenueGrowthYoY >= 8) {
    add("growth", 6, `wzrost przychodow ${formatPct(fundamentals.revenueGrowthYoY)}`);
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
    price: row.metrics?.price ?? row.price ?? null,
    drawdown52w: row.metrics?.drawdown52w ?? row.drawdown52w ?? null,
    return20d: row.metrics?.return20d ?? row.return20d ?? null,
    peTTM: row.fundamentals?.peTTM ?? row.peTTM ?? null,
    evToEbitdaTTM: row.fundamentals?.evToEbitdaTTM ?? row.evToEbitdaTTM ?? null,
    researchScore: row.researchScore?.total ?? row.researchScore ?? null,
    reboundScore: row.reboundScore?.total ?? row.reboundScore ?? null,
    nextStep: row.researchScore?.nextStep ?? row.nextStep ?? null,
    decisionStatus: row.decision?.status ?? row.decisionStatus ?? null,
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
  const fundamentalRows = rows.filter((row) => row.fundamentals);
  const fundamentalErrors = rows.filter((row) => row.fundamentalsError);
  const fmpProfileRows = rows.filter((row) => row.fundamentalsProvider === "fmp" && row.fundamentals?.source === "FMP profile");
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
    `- FMP profile loaded: ${fmpProfileRows.length}/${rows.length}`,
    `- Full fundamentals loaded: ${fundamentalRows.filter((row) => Number.isFinite(row.fundamentals?.peTTM)).length}/${rows.length}`,
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
    label = "Kandydat do inwestycji po deep dive";
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
      riskScore: filingVerdict.riskScore
    } : null
  };
}

async function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  let previousSecState = loadSecState();
  if (!Object.keys(previousSecState).length) {
    previousSecState = secStateFromSnapshot(await fetchPreviousPublishedSnapshot());
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

  const rows = [];
  for (const item of config.watchlist) {
    process.stdout.write(`Fetching ${item.ticker} (${item.yahoo || item.stooq})... `);
    try {
      const prices = await fetchYahoo(item.yahoo || item.ticker);
      const metrics = computeMetrics(prices);
      const signal = classify(metrics, item);
      const fundamentals = await fetchFundamentals(item);
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

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "Yahoo Chart daily prices",
    rules,
    upcomingEvents: upcomingEvents(30),
    rows
  };

  const alerts = buildAlerts(snapshot);

  const historyEntry = {
    generatedAt: snapshot.generatedAt,
    rows: historyRowsFromSnapshot(snapshot)
  };

  const history = [...previousHistory, historyEntry].slice(-180);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
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

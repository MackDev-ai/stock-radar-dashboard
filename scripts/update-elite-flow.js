const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const monitoringDataPath = path.join(dataDir, "monitoring-data.js");
const outputPath = path.join(dataDir, "elite-flow-data.js");
const statePath = path.join(dataDir, "elite-flow-state.json");
const reportPath = path.join(root, "elite-flow-report.md");
const politicalTradesPath = path.join(root, "political-trades.csv");

const secUserAgent = "local-monitoring-pipeline contact@example.com";
const lookbackDays = 120;
const maxForm4PerTicker = 3;
const secDelayMs = 250;

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] || ""]));
  });
}

function loadMonitoringData() {
  const raw = fs.readFileSync(monitoringDataPath, "utf8");
  const json = raw.replace(/^window\.MONITORING_DATA\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(json);
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url) {
  await sleep(secDelayMs);
  const response = await fetch(url, {
    headers: {
      "user-agent": secUserAgent,
      "accept": "application/json"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (/Traffic Limit|Request Rate Threshold/i.test(text)) throw new Error("SEC rate limit");
  return JSON.parse(text);
}

async function fetchText(url) {
  await sleep(secDelayMs);
  const response = await fetch(url, {
    headers: {
      "user-agent": secUserAgent,
      "accept": "application/xml,text/xml,text/plain,text/html"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (/Traffic Limit|Request Rate Threshold/i.test(text)) throw new Error("SEC rate limit");
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? cleanXml(match[1]) : "";
}

function cleanXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function num(value) {
  const n = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function blocks(xml, tagName) {
  return [...String(xml).matchAll(new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, "gi"))].map((m) => m[0]);
}

function parseOwnershipXml(xml) {
  const ownerBlocks = blocks(xml, "reportingOwner");
  const owners = ownerBlocks.map((block) => ({
    name: tag(block, "rptOwnerName"),
    cik: tag(block, "rptOwnerCik"),
    isDirector: tag(block, "isDirector") === "1",
    isOfficer: tag(block, "isOfficer") === "1",
    isTenPercentOwner: tag(block, "isTenPercentOwner") === "1",
    officerTitle: tag(block, "officerTitle")
  })).filter((owner) => owner.name);

  const transactions = [];
  for (const block of blocks(xml, "nonDerivativeTransaction")) {
    const code = tag(block, "transactionCode");
    const shares = num(tag(block, "transactionShares"));
    const price = num(tag(block, "transactionPricePerShare"));
    const acquiredDisposed = tag(block, "transactionAcquiredDisposedCode");
    transactions.push({
      securityTitle: tag(block, "securityTitle"),
      date: tag(block, "transactionDate"),
      code,
      acquiredDisposed,
      shares,
      price,
      value: Number.isFinite(shares) && Number.isFinite(price) ? shares * price : null,
      postShares: num(tag(block, "sharesOwnedFollowingTransaction")),
      directOrIndirect: tag(block, "directOrIndirectOwnership"),
      natureOfOwnership: tag(block, "natureOfOwnership")
    });
  }

  return {
    owners,
    transactions,
    issuer: {
      cik: tag(xml, "issuerCik"),
      name: tag(xml, "issuerName"),
      tradingSymbol: tag(xml, "issuerTradingSymbol")
    },
    remarks: tag(xml, "remarks")
  };
}

function rawOwnershipUrl(url) {
  return String(url).replace("/xslF345X06/", "/");
}

function isRelevantTransaction(tx) {
  return ["P", "S", "A", "M"].includes(tx.code);
}

function transactionLabel(code) {
  return {
    P: "INSIDER_BUY",
    S: "INSIDER_SELL",
    A: "AWARD_GRANT",
    M: "OPTION_EXERCISE"
  }[code] || code || "FORM4";
}

function scoreFiling(parsed, row) {
  let score = 0;
  const positives = [];
  const negatives = [];
  const txs = parsed.transactions.filter(isRelevantTransaction);
  const purchaseValue = txs.filter((tx) => tx.code === "P").reduce((sum, tx) => sum + (tx.value || 0), 0);
  const saleValue = txs.filter((tx) => tx.code === "S").reduce((sum, tx) => sum + (tx.value || 0), 0);
  const officers = parsed.owners.filter((owner) => owner.isOfficer || owner.isDirector);

  if (purchaseValue > 0) {
    score += purchaseValue >= 1_000_000 ? 35 : purchaseValue >= 100_000 ? 24 : 14;
    positives.push(`open market purchase ${formatMoney(purchaseValue)}`);
  }
  if (saleValue > 0) {
    score -= saleValue >= 5_000_000 ? 20 : saleValue >= 500_000 ? 12 : 5;
    negatives.push(`sale ${formatMoney(saleValue)}`);
  }
  if (officers.length) {
    score += 8;
    positives.push("director/officer involved");
  }
  if ((row.metrics?.drawdown52w ?? 0) <= -30 && purchaseValue > 0) {
    score += 15;
    positives.push(`purchase after drawdown ${formatPct(row.metrics.drawdown52w)}`);
  }
  if (row.status === "DISTRESSED" && purchaseValue > 0) {
    score += 10;
    positives.push("distressed insider support");
  }
  if (row.status === "DISTRESSED" && saleValue > purchaseValue) {
    score -= 10;
    negatives.push("distressed selling pressure");
  }

  return {
    score: Math.max(-50, Math.min(100, Math.round(score))),
    positives: positives.slice(0, 4),
    negatives: negatives.slice(0, 4),
    purchaseValue,
    saleValue
  };
}

function aggregateSignal(purchaseValue, saleValue, filingCount) {
  if (purchaseValue > 0 && saleValue > purchaseValue * 2) return "MIXED_WITH_BUY";
  if (purchaseValue > 0) return "INSIDER_BUY";
  if (saleValue > 0) return "INSIDER_SELL";
  return filingCount ? "FORM4_OTHER" : "NO_FLOW";
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function cutoffDate(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

async function fetchForm4ForRow(row) {
  const cik = row.sec?.cik || row.fundamentals?.cik;
  if (!cik) return { ticker: row.ticker, filings: [], error: "No CIK" };
  const cutoff = cutoffDate(lookbackDays);
  const submissions = await fetchJson(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`);
  const recent = submissions.filings?.recent || {};
  const filings = [];

  for (let i = 0; i < Math.min(120, recent.form?.length || 0); i++) {
    if (!["4", "4/A"].includes(recent.form[i])) continue;
    if (recent.filingDate[i] < cutoff) continue;
    const accession = recent.accessionNumber[i];
    const accessionCompact = String(accession).replace(/-/g, "");
    const primaryDocument = recent.primaryDocument[i];
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionCompact}/${primaryDocument}`;
    try {
      let xml = await fetchText(rawOwnershipUrl(url));
      let parsed = parseOwnershipXml(xml);
      if (!parsed.owners.length && !parsed.transactions.length && url.includes("/xslF345X06/")) {
        xml = await fetchText(url);
        parsed = parseOwnershipXml(xml);
      }
      const signal = scoreFiling(parsed, row);
      filings.push({
        ticker: row.ticker,
        name: row.name,
        status: row.status,
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate[i],
        form: recent.form[i],
        accessionNumber: accession,
        url,
        owners: parsed.owners,
        transactions: parsed.transactions.filter(isRelevantTransaction),
        signal
      });
    } catch (error) {
      filings.push({
        ticker: row.ticker,
        name: row.name,
        filingDate: recent.filingDate[i],
        form: recent.form[i],
        accessionNumber: accession,
        url,
        owners: [],
        transactions: [],
        signal: { score: 0, positives: [], negatives: [], purchaseValue: 0, saleValue: 0 },
        error: error.message
      });
    }
    if (filings.length >= maxForm4PerTicker) break;
  }

  return { ticker: row.ticker, filings, error: null };
}

function loadPoliticalTrades(rows) {
  if (!fs.existsSync(politicalTradesPath)) return [];
  const known = new Map(rows.map((row) => [String(row.ticker).toUpperCase(), row]));
  return parseCsv(fs.readFileSync(politicalTradesPath, "utf8"))
    .filter((row) => row.ticker)
    .map((trade) => {
      const ticker = String(trade.ticker || "").toUpperCase();
      const matched = known.get(ticker);
      return {
        date: trade.date,
        person: trade.person,
        role: trade.role,
        ticker,
        transaction: trade.transaction,
        amountRange: trade.amount_range,
        sourceUrl: trade.source_url,
        notes: trade.notes,
        matchedWatchlist: Boolean(matched),
        themes: matched?.themes || []
      };
    });
}

function summarizeTicker(row, form4) {
  const filings = form4.filter((filing) => filing.ticker === row.ticker);
  const txs = filings.flatMap((filing) => filing.transactions.map((tx) => ({ filing, tx })));
  const buys = txs.filter(({ tx }) => tx.code === "P");
  const sells = txs.filter(({ tx }) => tx.code === "S");
  const purchaseValue = buys.reduce((sum, { tx }) => sum + (tx.value || 0), 0);
  const saleValue = sells.reduce((sum, { tx }) => sum + (tx.value || 0), 0);
  const bestSignal = filings.slice().sort((a, b) => (b.signal?.score ?? 0) - (a.signal?.score ?? 0))[0] || null;
  const signal = aggregateSignal(purchaseValue, saleValue, filings.length);

  return {
    ticker: row.ticker,
    name: row.name,
    themes: row.themes || [],
    decision: row.decision || null,
    drawdown52w: row.metrics?.drawdown52w ?? null,
    signal,
    filingCount: filings.length,
    purchaseValue,
    saleValue,
    bestScore: bestSignal?.signal?.score ?? 0,
    bestFiling: bestSignal ? {
      filingDate: bestSignal.filingDate,
      form: bestSignal.form,
      url: bestSignal.url,
      owners: bestSignal.owners,
      transactions: bestSignal.transactions.slice(0, 5),
      positives: bestSignal.signal?.positives || [],
      negatives: bestSignal.signal?.negatives || []
    } : null
  };
}

function writeReport(snapshot, summaries, form4, politicalTrades, newFilings) {
  const top = summaries
    .filter((row) => row.signal !== "NO_FLOW")
    .sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0));
  const buyerRows = summaries
    .filter((row) => ["INSIDER_BUY", "MIXED_WITH_BUY"].includes(row.signal))
    .sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0));
  const sellerRows = summaries
    .filter((row) => row.signal === "INSIDER_SELL")
    .sort((a, b) => b.saleValue - a.saleValue);
  const lines = [
    "# Elite flow report",
    "",
    `Aktualizacja: ${snapshot.generatedAt}`,
    "",
    "Raport laczy SEC Form 4 insider transactions z recznie dopisywanymi transakcjami politycznymi. To sygnal pomocniczy, nie rekomendacja inwestycyjna.",
    "",
    "## Szybki odczyt",
    "",
    `- Watchlista: ${summaries.length} spolek`,
    `- Form 4 filings ${lookbackDays}d: ${form4.length}`,
    `- Nowe Form 4 vs poprzedni przebieg: ${newFilings.length}`,
    `- Reczne political trades: ${politicalTrades.length}`,
    ""
  ];

  lines.push("## Najmocniejsze sygnaly Form 4");
  lines.push("");
  if (!top.length) {
    lines.push("Brak Form 4 dla obserwowanych tickerow w aktualnym oknie.");
  } else {
    for (const row of top.slice(0, 15)) {
      const owners = row.bestFiling?.owners?.map((owner) => owner.officerTitle ? `${owner.name} (${owner.officerTitle})` : owner.name).join("; ") || "-";
      lines.push(`### ${row.ticker} - ${row.name}`);
      lines.push("");
      lines.push(`- Signal: ${row.signal}; score ${row.bestScore}`);
      lines.push(`- Purchase value: ${formatMoney(row.purchaseValue)}`);
      lines.push(`- Sale value: ${formatMoney(row.saleValue)}`);
      lines.push(`- Drawdown 52w: ${formatPct(row.drawdown52w)}`);
      lines.push(`- Owners: ${owners}`);
      lines.push(`- Plusy: ${row.bestFiling?.positives?.join("; ") || "-"}`);
      lines.push(`- Minusy: ${row.bestFiling?.negatives?.join("; ") || "-"}`);
      lines.push(`- Filing: ${row.bestFiling?.url || "-"}`);
      lines.push("");
    }
  }

  lines.push("## Zakupy insiderow do sprawdzenia");
  lines.push("");
  if (!buyerRows.length) {
    lines.push("Brak zakupow insiderow w aktualnym oknie.");
  } else {
    for (const row of buyerRows.slice(0, 12)) {
      lines.push(`- ${row.ticker}: ${row.signal}; buy ${formatMoney(row.purchaseValue)}, sell ${formatMoney(row.saleValue)}, drawdown ${formatPct(row.drawdown52w)}, score ${row.bestScore}`);
    }
  }

  lines.push("");
  lines.push("## Duze sprzedaze insiderow");
  lines.push("");
  if (!sellerRows.length) {
    lines.push("Brak sprzedazy insiderow w aktualnym oknie.");
  } else {
    for (const row of sellerRows.slice(0, 12)) {
      lines.push(`- ${row.ticker}: sell ${formatMoney(row.saleValue)}, drawdown ${formatPct(row.drawdown52w)}, latest ${row.bestFiling?.filingDate || "-"}`);
    }
  }

  lines.push("## Nowe Form 4");
  lines.push("");
  if (!newFilings.length) {
    lines.push("Brak nowych Form 4 wzgledem poprzedniego przebiegu.");
  } else {
    for (const filing of newFilings.slice(0, 30)) {
      lines.push(`- ${filing.ticker}: ${filing.form} ${filing.filingDate} - ${filing.url}`);
    }
  }

  lines.push("");
  lines.push("## Political trades reczne");
  lines.push("");
  if (!politicalTrades.length) {
    lines.push("Brak wpisow w `political-trades.csv`.");
  } else {
    for (const trade of politicalTrades) {
      lines.push(`- ${trade.date} ${trade.person} (${trade.role}) ${trade.transaction} ${trade.ticker} ${trade.amountRange}; matched=${trade.matchedWatchlist}; ${trade.sourceUrl || ""}`);
    }
  }

  lines.push("");
  lines.push("## Interpretacja");
  lines.push("");
  lines.push("- Najmocniejszy sygnal: insider open-market buy po duzym drawdownie i bez widocznego ryzyka emisji.");
  lines.push("- Slaby sygnal: award/grant, option exercise albo rutynowa sprzedaz bez kontekstu.");
  lines.push("- Polityczne disclosures sa opoznione, wiec traktuj je jako potwierdzenie tematu sektorowego, nie timing.");

  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
}

async function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  const snapshot = loadMonitoringData();
  const previous = loadJson(statePath, {});
  const allForm4 = [];
  const errors = [];

  for (const row of snapshot.rows) {
    process.stdout.write(`Elite flow ${row.ticker}... `);
    try {
      const result = await fetchForm4ForRow(row);
      allForm4.push(...result.filings);
      console.log(`${result.filings.length}`);
    } catch (error) {
      errors.push({ ticker: row.ticker, error: error.message });
      console.log(`failed: ${error.message}`);
    }
  }

  const previousAccessions = new Set(previous.accessions || []);
  const currentAccessions = allForm4.map((filing) => filing.accessionNumber).filter(Boolean);
  const hasPrevious = previousAccessions.size > 0;
  const newFilings = hasPrevious ? allForm4.filter((filing) => filing.accessionNumber && !previousAccessions.has(filing.accessionNumber)) : [];
  const politicalTrades = loadPoliticalTrades(snapshot.rows);
  const summaries = snapshot.rows.map((row) => summarizeTicker(row, allForm4));
  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    source: "SEC EDGAR Form 4 + manual political-trades.csv",
    summaries,
    form4: allForm4,
    politicalTrades,
    newFilings,
    errors
  };

  fs.writeFileSync(outputPath, `window.ELITE_FLOW_DATA = ${JSON.stringify(output, null, 2)};\n`);
  fs.writeFileSync(statePath, JSON.stringify({ generatedAt: output.generatedAt, accessions: currentAccessions }, null, 2));
  writeReport(output, summaries, allForm4, politicalTrades, newFilings);
  console.log(`Wrote ${path.relative(root, outputPath)}`);
  console.log(`Wrote ${path.relative(root, reportPath)}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

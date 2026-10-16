"use strict";

const TRANSACTION_CODES = {
  P: { label: "otwarty zakup na rynku", category: "OPEN_MARKET_BUY", direction: "KUPNO / LONG", market: true },
  S: { label: "sprzedaz na rynku", category: "OPEN_MARKET_SELL", direction: "SPRZEDAZ / REDUKCJA (NIE SHORT)", market: true },
  A: { label: "grant lub przyznanie akcji", category: "AWARD_GRANT", direction: "OPERACJA POZARYNKOWA", market: false },
  M: { label: "wykonanie lub konwersja instrumentu", category: "OPTION_EXERCISE", direction: "OPERACJA POZARYNKOWA", market: false },
  F: { label: "potracenie akcji na podatek lub cene wykonania", category: "TAX_WITHHOLDING", direction: "OPERACJA PODATKOWA", market: false },
  G: { label: "darowizna", category: "GIFT", direction: "OPERACJA POZARYNKOWA", market: false },
  C: { label: "konwersja instrumentu pochodnego", category: "CONVERSION", direction: "OPERACJA POZARYNKOWA", market: false },
  D: { label: "sprzedaz lub zwrot emitentowi", category: "ISSUER_DISPOSITION", direction: "OPERACJA POZARYNKOWA", market: false },
  J: { label: "inna transakcja", category: "OTHER", direction: "OPERACJA POZARYNKOWA", market: false },
  K: { label: "swap lub instrument podobny", category: "SWAP", direction: "OPERACJA POZARYNKOWA", market: false },
  U: { label: "przejecie akcji w ofercie", category: "TENDER", direction: "OPERACJA POZARYNKOWA", market: false },
  W: { label: "nabycie lub zbycie testamentowe", category: "INHERITANCE", direction: "OPERACJA POZARYNKOWA", market: false },
  X: { label: "wykonanie opcji in-the-money", category: "OPTION_EXERCISE", direction: "OPERACJA POZARYNKOWA", market: false },
  Z: { label: "glosowanie trustu", category: "TRUST_TRANSACTION", direction: "OPERACJA POZARYNKOWA", market: false }
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function xmlTagPattern(name) {
  const escaped = escapeRegex(name);
  return `(?:[A-Za-z0-9_.-]+:)?${escaped}`;
}

function cleanXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml, name) {
  const qualified = xmlTagPattern(name);
  const match = String(xml).match(new RegExp(`<${qualified}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${qualified}>`, "i"));
  return match ? cleanXml(match[1]) : "";
}

function blocks(xml, name) {
  const qualified = xmlTagPattern(name);
  return [...String(xml).matchAll(new RegExp(`<${qualified}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${qualified}>`, "gi"))].map((match) => match[0]);
}

function numberValue(value) {
  const number = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
  if (["1", "true", "yes"].includes(String(value || "").toLowerCase())) return true;
  if (["0", "false", "no"].includes(String(value || "").toLowerCase())) return false;
  return null;
}

function transactionCodeInfo(code) {
  const normalized = String(code || "").toUpperCase();
  return TRANSACTION_CODES[normalized] || {
    label: normalized ? `kod SEC ${normalized}` : "kod niepodany",
    category: "UNKNOWN",
    direction: "NIEUSTALONE",
    market: false
  };
}

function parseOwners(xml) {
  return blocks(xml, "reportingOwner").map((block) => ({
    name: tag(block, "rptOwnerName"),
    cik: tag(block, "rptOwnerCik"),
    isDirector: booleanValue(tag(block, "isDirector")) === true,
    isOfficer: booleanValue(tag(block, "isOfficer")) === true,
    isTenPercentOwner: booleanValue(tag(block, "isTenPercentOwner")) === true,
    isOther: booleanValue(tag(block, "isOther")) === true,
    officerTitle: tag(block, "officerTitle"),
    otherText: tag(block, "otherText")
  })).filter((owner) => owner.name);
}

function parseTransaction(block, derivative) {
  const code = tag(block, "transactionCode").toUpperCase();
  const codeInfo = transactionCodeInfo(code);
  const shares = numberValue(tag(block, "transactionShares"));
  const price = numberValue(tag(block, "transactionPricePerShare"));
  return {
    derivative,
    securityTitle: tag(block, "securityTitle"),
    underlyingSecurityTitle: tag(block, "underlyingSecurityTitle"),
    date: tag(block, "transactionDate"),
    deemedExecutionDate: tag(block, "deemedExecutionDate"),
    code,
    codeLabel: codeInfo.label,
    category: codeInfo.category,
    direction: codeInfo.direction,
    isOpenMarket: codeInfo.market,
    acquiredDisposed: tag(block, "transactionAcquiredDisposedCode"),
    shares,
    price,
    value: Number.isFinite(shares) && Number.isFinite(price) ? shares * price : null,
    postShares: numberValue(tag(block, "sharesOwnedFollowingTransaction")),
    directOrIndirect: tag(block, "directOrIndirectOwnership"),
    natureOfOwnership: tag(block, "natureOfOwnership"),
    exercisePrice: numberValue(tag(block, "conversionOrExercisePrice")),
    expirationDate: tag(block, "expirationDate")
  };
}

function parseOwnershipXml(xml) {
  const transactions = [
    ...blocks(xml, "nonDerivativeTransaction").map((block) => parseTransaction(block, false)),
    ...blocks(xml, "derivativeTransaction").map((block) => parseTransaction(block, true))
  ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  return {
    owners: parseOwners(xml),
    transactions,
    issuer: {
      cik: tag(xml, "issuerCik"),
      name: tag(xml, "issuerName"),
      tradingSymbol: tag(xml, "issuerTradingSymbol")
    },
    periodOfReport: tag(xml, "periodOfReport"),
    noSecuritiesOwned: booleanValue(tag(xml, "noSecuritiesBeneficiallyOwned")),
    tenB5One: booleanValue(tag(xml, "aff10b5One")),
    remarks: tag(xml, "remarks")
  };
}

function ownerRole(owner) {
  if (!owner) return "insider";
  const roles = [
    owner.officerTitle,
    owner.isDirector ? "dyrektor" : null,
    owner.isTenPercentOwner ? "wlasciciel >=10%" : null,
    owner.isOther ? owner.otherText || "inna rola" : null
  ].filter(Boolean);
  return roles.length ? roles.join(", ") : owner.isOfficer ? "czlonek zarzadu" : "insider";
}

function personName(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const commaParts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const ordered = commaParts.length >= 2 ? `${commaParts.slice(1).join(" ")} ${commaParts[0]}` : raw;
  return ordered.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

function rawOwnershipUrl(url) {
  return String(url || "").replace(/\/xslF345X\d+\//i, "/");
}

function summarizeOwnership(parsed) {
  const transactions = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
  const marketBuys = transactions.filter((tx) => tx.code === "P");
  const marketSells = transactions.filter((tx) => tx.code === "S");
  const nonMarket = transactions.filter((tx) => !tx.isOpenMarket);
  const purchaseValue = marketBuys.reduce((sum, tx) => sum + (tx.value || 0), 0);
  const saleValue = marketSells.reduce((sum, tx) => sum + (tx.value || 0), 0);
  const latestMarketTransaction = [...marketBuys, ...marketSells]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0] || null;
  const latestTransaction = transactions[0] || null;
  let signal = "NO_TRANSACTIONS";
  let direction = "BRAK";
  if (marketBuys.length && marketSells.length) {
    signal = "MIXED_OPEN_MARKET";
    direction = "KUPNO I SPRZEDAZ";
  } else if (marketBuys.length) {
    signal = "OPEN_MARKET_BUY";
    direction = "KUPNO / LONG";
  } else if (marketSells.length) {
    signal = "OPEN_MARKET_SELL";
    direction = "SPRZEDAZ / REDUKCJA (NIE SHORT)";
  } else if (nonMarket.length) {
    signal = "NON_MARKET_ONLY";
    direction = "BRAK TRANSAKCJI RYNKOWEJ";
  }

  const categories = [...new Set(nonMarket.map((tx) => tx.category).filter(Boolean))];
  return {
    hasOpenMarketTransaction: marketBuys.length + marketSells.length > 0,
    signal,
    direction,
    purchaseCount: marketBuys.length,
    saleCount: marketSells.length,
    nonMarketCount: nonMarket.length,
    purchaseValue,
    saleValue,
    latestMarketTransaction,
    latestTransaction,
    nonMarketCategories: categories,
    owner: parsed?.owners?.[0] || null,
    ownerRole: ownerRole(parsed?.owners?.[0]),
    tenB5One: parsed?.tenB5One ?? null
  };
}

module.exports = {
  TRANSACTION_CODES,
  blocks,
  cleanXml,
  ownerRole,
  parseOwnershipXml,
  personName,
  rawOwnershipUrl,
  summarizeOwnership,
  tag,
  transactionCodeInfo
};

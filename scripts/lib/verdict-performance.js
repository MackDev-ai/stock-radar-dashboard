"use strict";

const ACTIONS = ["INWESTUJ", "CZEKAJ", "ODRZUC"];
const WINDOWS = [5, 20, 60];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pctChange(current, previous) {
  const a = finite(current);
  const b = finite(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeSeries(series) {
  const byDate = new Map();
  for (const bar of Array.isArray(series) ? series : []) {
    if (!bar?.date || !Number.isFinite(finite(bar.close))) continue;
    byDate.set(String(bar.date).slice(0, 10), {
      date: String(bar.date).slice(0, 10),
      open: finite(bar.open),
      high: finite(bar.high),
      low: finite(bar.low),
      close: finite(bar.close)
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function barOnOrBefore(series, date) {
  if (!date) return null;
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].date <= date) return series[index];
  }
  return null;
}

function barOnOrAfter(series, date) {
  if (!date) return null;
  return series.find((bar) => bar.date >= date) || null;
}

function firstBarAfter(series, date) {
  if (!date) return null;
  return series.find((bar) => bar.date > date) || null;
}

function uniqueId(prefix, used) {
  let id = prefix.replace(/[^A-Za-z0-9_.:-]/g, "-");
  let suffix = 2;
  while (used.has(id)) {
    id = `${prefix}-${suffix}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
    suffix += 1;
  }
  used.add(id);
  return id;
}

function eventOutcome(series, benchmarkSeries, event, window) {
  if (!event.entryDate || !Number.isFinite(finite(event.entryPrice))) return null;
  const entryIndex = series.findIndex((bar) => bar.date >= event.entryDate);
  if (entryIndex < 0) return event.outcomes?.[String(window)] || null;
  const milestone = series[entryIndex + window];
  if (!milestone) return event.outcomes?.[String(window)] || null;
  const benchmarkBar = barOnOrBefore(benchmarkSeries, milestone.date);
  const benchmarkReturn = Number.isFinite(finite(event.benchmarkEntryPrice)) && benchmarkBar
    ? pctChange(benchmarkBar.close, event.benchmarkEntryPrice)
    : null;
  const assetReturn = pctChange(milestone.close, event.entryPrice);
  return {
    sessions: window,
    date: milestone.date,
    price: milestone.close,
    returnPct: round(assetReturn),
    benchmarkDate: benchmarkBar?.date || null,
    benchmarkReturnPct: round(benchmarkReturn),
    excessReturnPct: Number.isFinite(assetReturn) && Number.isFinite(benchmarkReturn)
      ? round(assetReturn - benchmarkReturn)
      : null
  };
}

function updateEvent(event, row, series, benchmarkSeries, generatedAt) {
  const next = { ...event, outcomes: { ...(event.outcomes || {}) } };
  const entryIndex = series.findIndex((bar) => bar.date >= next.entryDate);
  const last = series[series.length - 1] || null;
  const endDate = next.status === "CLOSED" && next.exitDate ? next.exitDate : last?.date;
  const endBar = endDate ? barOnOrBefore(series, endDate) : null;
  const endIndex = endBar ? series.findIndex((bar) => bar.date === endBar.date) : -1;
  const endPrice = next.status === "CLOSED" && Number.isFinite(finite(next.exitPrice))
    ? finite(next.exitPrice)
    : endBar?.close;

  if (entryIndex >= 0 && endIndex >= entryIndex) {
    const path = series.slice(entryIndex, endIndex + 1);
    const pathReturns = path.map((bar) => pctChange(bar.close, next.entryPrice)).filter(Number.isFinite);
    const minReturn = pathReturns.length ? Math.min(...pathReturns) : null;
    const maxReturn = pathReturns.length ? Math.max(...pathReturns) : null;
    let peak = finite(next.entryPrice);
    let maxDrawdown = 0;
    for (const bar of path) {
      peak = Math.max(peak, bar.close);
      const drawdown = pctChange(bar.close, peak);
      if (Number.isFinite(drawdown)) maxDrawdown = Math.min(maxDrawdown, drawdown);
    }
    next.sessionsElapsed = endIndex - entryIndex;
    next.maxAdverseExcursionPct = round(Math.min(
      Number.isFinite(finite(next.maxAdverseExcursionPct)) ? finite(next.maxAdverseExcursionPct) : 0,
      Number.isFinite(minReturn) ? minReturn : 0
    ));
    next.maxFavorableExcursionPct = round(Math.max(
      Number.isFinite(finite(next.maxFavorableExcursionPct)) ? finite(next.maxFavorableExcursionPct) : 0,
      Number.isFinite(maxReturn) ? maxReturn : 0
    ));
    next.maxDrawdownPct = round(Math.min(
      Number.isFinite(finite(next.maxDrawdownPct)) ? finite(next.maxDrawdownPct) : 0,
      maxDrawdown
    ));
  }

  const benchmarkBar = endDate ? barOnOrBefore(benchmarkSeries, endDate) : null;
  const currentReturn = pctChange(endPrice, next.entryPrice);
  const benchmarkReturn = benchmarkBar && Number.isFinite(finite(next.benchmarkEntryPrice))
    ? pctChange(benchmarkBar.close, next.benchmarkEntryPrice)
    : null;
  next.currentDate = endBar?.date || next.currentDate || null;
  next.currentPrice = Number.isFinite(endPrice) ? endPrice : next.currentPrice ?? null;
  next.currentReturnPct = round(currentReturn);
  next.benchmarkCurrentReturnPct = round(benchmarkReturn);
  next.currentExcessReturnPct = Number.isFinite(currentReturn) && Number.isFinite(benchmarkReturn)
    ? round(currentReturn - benchmarkReturn)
    : null;
  next.currentScore = row?.researchScore?.total ?? next.currentScore ?? null;
  next.lastEvaluatedAt = generatedAt;
  for (const window of WINDOWS) {
    next.outcomes[String(window)] = eventOutcome(series, benchmarkSeries, next, window);
  }
  return next;
}

function hitForAction(action, outcome) {
  if (!outcome || !Number.isFinite(finite(outcome.returnPct))) return null;
  if (action === "INWESTUJ") {
    return Number.isFinite(finite(outcome.excessReturnPct))
      ? outcome.returnPct > 0 && outcome.excessReturnPct > 0
      : outcome.returnPct > 0;
  }
  if (action === "ODRZUC") return outcome.returnPct <= 0;
  return outcome.returnPct < 5;
}

function aggregateOutcomes(events, action, window) {
  const outcomes = events
    .filter((event) => event.action === action)
    .map((event) => event.outcomes?.[String(window)])
    .filter((outcome) => outcome && Number.isFinite(finite(outcome.returnPct)));
  const average = (field) => {
    const values = outcomes.map((outcome) => finite(outcome[field])).filter(Number.isFinite);
    return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  const hits = outcomes.map((outcome) => hitForAction(action, outcome)).filter((value) => value !== null);
  return {
    count: outcomes.length,
    avgReturn: average("returnPct"),
    avgBenchmarkReturn: average("benchmarkReturnPct"),
    avgExcessReturn: average("excessReturnPct"),
    hitRate: hits.length ? round((hits.filter(Boolean).length / hits.length) * 100, 2) : null
  };
}

function emptyPaperPortfolio(options, generatedAt) {
  return {
    version: 1,
    generatedAt,
    initialCapital: finite(options.initialCapital) || 100000,
    maxPositions: finite(options.maxPositions) || 10,
    cash: finite(options.initialCapital) || 100000,
    positions: [],
    pendingOrders: [],
    trades: [],
    equityHistory: [],
    benchmarkSymbol: options.benchmarkSymbol || "SPY",
    benchmarkEntryDate: null,
    benchmarkEntryPrice: null
  };
}

function processPaperPortfolio(previous, rows, seriesByTicker, benchmarkSeries, generatedAt, options) {
  const portfolio = previous && Array.isArray(previous.positions)
    ? {
        ...emptyPaperPortfolio(options, generatedAt),
        ...previous,
        positions: previous.positions.map((position) => ({ ...position })),
        pendingOrders: (previous.pendingOrders || []).map((order) => ({ ...order })),
        trades: (previous.trades || []).map((trade) => ({ ...trade })),
        equityHistory: (previous.equityHistory || []).map((point) => ({ ...point }))
      }
    : emptyPaperPortfolio(options, generatedAt);
  portfolio.generatedAt = generatedAt;
  portfolio.maxPositions = finite(options.maxPositions) || portfolio.maxPositions || 10;
  const rowsByTicker = new Map(rows.map((row) => [row.ticker, row]));
  const remainingOrders = [];
  const tradeIds = new Set(portfolio.trades.map((trade) => trade.id));

  for (const order of portfolio.pendingOrders) {
    const series = seriesByTicker.get(order.ticker) || [];
    const bar = firstBarAfter(series, order.signalDate);
    if (!bar) {
      remainingOrders.push(order);
      continue;
    }
    const executionPrice = finite(bar.open) || finite(bar.close);
    if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
      remainingOrders.push(order);
      continue;
    }
    const existingIndex = portfolio.positions.findIndex((position) => position.ticker === order.ticker);
    if (order.side === "BUY" && existingIndex < 0 && portfolio.positions.length < portfolio.maxPositions) {
      const allocation = Math.min(portfolio.cash, portfolio.initialCapital / portfolio.maxPositions);
      if (allocation > 0) {
        const quantity = allocation / executionPrice;
        portfolio.cash -= allocation;
        portfolio.positions.push({
          ticker: order.ticker,
          name: order.name || rowsByTicker.get(order.ticker)?.name || "",
          signalDate: order.signalDate,
          openedAt: bar.date,
          entryPrice: executionPrice,
          quantity,
          cost: allocation,
          researchScore: order.researchScore ?? null,
          currentPrice: executionPrice,
          marketValue: allocation,
          returnPct: 0
        });
        const tradeId = uniqueId(`BUY-${order.ticker}-${bar.date}`, tradeIds);
        portfolio.trades.push({ id: tradeId, side: "BUY", ticker: order.ticker, date: bar.date, price: executionPrice, quantity, value: allocation });
        if (!portfolio.benchmarkEntryPrice) {
          const benchmarkBar = barOnOrAfter(benchmarkSeries, bar.date);
          portfolio.benchmarkEntryDate = benchmarkBar?.date || null;
          portfolio.benchmarkEntryPrice = finite(benchmarkBar?.open) || finite(benchmarkBar?.close);
        }
      }
    } else if (order.side === "SELL" && existingIndex >= 0) {
      const position = portfolio.positions[existingIndex];
      const value = position.quantity * executionPrice;
      portfolio.cash += value;
      portfolio.positions.splice(existingIndex, 1);
      const tradeId = uniqueId(`SELL-${order.ticker}-${bar.date}`, tradeIds);
      portfolio.trades.push({
        id: tradeId,
        side: "SELL",
        ticker: order.ticker,
        date: bar.date,
        price: executionPrice,
        quantity: position.quantity,
        value,
        pnl: value - position.cost,
        returnPct: round(pctChange(value, position.cost))
      });
    }
  }
  portfolio.pendingOrders = remainingOrders;

  const pendingKeys = new Set(portfolio.pendingOrders.map((order) => `${order.side}:${order.ticker}`));
  const latestMarketDate = benchmarkSeries[benchmarkSeries.length - 1]?.date
    || rows.map((row) => row.metrics?.date).filter(Boolean).sort().pop()
    || String(generatedAt).slice(0, 10);

  for (const position of portfolio.positions) {
    const row = rowsByTicker.get(position.ticker);
    const series = seriesByTicker.get(position.ticker) || [];
    const last = series[series.length - 1];
    const currentPrice = finite(last?.close) || finite(row?.metrics?.price) || finite(position.currentPrice) || finite(position.entryPrice);
    position.currentPrice = currentPrice;
    position.currentDate = last?.date || row?.metrics?.date || position.currentDate || null;
    position.marketValue = position.quantity * currentPrice;
    position.returnPct = round(pctChange(position.marketValue, position.cost));
    position.currentAction = row?.concreteVerdict?.action || null;
    if (position.currentAction !== "INWESTUJ" && !pendingKeys.has(`SELL:${position.ticker}`)) {
      portfolio.pendingOrders.push({
        id: `SELL-${position.ticker}-${position.currentDate}`,
        side: "SELL",
        ticker: position.ticker,
        name: position.name,
        signalDate: position.currentDate,
        createdAt: generatedAt,
        reason: `MODEL_${position.currentAction || "BRAK_DANYCH"}`
      });
      pendingKeys.add(`SELL:${position.ticker}`);
    }
  }

  const reserved = new Set([
    ...portfolio.positions.map((position) => position.ticker),
    ...portfolio.pendingOrders.filter((order) => order.side === "BUY").map((order) => order.ticker)
  ]);
  let capacity = portfolio.maxPositions - reserved.size;
  const candidates = rows
    .filter((row) => row.concreteVerdict?.action === "INWESTUJ")
    .filter((row) => /^[A-Z0-9-]+$/.test(String(row.yahoo || row.ticker || "")))
    .filter((row) => !reserved.has(row.ticker))
    .sort((a, b) => (b.researchScore?.total || 0) - (a.researchScore?.total || 0)
      || (b.concreteVerdict?.confidenceScore || 0) - (a.concreteVerdict?.confidenceScore || 0));
  for (const row of candidates) {
    if (capacity <= 0) break;
    portfolio.pendingOrders.push({
      id: `BUY-${row.ticker}-${row.metrics?.date || String(generatedAt).slice(0, 10)}`,
      side: "BUY",
      ticker: row.ticker,
      name: row.name || "",
      signalDate: row.metrics?.date || String(generatedAt).slice(0, 10),
      createdAt: generatedAt,
      researchScore: row.researchScore?.total ?? null,
      reason: "MODEL_INWESTUJ"
    });
    reserved.add(row.ticker);
    capacity -= 1;
  }

  const marketValue = portfolio.positions.reduce((sum, position) => sum + (finite(position.marketValue) || 0), 0);
  const value = portfolio.cash + marketValue;
  const returnPct = pctChange(value, portfolio.initialCapital);
  const latestBenchmark = benchmarkSeries[benchmarkSeries.length - 1] || null;
  const benchmarkReturn = Number.isFinite(finite(portfolio.benchmarkEntryPrice)) && latestBenchmark
    ? pctChange(latestBenchmark.close, portfolio.benchmarkEntryPrice)
    : null;
  const point = { date: latestMarketDate, value: round(value, 2), returnPct: round(returnPct) };
  const previousPointIndex = portfolio.equityHistory.findIndex((item) => item.date === point.date);
  if (previousPointIndex >= 0) portfolio.equityHistory[previousPointIndex] = point;
  else portfolio.equityHistory.push(point);
  portfolio.equityHistory = portfolio.equityHistory.sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
  let peak = portfolio.initialCapital;
  let maxDrawdown = 0;
  for (const item of portfolio.equityHistory) {
    peak = Math.max(peak, finite(item.value) || peak);
    const drawdown = pctChange(finite(item.value), peak);
    if (Number.isFinite(drawdown)) maxDrawdown = Math.min(maxDrawdown, drawdown);
  }
  portfolio.value = round(value, 2);
  portfolio.marketValue = round(marketValue, 2);
  portfolio.returnPct = round(returnPct);
  portfolio.benchmarkReturnPct = round(benchmarkReturn);
  portfolio.excessReturnPct = Number.isFinite(returnPct) && Number.isFinite(benchmarkReturn)
    ? round(returnPct - benchmarkReturn)
    : null;
  portfolio.maxDrawdownPct = round(maxDrawdown);
  portfolio.exposurePct = value > 0 ? round((marketValue / value) * 100) : 0;
  portfolio.realizedPnl = round(portfolio.trades.filter((trade) => trade.side === "SELL").reduce((sum, trade) => sum + (finite(trade.pnl) || 0), 0), 2);
  portfolio.trades = portfolio.trades.slice(-1000);
  return portfolio;
}

function buildSummary(events, rows, paperPortfolio, generatedAt) {
  const currentActions = Object.fromEntries(ACTIONS.map((action) => [
    action,
    rows.filter((row) => row.concreteVerdict?.action === action).length
  ]));
  const byAction = ACTIONS.map((action) => ({
    action,
    events: events.filter((event) => event.action === action).length,
    open: events.filter((event) => event.action === action && event.status === "OPEN").length,
    byWindow: Object.fromEntries(WINDOWS.map((window) => [String(window), aggregateOutcomes(events, action, window)]))
  }));
  const invest20 = byAction.find((item) => item.action === "INWESTUJ")?.byWindow?.["20"] || { count: 0 };
  const calibrationReady = invest20.count >= 30;
  const calibrationNotes = [];
  if (!calibrationReady) calibrationNotes.push(`Kalibracja zablokowana: ${invest20.count}/30 dojrzalych sygnalow INWESTUJ po 20 sesjach.`);
  if (calibrationReady && Number.isFinite(invest20.avgExcessReturn) && invest20.avgExcessReturn <= 0) {
    calibrationNotes.push("INWESTUJ nie pokonuje SPY po 20 sesjach: zaostrz prog lub filtr ceny.");
  }
  if (calibrationReady && Number.isFinite(invest20.hitRate) && invest20.hitRate < 50) {
    calibrationNotes.push("Skutecznosc INWESTUJ jest ponizej 50%: nie podnos wag modelu.");
  }
  if (calibrationReady && Number.isFinite(invest20.avgExcessReturn) && invest20.avgExcessReturn > 0 && invest20.hitRate >= 50) {
    calibrationNotes.push("Probka pozwala rozpoczac kontrolowana kalibracje progow.");
  }
  return {
    version: 1,
    generatedAt,
    benchmark: paperPortfolio.benchmarkSymbol || "SPY",
    eventCount: events.length,
    openCount: events.filter((event) => event.status === "OPEN").length,
    currentActions,
    byAction,
    calibration: {
      status: calibrationReady ? "READY" : "LOCKED",
      requiredInvest20: 30,
      maturedInvest20: invest20.count,
      notes: calibrationNotes
    },
    recentEvents: events
      .slice()
      .sort((a, b) => String(b.openedAt || "").localeCompare(String(a.openedAt || "")))
      .slice(0, 120),
    paperPortfolio: {
      initialCapital: paperPortfolio.initialCapital,
      value: paperPortfolio.value,
      cash: round(paperPortfolio.cash, 2),
      marketValue: paperPortfolio.marketValue,
      returnPct: paperPortfolio.returnPct,
      benchmarkReturnPct: paperPortfolio.benchmarkReturnPct,
      excessReturnPct: paperPortfolio.excessReturnPct,
      maxDrawdownPct: paperPortfolio.maxDrawdownPct,
      exposurePct: paperPortfolio.exposurePct,
      realizedPnl: paperPortfolio.realizedPnl,
      openPositions: paperPortfolio.positions.length,
      pendingOrders: paperPortfolio.pendingOrders.length,
      maxPositions: paperPortfolio.maxPositions,
      benchmarkSymbol: paperPortfolio.benchmarkSymbol,
      benchmarkEntryDate: paperPortfolio.benchmarkEntryDate,
      positions: paperPortfolio.positions,
      orders: paperPortfolio.pendingOrders.slice(0, 30),
      recentTrades: paperPortfolio.trades.slice(-30).reverse(),
      equityHistory: paperPortfolio.equityHistory
    }
  };
}

function buildVerdictLedger(previousLedger, rows, rawSeriesByTicker, rawBenchmarkSeries, generatedAt, options = {}) {
  const benchmarkSeries = normalizeSeries(rawBenchmarkSeries);
  const seriesByTicker = new Map();
  for (const [ticker, series] of rawSeriesByTicker.entries()) seriesByTicker.set(ticker, normalizeSeries(series));
  const previousEvents = Array.isArray(previousLedger?.events) ? previousLedger.events.map((event) => ({ ...event })) : [];
  const events = previousEvents;
  const usedIds = new Set(events.map((event) => event.id));
  const rowsByTicker = new Map(rows.map((row) => [row.ticker, row]));
  const latestOpen = new Map();
  for (const event of events.slice().sort((a, b) => String(a.openedAt || "").localeCompare(String(b.openedAt || "")))) {
    if (event.status !== "OPEN") continue;
    const previous = latestOpen.get(event.ticker);
    if (previous) {
      previous.status = "CLOSED";
      previous.closedAt = generatedAt;
      previous.exitReason = "DUPLICATE_REPAIRED";
    }
    latestOpen.set(event.ticker, event);
  }

  for (const row of rows) {
    const action = row.concreteVerdict?.action;
    if (!ACTIONS.includes(action)) continue;
    const series = seriesByTicker.get(row.ticker) || [];
    const latest = series[series.length - 1] || null;
    const currentOpen = latestOpen.get(row.ticker);
    if (currentOpen && currentOpen.action !== action) {
      currentOpen.status = "CLOSED";
      currentOpen.closedAt = generatedAt;
      currentOpen.exitDate = latest?.date || row.metrics?.date || String(generatedAt).slice(0, 10);
      currentOpen.exitPrice = finite(latest?.close) || finite(row.metrics?.price);
      currentOpen.exitAction = action;
      currentOpen.exitReason = "VERDICT_CHANGED";
      latestOpen.delete(row.ticker);
    }
    if (!latestOpen.has(row.ticker)) {
      const entryDate = latest?.date || row.metrics?.date || String(generatedAt).slice(0, 10);
      const entryPrice = finite(latest?.close) || finite(row.metrics?.price);
      const benchmarkEntry = barOnOrBefore(benchmarkSeries, entryDate);
      const event = {
        id: uniqueId(`${row.ticker}-${action}-${entryDate}-${String(generatedAt).slice(11, 19)}`, usedIds),
        ticker: row.ticker,
        name: row.name || "",
        themes: row.themes || [],
        action,
        confidence: row.concreteVerdict?.confidence || null,
        confidenceScore: row.concreteVerdict?.confidenceScore ?? null,
        reason: row.concreteVerdict?.reason || null,
        openedAt: generatedAt,
        entryDate,
        entryPrice,
        benchmarkSymbol: options.benchmarkSymbol || "SPY",
        benchmarkEntryDate: benchmarkEntry?.date || null,
        benchmarkEntryPrice: benchmarkEntry?.close ?? null,
        startScore: row.researchScore?.total ?? null,
        currentScore: row.researchScore?.total ?? null,
        status: "OPEN",
        sessionsElapsed: 0,
        outcomes: {}
      };
      events.push(event);
      latestOpen.set(row.ticker, event);
    }
  }

  const updatedEvents = events.map((event) => updateEvent(
    event,
    rowsByTicker.get(event.ticker),
    seriesByTicker.get(event.ticker) || [],
    benchmarkSeries,
    generatedAt
  ));
  const paperPortfolio = processPaperPortfolio(
    previousLedger?.paperPortfolio,
    rows,
    seriesByTicker,
    benchmarkSeries,
    generatedAt,
    options
  );
  const summary = buildSummary(updatedEvents, rows, paperPortfolio, generatedAt);
  return {
    version: 1,
    generatedAt,
    benchmarkSymbol: options.benchmarkSymbol || "SPY",
    methodology: {
      eventRule: "One event per ticker and explicit verdict transition",
      executionRule: "Paper orders execute at the next session open",
      windows: WINDOWS,
      benchmark: options.benchmarkSymbol || "SPY",
      calibrationMinimum: 30,
      currencyNote: "Returns use each listing currency; the paper portfolio includes symbols without an exchange suffix only."
    },
    events: updatedEvents.slice(-10000),
    paperPortfolio,
    summary
  };
}

module.exports = {
  ACTIONS,
  WINDOWS,
  buildVerdictLedger,
  normalizeSeries,
  pctChange
};

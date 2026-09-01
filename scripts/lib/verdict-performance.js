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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function primaryTheme(row, fallback = "OTHER") {
  return String(row?.themes?.[0] || fallback || "OTHER");
}

function riskLimits(options = {}) {
  return {
    maxPositionPct: finite(options.maxPositionPct) || 10,
    maxPrimaryThemePct: finite(options.maxPrimaryThemePct) || 20,
    maxPositionsPerTheme: finite(options.maxPositionsPerTheme) || 2,
    maxGapPct: finite(options.maxGapPct) || 3,
    targetRiskPct: finite(options.targetRiskPct) || 0.75,
    minPositionPct: finite(options.minPositionPct) || 2,
    reviewSessions: finite(options.reviewSessions) || 20,
    stopMinPct: finite(options.stopMinPct) || 5,
    stopMaxPct: finite(options.stopMaxPct) || 12
  };
}

function stopDistancePct(volatility, limits) {
  const annualized = finite(volatility) || 45;
  const dailyVolatility = annualized / Math.sqrt(252);
  return round(clamp(dailyVolatility * 3, limits.stopMinPct, limits.stopMaxPct), 2);
}

function addCalendarDays(date, days) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function positionValue(position) {
  return finite(position.marketValue) || finite(position.cost) || 0;
}

function portfolioValue(portfolio) {
  return (finite(portfolio.cash) || 0)
    + portfolio.positions.reduce((sum, position) => sum + positionValue(position), 0);
}

function themePositionStats(portfolio, theme) {
  const positions = portfolio.positions.filter((position) => primaryTheme(null, position.primaryTheme) === theme);
  return {
    count: positions.length,
    value: positions.reduce((sum, position) => sum + positionValue(position), 0)
  };
}

function executionCancellation(portfolio, order, generatedAt, reason, details = {}) {
  const cancellation = {
    id: `CANCEL-${order.ticker}-${order.signalDate || String(generatedAt).slice(0, 10)}-${reason}`,
    type: "CANCELLED",
    side: order.side,
    ticker: order.ticker,
    date: String(generatedAt).slice(0, 10),
    signalDate: order.signalDate || null,
    reason,
    ...details
  };
  portfolio.cancelledOrders.push(cancellation);
  portfolio.activity.push(cancellation);
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
    cancelledOrders: [],
    activity: [],
    equityHistory: [],
    riskLimits: riskLimits(options),
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
        cancelledOrders: (previous.cancelledOrders || []).map((order) => ({ ...order })),
        equityHistory: (previous.equityHistory || []).map((point) => ({ ...point }))
      }
    : emptyPaperPortfolio(options, generatedAt);
  portfolio.generatedAt = generatedAt;
  portfolio.maxPositions = finite(options.maxPositions) || portfolio.maxPositions || 10;
  portfolio.riskLimits = riskLimits(options);
  portfolio.activity = [];
  const limits = portfolio.riskLimits;
  const rowsByTicker = new Map(rows.map((row) => [row.ticker, row]));
  const remainingOrders = [];
  const tradeIds = new Set(portfolio.trades.map((trade) => trade.id));
  const pendingThemeCounts = new Map();
  let reservedPendingBuys = 0;

  const sortedOrders = portfolio.pendingOrders
    .map((order, index) => ({ ...order, _index: index }))
    .sort((a, b) => {
      if (a.side !== b.side) return a.side === "SELL" ? -1 : 1;
      if (a.side === "BUY") return (finite(b.researchScore) || 0) - (finite(a.researchScore) || 0) || a._index - b._index;
      return a._index - b._index;
    });

  for (const rawOrder of sortedOrders) {
    const { _index, ...order } = rawOrder;
    const row = rowsByTicker.get(order.ticker);
    const series = seriesByTicker.get(order.ticker) || [];
    order.primaryTheme = primaryTheme(row, order.primaryTheme);
    order.signalPrice = finite(order.signalPrice) || finite(barOnOrBefore(series, order.signalDate)?.close);
    order.volatility60dAnnualized = finite(order.volatility60dAnnualized)
      || finite(row?.metrics?.volatility60dAnnualized);
    order.stopDistancePct = finite(order.stopDistancePct)
      || stopDistancePct(order.volatility60dAnnualized, limits);
    const bar = firstBarAfter(series, order.signalDate);
    if (!bar) {
      if (order.side === "BUY") {
        const themeStats = themePositionStats(portfolio, order.primaryTheme);
        const themePending = pendingThemeCounts.get(order.primaryTheme) || 0;
        if (row?.concreteVerdict?.action !== "INWESTUJ") {
          executionCancellation(portfolio, order, generatedAt, "STALE_SIGNAL");
          continue;
        }
        if (portfolio.positions.length + reservedPendingBuys >= portfolio.maxPositions) {
          executionCancellation(portfolio, order, generatedAt, "PORTFOLIO_LIMIT");
          continue;
        }
        if (themeStats.count + themePending >= limits.maxPositionsPerTheme) {
          executionCancellation(portfolio, order, generatedAt, "THEME_POSITION_LIMIT", {
            primaryTheme: order.primaryTheme
          });
          continue;
        }
        pendingThemeCounts.set(order.primaryTheme, themePending + 1);
        reservedPendingBuys += 1;
      }
      remainingOrders.push(order);
      continue;
    }
    const executionPrice = finite(bar.open) || finite(bar.close);
    if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
      remainingOrders.push(order);
      continue;
    }
    const existingIndex = portfolio.positions.findIndex((position) => position.ticker === order.ticker);
    if (order.side === "BUY") {
      if (existingIndex >= 0) {
        executionCancellation(portfolio, order, generatedAt, "ALREADY_OPEN");
        continue;
      }
      if (portfolio.positions.length >= portfolio.maxPositions) {
        executionCancellation(portfolio, order, generatedAt, "PORTFOLIO_LIMIT");
        continue;
      }
      const gapPct = pctChange(executionPrice, order.signalPrice);
      if (!Number.isFinite(gapPct)) {
        executionCancellation(portfolio, order, generatedAt, "MISSING_SIGNAL_PRICE");
        continue;
      }
      if (Math.abs(gapPct) > limits.maxGapPct) {
        executionCancellation(portfolio, order, generatedAt, "GAP_LIMIT", {
          signalPrice: round(order.signalPrice, 4),
          executionPrice: round(executionPrice, 4),
          gapPct: round(gapPct, 2)
        });
        continue;
      }
      const beforeValue = portfolioValue(portfolio);
      const themeStats = themePositionStats(portfolio, order.primaryTheme);
      if (themeStats.count >= limits.maxPositionsPerTheme) {
        executionCancellation(portfolio, order, generatedAt, "THEME_POSITION_LIMIT", {
          primaryTheme: order.primaryTheme
        });
        continue;
      }
      const stopPct = finite(order.stopDistancePct) || stopDistancePct(order.volatility60dAnnualized, limits);
      const riskSizedAllocation = beforeValue * (limits.targetRiskPct / Math.max(stopPct, 0.01));
      const companyCap = beforeValue * limits.maxPositionPct / 100;
      const themeHeadroom = Math.max(0, beforeValue * limits.maxPrimaryThemePct / 100 - themeStats.value);
      const allocation = Math.min(portfolio.cash, riskSizedAllocation, companyCap, themeHeadroom);
      const minimumAllocation = beforeValue * limits.minPositionPct / 100;
      if (allocation + 0.01 < minimumAllocation) {
        executionCancellation(portfolio, order, generatedAt, "SIZE_BELOW_MINIMUM", {
          primaryTheme: order.primaryTheme,
          allocation: round(allocation, 2)
        });
        continue;
      }
      if (allocation > 0) {
        const quantity = allocation / executionPrice;
        portfolio.cash -= allocation;
        const position = {
          ticker: order.ticker,
          name: order.name || row?.name || "",
          signalDate: order.signalDate,
          openedAt: bar.date,
          entryPrice: executionPrice,
          signalPrice: order.signalPrice,
          gapPct: round(gapPct, 2),
          quantity,
          cost: allocation,
          researchScore: order.researchScore ?? null,
          primaryTheme: order.primaryTheme,
          volatility60dAnnualized: order.volatility60dAnnualized,
          stopDistancePct: stopPct,
          stopPrice: round(executionPrice * (1 - stopPct / 100), 4),
          reviewAfterSessions: limits.reviewSessions,
          reviewDateEstimate: addCalendarDays(bar.date, Math.ceil(limits.reviewSessions * 1.4)),
          sessionsHeld: 0,
          currentPrice: executionPrice,
          marketValue: allocation,
          returnPct: 0
        };
        portfolio.positions.push(position);
        const tradeId = uniqueId(`BUY-${order.ticker}-${bar.date}`, tradeIds);
        const trade = {
          id: tradeId,
          type: "FILLED_BUY",
          side: "BUY",
          ticker: order.ticker,
          date: bar.date,
          price: executionPrice,
          signalPrice: order.signalPrice,
          gapPct: round(gapPct, 2),
          quantity,
          value: allocation,
          allocationPct: beforeValue > 0 ? round(allocation / beforeValue * 100, 2) : null,
          primaryTheme: order.primaryTheme,
          stopPrice: position.stopPrice,
          reason: order.reason
        };
        portfolio.trades.push(trade);
        portfolio.activity.push(trade);
        if (!portfolio.benchmarkEntryPrice) {
          const benchmarkBar = barOnOrAfter(benchmarkSeries, bar.date);
          portfolio.benchmarkEntryDate = benchmarkBar?.date || null;
          portfolio.benchmarkEntryPrice = finite(benchmarkBar?.open) || finite(benchmarkBar?.close);
        }
      }
    } else if (order.side === "SELL" && existingIndex >= 0) {
      const position = portfolio.positions[existingIndex];
      const fraction = clamp(finite(order.fraction) || 1, 0.01, 1);
      const quantity = position.quantity * fraction;
      const cost = position.cost * fraction;
      const value = quantity * executionPrice;
      portfolio.cash += value;
      if (fraction >= 0.9999) {
        portfolio.positions.splice(existingIndex, 1);
      } else {
        position.quantity -= quantity;
        position.cost -= cost;
        position.marketValue = position.quantity * executionPrice;
        position.currentPrice = executionPrice;
        position.returnPct = round(pctChange(position.marketValue, position.cost));
        position.lastRiskAction = order.modelAction || order.reason || "PARTIAL_EXIT";
        position.pendingRiskAction = null;
      }
      const tradeId = uniqueId(`SELL-${order.ticker}-${bar.date}`, tradeIds);
      const trade = {
        id: tradeId,
        type: "FILLED_SELL",
        side: "SELL",
        ticker: order.ticker,
        date: bar.date,
        price: executionPrice,
        quantity,
        value,
        fraction: round(fraction, 2),
        pnl: value - cost,
        returnPct: round(pctChange(value, cost)),
        primaryTheme: position.primaryTheme,
        reason: order.reason
      };
      portfolio.trades.push(trade);
      portfolio.activity.push(trade);
    } else if (order.side === "SELL") {
      executionCancellation(portfolio, order, generatedAt, "POSITION_NOT_FOUND");
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
    position.primaryTheme = primaryTheme(row, position.primaryTheme);
    position.volatility60dAnnualized = finite(row?.metrics?.volatility60dAnnualized)
      || finite(position.volatility60dAnnualized);
    position.stopDistancePct = finite(position.stopDistancePct)
      || stopDistancePct(position.volatility60dAnnualized, limits);
    position.stopPrice = finite(position.stopPrice)
      || round(position.entryPrice * (1 - position.stopDistancePct / 100), 4);
    const entryIndex = series.findIndex((bar) => bar.date >= position.openedAt);
    const currentIndex = series.findIndex((bar) => bar.date === position.currentDate);
    position.sessionsHeld = entryIndex >= 0 && currentIndex >= entryIndex ? currentIndex - entryIndex : position.sessionsHeld || 0;
    position.reviewAfterSessions = finite(position.reviewAfterSessions) || limits.reviewSessions;
    position.reviewDateEstimate = position.reviewDateEstimate
      || addCalendarDays(position.openedAt, Math.ceil(position.reviewAfterSessions * 1.4));
    if (position.sessionsHeld >= position.reviewAfterSessions && !position.reviewNotifiedAt) {
      position.reviewNotifiedAt = generatedAt;
      portfolio.activity.push({
        id: `REVIEW-${position.ticker}-${position.currentDate}`,
        type: "REVIEW_DUE",
        ticker: position.ticker,
        date: position.currentDate,
        sessionsHeld: position.sessionsHeld,
        reason: "REVIEW_SESSION_LIMIT"
      });
    }
    if (position.currentAction === "INWESTUJ") {
      position.lastRiskAction = null;
      position.pendingRiskAction = null;
    }
    const stopBreached = Number.isFinite(currentPrice) && Number.isFinite(position.stopPrice) && currentPrice <= position.stopPrice;
    let exitReason = null;
    let exitFraction = 1;
    if (stopBreached) exitReason = "STOP_BREACH";
    else if (position.currentAction === "ODRZUC") exitReason = "MODEL_ODRZUC";
    else if (position.currentAction === "CZEKAJ" && position.lastRiskAction !== "CZEKAJ") {
      exitReason = "MODEL_CZEKAJ";
      exitFraction = 0.5;
    }
    if (exitReason && !pendingKeys.has(`SELL:${position.ticker}`)) {
      portfolio.pendingOrders.push({
        id: `SELL-${position.ticker}-${position.currentDate}`,
        side: "SELL",
        ticker: position.ticker,
        name: position.name,
        signalDate: position.currentDate,
        createdAt: generatedAt,
        reason: exitReason,
        modelAction: position.currentAction,
        fraction: exitFraction,
        primaryTheme: position.primaryTheme
      });
      position.pendingRiskAction = exitReason;
      pendingKeys.add(`SELL:${position.ticker}`);
      if (stopBreached) {
        portfolio.activity.push({
          id: `RISK-${position.ticker}-${position.currentDate}`,
          type: "RISK_BREACH",
          ticker: position.ticker,
          date: position.currentDate,
          currentPrice: round(currentPrice, 4),
          stopPrice: position.stopPrice,
          reason: "STOP_BREACH"
        });
      }
    }
  }

  const reserved = new Set([
    ...portfolio.positions.map((position) => position.ticker),
    ...portfolio.pendingOrders.filter((order) => order.side === "BUY").map((order) => order.ticker)
  ]);
  let capacity = portfolio.maxPositions - reserved.size;
  const reservedByTheme = new Map();
  for (const position of portfolio.positions) {
    reservedByTheme.set(position.primaryTheme, (reservedByTheme.get(position.primaryTheme) || 0) + 1);
  }
  for (const order of portfolio.pendingOrders.filter((item) => item.side === "BUY")) {
    const theme = primaryTheme(rowsByTicker.get(order.ticker), order.primaryTheme);
    reservedByTheme.set(theme, (reservedByTheme.get(theme) || 0) + 1);
  }
  const candidates = rows
    .filter((row) => row.concreteVerdict?.action === "INWESTUJ")
    .filter((row) => /^[A-Z0-9-]+$/.test(String(row.yahoo || row.ticker || "")))
    .filter((row) => !reserved.has(row.ticker))
    .sort((a, b) => (b.researchScore?.total || 0) - (a.researchScore?.total || 0)
      || (b.concreteVerdict?.confidenceScore || 0) - (a.concreteVerdict?.confidenceScore || 0));
  for (const row of candidates) {
    if (capacity <= 0) break;
    const theme = primaryTheme(row);
    if ((reservedByTheme.get(theme) || 0) >= limits.maxPositionsPerTheme) continue;
    const signalPrice = finite(row.metrics?.price);
    const volatility = finite(row.metrics?.volatility60dAnnualized);
    portfolio.pendingOrders.push({
      id: `BUY-${row.ticker}-${row.metrics?.date || String(generatedAt).slice(0, 10)}`,
      side: "BUY",
      ticker: row.ticker,
      name: row.name || "",
      signalDate: row.metrics?.date || String(generatedAt).slice(0, 10),
      createdAt: generatedAt,
      researchScore: row.researchScore?.total ?? null,
      primaryTheme: theme,
      signalPrice,
      volatility60dAnnualized: volatility,
      stopDistancePct: stopDistancePct(volatility, limits),
      reason: "MODEL_INWESTUJ"
    });
    reserved.add(row.ticker);
    reservedByTheme.set(theme, (reservedByTheme.get(theme) || 0) + 1);
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
  for (const position of portfolio.positions) {
    position.allocationPct = value > 0 ? round(position.marketValue / value * 100, 2) : 0;
    position.riskAtStopPct = round(position.allocationPct * position.stopDistancePct / 100, 2);
  }
  const pendingBuyThemes = new Map();
  for (const order of portfolio.pendingOrders.filter((item) => item.side === "BUY")) {
    pendingBuyThemes.set(order.primaryTheme, (pendingBuyThemes.get(order.primaryTheme) || 0) + 1);
  }
  const themeNames = new Set([
    ...portfolio.positions.map((position) => position.primaryTheme),
    ...pendingBuyThemes.keys()
  ]);
  portfolio.themeExposure = [...themeNames].map((theme) => {
    const stats = themePositionStats(portfolio, theme);
    return {
      theme,
      positions: stats.count,
      pendingBuys: pendingBuyThemes.get(theme) || 0,
      marketValue: round(stats.value, 2),
      exposurePct: value > 0 ? round(stats.value / value * 100, 2) : 0
    };
  }).sort((a, b) => b.exposurePct - a.exposurePct || a.theme.localeCompare(b.theme));
  portfolio.riskStatus = portfolio.positions.every((position) => position.allocationPct <= limits.maxPositionPct + 0.05)
    && portfolio.themeExposure.every((theme) => theme.exposurePct <= limits.maxPrimaryThemePct + 0.05 && theme.positions <= limits.maxPositionsPerTheme)
    ? "OK"
    : "BREACH";
  portfolio.realizedPnl = round(portfolio.trades.filter((trade) => trade.side === "SELL").reduce((sum, trade) => sum + (finite(trade.pnl) || 0), 0), 2);
  portfolio.trades = portfolio.trades.slice(-1000);
  portfolio.cancelledOrders = portfolio.cancelledOrders.slice(-1000);
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
      riskStatus: paperPortfolio.riskStatus,
      riskLimits: paperPortfolio.riskLimits,
      benchmarkSymbol: paperPortfolio.benchmarkSymbol,
      benchmarkEntryDate: paperPortfolio.benchmarkEntryDate,
      positions: paperPortfolio.positions,
      orders: paperPortfolio.pendingOrders.slice(0, 30),
      themeExposure: paperPortfolio.themeExposure,
      activity: paperPortfolio.activity,
      recentCancellations: paperPortfolio.cancelledOrders.slice(-30).reverse(),
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
      executionRule: "Paper orders execute at the next session open after gap, sizing and concentration checks",
      riskRule: "Volatility-sized positions; CZEKAJ reduces 50%, ODRZUC and stop breach exit 100%",
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

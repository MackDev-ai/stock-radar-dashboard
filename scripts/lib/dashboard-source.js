const DEFAULT_DASHBOARD_URL = "https://mackdev-ai.github.io/stock-radar-dashboard/";

function normalizeDashboardUrl(value) {
  const url = String(value || DEFAULT_DASHBOARD_URL).trim();
  return `${url.replace(/\/?([?#].*)?$/, "")}/`;
}

function dashboardBaseUrl(env = process.env) {
  return normalizeDashboardUrl(env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL);
}

function dashboardDataUrl(relativePath, configuredUrl, env = process.env) {
  const relative = String(relativePath || "").replace(/^\/+/, "");
  if (env.DASHBOARD_URL) return `${dashboardBaseUrl(env)}${relative}`;
  return configuredUrl || `${dashboardBaseUrl(env)}${relative}`;
}

function dashboardFetchHeaders(extra = {}, env = process.env) {
  const headers = { ...extra };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

module.exports = {
  DEFAULT_DASHBOARD_URL,
  dashboardBaseUrl,
  dashboardDataUrl,
  dashboardFetchHeaders,
  normalizeDashboardUrl
};

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_DASHBOARD_URL,
  dashboardBaseUrl,
  dashboardDataUrl,
  dashboardFetchHeaders,
  normalizeDashboardUrl
} = require("./lib/dashboard-source");
const { shouldRefreshExisting } = require("./restore-public-data");

const root = path.resolve(__dirname, "..");

assert.equal(normalizeDashboardUrl("https://example.pages.dev/path#view"), "https://example.pages.dev/path/");
assert.equal(dashboardBaseUrl({}), DEFAULT_DASHBOARD_URL);
assert.equal(dashboardDataUrl("data/test.json", "https://legacy.example/data/test.json", {}), "https://legacy.example/data/test.json");
assert.equal(
  dashboardDataUrl("data/test.json", "https://legacy.example/data/test.json", { DASHBOARD_URL: "https://private.example" }),
  "https://private.example/data/test.json"
);
assert.deepEqual(dashboardFetchHeaders({ "user-agent": "test" }, {}), { "user-agent": "test" });
assert.deepEqual(dashboardFetchHeaders({}, { CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret" }), {
  "CF-Access-Client-Id": "id",
  "CF-Access-Client-Secret": "secret"
});
assert.equal(shouldRefreshExisting("data/monitoring-data.js", "missing"), false);
assert.equal(shouldRefreshExisting("data/monitoring-data.js", "refresh"), true);
assert.equal(shouldRefreshExisting("data/monitoring-data.js", "refresh-monitoring"), true);
assert.equal(shouldRefreshExisting("data/filing-analysis.json", "refresh-monitoring"), false);

const stockWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "stock-radar.yml"), "utf8");
const filingWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "filing-watch.yml"), "utf8");
const uiWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "dashboard-ui.yml"), "utf8");
assert.match(stockWorkflow, /wrangler@4\.42\.0 pages deploy site-dist/);
assert.match(stockWorkflow, /CF_ACCESS_CLIENT_ID/);
assert.match(stockWorkflow, /ENABLE_GITHUB_PAGES != 'false'/);
assert.match(filingWorkflow, /RESTORE_PUBLIC_DATA_MODE: refresh-monitoring/);
assert.match(uiWorkflow, /RESTORE_PUBLIC_DATA_MODE: refresh/);

console.log("Hosting config check OK: GitHub fallback, Cloudflare Access and refresh modes verified");

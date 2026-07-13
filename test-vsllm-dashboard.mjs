import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = new URL(".", import.meta.url).pathname;
const wrapper = path.join(repoRoot, "bin", "codex-auth-advanced.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-advanced-vsllm-dashboard-"));
const codexHome = path.join(tempRoot, "codex-home");
const accountsDir = path.join(codexHome, "accounts");
fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });

const modelApiKey = "vsllm-2-secret";
const dashboardAccessToken = "dashboard-4242-secret";
const dashboardUserId = 4242;
const nowSeconds = Math.floor(Date.now() / 1000);
const lastResetAt = nowSeconds - 60 * 60;
const nextResetAt = lastResetAt + 8 * 60 * 60;
const subscriptionEndAt = nowSeconds + 7 * 24 * 60 * 60;
const requests = [];
let subscriptionEndpointAvailable = true;
let activeSubscriptions = [
  {
    id: 28897,
    plan_id: 20,
    status: "active",
    start_time: nowSeconds - 20 * 24 * 60 * 60,
    end_time: subscriptionEndAt,
    last_reset_time: lastResetAt,
    next_reset_time: nextResetAt,
    used_percent: 10,
    unlimited: false,
    consume_priority: 0
  }
];

function maskNewApiKey(value) {
  const key = value.replace(/^sk-/, "");
  if (key.length <= 4) return "*".repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}**********${key.slice(-4)}`;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function dashboardAuthenticated(req) {
  return req.headers.authorization === `Bearer ${dashboardAccessToken}`
    && req.headers["new-api-user"] === String(dashboardUserId);
}

const upstream = http.createServer((req, res) => {
  requests.push({
    url: req.url,
    authorization: req.headers.authorization,
    userId: req.headers["new-api-user"]
  });
  if (req.url === "/api/subscription/self") {
    if (!subscriptionEndpointAvailable) {
      json(res, 503, { success: false, message: "temporary dashboard outage" });
      return;
    }
    if (!dashboardAuthenticated(req)) {
      json(res, 401, { success: false, message: "unauthorized" });
      return;
    }
    json(res, 200, {
      success: true,
      message: "",
      data: {
        billing_preference: "subscription_only",
        subscriptions: activeSubscriptions.map((subscription) => ({ subscription })),
        all_subscriptions: []
      }
    });
    return;
  }
  if (req.url.startsWith("/api/token/?")) {
    if (!dashboardAuthenticated(req)) {
      json(res, 401, { success: false, message: "unauthorized" });
      return;
    }
    json(res, 200, {
      success: true,
      message: "",
      data: {
        page: 1,
        page_size: 100,
        total: 1,
        items: [{ id: 77, name: "Codex", key: maskNewApiKey(modelApiKey) }]
      }
    });
    return;
  }
  if (req.url === "/v1/models") {
    if (req.headers.authorization !== `Bearer ${modelApiKey}`) {
      json(res, 401, { error: { message: "invalid api key" } });
      return;
    }
    json(res, 403, {
      error: {
        message: "当前订阅额度不足或暂不可用，请稍后再试或联系管理员"
      }
    });
    return;
  }
  if (req.url.startsWith("/v1/usage?")) {
    json(res, 200, { usage: { total: { actual_cost: 96.242272 } } });
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function runWrapper(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempRoot,
        CODEX_HOME: codexHome
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if ((code ?? 1) !== 0 || signal) {
        reject(new Error(`wrapper failed with ${signal || code}:\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const upstreamPort = await listen(upstream);
const origin = `http://127.0.0.1:${upstreamPort}`;
const accountKey = "apikey-vsllm-2";
fs.writeFileSync(path.join(accountsDir, `${accountKey}.auth.json`), JSON.stringify({
  auth_mode: "apikey",
  OPENAI_API_KEY: modelApiKey,
  account_key: accountKey,
  alias: "vsllm-2"
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(accountsDir, `${accountKey}.config.toml`), [
  'model_provider = "OpenAI"',
  "",
  "[model_providers.OpenAI]",
  'name = "OpenAI"',
  `base_url = "${origin}"`,
  'wire_api = "responses"',
  'requires_openai_auth = true',
  ""
].join("\n"), { mode: 0o600 });
fs.writeFileSync(path.join(accountsDir, "registry.json"), JSON.stringify({
  schema_version: 2,
  active_account_key: accountKey,
  auto_switch: { enabled: false },
  accounts: [
    {
      account_key: accountKey,
      alias: "vsllm-2",
      email: "vsllm-2",
      auth_mode: "apikey",
      api_spend_limit_usd: 55,
      api_spend_window_minutes: 480,
      api_spend: {
        spend_usd: 55.5,
        total_spend_usd: 96.242272,
        limit_usd: 55,
        remaining_usd: 0,
        exhausted: true
      },
      last_usage: {
        primary: { used_percent: 100 },
        secondary: { used_percent: 100 }
      },
      api_exhausted_reason: "rolling_limit"
    }
  ]
}, null, 2), { mode: 0o600 });

try {
  const result = await runWrapper([
    "config",
    "vsllm-dashboard",
    "--user-id",
    String(dashboardUserId),
    "--alias",
    "fixture-vsllm-dashboard",
    "--origin",
    origin,
    "--stdin"
  ], `${dashboardAccessToken}\n`);

  if (!result.stdout.includes("Configured fixture-vsllm-dashboard (dashboard user 4242) for vsllm-2.")) {
    throw new Error(`unexpected setup output:\n${result.stdout}\n${result.stderr}`);
  }
  if (!result.stdout.includes("subscription: active, 90% remaining")) {
    throw new Error(`expected exact subscription percentage in output, got:\n${result.stdout}`);
  }
  if (`${result.stdout}\n${result.stderr}`.includes(dashboardAccessToken) || `${result.stdout}\n${result.stderr}`.includes(modelApiKey)) {
    throw new Error("credential setup output leaked a secret");
  }

  const registry = JSON.parse(fs.readFileSync(path.join(accountsDir, "registry.json"), "utf8"));
  const account = registry.accounts[0];
  if (account.provider_dashboard?.user_id !== dashboardUserId || account.provider_dashboard?.alias !== "fixture-vsllm-dashboard") {
    throw new Error(`dashboard metadata was not linked to the account: ${JSON.stringify(account.provider_dashboard)}`);
  }
  if (JSON.stringify(registry).includes(dashboardAccessToken)) {
    throw new Error("registry must not contain the dashboard access token");
  }
  if (account.api_spend?.source !== "provider_subscription" || account.api_spend?.exhausted !== false) {
    throw new Error(`subscription data did not replace stale rolling exhaustion: ${JSON.stringify(account.api_spend)}`);
  }
  if (account.api_spend?.used_percent !== 10 || account.api_spend?.reset_at !== nextResetAt) {
    throw new Error(`subscription timestamps or percentage were not persisted: ${JSON.stringify(account.api_spend)}`);
  }
  if (account.api_spend?.spend_usd !== 5.5 || account.api_spend?.remaining_usd !== 49.5) {
    throw new Error(`configured $55 cap was not projected from provider usage: ${JSON.stringify(account.api_spend)}`);
  }
  if (account.last_usage?.primary?.used_percent !== 10 || account.last_usage?.primary?.resets_at !== nextResetAt) {
    throw new Error(`last_usage did not use the provider reset window: ${JSON.stringify(account.last_usage)}`);
  }
  if (account.api_exhausted_reason != null) {
    throw new Error(`fresh active subscription should clear stale exhaustion reason: ${account.api_exhausted_reason}`);
  }

  subscriptionEndpointAvailable = false;
  await runWrapper(["config", "api-spend-limit", "vsllm-2", "55"]);
  const registryDuringDashboardOutage = JSON.parse(fs.readFileSync(path.join(accountsDir, "registry.json"), "utf8"));
  const accountDuringDashboardOutage = registryDuringDashboardOutage.accounts[0];
  if (accountDuringDashboardOutage.api_spend?.source !== "provider_subscription"
    || accountDuringDashboardOutage.api_spend?.used_percent !== 10
    || accountDuringDashboardOutage.api_spend?.exhausted !== false) {
    throw new Error(`dashboard outage should preserve the last authoritative subscription state: ${JSON.stringify(accountDuringDashboardOutage.api_spend)}`);
  }

  subscriptionEndpointAvailable = true;
  const fiveHourResetAt = nowSeconds + 4 * 60 * 60;
  const eightHourResetAt = nowSeconds + 7 * 60 * 60;
  activeSubscriptions = [
    {
      id: 30001,
      plan_id: 13,
      status: "active",
      start_time: nowSeconds - 10 * 24 * 60 * 60,
      end_time: subscriptionEndAt,
      last_reset_time: fiveHourResetAt - 5 * 60 * 60,
      next_reset_time: fiveHourResetAt,
      used_percent: 100,
      unlimited: false,
      consume_priority: 0
    },
    {
      id: 30002,
      plan_id: 20,
      status: "active",
      start_time: nowSeconds - 10 * 24 * 60 * 60,
      end_time: subscriptionEndAt,
      last_reset_time: eightHourResetAt - 8 * 60 * 60,
      next_reset_time: eightHourResetAt,
      used_percent: 40,
      unlimited: false,
      consume_priority: 1
    }
  ];
  await runWrapper(["config", "api-spend-limit", "vsllm-2", "55"]);
  const mixedSubscriptionRegistry = JSON.parse(fs.readFileSync(path.join(accountsDir, "registry.json"), "utf8"));
  const mixedSubscriptionAccount = mixedSubscriptionRegistry.accounts[0];
  if (mixedSubscriptionAccount.api_spend?.active_subscription_count !== 2
    || mixedSubscriptionAccount.api_spend?.plan_id !== 20
    || mixedSubscriptionAccount.api_spend?.used_percent !== 40
    || mixedSubscriptionAccount.api_spend?.reset_at !== eightHourResetAt
    || mixedSubscriptionAccount.api_spend?.exhausted !== false) {
    throw new Error(`a usable secondary subscription should keep the account available: ${JSON.stringify(mixedSubscriptionAccount.api_spend)}`);
  }

  activeSubscriptions[1] = { ...activeSubscriptions[1], used_percent: 100 };
  await runWrapper(["config", "api-spend-limit", "vsllm-2", "55"]);
  const exhaustedSubscriptionRegistry = JSON.parse(fs.readFileSync(path.join(accountsDir, "registry.json"), "utf8"));
  const exhaustedSubscriptionAccount = exhaustedSubscriptionRegistry.accounts[0];
  if (exhaustedSubscriptionAccount.api_spend?.active_subscription_count !== 2
    || exhaustedSubscriptionAccount.api_spend?.exhausted !== true
    || exhaustedSubscriptionAccount.api_exhausted_reason !== "subscription_limit") {
    throw new Error(`all active subscriptions at 100% should exhaust the account: ${JSON.stringify(exhaustedSubscriptionAccount)}`);
  }

  const credentialsDir = path.join(accountsDir, "provider-dashboard");
  const credentialFiles = fs.readdirSync(credentialsDir);
  if (credentialFiles.length !== 1) {
    throw new Error(`expected one dashboard credential file, got ${credentialFiles.length}`);
  }
  const credentialPath = path.join(credentialsDir, credentialFiles[0]);
  const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
  if (credential.user_id !== dashboardUserId || credential.account_key !== accountKey || credential.access_token !== dashboardAccessToken) {
    throw new Error("private dashboard credential file has incorrect identity data");
  }
  if ((fs.statSync(credentialPath).mode & 0o777) !== 0o600) {
    throw new Error("dashboard credential file must use mode 0600");
  }

  const dashboardRequests = requests.filter((request) => request.url.startsWith("/api/"));
  if (dashboardRequests.length < 3 || dashboardRequests.some((request) => (
    request.authorization !== `Bearer ${dashboardAccessToken}` || request.userId !== String(dashboardUserId)
  ))) {
    throw new Error(`dashboard requests used incorrect authentication: ${JSON.stringify(dashboardRequests)}`);
  }

  console.log("vsllm dashboard subscription extraction ok");
} finally {
  upstream.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPackageJsonPath = path.join(__dirname, "..", "package.json");
const requiredNodeMajor = 22;
const invokedCommandName = path.basename(process.argv[1] ?? "codex-auth", path.extname(process.argv[1] ?? ""));
const apiSpendLimitFlags = new Set(["--api-spend-limit-usd", "--api-limit-usd", "--spend-limit-usd"]);

function ensureSupportedNodeVersion() {
  const major = Number(process.versions?.node?.split(".")[0] ?? 0);
  if (Number.isInteger(major) && major >= requiredNodeMajor) {
    return;
  }

  console.error(
    `Node.js ${requiredNodeMajor}+ is required to run codex-auth-advanced. Current version: ${process.version}.`
  );
  process.exit(1);
}

ensureSupportedNodeVersion();

function userHome() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || normalDefaultCodexHome();
}

function normalDefaultCodexHome() {
  return path.join(userHome(), ".codex");
}

function managedGroupCodexHome(groupName) {
  if (groupName === "default") {
    return normalDefaultCodexHome();
  }
  return path.join(userHome(), "codex-auth-advanced", "groups", groupName);
}

function isApiKeyAwareGroupList(argv) {
  return argv.length >= 3 && argv[0] === "group" && argv[2] === "list" && !argv.includes("--live");
}

function isApiKeyAwareManagedList(argv) {
  return argv.length >= 1 && argv[0] === "list" && !argv.includes("--live");
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyFilePrivate(sourcePath, targetPath) {
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o600);
}

function timestampForBackup() {
  const now = new Date();
  const pad2 = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    "-",
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds())
  ].join("");
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.bak.${timestampForBackup()}`;
  fs.copyFileSync(filePath, backupPath);
  fs.chmodSync(backupPath, 0o600);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function accountFileKey(accountKey) {
  if (/^[A-Za-z0-9_.-]+$/.test(accountKey) && accountKey !== "." && accountKey !== "..") {
    return accountKey;
  }
  return Buffer.from(accountKey, "utf8").toString("base64url");
}

function accountAuthPath(codexHome, accountKey) {
  return path.join(codexHome, "accounts", `${accountFileKey(accountKey)}.auth.json`);
}

function accountConfigPath(codexHome, accountKey) {
  return path.join(codexHome, "accounts", `${accountFileKey(accountKey)}.config.toml`);
}

function rootConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

function accountKeyFromApiKey(apiKey) {
  return `apikey-${crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

function registryPath(codexHome) {
  return path.join(codexHome, "accounts", "registry.json");
}

function defaultApiKeyConfig(baseUrl) {
  const cleanedBaseUrl = String(baseUrl || "https://api.openai.com/").trim() || "https://api.openai.com/";
  return [
    'model_provider = "OpenAI"',
    'model = "gpt-5.4"',
    'review_model = "gpt-5.4"',
    'model_reasoning_effort = "xhigh"',
    'disable_response_storage = true',
    'network_access = "enabled"',
    'windows_wsl_setup_acknowledged = true',
    'model_context_window = 1000000',
    'model_auto_compact_token_limit = 900000',
    "",
    "[model_providers.OpenAI]",
    'name = "OpenAI"',
    `base_url = ${JSON.stringify(cleanedBaseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    ""
  ].join("\n");
}

function apiKeyTemplate(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized === "openai") {
    return {
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultSpendLimitUsd: null
    };
  }
  if (normalized === "codex-everywhere" || normalized === "codex_everywhere" || normalized === "everywhere") {
    return {
      name: "codex-everywhere",
      baseUrl: "https://codex-everywhere.com/",
      defaultSpendLimitUsd: 50
    };
  }
  return null;
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

function readBaseUrl(configPath) {
  try {
    const data = fs.readFileSync(configPath, "utf8");
    for (const rawLine of data.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("base_url")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const value = parseTomlString(line.slice(eq + 1));
      if (value) return value;
    }
  } catch {
    return null;
  }
  return null;
}

function modelsEndpointFromBaseUrl(baseUrl) {
  const cleaned = String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!cleaned) return "https://api.openai.com/v1/models";
  if (cleaned.endsWith("/models")) return cleaned;
  if (cleaned.endsWith("/v1")) return `${cleaned}/models`;
  return `${cleaned}/v1/models`;
}

function apiBaseFromModelsEndpoint(endpoint) {
  return String(endpoint).replace(/\/models\/?$/, "");
}

function costsEndpointFromModelsEndpoint(endpoint, startTime, endTime) {
  const apiBase = apiBaseFromModelsEndpoint(endpoint);
  const params = new URLSearchParams({
    start_time: String(startTime),
    end_time: String(endTime),
    bucket_width: "1d",
    limit: "31"
  });
  return `${apiBase}/organization/costs?${params.toString()}`;
}

function usageEndpointFromModelsEndpoint(endpoint, date) {
  return `${apiBaseFromModelsEndpoint(endpoint)}/usage?date=${encodeURIComponent(date)}`;
}

function loadApiKeyAccountsForGroup(groupName) {
  const codexHome = managedGroupCodexHome(groupName);
  return loadApiKeyAccountsFromCodexHome(groupName, codexHome);
}

function loadManagedGroups() {
  const groups = [{ name: "default", codexHome: normalDefaultCodexHome() }];
  const config = readJsonFile(path.join(userHome(), "codex-auth-advanced", "config.json"));
  if (config && Array.isArray(config.groups)) {
    for (const group of config.groups) {
      if (!group || typeof group.name !== "string" || typeof group.codex_home !== "string") continue;
      groups.push({ name: group.name, codexHome: group.codex_home });
    }
  }
  return groups;
}

function loadApiKeyAccountsForManagedList() {
  return loadManagedGroups().flatMap((group) => loadApiKeyAccountsFromCodexHome(group.name, group.codexHome));
}

function loadApiKeyAccountsFromCodexHome(groupName, codexHome) {
  const registry = readJsonFile(path.join(codexHome, "accounts", "registry.json"));
  if (!registry || !Array.isArray(registry.accounts)) return [];

  return registry.accounts
    .filter((account) => account && account.auth_mode === "apikey" && typeof account.account_key === "string")
    .map((account) => {
      const authPath = accountAuthPath(codexHome, account.account_key);
      const authJson = readJsonFile(authPath);
      const apiKey = typeof authJson?.OPENAI_API_KEY === "string" ? authJson.OPENAI_API_KEY : "";
      const baseUrl = readBaseUrl(accountConfigPath(codexHome, account.account_key));
      return {
        groupName,
        codexHome,
        account,
        apiKey,
        endpoint: modelsEndpointFromBaseUrl(baseUrl)
      };
    })
    .filter((entry) => entry.apiKey.length > 0);
}

async function checkApiKeyAccount(entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(entry.endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": "codex-auth-advanced"
      },
      signal: controller.signal
    });
    const costs = response.status === 200 || response.status === 429
      ? await fetchApiKeyCosts(entry)
      : { daily: null, weekly: null, spend: null, limitUsd: null };
    const limitUsd = apiSpendLimitUsd(entry.account) ?? costs.limitUsd;
    const exhausted = isApiKeyLimitExhausted(response.status, costs.spend, limitUsd);
    return {
      entry,
      ok: response.status === 200,
      label: exhausted ? "0%" : response.status === 200 ? "-" : String(response.status),
      daily: costs.daily,
      weekly: costs.weekly,
      spend: costs.spend,
      limitUsd,
      exhausted,
      status: response.status
    };
  } catch (error) {
    const name = error?.name === "AbortError" ? "TimedOut" : "RequestFailed";
    return { entry, ok: false, label: name, daily: null, weekly: null, spend: null, limitUsd: apiSpendLimitUsd(entry.account), exhausted: false, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

function utcStartOfTodaySeconds() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

function parseCostsTotal(body) {
  if (!body || !Array.isArray(body.data)) return null;
  let total = 0;
  let found = false;
  for (const bucket of body.data) {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const result of results) {
      const value = Number(result?.amount?.value);
      if (!Number.isFinite(value)) continue;
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

async function fetchCostTotal(entry, startTime, endTime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(costsEndpointFromModelsEndpoint(entry.endpoint, startTime, endTime), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": "codex-auth-advanced"
      },
      signal: controller.signal
    });
    if (response.status !== 200) return null;
    return parseCostsTotal(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isoDateFromSeconds(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function parseProviderUsageDetails(body) {
  const subscription = body?.subscription;
  const daily = Number(subscription?.daily_usage_usd);
  const monthly = Number(subscription?.monthly_usage_usd);
  const weekly = Number(subscription?.weekly_usage_usd);
  const dailyLimit = Number(subscription?.daily_limit_usd);
  const monthlyLimit = Number(subscription?.monthly_limit_usd);
  const weeklyLimit = Number(subscription?.weekly_limit_usd);
  const remaining = Number(body?.remaining);
  const fallback = Number(body?.total_cost ?? body?.cost ?? body?.usage_usd);
  const fallbackValue = Number.isFinite(fallback) ? fallback : null;
  const primaryUsage = Number.isFinite(daily)
    ? daily
    : Number.isFinite(weekly)
      ? weekly
      : Number.isFinite(monthly)
        ? monthly
        : fallbackValue;
  const primaryLimit = Number.isFinite(dailyLimit) && dailyLimit > 0
    ? dailyLimit
    : Number.isFinite(weeklyLimit) && weeklyLimit > 0
      ? weeklyLimit
      : Number.isFinite(monthlyLimit) && monthlyLimit > 0
        ? monthlyLimit
        : null;
  return {
    daily: Number.isFinite(daily) ? daily : fallbackValue,
    monthly: Number.isFinite(monthly) ? monthly : fallbackValue,
    spend: primaryUsage,
    limitUsd: primaryLimit,
    remaining: Number.isFinite(remaining) ? remaining : null
  };
}

async function fetchProviderUsage(entry, date) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(usageEndpointFromModelsEndpoint(entry.endpoint, date), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": "codex-auth-advanced"
      },
      signal: controller.signal
    });
    if (response.status !== 200) return null;
    return parseProviderUsageDetails(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApiKeyCosts(entry) {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = utcStartOfTodaySeconds();
  const weekStart = now - 7 * 24 * 60 * 60;
  const spendStart = now - 31 * 24 * 60 * 60;
  const [daily, weekly, spend] = await Promise.all([
    fetchCostTotal(entry, dayStart, now),
    fetchCostTotal(entry, weekStart, now),
    fetchCostTotal(entry, spendStart, now)
  ]);
  if (daily != null || weekly != null || spend != null) return { daily, weekly, spend };

  const providerDaily = await fetchProviderUsage(entry, isoDateFromSeconds(now));
  return {
    daily: providerDaily?.daily ?? null,
    weekly: providerDaily?.monthly ?? providerDaily?.daily ?? null,
    spend: providerDaily?.spend ?? providerDaily?.monthly ?? providerDaily?.daily ?? null,
    limitUsd: providerDaily?.limitUsd ?? null,
    remaining: providerDaily?.remaining ?? null
  };
}

function moneyUsed(value) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toFixed(2)} used`;
}

function moneyLimitStatus(spend, limitUsd) {
  if (!Number.isFinite(limitUsd)) return moneyUsed(spend);
  if (!Number.isFinite(spend)) return `$0.00/$${limitUsd.toFixed(2)}`;
  return `$${spend.toFixed(2)}/$${limitUsd.toFixed(2)}`;
}

function apiSpendLimitUsd(account) {
  const value = Number(account?.api_spend_limit_usd);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isApiKeyLimitExhausted(status, spend, limitUsd) {
  if (status === 429) return true;
  return Number.isFinite(limitUsd) && Number.isFinite(spend) && spend >= limitUsd;
}

function usageSnapshotForApiSpend(spend, limitUsd, exhausted) {
  const usedPercent = exhausted
    ? 100
    : Number.isFinite(spend) && Number.isFinite(limitUsd) && limitUsd > 0
      ? Math.max(0, Math.min(99, Math.floor((spend / limitUsd) * 100)))
      : 0;
  return {
    primary: {
      used_percent: usedPercent,
      window_minutes: 44640,
      resets_at: null
    },
    secondary: {
      used_percent: usedPercent,
      window_minutes: 44640,
      resets_at: null
    },
    credits: {
      has_credits: !exhausted,
      unlimited: false,
      balance: Number.isFinite(limitUsd) && Number.isFinite(spend) ? String(Math.max(0, limitUsd - spend)) : null
    },
    plan_type: "apikey"
  };
}

function parseApiSpendLimitArgs(argv) {
  const stripped = [];
  let limitUsd = null;
  let found = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!apiSpendLimitFlags.has(flag)) {
      stripped.push(arg);
      continue;
    }

    found = true;
    const rawValue = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    const parsed = Number(rawValue);
    if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
      console.error(`${flag} requires a positive dollar amount, for example ${flag} 50.`);
      process.exit(1);
    }
    limitUsd = parsed;
  }

  return { argv: stripped, limitUsd, found };
}

function importCommandInfo(argv) {
  if (argv[0] === "import") {
    return { codexHome: defaultCodexHome(), args: argv.slice(1) };
  }
  if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "import") {
    return { codexHome: managedGroupCodexHome(argv[1]), args: argv.slice(3) };
  }
  return null;
}

function importAlias(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--alias") return args[i + 1] ?? null;
    if (args[i].startsWith("--alias=")) return args[i].slice("--alias=".length);
  }
  return null;
}

function importPathArg(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--alias") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    return arg;
  }
  return args.includes("--cpa") ? path.join(userHome(), ".cli-proxy-api") : null;
}

function extractApiKeyFromJson(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["OPENAI_API_KEY", "api_key", "apiKey", "key"]) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key];
  }
  return null;
}

function readApiKeysFromImportPath(importPath) {
  if (!importPath) return [];
  const keys = [];
  const addFile = (filePath) => {
    const data = readJsonFile(filePath);
    const apiKey = extractApiKeyFromJson(data);
    if (apiKey) keys.push(apiKey);
  };

  try {
    const stat = fs.statSync(importPath);
    if (stat.isFile()) {
      addFile(importPath);
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(importPath)) {
        if (!name.endsWith(".json")) continue;
        addFile(path.join(importPath, name));
      }
    }
  } catch {
    return [];
  }

  return [...new Set(keys)];
}

function applyApiSpendLimitToImportedAccounts(codexHome, args, limitUsd) {
  if (!Number.isFinite(limitUsd)) return;
  const registry = readJsonFile(registryPath(codexHome));
  if (!registry || !Array.isArray(registry.accounts)) return;

  const accountKeys = new Set(readApiKeysFromImportPath(importPathArg(args)).map(accountKeyFromApiKey));
  const alias = importAlias(args);
  let changed = false;

  for (const account of registry.accounts) {
    if (!account || account.auth_mode !== "apikey") continue;
    const matchesKey = accountKeys.has(account.account_key);
    const matchesAlias = alias && account.alias === alias;
    if (!matchesKey && !matchesAlias) continue;
    if (account.api_spend_limit_usd === limitUsd) continue;
    account.api_spend_limit_usd = limitUsd;
    changed = true;
  }

  if (changed) {
    writeJsonFile(registryPath(codexHome), registry);
  }
}

function accountMatchesQuery(account, query) {
  const normalized = String(query || "").toLowerCase();
  if (/^\d+$/.test(normalized)) return false;
  return [account.account_key, account.alias, account.email, account.account_name, account.chatgpt_account_id]
    .filter((value) => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized));
}

function accountLabel(account) {
  return account.alias || account.email || account.account_name || account.account_key;
}

function accountPlanLabel(account) {
  if (account.auth_mode === "apikey") return "API";
  if (account.plan === "team") return "Business";
  if (typeof account.plan === "string" && account.plan.length > 0) {
    return `${account.plan[0].toUpperCase()}${account.plan.slice(1)}`;
  }
  return "-";
}

function accountUsageLabel(account, which) {
  const usage = which === "primary" ? account.last_usage?.primary : account.last_usage?.secondary;
  if (!usage || !Number.isFinite(Number(usage.used_percent))) return "-";
  return `${Math.max(0, 100 - Number(usage.used_percent))}%`;
}

function accountIsExhausted(account) {
  if (account.auth_mode === "apikey" && account.api_spend?.exhausted === true) return true;
  const primary = Number(account.last_usage?.primary?.used_percent);
  const secondary = Number(account.last_usage?.secondary?.used_percent);
  return Number.isFinite(primary) && primary >= 100 || Number.isFinite(secondary) && secondary >= 100;
}

function accountSortTime(account) {
  return Number(account.last_used_at || account.created_at || 0);
}

function sortedRegistryAccounts(registry) {
  return [...registry.accounts].sort((a, b) => accountSortTime(b) - accountSortTime(a));
}

function findAccountForSwitch(registry, query) {
  const accounts = sortedRegistryAccounts(registry);
  if (/^\d+$/.test(String(query || ""))) {
    const index = Number(query) - 1;
    return accounts[index] ? { account: accounts[index], ambiguous: false } : { account: null, ambiguous: false };
  }
  const matches = accounts.filter((account) => accountMatchesQuery(account, query));
  if (matches.length === 1) return { account: matches[0], ambiguous: false };
  if (matches.length > 1) return { account: null, ambiguous: true, matches };
  return { account: null, ambiguous: false };
}

function parseSwitchCommand(argv) {
  if (argv[0] === "switch") {
    return { codexHome: defaultCodexHome(), args: argv.slice(1) };
  }
  if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "switch") {
    return { codexHome: managedGroupCodexHome(argv[1]), args: argv.slice(3) };
  }
  return null;
}

function hasUnsupportedSwitchFlags(args) {
  return args.some((arg) => arg === "--live" || arg === "--auto" || arg === "--api" || arg === "--skip-api");
}

function switchToStoredAccount(codexHome, account) {
  const authPath = accountAuthPath(codexHome, account.account_key);
  if (!fs.existsSync(authPath)) {
    console.error(`Missing auth file for ${accountLabel(account)}: ${authPath}`);
    process.exit(1);
  }

  const rootAuthPath = path.join(codexHome, "auth.json");
  const rootConfig = rootConfigPath(codexHome);
  ensureDir(codexHome);
  backupIfExists(rootAuthPath);
  copyFilePrivate(authPath, rootAuthPath);

  if (account.auth_mode === "apikey") {
    const configPath = accountConfigPath(codexHome, account.account_key);
    if (fs.existsSync(configPath)) {
      backupIfExists(rootConfig);
      copyFilePrivate(configPath, rootConfig);
    }
  }

  const registryFile = registryPath(codexHome);
  const registry = readJsonFile(registryFile);
  if (registry && Array.isArray(registry.accounts)) {
    registry.active_account_key = account.account_key;
    registry.active_account_activated_at_ms = Date.now();
    const existing = registry.accounts.find((item) => item?.account_key === account.account_key);
    if (existing) existing.last_used_at = Math.floor(Date.now() / 1000);
    writeJsonFile(registryFile, registry);
    fs.chmodSync(registryFile, 0o600);
  }
  if (account.auth_mode !== "apikey") {
    ensureActiveAccountConfig(codexHome);
  }

  process.stdout.write(`Switched to ${accountLabel(account)}.\n`);
}

function renderSwitchRows(accounts, activeAccountKey) {
  const rows = accounts.map((account, index) => ({
    index: String(index + 1).padStart(2, "0"),
    marker: account.account_key === activeAccountKey ? "*" : " ",
    account: accountLabel(account),
    plan: accountPlanLabel(account),
    fiveHour: accountUsageLabel(account, "primary"),
    weekly: accountUsageLabel(account, "secondary"),
    exhausted: accountIsExhausted(account) ? "yes" : "no"
  }));
  const widths = {
    account: Math.max("ACCOUNT".length, ...rows.map((row) => row.account.length)),
    plan: Math.max("PLAN".length, ...rows.map((row) => row.plan.length)),
    fiveHour: Math.max("5H LEFT".length, ...rows.map((row) => row.fiveHour.length)),
    weekly: Math.max("WEEKLY LEFT".length, ...rows.map((row) => row.weekly.length)),
    exhausted: Math.max("EXHAUSTED".length, ...rows.map((row) => row.exhausted.length))
  };
  const header = `     ${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("EXHAUSTED", widths.exhausted)}`;
  process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
  for (const row of rows) {
    process.stdout.write(`${row.marker} ${row.index} ${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.exhausted, widths.exhausted)}\n`);
  }
}

function maybeHandleStoredSwitch(argv) {
  const command = parseSwitchCommand(argv);
  if (!command || hasUnsupportedSwitchFlags(command.args)) return false;

  const registry = readJsonFile(registryPath(command.codexHome));
  if (!registry || !Array.isArray(registry.accounts)) return false;
  if (!registry.accounts.some((account) => account?.auth_mode === "apikey")) return false;

  const query = command.args.join(" ").trim();
  if (query) {
    const result = findAccountForSwitch(registry, query);
    if (result.ambiguous) {
      console.error(`Multiple accounts matched "${query}". Use a more specific alias, email, account_key, or row number.`);
      process.exit(1);
    }
    if (!result.account) {
      console.error(`No account matched "${query}".`);
      process.exit(1);
    }
    switchToStoredAccount(command.codexHome, result.account);
    return true;
  }

  if (!process.stdin.isTTY) return false;
  const accounts = sortedRegistryAccounts(registry);
  renderSwitchRows(accounts, registry.active_account_key);
  const selected = readLineFromTty("Switch to account number, alias, or email [q to quit]: ");
  if (!selected || selected.toLowerCase() === "q") {
    process.stdout.write("No account switched.\n");
    return true;
  }
  const result = findAccountForSwitch(registry, selected);
  if (result.ambiguous) {
    console.error(`Multiple accounts matched "${selected}". Use a more specific selector.`);
    process.exit(1);
  }
  if (!result.account) {
    console.error(`No account matched "${selected}".`);
    process.exit(1);
  }
  switchToStoredAccount(command.codexHome, result.account);
  return true;
}

function setApiSpendLimit(codexHome, query, limitUsd) {
  const filePath = registryPath(codexHome);
  const registry = readJsonFile(filePath);
  if (!registry || !Array.isArray(registry.accounts)) {
    console.error(`No registry found at ${filePath}.`);
    process.exit(1);
  }

  const matches = registry.accounts.filter((account) => account?.auth_mode === "apikey" && accountMatchesQuery(account, query));
  if (matches.length === 0) {
    console.error(`No API-key account matched "${query}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple API-key accounts matched "${query}". Use a more specific alias, email, or account_key.`);
    process.exit(1);
  }

  matches[0].api_spend_limit_usd = limitUsd;
  writeJsonFile(filePath, registry);
  process.stdout.write(`Set API spend limit for ${matches[0].alias || matches[0].email || matches[0].account_key} to $${limitUsd.toFixed(2)}.\n`);
}

function parseAddApiKeyArgs(args) {
  const options = {
    alias: "",
    email: "",
    template: null,
    baseUrl: null,
    spendLimitUsd: null,
    apiKey: null,
    stdin: false,
    interactive: args.length === 0
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const nextValue = () => {
      const value = args[++i];
      if (!value) {
        console.error(`${arg} requires a value.`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--alias") {
      options.alias = nextValue();
    } else if (arg.startsWith("--alias=")) {
      options.alias = arg.slice("--alias=".length);
    } else if (arg === "--email") {
      options.email = nextValue();
    } else if (arg.startsWith("--email=")) {
      options.email = arg.slice("--email=".length);
    } else if (arg === "--base-url") {
      options.baseUrl = nextValue();
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--template") {
      options.template = nextValue();
    } else if (arg.startsWith("--template=")) {
      options.template = arg.slice("--template=".length);
    } else if (arg === "--api-spend-limit-usd" || arg === "--api-limit-usd" || arg === "--spend-limit-usd") {
      options.spendLimitUsd = Number(nextValue());
    } else if (arg.startsWith("--api-spend-limit-usd=")) {
      options.spendLimitUsd = Number(arg.slice("--api-spend-limit-usd=".length));
    } else if (arg.startsWith("--api-limit-usd=")) {
      options.spendLimitUsd = Number(arg.slice("--api-limit-usd=".length));
    } else if (arg.startsWith("--spend-limit-usd=")) {
      options.spendLimitUsd = Number(arg.slice("--spend-limit-usd=".length));
    } else if (arg === "--api-key") {
      options.apiKey = nextValue();
    } else if (arg.startsWith("--api-key=")) {
      options.apiKey = arg.slice("--api-key=".length);
    } else if (arg === "--stdin" || arg === "--api-key-stdin") {
      options.stdin = true;
    } else {
      console.error(`unknown argument for add-api-key: ${arg}`);
      process.exit(1);
    }
  }

  if (options.spendLimitUsd != null && (!Number.isFinite(options.spendLimitUsd) || options.spendLimitUsd <= 0)) {
    console.error("--api-spend-limit-usd requires a positive dollar amount.");
    process.exit(1);
  }

  if (options.interactive) {
    populateInteractiveAddApiKeyOptions(options);
  }

  const template = apiKeyTemplate(options.template ?? "openai");
  if (!template) {
    console.error("--template must be either openai or codex-everywhere.");
    process.exit(1);
  }
  options.template = template.name;
  options.baseUrl = options.baseUrl || template.baseUrl;
  if (options.spendLimitUsd == null && Number.isFinite(template.defaultSpendLimitUsd)) {
    options.spendLimitUsd = template.defaultSpendLimitUsd;
  }

  return options;
}

function readLineFromTty(prompt) {
  process.stderr.write(prompt);
  const chunks = [];
  const buf = Buffer.alloc(1);
  while (true) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch (error) {
      if (error?.code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      throw error;
    }
    if (n === 0) break;
    if (buf[0] === 10 || buf[0] === 13) break;
    chunks.push(Buffer.from(buf));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function requireInteractiveTty(command) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`${command} requires an interactive terminal, or pass --template/--alias/--stdin explicitly.`);
    process.exit(1);
  }
}

function parsePositiveMoney(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${label} must be a positive dollar amount.`);
    process.exit(1);
  }
  return parsed;
}

function promptTemplateName() {
  process.stderr.write("API key add mode:\n");
  process.stderr.write("  1) Use template: OpenAI\n");
  process.stderr.write("  2) Use template: Codex-Everywhere\n");
  process.stderr.write("  3) Custom provider (current/manual behavior)\n");
  while (true) {
    const choice = readLineFromTty("Choose [1-3]: ");
    if (choice === "" || choice === "1") return "openai";
    if (choice === "2") return "codex-everywhere";
    if (choice === "3") return "custom";
    process.stderr.write("Please choose 1, 2, or 3.\n");
  }
}

function populateInteractiveAddApiKeyOptions(options) {
  requireInteractiveTty("add-api-key");
  const templateName = promptTemplateName();
  if (templateName === "custom") {
    options.template = "openai";
    const baseUrl = readLineFromTty("Base URL [https://api.openai.com/v1]: ");
    options.baseUrl = baseUrl || "https://api.openai.com/v1";
  } else {
    options.template = templateName;
  }

  const alias = readLineFromTty("Alias: ");
  if (alias) options.alias = alias;

  const email = readLineFromTty("Display email/name [same as alias]: ");
  if (email) options.email = email;

  const template = apiKeyTemplate(options.template);
  const defaultLimit = template?.defaultSpendLimitUsd;
  const limitPrompt = Number.isFinite(defaultLimit)
    ? `Spend limit USD [${defaultLimit}]: `
    : "Spend limit USD [none]: ";
  const limit = readLineFromTty(limitPrompt);
  if (limit) {
    options.spendLimitUsd = parsePositiveMoney(limit, "Spend limit");
  } else if (Number.isFinite(defaultLimit)) {
    options.spendLimitUsd = defaultLimit;
  }
}

function readApiKeyForAdd(options) {
  if (options.apiKey) return options.apiKey.trim();
  if (options.stdin) return fs.readFileSync(0, "utf8").trim();
  if (process.env.CODEX_AUTH_API_KEY) return process.env.CODEX_AUTH_API_KEY.trim();
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  if (process.stdin.isTTY && process.stderr.isTTY) return readSecretLineFromTty("API key: ");
  console.error("add-api-key requires --stdin, --api-key, CODEX_AUTH_API_KEY, OPENAI_API_KEY, or an interactive terminal.");
  process.exit(1);
}

function readSecretLineFromTty(prompt) {
  process.stderr.write(prompt);
  if (process.platform !== "win32") {
    spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  }
  try {
    const chunks = [];
    const buf = Buffer.alloc(1);
    while (true) {
      let n = 0;
      try {
        n = fs.readSync(0, buf, 0, 1, null);
      } catch (error) {
        if (error?.code === "EAGAIN") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          continue;
        }
        throw error;
      }
      if (n === 0) break;
      if (buf[0] === 10 || buf[0] === 13) break;
      chunks.push(Buffer.from(buf));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    if (process.platform !== "win32") {
      spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
    }
    process.stderr.write("\n");
  }
}

function loadOrCreateRegistry(codexHome) {
  const filePath = registryPath(codexHome);
  const existing = readJsonFile(filePath);
  if (existing && Array.isArray(existing.accounts)) return existing;
  return {
    schema_version: 2,
    active_account_key: null,
    active_account_activated_at_ms: null,
    active_group: null,
    auto_switch: { enabled: false, primary_threshold_percent: 100, secondary_threshold_percent: 100 },
    api: { enabled: true },
    accounts: [],
    groups: []
  };
}

function addApiKeyAccount(codexHome, options) {
  const apiKey = readApiKeyForAdd(options);
  if (!apiKey) {
    console.error("API key cannot be empty.");
    process.exit(1);
  }

  const accountKey = accountKeyFromApiKey(apiKey);
  const now = Math.floor(Date.now() / 1000);
  const accountsDir = path.join(codexHome, "accounts");
  ensureDir(accountsDir);

  const registry = loadOrCreateRegistry(codexHome);
  const existing = registry.accounts.find((account) => account?.account_key === accountKey);
  const account = existing ?? {
    account_key: accountKey,
    chatgpt_account_id: accountKey,
    chatgpt_user_id: "apikey",
    email: options.email || options.alias || accountKey,
    alias: options.alias || "",
    account_name: null,
    plan: null,
    auth_mode: "apikey",
    created_at: now,
    last_used_at: null,
    last_usage: null,
    last_usage_at: null,
    last_local_rollout: null
  };

  account.api_template = options.template;
  account.email = options.email || account.email || options.alias || accountKey;
  account.alias = options.alias || account.alias || "";
  account.auth_mode = "apikey";
  if (Number.isFinite(options.spendLimitUsd)) {
    account.api_spend_limit_usd = options.spendLimitUsd;
  }

  if (!existing) {
    registry.accounts.push(account);
  }

  writeJsonFile(accountAuthPath(codexHome, accountKey), {
    auth_mode: "apikey",
    OPENAI_API_KEY: apiKey
  });
  fs.chmodSync(accountAuthPath(codexHome, accountKey), 0o600);

  fs.writeFileSync(accountConfigPath(codexHome, accountKey), defaultApiKeyConfig(options.baseUrl), { encoding: "utf8", mode: 0o600 });
  writeJsonFile(registryPath(codexHome), registry);
  fs.chmodSync(registryPath(codexHome), 0o600);

  process.stdout.write(`${existing ? "Updated" : "Added"} API-key account ${account.alias || account.email || accountKey}.\n`);
}

async function maybeHandleAddApiKey(argv) {
  let codexHome = null;
  let args = null;
  if (argv[0] === "add-api-key") {
    codexHome = defaultCodexHome();
    args = argv.slice(1);
  } else if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "add-api-key") {
    codexHome = managedGroupCodexHome(argv[1]);
    args = argv.slice(3);
  } else {
    return false;
  }

  addApiKeyAccount(codexHome, parseAddApiKeyArgs(args));
  await syncApiKeySpendLimits();
  ensureAllActiveAccountConfigs();
  return true;
}

function activeRegistryAccount(codexHome) {
  const registry = readJsonFile(registryPath(codexHome));
  if (!registry || !Array.isArray(registry.accounts) || typeof registry.active_account_key !== "string") {
    return null;
  }
  return registry.accounts.find((account) => account?.account_key === registry.active_account_key) ?? null;
}

function removeTomlTopLevelKeyAndSection(toml, topLevelKeys, sections) {
  const lines = toml.split(/\r?\n/);
  const out = [];
  let currentSection = null;
  let skipSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      skipSection = sections.has(currentSection);
      if (skipSection) continue;
    }
    if (skipSection) continue;

    if (currentSection === null) {
      const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (keyMatch && topLevelKeys.has(keyMatch[1])) continue;
    }

    out.push(line);
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function ensureActiveAccountConfig(codexHome) {
  const active = activeRegistryAccount(codexHome);
  if (!active || active.auth_mode === "apikey") return;

  const configPath = rootConfigPath(codexHome);
  let current = "";
  try {
    current = fs.readFileSync(configPath, "utf8");
  } catch {
    return;
  }

  const next = removeTomlTopLevelKeyAndSection(
    current,
    new Set(["model_provider"]),
    new Set(["model_providers.OpenAI"])
  );
  if (next !== current) {
    fs.writeFileSync(configPath, next, "utf8");
  }
}

function ensureAllActiveAccountConfigs() {
  for (const group of loadManagedGroups()) {
    ensureActiveAccountConfig(group.codexHome);
  }
}

async function maybeHandleApiSpendLimitConfig(argv) {
  let codexHome = null;
  let args = null;
  if (argv[0] === "config" && argv[1] === "api-spend-limit") {
    codexHome = defaultCodexHome();
    args = argv.slice(2);
  } else if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "config" && argv[3] === "api-spend-limit") {
    codexHome = managedGroupCodexHome(argv[1]);
    args = argv.slice(4);
  } else {
    return false;
  }

  if (args.length !== 2) {
    console.error("api-spend-limit requires an API-key account query and a positive dollar amount.");
    process.exit(1);
  }
  const limitUsd = Number(args[1]);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    console.error("api-spend-limit requires a positive dollar amount, for example 50.");
    process.exit(1);
  }

  setApiSpendLimit(codexHome, args[0], limitUsd);
  await syncApiKeySpendLimits();
  return true;
}

async function fetchApiKeyStatus(entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(entry.endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": "codex-auth-advanced"
      },
      signal: controller.signal
    });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function syncApiKeySpendLimits() {
  const entries = loadApiKeyAccountsForManagedList();
  if (!entries.length) return;

  const byRegistry = new Map();
  for (const entry of entries) {
    const status = await fetchApiKeyStatus(entry);
    const costs = status === 200 || status === 429 ? await fetchApiKeyCosts(entry) : { spend: null, limitUsd: null };
    const limitUsd = apiSpendLimitUsd(entry.account) ?? costs.limitUsd;
    const exhausted = isApiKeyLimitExhausted(status, costs.spend, limitUsd);
    if (!Number.isFinite(limitUsd) && !exhausted) continue;
    const key = registryPath(entry.codexHome);
    if (!byRegistry.has(key)) byRegistry.set(key, []);
    byRegistry.get(key).push({ accountKey: entry.account.account_key, status, spend: costs.spend, limitUsd, exhausted, remaining: costs.remaining });
  }

  for (const [filePath, updates] of byRegistry) {
    const registry = readJsonFile(filePath);
    if (!registry || !Array.isArray(registry.accounts)) continue;
    const before = JSON.stringify(registry.accounts);
    for (const update of updates) {
      const account = registry.accounts.find((item) => item?.account_key === update.accountKey);
      if (!account) continue;
      if (!Number.isFinite(account.api_spend_limit_usd) && Number.isFinite(update.limitUsd)) {
        account.api_spend_limit_usd = update.limitUsd;
      }
      account.api_spend = {
        spend_usd: Number.isFinite(update.spend) ? update.spend : null,
        limit_usd: update.limitUsd,
        remaining_usd: Number.isFinite(update.remaining) ? update.remaining : null,
        status: update.status,
        exhausted: update.exhausted,
        checked_at: Math.floor(Date.now() / 1000)
      };
      account.last_usage = usageSnapshotForApiSpend(update.spend, update.limitUsd, update.exhausted);
      account.last_usage_at = Math.floor(Date.now() / 1000);
    }
    if (before !== JSON.stringify(registry.accounts)) {
      writeJsonFile(filePath, registry);
    }
  }
}

function accountDisplayNeedles(account) {
  return [account.alias, account.account_name, account.email].filter(
    (value) => typeof value === "string" && value.length > 0
  );
}

function patchApiKeyMissingAuthOutput(output, checks) {
  if (!output || !checks.length) return output;
  const rendered = renderListTableWithDailyColumn(output, checks);
  if (rendered) return rendered;
  return output;
}

function matchingApiCheck(row, checks) {
  const exact = checks.find((check) =>
    accountDisplayNeedles(check.entry.account).some((needle) => row.account === needle)
  );
  if (exact) return exact;
  const candidates = checks
    .filter((check) => accountDisplayNeedles(check.entry.account).some((needle) => row.account.includes(needle)))
    .sort((a, b) => {
      const aLen = Math.max(...accountDisplayNeedles(a.entry.account).map((needle) => needle.length));
      const bLen = Math.max(...accountDisplayNeedles(b.entry.account).map((needle) => needle.length));
      return bLen - aLen;
    });
  return candidates[0];
}

function splitTableLine(line) {
  const parts = line.trimEnd().split(/\s{2,}/);
  if (parts[0] === "") parts.shift();
  return parts;
}

function parseAccountRow(line, grouped) {
  const parts = splitTableLine(line);
  const minParts = grouped ? 6 : 5;
  if (parts.length < minParts) return null;

  const prefix = parts[0].trim();
  const prefixMatch = grouped
    ? prefix.match(/^([* ]?)\s*(\d+)\s+(\S+)$/)
    : prefix.match(/^([* ]?)\s*(\d+)\s+(.+)$/);
  if (!prefixMatch) return null;

  if (grouped) {
    return {
      marker: prefixMatch[1] === "*" ? "*" : " ",
      index: prefixMatch[2],
      group: prefixMatch[3],
      account: parts[1],
      plan: parts[2],
      fiveHour: parts[3],
      daily: "-",
      weekly: parts[4],
      last: parts.slice(5).join("  ")
    };
  }

  return {
    marker: prefixMatch[1] === "*" ? "*" : " ",
    index: prefixMatch[2],
    group: null,
    account: prefixMatch[3],
    plan: parts[1],
    fiveHour: parts[2],
    daily: "-",
    weekly: parts[3],
    last: parts.slice(4).join("  ")
  };
}

function pad(value, width) {
  return String(value ?? "").padEnd(width, " ");
}

function renderSeparator(width) {
  return "-".repeat(width);
}

function renderGroupSeparator(name, width) {
  const prefix = `-- ${name} `;
  return `${prefix}${"-".repeat(Math.max(0, width - prefix.length))}`;
}

function renderListTableWithDailyColumn(output, checks) {
  const inputLines = output.split("\n");
  const headerLine = inputLines.find((line) => line.includes("ACCOUNT") && line.includes("PLAN") && line.includes("WEEKLY"));
  if (!headerLine) return null;
  const grouped = headerLine.includes("GROUP");
  const items = [];

  for (const line of inputLines) {
    if (!line.trim()) continue;
    if (line.includes("ACCOUNT") && line.includes("PLAN")) continue;
    if (/^-+$/.test(line.trim())) continue;
    if (line.startsWith("-- ")) {
      const name = line.slice(3).trim().split(/\s+/)[0];
      items.push({ type: "group", name });
      continue;
    }
    const row = parseAccountRow(line, grouped);
    if (!row) continue;
    const check = matchingApiCheck(row, checks);
    if (check) {
      row.plan = "API";
      row.fiveHour = check.label;
      row.daily = check.ok ? moneyUsed(check.daily) : "-";
      row.weekly = check.exhausted ? moneyLimitStatus(check.spend, check.limitUsd) : check.ok ? moneyLimitStatus(check.spend ?? check.weekly, check.limitUsd) : check.label;
      row.last = check.ok ? "Now" : row.last;
    }
    items.push({ type: "row", row });
  }

  const rows = items.filter((item) => item.type === "row").map((item) => item.row);
  if (!rows.length) return null;
  const widths = {
    index: Math.max(2, ...rows.map((row) => row.index.length)),
    group: grouped ? Math.max("GROUP".length, ...rows.map((row) => row.group.length)) : 0,
    account: Math.max("ACCOUNT".length, ...rows.map((row) => row.account.length)),
    plan: Math.max("PLAN".length, ...rows.map((row) => row.plan.length)),
    fiveHour: Math.max("5H LEFT".length, ...rows.map((row) => row.fiveHour.length)),
    daily: Math.max("DAILY".length, ...rows.map((row) => row.daily.length)),
    weekly: Math.max("WEEKLY LEFT".length, ...rows.map((row) => row.weekly.length)),
    last: Math.max("LAST ACTIVITY".length, ...rows.map((row) => row.last.length))
  };

  const prefixWidth = 2 + widths.index + 1;
  const out = [];
  if (grouped) {
    out.push(`${" ".repeat(prefixWidth)}${pad("GROUP", widths.group)}  ${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("DAILY", widths.daily)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("LAST ACTIVITY", widths.last)}`);
  } else {
    out.push(`${" ".repeat(prefixWidth)}${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("DAILY", widths.daily)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("LAST ACTIVITY", widths.last)}`);
  }
  const totalWidth = out[0].length;
  out.push(renderSeparator(totalWidth));

  for (const item of items) {
    if (item.type === "group") {
      out.push(renderGroupSeparator(item.name, totalWidth));
      continue;
    }
    const row = item.row;
    if (grouped) {
      out.push(`${row.marker} ${row.index.padStart(widths.index, "0")} ${pad(row.group, widths.group)}  ${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.daily, widths.daily)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.last, widths.last)}`);
    } else {
      out.push(`${row.marker} ${row.index.padStart(widths.index, "0")} ${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.daily, widths.daily)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.last, widths.last)}`);
    }
  }

  return `${out.join("\n")}\n`;
}

async function maybeRunApiKeyAwareGroupList(binaryPath, argv) {
  const isGroupList = isApiKeyAwareGroupList(argv);
  const isManagedList = isApiKeyAwareManagedList(argv);
  if (!isGroupList && !isManagedList) return false;

  const apiKeyAccounts = isGroupList ? loadApiKeyAccountsForGroup(argv[1]) : loadApiKeyAccountsForManagedList();
  if (apiKeyAccounts.length === 0) return false;

  const checks = await Promise.all(apiKeyAccounts.map(checkApiKeyAccount));
  const env = childEnvForArgv(argv);

  const child = spawnSync(binaryPath, argv, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    env
  });

  if (child.stdout) {
    process.stdout.write(patchApiKeyMissingAuthOutput(child.stdout, checks));
  }
  if (child.stderr) {
    process.stderr.write(child.stderr);
  }
  if (!child.error && !child.signal && (child.status ?? 1) === 0) {
    await syncApiKeySpendLimits();
    ensureAllActiveAccountConfigs();
  }
  exitFromChild(child);
  return true;
}

function readRootPackage() {
  try {
    return JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function maybePrintPreviewVersion(argv) {
  if (argv.length !== 1) return false;
  if (argv[0] !== "--version" && argv[0] !== "-V") return false;

  const rootPackage = readRootPackage();
  if (!rootPackage) return false;

  const previewLabel = rootPackage.codexAuthPreviewLabel;
  if (typeof previewLabel !== "string" || previewLabel.length === 0) return false;
  if (typeof rootPackage.version !== "string" || rootPackage.version.length === 0) return false;

  process.stdout.write(`${invokedCommandName} ${rootPackage.version} (preview ${previewLabel})\n`);
  return true;
}

if (maybePrintPreviewVersion(process.argv.slice(2))) {
  process.exit(0);
}

function childEnvForArgv(argv) {
  const env = {
    ...process.env,
    CODEX_AUTH_NODE_EXECUTABLE: process.execPath
  };
  if (argv[0] === "group" && argv[1] === "default") {
    env.CODEX_HOME = normalDefaultCodexHome();
  }
  return env;
}

function resolveBinary() {
  const platformDir = `${process.platform}-${process.arch}`;
  const vendorBinDir = path.join(__dirname, "..", "vendor", platformDir, "bin");
  if (!fs.existsSync(vendorBinDir)) {
    console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    console.error(`Missing local binary directory: ${vendorBinDir}`);
    process.exit(1);
  }

  const wantsAdvancedBinary = invokedCommandName === "codex-auth-advanced";
  const advancedBinaryName = process.platform === "win32" ? "codex-auth-advanced.exe" : "codex-auth-advanced";
  const defaultBinaryName = process.platform === "win32" ? "codex-auth.exe" : "codex-auth";
  const binaryName = wantsAdvancedBinary ? advancedBinaryName : defaultBinaryName;
  const binaryPath = path.join(vendorBinDir, binaryName);
  if (!fs.existsSync(binaryPath)) {
    const fallbackPath = path.join(vendorBinDir, defaultBinaryName);
    if (!wantsAdvancedBinary || !fs.existsSync(fallbackPath)) {
      console.error(`Missing local binary: ${binaryPath}`);
      process.exit(1);
    }
    return fallbackPath;
  }
  return binaryPath;
}

const binaryPath = resolveBinary();
const parsedApiSpendLimitArgs = parseApiSpendLimitArgs(process.argv.slice(2));
const argv = parsedApiSpendLimitArgs.argv;
const apiSpendLimitImportInfo = importCommandInfo(argv);

if (parsedApiSpendLimitArgs.found && !apiSpendLimitImportInfo) {
  console.error("--api-spend-limit-usd can only be used with `import` or `group <name> import`.");
  process.exit(1);
}

if (await maybeHandleApiSpendLimitConfig(argv)) {
  process.exit(0);
}

if (await maybeHandleAddApiKey(argv)) {
  process.exit(0);
}

if (maybeHandleStoredSwitch(argv)) {
  process.exit(0);
}

ensureAllActiveAccountConfigs();

if (!apiSpendLimitImportInfo) {
  await syncApiKeySpendLimits();
}

function exitFromChild(child) {
  if (child.error) {
    console.error(child.error.message);
    process.exit(1);
  }

  if (child.signal) {
    process.kill(process.pid, child.signal);
  } else {
    process.exit(child.status ?? 1);
  }
}

if (!(await maybeRunApiKeyAwareGroupList(binaryPath, argv))) {
  const child = spawnSync(binaryPath, argv, {
    stdio: "inherit",
    env: childEnvForArgv(argv)
  });

  if (!child.error && !child.signal && (child.status ?? 1) === 0) {
    if (apiSpendLimitImportInfo) {
      applyApiSpendLimitToImportedAccounts(apiSpendLimitImportInfo.codexHome, apiSpendLimitImportInfo.args, parsedApiSpendLimitArgs.limitUsd);
    }
    await syncApiKeySpendLimits();
    ensureAllActiveAccountConfigs();
  }

  exitFromChild(child);
}

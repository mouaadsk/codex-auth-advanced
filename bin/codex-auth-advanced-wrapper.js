#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPackageJsonPath = path.join(__dirname, "..", "package.json");
const requiredNodeMajor = 22;
const invokedCommandName = path.basename(process.argv[1] ?? "codex-auth-advanced", path.extname(process.argv[1] ?? ""));
const apiSpendLimitFlags = new Set(["--api-spend-limit-usd", "--api-limit-usd", "--spend-limit-usd"]);
const launchAgentLabel = "com.mouaadsk.codex-auth-advanced.manager";
const providerProxyHost = process.env.CODEX_AUTH_ADVANCED_PROXY_HOST || "127.0.0.1";
const providerProxyPort = Number(process.env.CODEX_AUTH_ADVANCED_PROXY_PORT || 47778);
const providerProxyPrefix = "/_codex-auth-advanced";
const chatgptCloudflareCookies = new Map();

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
    return defaultCodexHome();
  }
  return path.join(userHome(), "codex-auth-advanced", "groups", groupName);
}

function projectsConfigPath() {
  return path.join(userHome(), "codex-auth-advanced", "projects.json");
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
  writeTextFilePrivate(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFilePrivate(sourcePath, targetPath) {
  const tempPath = privateTempPath(targetPath);
  try {
    fs.copyFileSync(sourcePath, tempPath);
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function privateTempPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  return path.join(dir, `.${base}.${suffix}.tmp`);
}

function writeTextFilePrivate(filePath, value, mode = 0o600) {
  const tempPath = privateTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, value, { encoding: "utf8", mode });
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
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

const apiKeySessionConfigKeys = ["model", "review_model", "model_reasoning_effort"];

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function topLevelTomlValues(toml, keys) {
  const wanted = new Set(keys);
  const values = new Map();
  let inTopLevel = true;
  for (const rawLine of String(toml || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match || !wanted.has(match[1])) continue;
    values.set(match[1], match[2].trim());
  }
  return values;
}

function applyTopLevelTomlValues(toml, values) {
  if (!values || values.size === 0) return toml;

  const lines = String(toml || "").split(/\r?\n/);
  const found = new Set();
  let inTopLevel = true;
  let firstSectionIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("[") && trimmed.endsWith("]");
  });
  if (firstSectionIndex === -1) firstSectionIndex = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!match || !values.has(match[1])) continue;
    lines[i] = `${match[1]} = ${values.get(match[1])}`;
    found.add(match[1]);
  }

  const missing = apiKeySessionConfigKeys
    .filter((key) => values.has(key) && !found.has(key))
    .map((key) => `${key} = ${values.get(key)}`);
  if (missing.length > 0) {
    lines.splice(firstSectionIndex, 0, ...missing, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function mergeSessionModelConfig(targetToml, sourceToml) {
  return applyTopLevelTomlValues(
    targetToml,
    topLevelTomlValues(sourceToml, apiKeySessionConfigKeys)
  );
}

function providerProxyGroupId(codexHome) {
  return Buffer.from(path.resolve(codexHome), "utf8").toString("base64url");
}

function codexHomeFromProviderProxyGroupId(groupId) {
  return Buffer.from(String(groupId || ""), "base64url").toString("utf8");
}

function providerProxyBaseUrl(codexHome) {
  return `http://${providerProxyHost}:${providerProxyPort}${providerProxyPrefix}/${providerProxyGroupId(codexHome)}`;
}

function providerProxyHealthUrl() {
  return `http://${providerProxyHost}:${providerProxyPort}${providerProxyPrefix}/health`;
}

function isProviderProxyBaseUrl(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl || ""));
    const expectedPort = String(providerProxyPort);
    const actualPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return parsed.hostname === providerProxyHost
      && actualPort === expectedPort
      && parsed.pathname.startsWith(`${providerProxyPrefix}/`);
  } catch {
    return false;
  }
}

function apiKeyProxyConfig(codexHome, accountToml, rootToml) {
  const baseToml = String(rootToml || "").trim() ? rootToml : accountToml;
  return upsertOpenAiProviderConfig(
    mergeSessionModelConfig(baseToml, rootToml || accountToml),
    providerProxyBaseUrl(codexHome)
  );
}

function upsertOpenAiProviderConfig(toml, baseUrl) {
  const sourceToml = String(toml || "").trim()
    ? String(toml || "")
    : defaultApiKeyConfig(baseUrl, "");
  const withoutOpenAiProvider = removeTomlTopLevelKeyAndSection(
    sourceToml,
    new Set(["model_provider", "openai_base_url"]),
    new Set(["model_providers.OpenAI"])
  ).trimEnd();
  const lines = withoutOpenAiProvider ? withoutOpenAiProvider.split(/\r?\n/) : [];
  let firstSectionIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("[") && trimmed.endsWith("]");
  });
  if (firstSectionIndex === -1) firstSectionIndex = lines.length;

  const prefix = [
    "model_provider = \"openai\"",
    `openai_base_url = ${JSON.stringify(baseUrl)}`
  ];
  if (firstSectionIndex > 0) prefix.push("");
  lines.splice(firstSectionIndex, 0, ...prefix);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function apiKeyContextDefaults(templateName) {
  const template = apiKeyTemplate(templateName);
  return {
    modelContextWindow: Number.isFinite(template?.defaultModelContextWindow) ? template.defaultModelContextWindow : 512000,
    autoCompactTokenLimit: Number.isFinite(template?.defaultAutoCompactTokenLimit) ? template.defaultAutoCompactTokenLimit : 400000
  };
}

function defaultApiKeyConfig(baseUrl, sourceToml = "", templateName = null) {
  const cleanedBaseUrl = String(baseUrl || "https://api.openai.com/").trim() || "https://api.openai.com/";
  const contextDefaults = apiKeyContextDefaults(templateName);
  return mergeSessionModelConfig([
    'model_provider = "openai"',
    `openai_base_url = ${JSON.stringify(cleanedBaseUrl)}`,
    'model = "gpt-5.5"',
    'review_model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh"',
    'disable_response_storage = true',
    'network_access = "enabled"',
    'windows_wsl_setup_acknowledged = true',
    `model_context_window = ${contextDefaults.modelContextWindow}`,
    `model_auto_compact_token_limit = ${contextDefaults.autoCompactTokenLimit}`,
    "",
  ].join("\n"), sourceToml);
}

function apiKeyTemplate(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized === "openai") {
    return {
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultSpendLimitUsd: null,
      defaultModelContextWindow: 512000,
      defaultAutoCompactTokenLimit: 400000
    };
  }
  if (normalized === "codex-everywhere" || normalized === "codex_everywhere" || normalized === "everywhere") {
    return {
      name: "codex-everywhere",
      baseUrl: "https://codex-everywhere.com/",
      defaultSpendLimitUsd: 50,
      defaultModelContextWindow: 512000,
      defaultAutoCompactTokenLimit: 300000
    };
  }
  if (normalized === "tcdmx") {
    return {
      name: "tcdmx",
      baseUrl: "https://tcdmx.com",
      defaultSpendLimitUsd: 300,
      defaultModelContextWindow: 512000,
      defaultAutoCompactTokenLimit: 400000
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

function tomlLiteralForCli(rawValue) {
  const value = String(rawValue || "").trim();
  return value.length > 0 ? value : null;
}

function tomlStringForCli(rawValue) {
  const value = tomlLiteralForCli(rawValue);
  if (!value) return null;
  return parseTomlString(value);
}

function realPathIfPossible(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function pathContains(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function rememberedProjectGroupForCwd(cwd = process.cwd()) {
  const config = readJsonFile(projectsConfigPath());
  if (!config || !Array.isArray(config.projects)) return "default";

  const currentPath = realPathIfPossible(cwd);
  let best = null;
  for (const project of config.projects) {
    if (typeof project?.root !== "string" || typeof project?.group !== "string") continue;
    const rootPath = realPathIfPossible(project.root);
    if (!pathContains(rootPath, currentPath)) continue;
    if (!best || rootPath.length > best.rootPath.length) {
      best = { rootPath, group: project.group };
    }
  }
  return best?.group || "default";
}

function launchCodexHome(argv) {
  if (argv[0] === "launch") {
    return managedGroupCodexHome(rememberedProjectGroupForCwd());
  }
  if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "launch") {
    return managedGroupCodexHome(argv[1]);
  }
  return null;
}

function hasArg(args, names) {
  const wanted = new Set(names);
  return args.some((arg) => wanted.has(arg) || [...wanted].some((name) => arg.startsWith(`${name}=`)));
}

function configOverrideValue(arg) {
  const eq = String(arg || "").indexOf("=");
  if (eq <= 0) return null;
  return String(arg).slice(0, eq).trim();
}

function hasConfigOverride(args, key) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    let value = null;
    if (arg === "-c" || arg === "--config") {
      value = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--config=")) {
      value = arg.slice("--config=".length);
    }
    if (configOverrideValue(value) === key) return true;
  }
  return false;
}

function launchPassthroughArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return { head: argv, passthrough: [] };
  }
  return {
    head: argv.slice(0, separatorIndex),
    passthrough: argv.slice(separatorIndex + 1)
  };
}

function isHelpOrVersionArgs(args) {
  return hasArg(args, ["--help", "-h", "--version", "-V"]);
}

function launchConfigOverrideArgs(codexHome, passthrough) {
  const values = topLevelTomlValues(readTextFile(rootConfigPath(codexHome)), apiKeySessionConfigKeys);
  const overrides = [];
  const model = tomlStringForCli(values.get("model"));
  if (model && !hasArg(passthrough, ["--model", "-m"]) && !hasConfigOverride(passthrough, "model")) {
    overrides.push("--model", model);
  }
  const reasoningEffort = tomlLiteralForCli(values.get("model_reasoning_effort"));
  if (reasoningEffort && !hasConfigOverride(passthrough, "model_reasoning_effort")) {
    overrides.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  return overrides;
}

function launchArgvWithCurrentConfig(argv) {
  const codexHome = launchCodexHome(argv);
  if (!codexHome) return argv;
  if (isHelpOrVersionArgs(argv)) return argv;

  const { head, passthrough } = launchPassthroughArgs(argv);
  if (isHelpOrVersionArgs(passthrough)) return argv;

  const overrides = launchConfigOverrideArgs(codexHome, passthrough);
  if (overrides.length === 0) return argv;
  return [...head, "--", ...overrides, ...passthrough];
}

function readBaseUrl(configPath) {
  const values = readConfigBaseUrls(configPath);
  return values.baseUrl || values.openaiBaseUrl || null;
}

function readConfigBaseUrls(configPath) {
  const values = { openaiBaseUrl: null, baseUrl: null };
  let currentSection = null;
  try {
    const data = fs.readFileSync(configPath, "utf8");
    for (const rawLine of data.split(/\r?\n/)) {
      const line = rawLine.trim();
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = parseTomlString(line.slice(eq + 1));
      if (!value) continue;
      if (!currentSection && key === "openai_base_url") values.openaiBaseUrl = value;
      if (key === "base_url") values.baseUrl = value;
    }
  } catch {
    return values;
  }
  return values;
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
  const groups = [{ name: "default", codexHome: defaultCodexHome() }];
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
  try {
    const health = await fetchApiKeyHealth(entry);
    const costs = health.status == null
      ? { daily: null, weekly: null, spend: null, limitUsd: null, exhausted: false }
      : await fetchApiKeyCosts(entry);
    const limitUsd = apiSpendLimitUsd(entry.account) ?? costs.limitUsd;
    const exhausted = isApiKeyLimitExhausted(health.status, costs.spend, limitUsd, {
      providerExhausted: health.exhausted || costs.exhausted,
      remaining: costs.remaining
    });
    return {
      entry,
      ok: health.status === 200,
      label: exhausted ? "0%" : health.status === 200 ? "-" : health.errorName ?? String(health.status),
      daily: costs.daily,
      weekly: costs.weekly,
      spend: costs.spend,
      limitUsd,
      exhausted,
      status: health.status
    };
  } catch (error) {
    const name = error?.name === "AbortError" ? "TimedOut" : "RequestFailed";
    return { entry, ok: false, label: name, daily: null, weekly: null, spend: null, limitUsd: apiSpendLimitUsd(entry.account), exhausted: false, status: null };
  }
}

function isInsufficientBalanceBody(body) {
  if (!body) return false;
  if (typeof body === "string") return /insufficient[_ -]?(balance|quota|credits?)/i.test(body);
  const code = typeof body?.code === "string" ? body.code : "";
  const message = typeof body?.message === "string" ? body.message : "";
  const errorCode = typeof body?.error?.code === "string" ? body.error.code : "";
  const errorMessage = typeof body?.error?.message === "string" ? body.error.message : "";
  const text = `${code} ${message} ${errorCode} ${errorMessage}`;
  return /insufficient[_ -]?(balance|quota|credits?)/i.test(text);
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchApiKeyHealth(entry) {
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
    const body = response.status === 200 ? null : await readResponseBody(response);
    return {
      status: response.status,
      exhausted: response.status === 429 || isInsufficientBalanceBody(body)
    };
  } catch (error) {
    return {
      status: null,
      exhausted: false,
      errorName: error?.name === "AbortError" ? "TimedOut" : "RequestFailed"
    };
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

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseProviderUsageDetails(body) {
  const subscription = body?.subscription;
  const usage = body?.usage;
  const todayUsage = usage?.today;
  const totalUsage = usage?.total;
  const daily = firstFinite(subscription?.daily_usage_usd, todayUsage?.actual_cost, todayUsage?.cost);
  const weekly = firstFinite(subscription?.weekly_usage_usd, body?.weekly_usage_usd);
  const monthly = firstFinite(subscription?.monthly_usage_usd, body?.monthly_usage_usd);
  const total = firstFinite(totalUsage?.actual_cost, totalUsage?.cost, body?.total_cost, body?.cost, body?.usage_usd);
  const dailyLimit = firstFinite(subscription?.daily_limit_usd, body?.daily_limit_usd);
  const weeklyLimit = firstFinite(subscription?.weekly_limit_usd, body?.weekly_limit_usd);
  const monthlyLimit = firstFinite(subscription?.monthly_limit_usd, body?.monthly_limit_usd);
  const remaining = firstFinite(body?.remaining);
  const balance = firstFinite(body?.balance);
  const activeLimit = firstFinite(
    Number.isFinite(dailyLimit) && dailyLimit > 0 ? dailyLimit : null,
    Number.isFinite(weeklyLimit) && weeklyLimit > 0 ? weeklyLimit : null,
    Number.isFinite(monthlyLimit) && monthlyLimit > 0 ? monthlyLimit : null
  );
  const activeUsage = Number.isFinite(dailyLimit) && dailyLimit > 0
    ? firstFinite(daily, Number.isFinite(remaining) ? dailyLimit - remaining : null)
    : Number.isFinite(weeklyLimit) && weeklyLimit > 0
      ? weekly
      : Number.isFinite(monthlyLimit) && monthlyLimit > 0
        ? monthly
        : firstFinite(total, monthly, weekly, daily);
  const primaryUsage = firstFinite(activeUsage, total, monthly, weekly, daily);
  const primaryLimit = activeLimit;
  const exhausted = remaining === 0 && (Number.isFinite(primaryLimit) || Number.isFinite(balance));
  return {
    daily: Number.isFinite(daily) ? daily : total,
    weekly: Number.isFinite(weekly) ? weekly : null,
    monthly: Number.isFinite(monthly) ? monthly : total,
    spend: primaryUsage,
    limitUsd: primaryLimit,
    remaining: Number.isFinite(remaining) ? remaining : null,
    exhausted
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
  if (shouldPreferProviderUsage(entry)) {
    const providerUsage = await fetchProviderUsage(entry, isoDateFromSeconds(now));
    if (hasProviderUsageDetails(providerUsage)) return costsFromProviderUsage(providerUsage);
  }

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
  return costsFromProviderUsage(providerDaily);
}

function shouldPreferProviderUsage(entry) {
  const apiBase = apiBaseFromModelsEndpoint(entry.endpoint).toLowerCase();
  return !apiBase.startsWith("https://api.openai.com/v1");
}

function upstreamBaseFromAccountConfig(codexHome, accountKey) {
  const baseUrl = readBaseUrl(accountConfigPath(codexHome, accountKey));
  if (!baseUrl || isProviderProxyBaseUrl(baseUrl)) return null;
  return String(baseUrl).trim().replace(/\/+$/, "");
}

function activeApiProxyTarget(codexHome) {
  const registry = readJsonFile(registryPath(codexHome));
  const account = activeRegistryAccountFromRegistry(registry);
  if (!account) {
    return { error: "No active account for this group.", status: 409 };
  }

  if (account.auth_mode !== "apikey") {
    return {
      account,
      apiKey: null,
      upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
      chatgpt: true
    };
  }

  const authJson = readJsonFile(accountAuthPath(codexHome, account.account_key));
  const apiKey = typeof authJson?.OPENAI_API_KEY === "string" ? authJson.OPENAI_API_KEY : "";
  if (!apiKey) {
    return { error: `Missing API key for ${accountLabel(account)}.`, status: 500 };
  }

  const upstreamBaseUrl = upstreamBaseFromAccountConfig(codexHome, account.account_key);
  if (!upstreamBaseUrl) {
    return { error: `Missing upstream base_url for ${accountLabel(account)}.`, status: 500 };
  }

  return { account, apiKey, upstreamBaseUrl, chatgpt: false };
}

function targetUrlForProxyRequest(req, codexHome) {
  const groupPath = `${providerProxyPrefix}/${providerProxyGroupId(codexHome)}`;
  const incoming = new URL(req.url || "/", `http://${providerProxyHost}:${providerProxyPort}`);
  let rest = incoming.pathname.startsWith(groupPath)
    ? incoming.pathname.slice(groupPath.length)
    : incoming.pathname;
  if (!rest.startsWith("/")) rest = `/${rest}`;
  if (rest === "/") rest = "";
  const target = activeApiProxyTarget(codexHome);
  if (target.error) return target;
  return {
    ...target,
    url: `${target.upstreamBaseUrl}${rest}${incoming.search}`
  };
}

function stripHopByHopHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) out[key] = value.join(", ");
    else if (value != null) out[key] = String(value);
  }
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length"
  ]) {
    delete out[name];
  }
  return out;
}

function stripProxyResponseHeaders(headers) {
  const out = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if ([
      "connection",
      "content-encoding",
      "content-length",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade"
    ].includes(lower)) {
      return;
    }
    out[key] = value;
  });
  return out;
}

function isAllowedCloudflareCookieName(name) {
  return [
    "__cf_bm",
    "__cflb",
    "__cfruid",
    "__cfseq",
    "__cfwaitingroom",
    "_cfuvid",
    "cf_clearance",
    "cf_ob_info",
    "cf_use_ob"
  ].includes(name) || name.startsWith("cf_chl_");
}

function cookieNameFromSetCookie(header) {
  const name = String(header || "").split("=", 1)[0]?.trim();
  return name || null;
}

function captureChatgptCloudflareCookies(headers) {
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [];
  for (const header of setCookies) {
    const name = cookieNameFromSetCookie(header);
    if (!name || !isAllowedCloudflareCookieName(name)) continue;
    const value = String(header).split(";", 1)[0]?.trim();
    if (value) chatgptCloudflareCookies.set(name, value);
  }
}

function chatgptCloudflareCookieHeader() {
  return [...chatgptCloudflareCookies.values()].join("; ");
}

function writeProxyError(res, status, message) {
  const body = JSON.stringify({ error: { message, type: "codex_auth_advanced_proxy" } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function handleProviderProxyRequest(req, res) {
  const incoming = new URL(req.url || "/", `http://${providerProxyHost}:${providerProxyPort}`);
  if (incoming.pathname === `${providerProxyPrefix}/health`) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const pathMatch = incoming.pathname.match(new RegExp(`^${providerProxyPrefix.replaceAll("/", "\\/")}\\/([^/]+)(?:\\/|$)`));
  if (!pathMatch) {
    writeProxyError(res, 404, "Unknown codex-auth-advanced proxy route.");
    return;
  }

  let codexHome = "";
  try {
    codexHome = codexHomeFromProviderProxyGroupId(pathMatch[1]);
  } catch {
    writeProxyError(res, 400, "Invalid codex-auth-advanced proxy group id.");
    return;
  }

  const target = targetUrlForProxyRequest(req, codexHome);
  if (target.error) {
    writeProxyError(res, target.status || 500, target.error);
    return;
  }

  try {
    const headers = stripHopByHopHeaders(req.headers);
    if (!target.chatgpt) {
      headers.authorization = `Bearer ${target.apiKey}`;
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (
          lower === "cookie" ||
          lower.startsWith("oai-") ||
          lower === "x-authorization" ||
          lower.startsWith("sec-") ||
          lower === "referer" ||
          lower === "origin"
        ) {
          delete headers[key];
        }
      }
    } else if (chatgptCloudflareCookies.size > 0) {
      const existingCookie = headers.cookie ? `${headers.cookie}; ` : "";
      headers.cookie = `${existingCookie}${chatgptCloudflareCookieHeader()}`;
    }
    headers["user-agent"] = headers["user-agent"] || "codex-auth-advanced-proxy";
    const upstream = await fetch(target.url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : Readable.toWeb(req),
      duplex: "half"
    });
    if (target.chatgpt) {
      captureChatgptCloudflareCookies(upstream.headers);
    }

    res.writeHead(upstream.status, stripProxyResponseHeaders(upstream.headers));
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    writeProxyError(res, 502, `Provider proxy request failed: ${error?.message || error}`);
  }
}

function startProviderProxyServer() {
  const server = http.createServer((req, res) => {
    handleProviderProxyRequest(req, res).catch((error) => {
      writeProxyError(res, 500, `Provider proxy crashed: ${error?.message || error}`);
    });
  });
  server.listen(providerProxyPort, providerProxyHost, () => {
    process.stdout.write(`codex-auth-advanced provider proxy listening on http://${providerProxyHost}:${providerProxyPort}\n`);
  });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      process.stderr.write(`Provider proxy port ${providerProxyPort} is already in use.\n`);
    } else {
      process.stderr.write(`Provider proxy failed: ${error?.message || error}\n`);
    }
    process.exit(1);
  });
}

async function providerProxyIsRunning() {
  try {
    const response = await fetch(providerProxyHealthUrl(), { signal: AbortSignal.timeout(700) });
    return response.status === 200;
  } catch {
    return false;
  }
}

function detachedProxyEnv() {
  return {
    ...process.env,
    CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath,
    CODEX_AUTH_ADVANCED_PROVIDER_PROXY_CHILD: "1"
  };
}

async function ensureProviderProxyRunning({ quiet = false } = {}) {
  if (await providerProxyIsRunning()) return true;
  const scriptPath = path.join(__dirname, "codex-auth-advanced.js");
  const child = spawn(process.execPath, [scriptPath, "proxy", "serve"], {
    detached: true,
    stdio: "ignore",
    env: detachedProxyEnv()
  });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await providerProxyIsRunning()) {
      if (!quiet) process.stdout.write(`Started codex-auth-advanced provider proxy at http://${providerProxyHost}:${providerProxyPort}.\n`);
      return true;
    }
  }
  if (!quiet) process.stderr.write(`Warning: provider proxy did not respond at ${providerProxyHealthUrl()}.\n`);
  return false;
}

async function maybeHandleProviderProxy(argv) {
  if (argv[0] !== "proxy") return false;
  const subcommand = argv[1] || "status";
  if (subcommand === "serve") {
    startProviderProxyServer();
    await new Promise(() => {});
    return true;
  }
  if (subcommand === "start") {
    const ok = await ensureProviderProxyRunning();
    process.exit(ok ? 0 : 1);
  }
  if (subcommand === "status") {
    const ok = await providerProxyIsRunning();
    process.stdout.write(`provider proxy: ${ok ? "running" : "stopped"} (${providerProxyHealthUrl()})\n`);
    process.exit(ok ? 0 : 1);
  }
  console.error("Usage: codex-auth-advanced proxy status|start|serve");
  process.exit(1);
}

function hasProviderUsageDetails(providerUsage) {
  if (!providerUsage) return false;
  return [providerUsage.daily, providerUsage.weekly, providerUsage.monthly, providerUsage.spend, providerUsage.limitUsd, providerUsage.remaining]
    .some((value) => Number.isFinite(value));
}

function costsFromProviderUsage(providerUsage) {
  return {
    daily: providerUsage?.daily ?? null,
    weekly: providerUsage?.weekly ?? providerUsage?.monthly ?? providerUsage?.daily ?? null,
    spend: providerUsage?.spend ?? providerUsage?.monthly ?? providerUsage?.daily ?? null,
    limitUsd: providerUsage?.limitUsd ?? null,
    remaining: providerUsage?.remaining ?? null,
    exhausted: providerUsage?.exhausted === true
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

function isApiKeyLimitExhausted(status, spend, limitUsd, options = {}) {
  if (status === 429) return true;
  if (options.providerExhausted === true) return true;
  if ((status === 402 || status === 403) && Number(options.remaining) === 0) return true;
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

function accountRemainingPercent(account, which) {
  const usage = which === "primary" ? account.last_usage?.primary : account.last_usage?.secondary;
  const used = Number(usage?.used_percent);
  if (!Number.isFinite(used)) return null;
  return Math.max(0, 100 - used);
}

function registryAutoThresholds(registry) {
  const auto = registry?.auto_switch ?? {};
  const primary = Number(auto.threshold_5h_percent ?? auto.primary_threshold_percent ?? 0);
  const secondary = Number(auto.threshold_weekly_percent ?? auto.secondary_threshold_percent ?? 0);
  return {
    primary: Number.isFinite(primary) ? primary : 0,
    secondary: Number.isFinite(secondary) ? secondary : 0
  };
}

function accountShouldAutoSwitch(account, registry) {
  if (!account) return false;
  if (account.auth_mode === "apikey") return accountIsExhausted(account);
  if (accountIsExhausted(account)) return true;
  const thresholds = registryAutoThresholds(registry);
  const primary = accountRemainingPercent(account, "primary");
  const secondary = accountRemainingPercent(account, "secondary");
  return primary != null && primary <= thresholds.primary || secondary != null && secondary <= thresholds.secondary;
}

function accountIsSwitchCandidate(account) {
  return !accountIsExhausted(account);
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
  return args.some((arg) => arg === "--api" || arg === "--skip-api");
}

function switchFlags(args) {
  const flags = {
    live: false,
    auto: false,
    selectors: []
  };
  for (const arg of args) {
    if (arg === "--live") flags.live = true;
    else if (arg === "--auto") flags.auto = true;
    else flags.selectors.push(arg);
  }
  return flags;
}

async function switchToStoredAccount(codexHome, account) {
  const authPath = accountAuthPath(codexHome, account.account_key);
  if (!fs.existsSync(authPath)) {
    console.error(`Missing auth file for ${accountLabel(account)}: ${authPath}`);
    process.exit(1);
  }

  const rootAuthPath = path.join(codexHome, "auth.json");
  const rootConfig = rootConfigPath(codexHome);
  ensureDir(codexHome);

  if (account.auth_mode === "apikey") {
    const configPath = accountConfigPath(codexHome, account.account_key);
    if (fs.existsSync(configPath)) {
      const accountConfig = readTextFile(configPath);
      const nextConfig = apiKeyProxyConfig(codexHome, accountConfig, readTextFile(rootConfig));
      backupIfExists(rootConfig);
      writeTextFilePrivate(rootConfig, nextConfig, 0o600);
      const refreshedAccountConfig = mergeSessionModelConfig(accountConfig, readTextFile(rootConfig));
      if (refreshedAccountConfig !== accountConfig) {
        writeTextFilePrivate(configPath, refreshedAccountConfig, 0o600);
      }
    }
    await ensureProviderProxyRunning();
  } else {
    const currentConfig = readTextFile(rootConfig);
    if (currentConfig.trim()) {
      backupIfExists(rootConfig);
      writeTextFilePrivate(rootConfig, upsertOpenAiProviderConfig(currentConfig, providerProxyBaseUrl(codexHome)), 0o600);
    }
    await ensureProviderProxyRunning();
  }

  backupIfExists(rootAuthPath);
  copyFilePrivate(authPath, rootAuthPath);
  if (account.auth_mode === "apikey") {
    const rootAuth = readJsonFile(rootAuthPath);
    if (rootAuth && typeof rootAuth === "object") {
      rootAuth.auth_mode = "apikey";
      rootAuth.email = account.email || account.alias || account.account_key;
      rootAuth.alias = account.alias || "";
      rootAuth.account_key = account.account_key;
      writeJsonFile(rootAuthPath, rootAuth);
      fs.chmodSync(rootAuthPath, 0o600);
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
  process.stdout.write(`Switched to ${accountLabel(account)}.\n`);
}

function renderSwitchRows(accounts, activeAccountKey, { includeExhausted = true } = {}) {
  const rows = accounts.map((account, index) => ({
    index: String(index + 1).padStart(2, "0"),
    marker: account.account_key === activeAccountKey ? "*" : " ",
    account: accountLabel(account),
    plan: accountPlanLabel(account),
    fiveHour: accountUsageLabel(account, "primary"),
    weekly: accountUsageLabel(account, "secondary"),
    exhausted: accountIsExhausted(account) ? "yes" : "no"
  })).filter((row) => includeExhausted || row.exhausted !== "yes");
  if (!rows.length) {
    process.stdout.write("No usable accounts found.\n");
    return;
  }
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

function apiAccountDailyLabel(account) {
  const value = Number(account.api_spend?.spend_usd);
  return Number.isFinite(value) ? moneyUsed(value) : "-";
}

function apiAccountWeeklyLabel(account) {
  if (account.auth_mode !== "apikey") return accountUsageLabel(account, "secondary");
  const spend = Number(account.api_spend?.spend_usd);
  const trackedLimit = Number(account.api_spend?.limit_usd);
  const limit = apiSpendLimitUsd(account) ?? (Number.isFinite(trackedLimit) && trackedLimit > 0 ? trackedLimit : null);
  return moneyLimitStatus(spend, limit);
}

function accountLastLabel(account) {
  if (account.auth_mode === "apikey" && account.api_spend?.checked_at) return "Now";
  const last = Number(account.last_used_at || account.created_at);
  if (!Number.isFinite(last) || last <= 0) return "-";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - last);
  if (seconds < 60) return "Now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderLocalList(groups) {
  const rows = [];
  const grouped = groups.length > 1;
  for (const group of groups) {
    const registry = readJsonFile(registryPath(group.codexHome));
    if (!registry || !Array.isArray(registry.accounts)) continue;
    for (const [index, account] of sortedRegistryAccounts(registry).entries()) {
      rows.push({
        marker: account.account_key === registry.active_account_key ? "*" : " ",
        index: String(index + 1).padStart(2, "0"),
        group: group.name,
        account: accountLabel(account),
        plan: accountPlanLabel(account),
        fiveHour: accountUsageLabel(account, "primary"),
        daily: account.auth_mode === "apikey" ? apiAccountDailyLabel(account) : "-",
        weekly: apiAccountWeeklyLabel(account),
        last: accountLastLabel(account)
      });
    }
  }
  if (!rows.length) {
    process.stdout.write("No accounts found.\n");
    return;
  }

  const widths = {
    group: grouped ? Math.max("GROUP".length, ...rows.map((row) => row.group.length)) : 0,
    account: Math.max("ACCOUNT".length, ...rows.map((row) => row.account.length)),
    plan: Math.max("PLAN".length, ...rows.map((row) => row.plan.length)),
    fiveHour: Math.max("5H LEFT".length, ...rows.map((row) => row.fiveHour.length)),
    daily: Math.max("DAILY".length, ...rows.map((row) => row.daily.length)),
    weekly: Math.max("WEEKLY LEFT".length, ...rows.map((row) => row.weekly.length)),
    last: Math.max("LAST ACTIVITY".length, ...rows.map((row) => row.last.length))
  };
  const prefixWidth = 5;
  const header = grouped
    ? `${" ".repeat(prefixWidth)}${pad("GROUP", widths.group)}  ${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("DAILY", widths.daily)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("LAST ACTIVITY", widths.last)}`
    : `${" ".repeat(prefixWidth)}${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("DAILY", widths.daily)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("LAST ACTIVITY", widths.last)}`;
  process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
  for (const row of rows) {
    const prefix = `${row.marker} ${row.index} `;
    if (grouped) {
      process.stdout.write(`${prefix}${pad(row.group, widths.group)}  ${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.daily, widths.daily)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.last, widths.last)}\n`);
    } else {
      process.stdout.write(`${prefix}${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.daily, widths.daily)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.last, widths.last)}\n`);
    }
  }
}

function parseListLiveCommand(argv) {
  if (argv[0] === "list" && argv.includes("--live")) {
    return { groups: loadManagedGroups() };
  }
  if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "list" && argv.includes("--live")) {
    return { groups: [{ name: argv[1], codexHome: managedGroupCodexHome(argv[1]) }] };
  }
  if (argv[0] === "group" && argv[1] === "list" && typeof argv[2] === "string" && argv.includes("--live")) {
    return { groups: [{ name: argv[2], codexHome: managedGroupCodexHome(argv[2]) }] };
  }
  return null;
}

async function maybeHandleStoredListLive(argv) {
  const command = parseListLiveCommand(argv);
  if (!command) return false;
  const hasApiKeyAccounts = command.groups.some((group) => {
    const registry = readJsonFile(registryPath(group.codexHome));
    return registry?.accounts?.some((account) => account?.auth_mode === "apikey");
  });
  if (!hasApiKeyAccounts) return false;

  while (true) {
    await syncApiKeySpendLimits();
    clearScreen();
    renderLocalList(command.groups);
    process.stdout.write("\nRefreshing every 5s. Press Ctrl-C to stop.\n");
    sleep(5000);
  }
}

async function maybeHandleStoredSwitch(argv) {
  const command = parseSwitchCommand(argv);
  if (!command || hasUnsupportedSwitchFlags(command.args)) return false;

  const registry = readJsonFile(registryPath(command.codexHome));
  if (!registry || !Array.isArray(registry.accounts)) return false;
  if (!registry.accounts.some((account) => account?.auth_mode === "apikey")) return false;

  const flags = switchFlags(command.args);
  if (flags.auto && !flags.live) {
    console.error("--auto requires --live.");
    process.exit(1);
  }

  if (flags.live) {
    await handleLiveStoredSwitch(command.codexHome, flags.auto);
    return true;
  }

  const query = flags.selectors.join(" ").trim();
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
    await switchToStoredAccount(command.codexHome, result.account);
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
  await switchToStoredAccount(command.codexHome, result.account);
  return true;
}

function clearScreen() {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function activeRegistryAccountFromRegistry(registry) {
  if (!registry || typeof registry.active_account_key !== "string") return null;
  return registry.accounts.find((account) => account?.account_key === registry.active_account_key) ?? null;
}

function firstUsableSwitchCandidate(registry) {
  const active = registry.active_account_key;
  return sortedRegistryAccounts(registry).find((account) => account.account_key !== active && accountIsSwitchCandidate(account)) ?? null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function handleLiveStoredSwitch(codexHome, auto) {
  while (true) {
    const registry = readJsonFile(registryPath(codexHome));
    if (!registry || !Array.isArray(registry.accounts)) {
      console.error(`No registry found at ${registryPath(codexHome)}.`);
      process.exit(1);
    }
    clearScreen();
    renderSwitchRows(sortedRegistryAccounts(registry), registry.active_account_key);
    process.stdout.write(`\n${auto ? "Auto-switch is watching usable accounts. Press Ctrl-C to stop." : "Enter a selector to switch, or q to quit."}\n`);

    if (auto) {
      const active = activeRegistryAccountFromRegistry(registry);
      if (accountShouldAutoSwitch(active, registry)) {
        const candidate = firstUsableSwitchCandidate(registry);
        if (candidate) {
          await switchToStoredAccount(codexHome, candidate);
        } else {
          process.stdout.write("No usable switch candidate found.\n");
        }
      }
      sleep(5000);
      continue;
    }

    const selected = readLineFromTty("Switch to account number, alias, or email [q to quit]: ");
    if (!selected || selected.toLowerCase() === "q") {
      process.stdout.write("No account switched.\n");
      return;
    }
    const result = findAccountForSwitch(registry, selected);
    if (result.ambiguous) {
      process.stderr.write(`Multiple accounts matched "${selected}". Use a more specific selector.\n`);
      sleep(1200);
      continue;
    }
    if (!result.account) {
      process.stderr.write(`No account matched "${selected}".\n`);
      sleep(1200);
      continue;
    }
    await switchToStoredAccount(codexHome, result.account);
    sleep(1200);
  }
}

function autoSwitchEnabled(registry) {
  const auto = registry?.auto_switch;
  return auto?.enabled === true;
}

async function autoSwitchCycleForGroup(group) {
  const registry = readJsonFile(registryPath(group.codexHome));
  if (!registry || !Array.isArray(registry.accounts) || !autoSwitchEnabled(registry)) return;
  const active = activeRegistryAccountFromRegistry(registry);
  if (!accountShouldAutoSwitch(active, registry)) return;
  const candidate = firstUsableSwitchCandidate(registry);
  if (!candidate) return;
  await switchToStoredAccount(group.codexHome, candidate);
}

async function runAutoSwitchCycle() {
  syncMissingApiKeyConfigsAllGroups();
  await ensureProviderProxyForActiveApiAccounts();
  await syncApiKeySpendLimits();
  for (const group of loadManagedGroups()) {
    await autoSwitchCycleForGroup(group);
  }
}

async function maybeHandleDaemon(argv) {
  if (argv[0] !== "daemon") return false;
  const once = argv.includes("--once") || argv.includes("--manager-once");
  const supported = argv.some((arg) => arg === "--watch" || arg === "--manager" || arg === "--once" || arg === "--manager-once");
  if (!supported) return false;
  if (once) {
    await runAutoSwitchCycle();
    return true;
  }
  while (true) {
    await runAutoSwitchCycle();
    sleep(30000);
  }
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
    console.error("--template must be one of: openai, codex-everywhere, tcdmx.");
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
  process.stderr.write("  3) Use template: TCDMX\n");
  process.stderr.write("  4) Custom provider (current/manual behavior)\n");
  while (true) {
    const choice = readLineFromTty("Choose [1-4]: ");
    if (choice === "" || choice === "1") return "openai";
    if (choice === "2") return "codex-everywhere";
    if (choice === "3") return "tcdmx";
    if (choice === "4") return "custom";
    process.stderr.write("Please choose 1, 2, 3, or 4.\n");
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
  if (process.env.CODEX_AUTH_ADVANCED_API_KEY) return process.env.CODEX_AUTH_ADVANCED_API_KEY.trim();
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  if (process.stdin.isTTY && process.stderr.isTTY) return readSecretLineFromTty("API key: ");
  console.error("add-api-key requires --stdin, --api-key, CODEX_AUTH_ADVANCED_API_KEY, OPENAI_API_KEY, or an interactive terminal.");
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
  const existingConfigPath = accountConfigPath(codexHome, accountKey);
  const existingBaseUrl = existing ? readBaseUrl(existingConfigPath) : null;
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
  if (existingBaseUrl && !isProviderProxyBaseUrl(existingBaseUrl) && options.baseUrl === apiKeyTemplate(options.template)?.baseUrl) {
    options.baseUrl = existingBaseUrl;
  }
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
    OPENAI_API_KEY: apiKey,
    email: account.email,
    alias: account.alias,
    account_key: account.account_key
  });
  fs.chmodSync(accountAuthPath(codexHome, accountKey), 0o600);

  writeTextFilePrivate(accountConfigPath(codexHome, accountKey), defaultApiKeyConfig(options.baseUrl, readTextFile(rootConfigPath(codexHome)), options.template), 0o600);
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
  const registry = readJsonFile(registryPath(codexHome));
  if (!registry?.active_account_key) return;

  const configPath = rootConfigPath(codexHome);
  let current = "";
  try {
    current = fs.readFileSync(configPath, "utf8");
  } catch {
    return;
  }

  const next = upsertOpenAiProviderConfig(current, providerProxyBaseUrl(codexHome));
  if (next !== current) {
    writeTextFilePrivate(configPath, next, 0o600);
  }
}

function ensureAllActiveAccountConfigs() {
  for (const group of loadManagedGroups()) {
    ensureActiveAccountConfig(group.codexHome);
  }
}

async function ensureProviderProxyForActiveApiAccounts() {
  for (const group of loadManagedGroups()) {
    const registry = readJsonFile(registryPath(group.codexHome));
    if (registry?.active_account_key) {
      await ensureProviderProxyRunning({ quiet: true });
      return;
    }
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

async function syncApiKeySpendLimits() {
  const entries = loadApiKeyAccountsForManagedList();
  if (!entries.length) return;

  const byRegistry = new Map();
  for (const entry of entries) {
    const health = await fetchApiKeyHealth(entry);
    const costs = health.status == null
      ? { spend: null, limitUsd: null, remaining: null, exhausted: false }
      : await fetchApiKeyCosts(entry);
    const limitUsd = apiSpendLimitUsd(entry.account) ?? costs.limitUsd;
    const exhausted = isApiKeyLimitExhausted(health.status, costs.spend, limitUsd, {
      providerExhausted: health.exhausted || costs.exhausted,
      remaining: costs.remaining
    });
    if (!Number.isFinite(limitUsd) && !exhausted) continue;
    const key = registryPath(entry.codexHome);
    if (!byRegistry.has(key)) byRegistry.set(key, []);
    byRegistry.get(key).push({ accountKey: entry.account.account_key, status: health.status, spend: costs.spend, limitUsd, exhausted, remaining: costs.remaining });
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

function syncMissingApiKeyConfigsAllGroups() {
  const groups = loadManagedGroups();
  const configByAccountKey = new Map();
  for (const group of groups) {
    const registry = readJsonFile(registryPath(group.codexHome));
    if (!registry || !Array.isArray(registry.accounts)) continue;
    for (const account of registry.accounts) {
      if (account?.auth_mode !== "apikey") continue;
      const configPath = accountConfigPath(group.codexHome, account.account_key);
      if (fs.existsSync(configPath) && !configByAccountKey.has(account.account_key)) {
        configByAccountKey.set(account.account_key, configPath);
      }
    }
  }

  for (const group of groups) {
    const registry = readJsonFile(registryPath(group.codexHome));
    if (!registry || !Array.isArray(registry.accounts)) continue;
    for (const account of registry.accounts) {
      if (account?.auth_mode !== "apikey") continue;
      const targetPath = accountConfigPath(group.codexHome, account.account_key);
      if (fs.existsSync(targetPath)) continue;
      const sourcePath = configByAccountKey.get(account.account_key);
      if (!sourcePath || !fs.existsSync(sourcePath)) continue;
      ensureDir(path.dirname(targetPath));
      copyFilePrivate(sourcePath, targetPath);
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

function patchApiKeyMissingAuthError(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "warning: auth.json missing email; skipping sync")
    .join("\n")
    .replace(/\n?$/, (match) => match);
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
    const patchedStderr = patchApiKeyMissingAuthError(child.stderr);
    if (patchedStderr.trim().length > 0) process.stderr.write(patchedStderr.endsWith("\n") ? patchedStderr : `${patchedStderr}\n`);
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

  const previewLabel = rootPackage.codexAuthAdvancedPreviewLabel;
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
    CODEX_AUTH_ADVANCED_NODE_EXECUTABLE: process.execPath
  };
  if (argv[0] === "group" && argv[1] === "default") {
    env.CODEX_HOME = defaultCodexHome();
  }
  return env;
}

function isAutoConfigCommand(argv) {
  if (argv[0] === "config" && argv[1] === "auto") return true;
  return argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "auto";
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function repairMacLaunchAgentPath() {
  if (process.platform !== "darwin") return;
  const launchAgentsDir = path.join(userHome(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${launchAgentLabel}.plist`);
  const scriptPath = path.join(__dirname, "codex-auth-advanced.js");
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${launchAgentLabel}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(process.execPath)}</string>`,
    `    <string>${xmlEscape(scriptPath)}</string>`,
    '    <string>daemon</string>',
    '    <string>--manager</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>CODEX_AUTH_ADVANCED_VERSION</key>',
    '    <string>0.3.0-alpha.2</string>',
    '    <key>CODEX_AUTH_ADVANCED_NODE_EXECUTABLE</key>',
    `    <string>${xmlEscape(process.execPath)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    ''
  ].join("\n");
  ensureDir(launchAgentsDir);
  fs.writeFileSync(plistPath, plist, "utf8");
  for (const fileName of fs.readdirSync(launchAgentsDir)) {
    if (fileName === path.basename(plistPath)) continue;
    if (!fileName.endsWith(".codex-auth-advanced.manager.plist")) continue;
    fs.rmSync(path.join(launchAgentsDir, fileName));
  }
  unloadStaleMacLaunchAgents(launchAgentsDir, plistPath);
}

function unloadStaleMacLaunchAgents(launchAgentsDir, currentPlistPath) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid == null) return;

  const labels = new Set();
  try {
    for (const fileName of fs.readdirSync(launchAgentsDir)) {
      if (fileName === path.basename(currentPlistPath)) continue;
      if (!fileName.endsWith(".codex-auth-advanced.manager.plist")) continue;
      labels.add(fileName.slice(0, -".plist".length));
    }
  } catch {
    return;
  }

  const domain = `gui/${uid}`;
  const child = spawnSync("launchctl", ["print", domain], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8"
  });
  if ((child.status ?? 1) === 0) {
    const labelPattern = /^\s*(?:\d+\s+\S+\s+)?([A-Za-z0-9_.-]+\.codex-auth-advanced\.manager)(?:\s*=)?\s*$/gm;
    let match = labelPattern.exec(child.stdout);
    while (match) {
      if (match[1] !== launchAgentLabel) labels.add(match[1]);
      match = labelPattern.exec(child.stdout);
    }
  }

  for (const label of labels) {
    if (label === launchAgentLabel) continue;
    spawnSync("launchctl", ["bootout", `${domain}/${label}`], {
      stdio: "ignore"
    });
  }
}

function isStatusCommand(argv) {
  if (argv[0] === "status") return true;
  if (argv[0] === "group" && argv[1] === "status") return true;
  return argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "status";
}

function macLaunchAgentIsRunning() {
  if (process.platform !== "darwin") return null;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid == null) return null;
  const child = spawnSync("launchctl", ["print", `gui/${uid}/${launchAgentLabel}`], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });
  if ((child.status ?? 1) !== 0) return false;
  return child.stdout.includes("state = running");
}

function patchStatusOutput(output) {
  const serviceRunning = macLaunchAgentIsRunning();
  if (serviceRunning == null) return output;
  const serviceLine = `service: ${serviceRunning ? "running" : "stopped"}`;
  if (/^service: .*$/m.test(output)) {
    return output.replace(/^service: .*$/m, serviceLine);
  }
  return `${output.trimEnd()}\n${serviceLine}\n`;
}

function maybeRunStatus(binaryPath, argv) {
  if (!isStatusCommand(argv)) return false;
  const child = spawnSync(binaryPath, argv, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    env: childEnvForArgv(argv)
  });
  if (child.stdout) process.stdout.write(patchStatusOutput(child.stdout));
  if (child.stderr) process.stderr.write(child.stderr);
  exitFromChild(child);
  return true;
}

function resolveBinary() {
  const platformDir = `${process.platform}-${process.arch}`;
  const vendorBinDir = path.join(__dirname, "..", "vendor", platformDir, "bin");
  if (!fs.existsSync(vendorBinDir)) {
    console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    console.error(`Missing local binary directory: ${vendorBinDir}`);
    process.exit(1);
  }

  const advancedBinaryName = process.platform === "win32" ? "codex-auth-advanced.exe" : "codex-auth-advanced";
  const binaryPath = path.join(vendorBinDir, advancedBinaryName);
  if (!fs.existsSync(binaryPath)) {
    console.error(`Missing local binary: ${binaryPath}`);
    process.exit(1);
  }
  return binaryPath;
}

const binaryPath = resolveBinary();
const parsedApiSpendLimitArgs = parseApiSpendLimitArgs(process.argv.slice(2));
const argv = launchArgvWithCurrentConfig(parsedApiSpendLimitArgs.argv);
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
  const child = spawnSync(binaryPath, argv, {
    stdio: "inherit",
    env: childEnvForArgv(argv)
  });
  exitFromChild(child);
}
const apiSpendLimitImportInfo = importCommandInfo(argv);

if (parsedApiSpendLimitArgs.found && !apiSpendLimitImportInfo) {
  console.error("--api-spend-limit-usd can only be used with `import` or `group <name> import`.");
  process.exit(1);
}

if (await maybeHandleProviderProxy(argv)) {
  process.exit(0);
}

if (await maybeHandleApiSpendLimitConfig(argv)) {
  process.exit(0);
}

if (await maybeHandleAddApiKey(argv)) {
  process.exit(0);
}

syncMissingApiKeyConfigsAllGroups();

if (!apiSpendLimitImportInfo) {
  await syncApiKeySpendLimits();
}

if (await maybeHandleDaemon(argv)) {
  process.exit(0);
}

if (await maybeHandleStoredListLive(argv)) {
  process.exit(0);
}

if (await maybeHandleStoredSwitch(argv)) {
  process.exit(0);
}

ensureAllActiveAccountConfigs();

if (maybeRunStatus(binaryPath, argv)) {
  process.exit(0);
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
    syncMissingApiKeyConfigsAllGroups();
    if (isAutoConfigCommand(argv)) {
      repairMacLaunchAgentPath();
    }
    ensureAllActiveAccountConfigs();
  }

  exitFromChild(child);
}

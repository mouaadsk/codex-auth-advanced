import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseTomlString, tomlKeyValue, tomlSectionName } from "./codex-config.mjs";
import {
  apiProviderExhaustionReason,
  apiSpendLimitUsd,
  apiSpendRemainingLabel,
  applyApiSpendWindow,
  costsFromProviderUsage,
  costsFromVsllmSubscription,
  hasProviderUsageDetails,
  isApiKeyLimitExhausted,
  isVsllmApiAccount,
  parseProviderUsageDetails,
  parseVsllmSubscriptionSelf
} from "./provider-policy.mjs";
import { providerDashboardCredentialsDir, readJsonFile } from "./storage.mjs";

export function normalizeProviderOrigin(value) {
  try {
    return new URL(String(value || "").trim()).origin;
  } catch {
    return null;
  }
}

function providerDashboardIdentity(origin, userId) {
  const normalizedOrigin = normalizeProviderOrigin(origin);
  const normalizedUserId = Number(userId);
  if (!normalizedOrigin || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return null;
  return `${normalizedOrigin}|${normalizedUserId}`;
}

export function providerDashboardCredentialPath(codexHome, origin, userId) {
  const identity = providerDashboardIdentity(origin, userId);
  if (!identity) return null;
  const fileKey = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(providerDashboardCredentialsDir(codexHome), `${fileKey}.json`);
}

export function readProviderDashboardCredential(codexHome, account) {
  const metadata = account?.provider_dashboard;
  const filePath = providerDashboardCredentialPath(codexHome, metadata?.origin, metadata?.user_id);
  if (!filePath) return null;
  const credential = readJsonFile(filePath);
  if (!credential || credential.account_key !== account?.account_key) return null;
  if (providerDashboardIdentity(credential.origin, credential.user_id) !== providerDashboardIdentity(metadata.origin, metadata.user_id)) {
    return null;
  }
  if (typeof credential.access_token !== "string" || !credential.access_token.trim()) return null;
  return credential;
}

export function readBaseUrl(configPath) {
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
      const sectionName = tomlSectionName(line);
      if (sectionName != null) {
        currentSection = sectionName;
        continue;
      }
      const item = tomlKeyValue(line);
      if (!item) continue;
      const value = parseTomlString(item.value);
      if (!value) continue;
      if (!currentSection && item.key === "openai_base_url") values.openaiBaseUrl = value;
      if (item.key === "base_url") values.baseUrl = value;
    }
  } catch {
    return values;
  }
  return values;
}

export function modelsEndpointFromBaseUrl(baseUrl) {
  const cleaned = canonicalizeVsllmProviderBaseUrl(
    String(baseUrl || "https://api.openai.com/v1").trim()
  ).replace(/\/+$/, "");
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

export async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function readClonedResponseBody(response) {
  try {
    return await readResponseBody(response.clone());
  } catch {
    return null;
  }
}

function apiKeyRequestHeaders(entry) {
  return {
    Authorization: `Bearer ${entry.apiKey}`,
    "User-Agent": "codex-auth-advanced"
  };
}

async function withAbortTimeout(timeoutMs, callback) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function fetchApiKeyEndpoint(entry, url, { signal, method = "GET" } = {}) {
  return fetch(url, {
    method,
    headers: apiKeyRequestHeaders(entry),
    signal
  });
}

export async function fetchApiKeyHealth(entry) {
  try {
    const response = await withAbortTimeout(5000, (signal) => fetchApiKeyEndpoint(entry, entry.endpoint, { signal }));
    const body = response.status === 200 ? null : await readResponseBody(response);
    const exhaustionReason = apiProviderExhaustionReason(response.status, body, entry.account);
    return {
      status: response.status,
      exhausted: exhaustionReason != null
    };
  } catch (error) {
    return {
      status: null,
      exhausted: false,
      errorName: error?.name === "AbortError" ? "TimedOut" : "RequestFailed"
    };
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
  try {
    const response = await withAbortTimeout(15000, (signal) => fetchApiKeyEndpoint(
      entry,
      costsEndpointFromModelsEndpoint(entry.endpoint, startTime, endTime),
      { signal }
    ));
    if (response.status !== 200) return null;
    return parseCostsTotal(await response.json());
  } catch {
    return null;
  }
}

function isoDateFromSeconds(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function providerOriginFromModelsEndpoint(endpoint) {
  return normalizeProviderOrigin(endpoint);
}

const vsllmApiOrigin = "https://api.vsllm.com";
const vsllmWebOrigin = "https://vsllm.com";

export function canonicalizeVsllmProviderBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.origin !== vsllmWebOrigin && parsed.origin !== vsllmApiOrigin) return raw;
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${vsllmApiOrigin}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}

export function canonicalizeVsllmProviderOrigin(origin) {
  const normalized = normalizeProviderOrigin(origin);
  if (!normalized) return normalized;
  return (normalized === vsllmWebOrigin || normalized === vsllmApiOrigin) ? vsllmApiOrigin : normalized;
}

export function providerDashboardOriginMatchesModelsEndpoint(modelsEndpoint, dashboardOrigin) {
  const modelsOrigin = providerOriginFromModelsEndpoint(modelsEndpoint);
  const normalizedDashboardOrigin = normalizeProviderOrigin(dashboardOrigin);
  if (!modelsOrigin || !normalizedDashboardOrigin) return false;
  if (
    (modelsOrigin === vsllmWebOrigin || modelsOrigin === vsllmApiOrigin) &&
    (normalizedDashboardOrigin === vsllmWebOrigin || normalizedDashboardOrigin === vsllmApiOrigin)
  ) {
    return true;
  }
  return modelsOrigin === normalizedDashboardOrigin;
}

function providerDashboardRequestHeaders(credential) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.access_token}`,
    "Cache-Control": "no-store",
    "New-Api-User": String(credential.user_id),
    "User-Agent": "codex-auth-advanced"
  };
}

export async function fetchProviderDashboardJson(credential, pathname, options = {}) {
  const origin = canonicalizeVsllmProviderOrigin(credential?.origin);
  if (!origin) return { status: null, body: null, error: "invalid_provider_origin" };
  const url = new URL(pathname, `${origin}/`).toString();
  try {
    const response = await withAbortTimeout(options.timeoutMs ?? 10000, (signal) => fetch(url, {
      method: options.method || "GET",
      headers: {
        ...providerDashboardRequestHeaders(credential),
        ...(options.headers || {})
      },
      body: options.body,
      signal
    }));
    return {
      status: response.status,
      body: await readResponseBody(response),
      error: null
    };
  } catch (error) {
    return {
      status: null,
      body: null,
      error: error?.name === "AbortError" ? "timeout" : "request_failed"
    };
  }
}

async function fetchVsllmSubscriptionUsage(entry) {
  const credential = entry?.dashboardCredential;
  if (!credential || !isVsllmApiAccount(entry.account, entry.endpoint)) {
    return { configured: false, subscription: null };
  }
  if (!providerDashboardOriginMatchesModelsEndpoint(entry.endpoint, credential.origin)) {
    return { configured: true, subscription: null };
  }
  const result = await fetchProviderDashboardJson(credential, "/api/subscription/self");
  if (result.status !== 200) return { configured: true, subscription: null };
  return {
    configured: true,
    subscription: parseVsllmSubscriptionSelf(result.body)
  };
}

async function fetchProviderUsage(entry, date) {
  try {
    const response = await withAbortTimeout(15000, (signal) => fetchApiKeyEndpoint(
      entry,
      usageEndpointFromModelsEndpoint(entry.endpoint, date),
      { signal }
    ));
    if (response.status !== 200) return null;
    return parseProviderUsageDetails(await response.json());
  } catch {
    return null;
  }
}

async function fetchNewApiBilling(entry) {
  const apiBase = apiBaseFromModelsEndpoint(entry.endpoint);
  try {
    const [subRes, usageRes] = await withAbortTimeout(10000, (signal) => Promise.all([
      fetchApiKeyEndpoint(entry, `${apiBase}/dashboard/billing/subscription`, { signal }),
      fetchApiKeyEndpoint(entry, `${apiBase}/dashboard/billing/usage`, { signal })
    ]));

    if (subRes.status !== 200 || usageRes.status !== 200) {
      return null;
    }

    const subData = await subRes.json();
    const usageData = await usageRes.json();

    const hardLimit = Number(subData?.hard_limit_usd);
    const totalUsageCents = Number(usageData?.total_usage);

    if (!Number.isFinite(totalUsageCents)) return null;

    const spend = totalUsageCents / 100;
    const limitUsd = (Number.isFinite(hardLimit) && hardLimit < 9999999) ? hardLimit : null;
    const remaining = Number.isFinite(limitUsd) ? Math.max(0, limitUsd - spend) : null;

    return {
      daily: spend,
      weekly: spend,
      monthly: spend,
      spend,
      totalSpend: spend,
      limitUsd,
      remaining,
      exhausted: Number.isFinite(limitUsd) && remaining <= 0
    };
  } catch {
    return null;
  }
}

function shouldPreferProviderUsage(entry) {
  const apiBase = apiBaseFromModelsEndpoint(entry.endpoint).toLowerCase();
  return !apiBase.startsWith("https://api.openai.com/v1");
}

export async function fetchApiKeyCosts(entry) {
  const now = Math.floor(Date.now() / 1000);
  const dashboardSubscription = await fetchVsllmSubscriptionUsage(entry);
  if (dashboardSubscription.subscription) {
    return costsFromVsllmSubscription(dashboardSubscription.subscription, entry.account);
  }
  if (dashboardSubscription.configured) {
    return {
      daily: null,
      weekly: null,
      spend: null,
      totalSpend: null,
      limitUsd: apiSpendLimitUsd(entry.account),
      remaining: null,
      exhausted: false,
      dashboardUnavailable: true
    };
  }

  if (shouldPreferProviderUsage(entry)) {
    const providerUsage = await fetchProviderUsage(entry, isoDateFromSeconds(now));
    if (hasProviderUsageDetails(providerUsage)) return applyApiSpendWindow(entry, costsFromProviderUsage(providerUsage));

    const newApiBilling = await fetchNewApiBilling(entry);
    if (newApiBilling) return applyApiSpendWindow(entry, newApiBilling);
  }

  const dayStart = utcStartOfTodaySeconds();
  const weekStart = now - 7 * 24 * 60 * 60;
  const spendStart = now - 31 * 24 * 60 * 60;
  const [daily, weekly, spend] = await Promise.all([
    fetchCostTotal(entry, dayStart, now),
    fetchCostTotal(entry, weekStart, now),
    fetchCostTotal(entry, spendStart, now)
  ]);
  if (daily != null || weekly != null || spend != null) {
    return applyApiSpendWindow(entry, { daily, weekly, spend, totalSpend: spend });
  }

  const providerDaily = await fetchProviderUsage(entry, isoDateFromSeconds(now));
  return applyApiSpendWindow(entry, costsFromProviderUsage(providerDaily));
}

export async function checkApiKeyAccount(entry) {
  try {
    const [health, costs] = await Promise.all([
      fetchApiKeyHealth(entry),
      fetchApiKeyCosts(entry)
    ]);
    const cleanCosts = health.status == null || !costs
      ? { daily: null, weekly: null, spend: null, limitUsd: null, exhausted: false }
      : costs;
    const limitUsd = apiSpendLimitUsd(entry.account, { endpoint: entry.endpoint }) ?? cleanCosts.limitUsd;
    const exhausted = isApiKeyLimitExhausted(health.status, cleanCosts.spend, limitUsd, {
      providerExhausted: cleanCosts.subscription ? cleanCosts.exhausted : health.exhausted || cleanCosts.exhausted,
      authoritativeSubscription: cleanCosts.subscription != null,
      remaining: cleanCosts.remaining
    });
    return {
      entry,
      ok: health.status === 200,
      label: health.status === 200
        ? apiSpendRemainingLabel(cleanCosts.spend, limitUsd, exhausted, {
          windowMinutes: cleanCosts.spendWindowMinutes,
          usedPercent: cleanCosts.providerUsedPercent
        })
        : health.errorName ?? String(health.status),
      daily: cleanCosts.daily,
      weekly: cleanCosts.weekly,
      spend: cleanCosts.spend,
      totalSpend: cleanCosts.totalSpend,
      limitUsd,
      windowMinutes: cleanCosts.spendWindowMinutes,
      exhausted,
      status: health.status
    };
  } catch (error) {
    const name = error?.name === "AbortError" ? "TimedOut" : "RequestFailed";
    return {
      entry,
      ok: false,
      label: name,
      daily: null,
      weekly: null,
      spend: null,
      totalSpend: null,
      limitUsd: apiSpendLimitUsd(entry.account, { endpoint: entry.endpoint }),
      windowMinutes: null,
      exhausted: false,
      status: null
    };
  }
}

const vsllmDefaultSpendWindowMinutes = 480;
const claudeGatewayModelPrefix = "claude-fable-5-dd-";
const claudeVsllmGatewayModelPrefix = "claude-vsllm-";
const legacyVsllmClaudeGatewayModelIds = new Set([
  "claude-fake-5",
  "kimi-k3",
  "grok-4.5"
]);

function reversedModelId(value) {
  return [...value].reverse().join("");
}

function splitClaudeGatewayModelSuffix(value) {
  let base = value;
  let suffix = "";
  while (true) {
    const match = base.match(/(\[1m\]|\([^()]+\))$/i);
    if (!match) break;
    suffix = `${match[0]}${suffix}`;
    base = base.slice(0, -match[0].length);
  }
  return { base, suffix };
}

export function encodedClaudeGatewayModelId(model) {
  const id = String(model || "").trim();
  if (!id || /^(claude|anthropic)/i.test(id)) return id;
  return `${claudeGatewayModelPrefix}${reversedModelId(id)}`;
}

export function encodedVsllmClaudeGatewayModelId(model) {
  const id = String(model || "").trim();
  if (!id) return id;
  return `${claudeVsllmGatewayModelPrefix}${Buffer.from(id, "utf8").toString("base64url")}`;
}

function decodedVsllmClaudeGatewayModelId(value) {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function resolvedClaudeGatewayModelId(model) {
  const id = String(model || "").trim();
  const { base, suffix } = splitClaudeGatewayModelSuffix(id);
  if (base.startsWith(claudeVsllmGatewayModelPrefix)) {
    const decoded = decodedVsllmClaudeGatewayModelId(base.slice(claudeVsllmGatewayModelPrefix.length));
    return decoded ? `${decoded}${suffix}` : id;
  }
  if (!base.startsWith(claudeGatewayModelPrefix)) return id;
  const encoded = base.slice(claudeGatewayModelPrefix.length);
  if (!encoded) return id;
  return `${reversedModelId(encoded)}${suffix}`;
}

export function isVsllmClaudeGatewayModelId(model) {
  const id = String(model || "").trim();
  const { base } = splitClaudeGatewayModelSuffix(id);
  if (base.startsWith(claudeVsllmGatewayModelPrefix)) {
    return decodedVsllmClaudeGatewayModelId(base.slice(claudeVsllmGatewayModelPrefix.length)) != null;
  }
  if (base.startsWith(claudeGatewayModelPrefix)) {
    const resolved = resolvedClaudeGatewayModelId(base).toLowerCase();
    return legacyVsllmClaudeGatewayModelIds.has(resolved);
  }
  return legacyVsllmClaudeGatewayModelIds.has(base.toLowerCase());
}

export function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function accountOrEndpointMatches(value, pattern) {
  return typeof value === "string" && value.toLowerCase().includes(pattern);
}

export function isVsllmApiAccount(account, endpoint = "") {
  const isVsllm = String(account?.email || "").startsWith("vsllm") || String(account?.alias || "").startsWith("vsllm");
  return isVsllm || accountOrEndpointMatches(endpoint, "vsllm.com");
}

export function apiSpendLimitUsd(account, options = {}) {
  const value = Number(account?.api_spend_limit_usd);
  if (Number.isFinite(value) && value > 0) return value;
  return null;
}

function normalizeRollingSpendSamples(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((sample) => {
      const at = Number(sample?.at);
      const spendUsd = Number(sample?.spend_usd);
      if (!Number.isFinite(at) || !Number.isFinite(spendUsd) || spendUsd <= 0) return null;
      return {
        at: Math.floor(at),
        spend_usd: spendUsd,
        total_spend_usd: Number.isFinite(Number(sample?.total_spend_usd)) ? Number(sample.total_spend_usd) : null
      };
    })
    .filter(Boolean);
}

export function rollingApiSpendFromTotal(account, totalSpend, windowMinutes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const windowSeconds = Math.max(60, Math.floor(Number(windowMinutes) * 60));
  const previous = account?.api_spend_window || account?.api_spend?.rolling || {};
  const previousTotal = Number(previous.total_spend_usd);
  let samples = normalizeRollingSpendSamples(previous.samples);

  if (Number.isFinite(totalSpend)) {
    if (Number.isFinite(previousTotal)) {
      const delta = totalSpend >= previousTotal ? totalSpend - previousTotal : 0;
      if (delta > 0.000001) {
        samples.push({
          at: nowSeconds,
          spend_usd: Number(delta.toFixed(6)),
          total_spend_usd: totalSpend
        });
      }
    }
  }

  const cutoff = nowSeconds - windowSeconds;
  samples = samples.filter((sample) => sample.at >= cutoff);
  const spend = samples.reduce((total, sample) => total + sample.spend_usd, 0);

  return {
    spend: Number(spend.toFixed(6)),
    state: {
      window_minutes: Math.floor(Number(windowMinutes)),
      total_spend_usd: Number.isFinite(totalSpend) ? totalSpend : (Number.isFinite(previousTotal) ? previousTotal : null),
      samples,
      updated_at: nowSeconds
    }
  };
}

export function rollingApiSpendResetAt(samples, limitUsd, windowMinutes, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0 || !Number.isFinite(windowMinutes)) return null;
  const windowSeconds = Math.max(60, Math.floor(Number(windowMinutes) * 60));
  const cutoff = nowSeconds - windowSeconds;
  const activeSamples = normalizeRollingSpendSamples(samples)
    .filter((sample) => sample.at >= cutoff)
    .sort((a, b) => a.at - b.at);
  let spend = activeSamples.reduce((total, sample) => total + sample.spend_usd, 0);
  if (!activeSamples.length) return null;
  if (spend < limitUsd) return activeSamples[0].at + windowSeconds;

  for (const sample of activeSamples) {
    spend -= sample.spend_usd;
    const resetAt = sample.at + windowSeconds;
    if (spend < limitUsd) return resetAt;
  }
  return activeSamples[activeSamples.length - 1].at + windowSeconds;
}

export function apiSpendWindowMinutes(account, options = {}) {
  const configured = Number(account?.api_spend_window_minutes);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  if (isVsllmApiAccount(account, options.endpoint)) return vsllmDefaultSpendWindowMinutes;
  return null;
}

export function applyApiSpendWindow(entry, costs) {
  if (!costs) return costs;
  const windowMinutes = apiSpendWindowMinutes(entry.account, { endpoint: entry.endpoint });
  if (!Number.isFinite(windowMinutes)) return costs;

  const totalSpend = firstFinite(costs.totalSpend, costs.monthly, costs.weekly, costs.daily, costs.spend);
  if (!Number.isFinite(totalSpend)) return costs;

  const rolling = rollingApiSpendFromTotal(entry.account, totalSpend, windowMinutes);
  const limitUsd = apiSpendLimitUsd(entry.account, { endpoint: entry.endpoint }) ?? costs.limitUsd;
  const remaining = Number.isFinite(limitUsd) ? Math.max(0, limitUsd - rolling.spend) : costs.remaining;
  const resetsAt = rollingApiSpendResetAt(rolling.state.samples, limitUsd, windowMinutes);
  return {
    ...costs,
    daily: rolling.spend,
    weekly: rolling.spend,
    spend: rolling.spend,
    totalSpend,
    limitUsd,
    remaining,
    resetsAt,
    spendWindowMinutes: windowMinutes,
    rollingState: rolling.state
  };
}

function responseBodySearchText(body, { includeParams = false } = {}) {
  if (!body) return "";
  if (typeof body === "string") return body;
  const code = typeof body?.code === "string" ? body.code : "";
  const message = typeof body?.message === "string" ? body.message : "";
  const errorCode = typeof body?.error?.code === "string" ? body.error.code : "";
  const errorMessage = typeof body?.error?.message === "string" ? body.error.message : "";
  const parts = [code, message, errorCode, errorMessage];
  if (includeParams) {
    if (typeof body?.param === "string") parts.push(body.param);
    if (typeof body?.error?.param === "string") parts.push(body.error.param);
  }
  return parts.filter(Boolean).join(" ");
}

function responseBodyMatches(body, pattern, options = {}) {
  const text = responseBodySearchText(body, options);
  return text.length > 0 && pattern.test(text);
}

function isInsufficientBalanceBody(body) {
  return responseBodyMatches(body, /insufficient[_ -]?(balance|quota|credits?)|额度不足/i);
}

function isNoActiveSubscriptionBody(body) {
  return responseBodyMatches(body, /no active (subscription|package|plan)|activate (your )?subscription|暂无生效套餐|激活订阅/i);
}

function isVsllmTransientUsageLimitBody(body) {
  return responseBodyMatches(
    body,
    /you(?:['’]ve| have) hit your usage limit(?:\.\s*try again later\.?)?|当前订阅额度不足或暂不可用|请稍后再试/i
  );
}

function isVsllmApiKeyRestrictionBody(body) {
  return responseBodyMatches(
    body,
    /(?:ip\s+)?access denied by api[- ]?key restrictions?/i
  );
}

function isModelCapacityBody(body) {
  return responseBodyMatches(
    body,
    /server[_ -]?is[_ -]?overloaded|slow[_ -]?down|selected model is at capacity|model.{0,40}at capacity/i
  );
}

function isInvalidApiKeyBody(body) {
  return responseBodyMatches(body, /invalid[_ -]?api[_ -]?key|invalid[_ -]?key|unauthorized/i);
}

export function isInvalidEncryptedContentBody(body) {
  return responseBodyMatches(
    body,
    /invalid[_ -]?encrypted[_ -]?content|encrypted content.*(decrypt|parse|verified)|missing[_ -]?required[_ -]?parameter.*encrypted[_ -]?content|missing required parameter.*encrypted[_ -]?content/i,
    { includeParams: true }
  );
}

function apiAccountRollingLimitReached(account) {
  const limitUsd = apiSpendLimitUsd(account);
  if (!Number.isFinite(limitUsd)) return false;
  const spend = Number(account?.api_spend?.spend_usd);
  if (Number.isFinite(spend)) return spend >= limitUsd;
  const primary = Number(account?.last_usage?.primary?.used_percent);
  const secondary = Number(account?.last_usage?.secondary?.used_percent);
  return Number.isFinite(primary) && primary >= 100 || Number.isFinite(secondary) && secondary >= 100;
}

function shouldTrustProviderBalanceExhaustion(account) {
  if (!isVsllmApiAccount(account)) return true;
  return apiAccountRollingLimitReached(account);
}

export function apiProviderTransientRetryReason(status, body, account = null) {
  if (status === 503 && isModelCapacityBody(body)) return "model_capacity";
  if (!isVsllmApiAccount(account)) return null;
  if (status === 403 && isVsllmApiKeyRestrictionBody(body)) return "api_key_restriction";
  if (apiAccountRollingLimitReached(account)) return null;
  if (isInvalidApiKeyBody(body) || isNoActiveSubscriptionBody(body)) return null;
  if (status === 429 || isVsllmTransientUsageLimitBody(body)) return "vsllm_usage_limit";
  return null;
}

export function apiProviderExhaustionReason(status, body, account = null) {
  if (isInvalidApiKeyBody(body)) return "invalid_api_key";
  if (isInsufficientBalanceBody(body)) {
    return shouldTrustProviderBalanceExhaustion(account) ? "provider_limit" : null;
  }
  if (status === 402 && isNoActiveSubscriptionBody(body)) {
    return "no_active_subscription";
  }
  if (status === 429) return "rate_limit";
  return null;
}

function normalizeSubscriptionRecord(summary) {
  const subscription = summary?.subscription ?? summary;
  if (!subscription || typeof subscription !== "object") return null;
  const amountTotal = firstFinite(subscription.amount_total, summary?.amount_total);
  const amountUsed = firstFinite(subscription.amount_used, summary?.amount_used);
  const derivedUsedPercent = Number.isFinite(amountTotal) && amountTotal > 0 && Number.isFinite(amountUsed)
    ? (amountUsed / amountTotal) * 100
    : null;
  return {
    id: firstFinite(subscription.id, summary?.id),
    planId: firstFinite(subscription.plan_id, summary?.plan_id),
    status: String(subscription.status || summary?.status || "").toLowerCase(),
    startAt: firstFinite(subscription.start_time, summary?.start_time),
    endAt: firstFinite(subscription.end_time, summary?.end_time),
    lastResetAt: firstFinite(subscription.last_reset_time, summary?.last_reset_time),
    resetAt: firstFinite(subscription.next_reset_time, summary?.next_reset_time),
    usedPercent: firstFinite(subscription.used_percent, summary?.used_percent, derivedUsedPercent),
    unlimited: subscription.unlimited === true || summary?.unlimited === true,
    consumePriority: firstFinite(subscription.consume_priority, summary?.consume_priority)
  };
}

export function parseVsllmSubscriptionSelf(body, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (body?.success !== true || !body?.data || typeof body.data !== "object") return null;
  const records = Array.isArray(body.data.subscriptions)
    ? body.data.subscriptions.map(normalizeSubscriptionRecord).filter(Boolean)
    : [];
  const active = records.filter((record) => {
    if (record.status && record.status !== "active") return false;
    if (Number.isFinite(record.startAt) && record.startAt > nowSeconds) return false;
    if (Number.isFinite(record.endAt) && record.endAt <= nowSeconds) return false;
    return true;
  });
  active.sort((left, right) => {
    const leftPriority = Number.isFinite(left.consumePriority) ? left.consumePriority : Number.MAX_SAFE_INTEGER;
    const rightPriority = Number.isFinite(right.consumePriority) ? right.consumePriority : Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority;
  });

  const usable = active.filter((record) => record.unlimited || !Number.isFinite(record.usedPercent) || record.usedPercent < 100);
  const selected = usable[0] ?? active[0] ?? null;
  const billingPreference = typeof body.data.billing_preference === "string"
    ? body.data.billing_preference
    : null;
  const allActiveSubscriptionsExhausted = active.length > 0 && active.every((record) => (
    !record.unlimited && Number.isFinite(record.usedPercent) && record.usedPercent >= 100
  ));
  const exhausted = billingPreference === "subscription_only" && (active.length === 0 || allActiveSubscriptionsExhausted);
  const windowSeconds = selected && Number.isFinite(selected.lastResetAt) && Number.isFinite(selected.resetAt)
    ? selected.resetAt - selected.lastResetAt
    : null;

  return {
    activeSubscriptionCount: active.length,
    billingPreference,
    exhausted,
    subscriptionId: selected?.id ?? null,
    planId: selected?.planId ?? null,
    usedPercent: selected?.unlimited ? 0 : selected?.usedPercent ?? null,
    unlimited: selected?.unlimited === true,
    lastResetAt: selected?.lastResetAt ?? null,
    resetAt: selected?.resetAt ?? null,
    endAt: selected?.endAt ?? null,
    windowMinutes: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds / 60 : null
  };
}

export function costsFromVsllmSubscription(subscription, account) {
  if (!subscription) return null;
  const limitUsd = apiSpendLimitUsd(account);
  const usedPercent = Number(subscription.usedPercent);
  const spend = Number.isFinite(limitUsd) && Number.isFinite(usedPercent)
    ? Number((limitUsd * Math.max(0, Math.min(100, usedPercent)) / 100).toFixed(6))
    : null;
  const remaining = Number.isFinite(limitUsd) && Number.isFinite(spend)
    ? Math.max(0, limitUsd - spend)
    : null;
  return {
    daily: spend,
    weekly: spend,
    spend,
    totalSpend: null,
    limitUsd,
    remaining,
    exhausted: subscription.exhausted === true,
    resetsAt: subscription.resetAt,
    spendWindowMinutes: subscription.windowMinutes,
    providerUsedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    subscription
  };
}

function normalizeProxyModelAlias(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function remappedVsllmModel(model, { compact = false } = {}) {
  const normalized = normalizeProxyModelAlias(model);
  if (normalized === "gpt-5.2") {
    return compact ? "gpt-5.5-openai-compact" : "gpt-5.5";
  }
  if (normalized === "gpt-5.5-pro20x") {
    return compact ? "gpt-5.5-openai-compact" : "gpt-5.5";
  }
  const aliases = {
    "kimi-k3[1m]": "kimi-k3",
    "grok-4.5[1m]": "grok-4.5",
    "gpt-5.5-pro20x-openai-compact": "gpt-5.5-openai-compact",
    "gpt-5.6-sol-pro20x": "gpt-5.6-sol",
    "gpt-5.6-terra-pro20x": "gpt-5.6-terra",
    "gpt-5.6-luna-pro20x": "gpt-5.6-luna"
  };
  if (aliases[normalized]) return aliases[normalized];
  return null;
}

export function remappedProxyRequestModel(model, target, { compact = false } = {}) {
  if (!isVsllmApiAccount(target?.account, target?.upstreamBaseUrl || target?.url || "")) return null;
  return remappedVsllmModel(model, { compact });
}

export function parseProviderUsageDetails(body) {
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
    totalSpend: Number.isFinite(total) ? total : null,
    limitUsd: primaryLimit,
    remaining: Number.isFinite(remaining) ? remaining : null,
    exhausted
  };
}

export function hasProviderUsageDetails(providerUsage) {
  if (!providerUsage) return false;
  return [providerUsage.daily, providerUsage.weekly, providerUsage.monthly, providerUsage.spend, providerUsage.limitUsd, providerUsage.remaining]
    .some((value) => Number.isFinite(value));
}

export function costsFromProviderUsage(providerUsage) {
  return {
    daily: providerUsage?.daily ?? null,
    weekly: providerUsage?.weekly ?? providerUsage?.monthly ?? providerUsage?.daily ?? null,
    spend: providerUsage?.spend ?? providerUsage?.monthly ?? providerUsage?.daily ?? null,
    totalSpend: providerUsage?.totalSpend ?? providerUsage?.monthly ?? providerUsage?.spend ?? null,
    limitUsd: providerUsage?.limitUsd ?? null,
    remaining: providerUsage?.remaining ?? null,
    exhausted: providerUsage?.exhausted === true
  };
}

export function moneyUsed(value) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toFixed(2)} used`;
}

export function moneyLimitStatus(spend, limitUsd) {
  if (!Number.isFinite(limitUsd)) return moneyUsed(spend);
  if (!Number.isFinite(spend)) return `$0.00/$${limitUsd.toFixed(2)}`;
  return `$${spend.toFixed(2)}/$${limitUsd.toFixed(2)}`;
}

export function isApiKeyLimitExhausted(status, spend, limitUsd, options = {}) {
  if (status === 429 && options.authoritativeSubscription !== true) return true;
  if (options.providerExhausted === true) return true;
  if ((status === 402 || status === 403) && Number(options.remaining) === 0) return true;
  return Number.isFinite(limitUsd) && Number.isFinite(spend) && spend >= limitUsd;
}

export function apiSpendRemainingLabel(spend, limitUsd, exhausted, options = {}) {
  if (exhausted) return "0%";
  const providerUsedPercent = Number(options.usedPercent);
  if (Number.isFinite(providerUsedPercent)) {
    return `${Math.max(0, 100 - Math.floor(Math.max(0, Math.min(100, providerUsedPercent))))}%`;
  }
  if (!Number.isFinite(options.windowMinutes) || !Number.isFinite(spend) || !Number.isFinite(limitUsd) || limitUsd <= 0) return "-";
  const usedPercent = Math.max(0, Math.min(100, Math.floor((spend / limitUsd) * 100)));
  return `${Math.max(0, 100 - usedPercent)}%`;
}

export function usageSnapshotForApiSpend(spend, limitUsd, exhausted, options = {}) {
  const resetsAt = Number(options.resetsAt);
  const resetValue = Number.isFinite(resetsAt) && resetsAt > 0 ? Math.floor(resetsAt) : null;
  const providerUsedPercent = Number(options.usedPercent);
  const usedPercent = exhausted
    ? 100
    : Number.isFinite(providerUsedPercent)
      ? Math.max(0, Math.min(99, Number(providerUsedPercent.toFixed(2))))
    : Number.isFinite(spend) && Number.isFinite(limitUsd) && limitUsd > 0
      ? Math.max(0, Math.min(99, Math.floor((spend / limitUsd) * 100)))
      : 0;
  const windowMinutes = Number.isFinite(options.windowMinutes) ? options.windowMinutes : 44640;
  return {
    primary: {
      used_percent: usedPercent,
      window_minutes: windowMinutes,
      resets_at: resetValue
    },
    secondary: {
      used_percent: usedPercent,
      window_minutes: windowMinutes,
      resets_at: resetValue
    },
    credits: {
      has_credits: !exhausted,
      unlimited: options.unlimited === true,
      balance: Number.isFinite(limitUsd) && Number.isFinite(spend) ? String(Math.max(0, limitUsd - spend)) : null
    },
    plan_type: "apikey"
  };
}

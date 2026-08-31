import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  apiKeyTemplateForAccount,
  mergeApiRuntimeConfig,
  mergeSessionModelConfig,
  upsertOpenAiProviderConfig
} from "./codex-config.mjs";
import {
  canonicalizeVsllmProviderBaseUrl,
  modelsEndpointFromBaseUrl,
  readBaseUrl,
  readProviderDashboardCredential
} from "./provider-client.mjs";
import {
  apiProviderExhaustionReason,
  apiSpendLimitUsd,
  apiSpendWindowMinutes,
  rollingApiSpendResetAt,
  usageSnapshotForApiSpend
} from "./provider-policy.mjs";
import {
  accountAuthPath,
  accountConfigPath,
  backupIfExists,
  defaultCodexHome,
  ensureDir,
  managedGroupCodexHome,
  readJsonFile,
  readTextFile,
  registryPath,
  rootConfigPath,
  userHome,
  writeJsonFile,
  writeJsonFileInPlace,
  writeTextFilePrivate
} from "./storage.mjs";

export function createAccountService({ providerProxy, chatgptCodexBaseUrl }) {
  const providerProxyBaseUrl = providerProxy.baseUrl;
  const isProviderProxyBaseUrl = providerProxy.isBaseUrl;
  const ensureProviderProxyRunning = providerProxy.ensureRunning;
  const proxyRequestTargetUrl = providerProxy.proxyRequestTargetUrl;

  function apiKeyProxyConfig(codexHome, accountToml, rootToml) {
    const baseToml = String(rootToml || "").trim() ? rootToml : accountToml;
    const withApiRuntimeConfig = mergeApiRuntimeConfig(baseToml, accountToml);
    return upsertOpenAiProviderConfig(
      mergeSessionModelConfig(withApiRuntimeConfig, rootToml || accountToml),
      providerProxyBaseUrl(codexHome)
    );
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

  function loadRegistryRecordForGroup(group) {
    const filePath = registryPath(group.codexHome);
    const registry = reconcileRegistryActiveAccount(group.codexHome, readJsonFile(filePath));
    if (!registry || !Array.isArray(registry.accounts)) return null;
    return { ...group, registry };
  }

  function loadRegistryRecordsForGroups(groups) {
    return groups.map(loadRegistryRecordForGroup).filter(Boolean);
  }

  function loadManagedRegistryRecords() {
    return loadRegistryRecordsForGroups(loadManagedGroups());
  }

  const apiAccountMetadataKeys = [
    "api_template",
    "api_spend_limit_usd",
    "api_spend_window_minutes",
    "api_spend",
    "api_spend_window",
    "api_exhausted_reason",
    "provider_dashboard"
  ];

  function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function snapshotApiAccountMetadata() {
    const snapshots = new Map();
    for (const group of loadManagedRegistryRecords()) {
      const accountSnapshots = new Map();
      for (const account of group.registry.accounts) {
        if (!account || account.auth_mode !== "apikey" || typeof account.account_key !== "string") continue;
        const metadata = {};
        for (const key of apiAccountMetadataKeys) {
          if (Object.prototype.hasOwnProperty.call(account, key)) {
            metadata[key] = cloneJsonValue(account[key]);
          }
        }
        if (Object.keys(metadata).length > 0) {
          accountSnapshots.set(account.account_key, metadata);
        }
      }
      if (accountSnapshots.size > 0) {
        snapshots.set(registryPath(group.codexHome), accountSnapshots);
      }
    }
    return snapshots;
  }

  function restoreApiAccountMetadataSnapshot(snapshots) {
    if (!snapshots || snapshots.size === 0) return;
    for (const [filePath, accountSnapshots] of snapshots) {
      const registry = readJsonFile(filePath);
      if (!registry || !Array.isArray(registry.accounts)) continue;
      let changed = false;
      for (const account of registry.accounts) {
        if (!account || typeof account.account_key !== "string") continue;
        const metadata = accountSnapshots.get(account.account_key);
        if (!metadata) continue;
        for (const [key, value] of Object.entries(metadata)) {
          if (account[key] !== undefined) continue;
          account[key] = cloneJsonValue(value);
          changed = true;
        }
      }
      if (changed) {
        writeJsonFile(filePath, registry);
      }
    }
  }

  function loadApiKeyAccountsForManagedList() {
    return loadManagedRegistryRecords().flatMap((group) => loadApiKeyAccountsFromRegistry(group.name, group.codexHome, group.registry));
  }

  function loadApiKeyAccountsFromCodexHome(groupName, codexHome) {
    const registry = readJsonFile(path.join(codexHome, "accounts", "registry.json"));
    return loadApiKeyAccountsFromRegistry(groupName, codexHome, registry);
  }

  function loadApiKeyAccountsFromRegistry(groupName, codexHome, registry) {
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
          endpoint: modelsEndpointFromBaseUrl(baseUrl),
          dashboardCredential: readProviderDashboardCredential(codexHome, account)
        };
      })
      .filter((entry) => entry.apiKey.length > 0);
  }

  function upstreamBaseFromAccountConfig(codexHome, accountKey) {
    const baseUrl = readBaseUrl(accountConfigPath(codexHome, accountKey));
    if (!baseUrl || isProviderProxyBaseUrl(baseUrl)) return null;
    return canonicalizeVsllmProviderBaseUrl(baseUrl).replace(/\/+$/, "");
  }

  function apiProxyTargetForAccount(codexHome, account) {
    if (!account) {
      return { error: "No active account for this group.", status: 409 };
    }

    if (account.auth_mode !== "apikey") {
      const authJson = readJsonFile(accountAuthPath(codexHome, account.account_key));
      const accessToken = typeof authJson?.tokens?.access_token === "string" ? authJson.tokens.access_token : "";
      return {
        account,
        apiKey: null,
        accessToken,
        upstreamBaseUrl: chatgptCodexBaseUrl,
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

    const template = apiKeyTemplateForAccount(account, upstreamBaseUrl);
    return {
      account,
      apiKey,
      upstreamBaseUrl,
      chatgpt: false,
      apiTemplate: template?.name || "openai",
      repairInvalidEncryptedContent: template?.repairInvalidEncryptedContent === true,
      stripInternalMetadataPassthrough: template?.stripInternalMetadataPassthrough === true || account?.strip_internal_metadata_passthrough === true
    };
  }

  function activeApiProxyTarget(codexHome) {
    const registry = reconcileRegistryActiveAccount(codexHome, readJsonFile(registryPath(codexHome)));
    return apiProxyTargetForAccount(codexHome, activeRegistryAccountFromRegistry(registry));
  }

  // Enumerate API-key accounts in the same group that can serve as a last-
  // resort fallback for an idempotent compaction request. The active account
  // comes first; the remaining usable same-group apikey accounts follow in
  // the standard sorted order. Pinned routes never get a fallback chain: a
  // pinned proxy URL stays on the caller-selected account only. Returns the
  // already-built proxy target so callers can hand it straight to the
  // compaction summarizer.
  function listCompactionAccountCandidates(codexHome, options = {}) {
    const excludeAccountKeys = new Set(
      Array.isArray(options.excludeAccountKeys) ? options.excludeAccountKeys : []
    );
    const pinnedOnly = options.pinnedOnly === true;
    if (pinnedOnly) return [];
    const registry = reconcileRegistryActiveAccount(codexHome, readJsonFile(registryPath(codexHome)));
    if (!registry || !Array.isArray(registry.accounts)) return [];
    const activeKey = activeAccountKeyFromRegistry(registry);
    const orderedKeys = [];
    if (activeKey) orderedKeys.push(activeKey);
    for (const account of sortedRegistryAccounts(registry)) {
      if (!account || account.account_key === activeKey) continue;
      orderedKeys.push(account.account_key);
    }
    const out = [];
    for (const accountKey of orderedKeys) {
      if (excludeAccountKeys.has(accountKey)) continue;
      const account = accountForKey(registry, accountKey);
      if (!account || account.auth_mode !== "apikey") continue;
      if (accountIsExhausted(account)) continue;
      const target = apiProxyTargetForAccount(codexHome, account);
      if (!target || target.error) continue;
      out.push(target);
    }
    return out;
  }

  function apiProxyAccountForSelector(codexHome, selector) {
    const registry = readJsonFile(registryPath(codexHome));
    if (!registry || !Array.isArray(registry.accounts)) {
      return { error: "No account registry found for this proxy route.", status: 404 };
    }

    const normalized = String(selector || "").trim().toLowerCase();
    if (!normalized) {
      return { error: "A pinned proxy account selector is required.", status: 400 };
    }

    const matches = registry.accounts.filter((account) => {
      if (!account || account.auth_mode !== "apikey") return false;
      return [account.account_key, account.alias]
        .filter((value) => typeof value === "string" && value.length > 0)
        .some((value) => value.toLowerCase() === normalized);
    });
    if (matches.length === 0) {
      return { error: `No API-key account matched pinned proxy selector ${JSON.stringify(selector)}.`, status: 404 };
    }
    if (matches.length > 1) {
      return { error: `Pinned proxy selector ${JSON.stringify(selector)} is ambiguous. Use the account key from \`proxy url\`.`, status: 409 };
    }
    return { account: matches[0] };
  }

  function pinnedApiProxyTarget(codexHome, selector) {
    const selected = apiProxyAccountForSelector(codexHome, selector);
    if (selected.error) return selected;
    return apiProxyTargetForAccount(codexHome, selected.account);
  }

  function markApiAccountExhaustedFromProxy(codexHome, account, status, body) {
    const filePath = registryPath(codexHome);
    const registry = readJsonFile(filePath);
    if (!registry || !Array.isArray(registry.accounts)) return null;

    const existing = registry.accounts.find((item) => item?.account_key === account?.account_key);
    if (!existing) return null;

    const now = Math.floor(Date.now() / 1000);
    const limitUsd = apiSpendLimitUsd(existing);
    const windowMinutes = apiSpendWindowMinutes(existing);
    existing.api_spend = {
      spend_usd: Number.isFinite(Number(existing.api_spend?.spend_usd)) ? Number(existing.api_spend.spend_usd) : null,
      total_spend_usd: Number.isFinite(Number(existing.api_spend?.total_spend_usd)) ? Number(existing.api_spend.total_spend_usd) : null,
      limit_usd: limitUsd,
      remaining_usd: 0,
      window_minutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
      status,
      exhausted: true,
      checked_at: now
    };
    existing.last_usage = usageSnapshotForApiSpend(existing.api_spend.spend_usd, limitUsd, true, {
      windowMinutes,
      resetsAt: rollingApiSpendResetAt(existing.api_spend_window?.samples, limitUsd, windowMinutes)
    });
    existing.last_usage_at = now;
    existing.api_exhausted_reason = apiProviderExhaustionReason(status, body, existing) || "provider_limit";
    writeJsonFile(filePath, registry);
    return registry;
  }

  async function switchFromExhaustedApiAccount(codexHome, account, status, body, options = {}) {
    const registry = markApiAccountExhaustedFromProxy(codexHome, account, status, body);
    if (!registry || (!options.force && !autoSwitchEnabled(registry))) return false;

    const candidate = firstUsableSwitchCandidate(registry, {
      preferredAuthMode: "apikey",
      excludeAccountKeys: options.excludeAccountKeys
    });
    if (!candidate) return false;
    await switchToStoredAccount(codexHome, candidate);
    return true;
  }

  async function targetFromTransientApiFailure(codexHome, req, options = {}) {
    const registry = readJsonFile(registryPath(codexHome));
    if (!registry || !autoSwitchEnabled(registry)) return null;

    const candidate = firstUsableSwitchCandidate(registry, {
      preferredAuthMode: "apikey",
      excludeAccountKeys: options.excludeAccountKeys
    });
    if (!candidate) return null;
    const target = apiProxyTargetForAccount(codexHome, candidate);
    if (target.error) return null;
    return proxyRequestTargetUrl(req, codexHome, target);
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

  // Auto-switch is gated on hard exhaustion only. The configured
  // `threshold_5h_percent` / `threshold_weekly_percent` values are kept for
  // backwards compatibility with existing registries and the `config auto`
  // display, but they no longer trigger an automatic account flip. Switching
  // on near-threshold usage was churning the active account every 30 s when
  // the most-recently-used candidate happened to be different.
  function accountShouldAutoSwitch(account, registry) {
    if (!account) return false;
    return accountIsExhausted(account);
  }

  function accountIsSwitchCandidate(account) {
    return !accountIsExhausted(account);
  }

  function accountSortTime(account) {
    return Number(account.last_used_at || account.created_at || 0);
  }

  // Lower is better. Missing usage counts as 0% (freshest possible) so an
  // account we have never observed is preferred over one we have already
  // loaded.
  function accountUsagePercent(account) {
    const primary = Number(account?.last_usage?.primary?.used_percent);
    return Number.isFinite(primary) ? primary : 0;
  }

  // Order candidates by usage ascending (best first), then by last_used_at
  // ascending (oldest first) so the daemon rotates fairly instead of
  // re-picking the same account every cycle.
  function compareSwitchCandidates(a, b) {
    const byUsage = accountUsagePercent(a) - accountUsagePercent(b);
    if (byUsage !== 0) return byUsage;
    return accountSortTime(a) - accountSortTime(b);
  }

  function sortedRegistryAccounts(registry) {
    return [...registry.accounts].sort((a, b) => accountSortTime(b) - accountSortTime(a));
  }

  function accountForKey(registry, accountKey) {
    if (!registry || !Array.isArray(registry.accounts) || typeof accountKey !== "string") return null;
    return registry.accounts.find((account) => account?.account_key === accountKey) ?? null;
  }

  // `active_account_key` is the canonical field used by the proxy. Older
  // native registries may also carry `activeAccountKey` or per-account
  // `active` flags; use those only as migration fallbacks when the canonical
  // key is absent or points at an account that no longer exists.
  function activeAccountKeyFromRegistry(registry) {
    if (!registry || !Array.isArray(registry.accounts)) return null;
    const canonical = typeof registry.active_account_key === "string"
      ? registry.active_account_key.trim()
      : "";
    if (canonical && accountForKey(registry, canonical)) return canonical;

    const legacy = typeof registry.activeAccountKey === "string"
      ? registry.activeAccountKey.trim()
      : "";
    if (legacy && accountForKey(registry, legacy)) return legacy;

    const flagged = registry.accounts.find((account) => account?.active === true);
    return typeof flagged?.account_key === "string" ? flagged.account_key : null;
  }

  function synchronizeActiveAccountMetadata(registry, accountKey) {
    if (!registry || !Array.isArray(registry.accounts) || !accountForKey(registry, accountKey)) return false;
    let changed = false;
    if (registry.active_account_key !== accountKey) {
      registry.active_account_key = accountKey;
      changed = true;
    }

    const hasLegacyKey = Object.prototype.hasOwnProperty.call(registry, "activeAccountKey");
    const hasActiveFlags = registry.accounts.some((account) => Object.prototype.hasOwnProperty.call(account || {}, "active"));
    if (hasLegacyKey && registry.activeAccountKey !== accountKey) {
      registry.activeAccountKey = accountKey;
      changed = true;
    }
    if (hasActiveFlags) {
      for (const account of registry.accounts) {
        const next = account?.account_key === accountKey;
        if (account.active !== next) {
          account.active = next;
          changed = true;
        }
      }
    }
    return changed;
  }

  function rootAuthAccountKey(registry, rootAuth) {
    if (!registry || !Array.isArray(registry.accounts) || !rootAuth || typeof rootAuth !== "object") return "";
    const explicit = typeof rootAuth.account_key === "string" ? rootAuth.account_key.trim() : "";
    if (explicit && accountForKey(registry, explicit)) return explicit;

    const accountId = typeof rootAuth.tokens?.account_id === "string" ? rootAuth.tokens.account_id.trim() : "";
    if (accountId) {
      const matches = registry.accounts.filter((account) => account?.chatgpt_account_id === accountId);
      if (matches.length === 1) return matches[0].account_key;
    }

    const email = typeof rootAuth.email === "string" ? rootAuth.email.trim().toLowerCase() : "";
    if (email) {
      const matches = registry.accounts.filter((account) => typeof account?.email === "string" && account.email.trim().toLowerCase() === email);
      if (matches.length === 1) return matches[0].account_key;
    }
    return "";
  }

  // auth.json is the credential identity Codex presents as active. Native
  // activation writes it without changing the wrapper's activation timestamp;
  // use that timestamp to distinguish a native switch from a deliberately
  // rewritten test/registry state or a stale auth file.
  function reconcileRegistryActiveAccount(codexHome, registry, options = {}) {
    if (!registry || !Array.isArray(registry.accounts)) return registry;
    const persist = options.persist !== false;
    const rootAuthPath = path.join(codexHome, "auth.json");
    const rootAuth = readJsonFile(rootAuthPath);
    const rootKey = rootAuthAccountKey(registry, rootAuth);
    if (!rootKey) return registry;

    const registryKey = activeAccountKeyFromRegistry(registry);
    let rootMtimeMs = 0;
    try {
      rootMtimeMs = Number(fs.statSync(rootAuthPath).mtimeMs) || 0;
    } catch {
      return registry;
    }
    if (registryKey === rootKey) {
      // Repair legacy markers even when the canonical key is already right.
      if (synchronizeActiveAccountMetadata(registry, rootKey)) {
        if (persist) writeJsonFile(registryPath(codexHome), registry);
      }
      return registry;
    }

    const activatedAtMs = Number(registry.active_account_activated_at_ms) || 0;
    if (registryKey && activatedAtMs <= 0) {
      // Pre-timestamp registries can still reconcile a native activation when
      // auth.json is the newer file. Otherwise keep the registry authoritative.
      let registryMtimeMs = 0;
      try {
        registryMtimeMs = Number(fs.statSync(registryPath(codexHome)).mtimeMs) || 0;
      } catch {
        return registry;
      }
      if (rootMtimeMs <= registryMtimeMs) return registry;
    }
    if (activatedAtMs > 0 && rootMtimeMs <= activatedAtMs) return registry;

    if (synchronizeActiveAccountMetadata(registry, rootKey)) {
      registry.active_account_activated_at_ms = Math.max(Date.now(), Math.ceil(rootMtimeMs));
      if (persist) {
        writeJsonFile(registryPath(codexHome), registry);
        try { fs.chmodSync(registryPath(codexHome), 0o600); } catch { /* best effort */ }
      }
    }
    return registry;
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

  async function switchToStoredAccount(codexHome, account) {
    const registryFile = registryPath(codexHome);
    const registry = readJsonFile(registryFile);
    const storedAccount = accountForKey(registry, account?.account_key);
    if (!storedAccount) {
      console.error(`Account is not present in the registry: ${accountLabel(account)}.`);
      process.exit(1);
    }
    account = storedAccount;

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
    const rootAuth = readJsonFile(authPath);
    if (rootAuth && typeof rootAuth === "object") {
      rootAuth.auth_mode = account.auth_mode === "apikey" ? "apikey" : "chatgpt";
      rootAuth.email = account.email || rootAuth.email || "";
      rootAuth.alias = account.alias || rootAuth.alias || "";
      rootAuth.account_key = account.account_key;
      rootAuth.codex_auth_advanced_switch_nonce = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      if (account.auth_mode === "apikey") {
        rootAuth.email = account.email || account.alias || account.account_key;
        rootAuth.alias = account.alias || rootAuth.alias || "";
      }
      writeJsonFileInPlace(rootAuthPath, rootAuth);
      fs.chmodSync(rootAuthPath, 0o600);
    }

    if (registry && Array.isArray(registry.accounts)) {
      synchronizeActiveAccountMetadata(registry, account.account_key);
      registry.active_account_activated_at_ms = Date.now();
      const existing = registry.accounts.find((item) => item?.account_key === account.account_key);
      if (existing) existing.last_used_at = Math.floor(Date.now() / 1000);
      writeJsonFile(registryFile, registry);
      fs.chmodSync(registryFile, 0o600);
    }
    process.stdout.write(`Switched to ${accountLabel(account)}.\n`);
  }

  function activeRegistryAccountFromRegistry(registry) {
    const activeKey = activeAccountKeyFromRegistry(registry);
    return accountForKey(registry, activeKey);
  }

  function firstUsableSwitchCandidate(registry, { preferredAuthMode = null, excludeAccountKeys = null } = {}) {
    const active = activeAccountKeyFromRegistry(registry);
    const excluded = new Set(excludeAccountKeys || []);
    const candidates = [...registry.accounts]
      .filter((account) => account.account_key !== active && !excluded.has(account.account_key) && accountIsSwitchCandidate(account))
      .sort(compareSwitchCandidates);
    if (preferredAuthMode) {
      const preferred = candidates.find((account) => account.auth_mode === preferredAuthMode);
      if (preferred) return preferred;
    }
    return candidates[0] ?? null;
  }

  function autoSwitchEnabled(registry) {
    const auto = registry?.auto_switch;
    return auto?.enabled === true;
  }

  return {
    apiKeyProxyConfig,
    loadApiKeyAccountsForGroup,
    loadManagedGroups,
    loadRegistryRecordForGroup,
    loadRegistryRecordsForGroups,
    loadManagedRegistryRecords,
    snapshotApiAccountMetadata,
    restoreApiAccountMetadataSnapshot,
    loadApiKeyAccountsForManagedList,
    loadApiKeyAccountsFromCodexHome,
    loadApiKeyAccountsFromRegistry,
    activeApiProxyTarget,
    apiProxyAccountForSelector,
    pinnedApiProxyTarget,
    markApiAccountExhaustedFromProxy,
    switchFromExhaustedApiAccount,
    targetFromTransientApiFailure,
    accountMatchesQuery,
    accountLabel,
    accountPlanLabel,
    accountUsageLabel,
    accountIsExhausted,
    accountRemainingPercent,
    accountUsagePercent,
    registryAutoThresholds,
    accountShouldAutoSwitch,
    sortedRegistryAccounts,
    compareSwitchCandidates,
    findAccountForSwitch,
    reconcileRegistryActiveAccount,
    switchToStoredAccount,
    activeRegistryAccountFromRegistry,
    firstUsableSwitchCandidate,
    autoSwitchEnabled,
    listCompactionAccountCandidates
  };
}

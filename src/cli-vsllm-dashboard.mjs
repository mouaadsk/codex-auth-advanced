import fs from "node:fs";
import path from "node:path";
import {
  canonicalizeVsllmProviderOrigin,
  fetchProviderDashboardJson,
  normalizeProviderOrigin,
  providerDashboardCredentialPath,
  providerDashboardOriginMatchesModelsEndpoint
} from "./provider-client.mjs";
import {
  firstFinite,
  parseVsllmSubscriptionSelf
} from "./provider-policy.mjs";
import {
  accountConfigPath,
  defaultCodexHome,
  ensureDir,
  managedGroupCodexHome,
  providerDashboardCredentialsDir,
  readJsonFile,
  registryPath,
  writeJsonFile
} from "./storage.mjs";
export function parseVsllmDashboardConfigArgs(args) {
  const options = {
    account: null,
    alias: "",
    origin: "https://vsllm.com",
    stdin: false,
    userId: null
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
    if (arg === "--account") {
      options.account = nextValue();
    } else if (arg.startsWith("--account=")) {
      options.account = arg.slice("--account=".length);
    } else if (arg === "--alias") {
      options.alias = nextValue();
    } else if (arg.startsWith("--alias=")) {
      options.alias = arg.slice("--alias=".length);
    } else if (arg === "--origin") {
      options.origin = nextValue();
    } else if (arg.startsWith("--origin=")) {
      options.origin = arg.slice("--origin=".length);
    } else if (arg === "--user-id") {
      options.userId = Number(nextValue());
    } else if (arg.startsWith("--user-id=")) {
      options.userId = Number(arg.slice("--user-id=".length));
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (!arg.startsWith("-") && options.account == null) {
      options.account = arg;
    } else {
      console.error(`unknown argument for vsllm-dashboard: ${arg}`);
      process.exit(1);
    }
  }

  options.origin = normalizeProviderOrigin(options.origin);
  if (!options.origin) {
    console.error("vsllm-dashboard requires a valid --origin URL.");
    process.exit(1);
  }
  if (!Number.isInteger(options.userId) || options.userId <= 0) {
    console.error("vsllm-dashboard requires a positive numeric --user-id.");
    process.exit(1);
  }
  return options;
}

export function readVsllmDashboardAccessToken(options) {
  if (options.stdin) return fs.readFileSync(0, "utf8").trim();
  if (process.env.CODEX_AUTH_ADVANCED_VSLLM_ACCESS_TOKEN) {
    return process.env.CODEX_AUTH_ADVANCED_VSLLM_ACCESS_TOKEN.trim();
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    return readSecretLineFromTty("VSLLM dashboard access token: ");
  }
  console.error("vsllm-dashboard requires --stdin, CODEX_AUTH_ADVANCED_VSLLM_ACCESS_TOKEN, or an interactive terminal.");
  process.exit(1);
}

export function maskedNewApiTokenKey(apiKey) {
  const key = String(apiKey || "").trim().replace(/^Bearer\s+/i, "").replace(/^sk-/, "");
  if (!key) return "";
  if (key.length <= 4) return "*".repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}**********${key.slice(-4)}`;
}

export function normalizeMaskedNewApiTokenKey(value) {
  return String(value || "").trim().replace(/^sk-/, "");
}

export async function fetchDashboardMaskedTokenKeys(credential) {
  const maskedKeys = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const result = await fetchProviderDashboardJson(credential, `/api/token/?p=${page}&size=100`);
    if (result.status !== 200 || result.body?.success !== true) {
      return { ok: false, maskedKeys, message: result.body?.message || result.error || `HTTP ${result.status}` };
    }
    const data = result.body?.data;
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const masked = normalizeMaskedNewApiTokenKey(item?.key);
      if (masked) maskedKeys.add(masked);
    }
    const total = Number(data?.total);
    if (!Number.isFinite(total) || page * 100 >= total) break;
  }
  return { ok: true, maskedKeys, message: "" };
}

import { createAccountService } from "./account-service.mjs";

const defaultAccountService = createAccountService({
  providerProxy: { baseUrl: () => "" },
  chatgptCodexBaseUrl: "https://chatgpt.com/backend-api/codex"
});

export function matchingDashboardApiEntries(codexHome, credential, maskedKeys) {
  return defaultAccountService.loadApiKeyAccountsFromCodexHome("default", codexHome).filter((entry) => {
    if (!providerDashboardOriginMatchesModelsEndpoint(entry.endpoint, credential.origin)) return false;
    const masked = maskedNewApiTokenKey(entry.apiKey);
    return masked && maskedKeys.has(masked);
  });
}

export function selectDashboardApiEntry(codexHome, options, tokenResult, credential) {
  const discovered = matchingDashboardApiEntries(codexHome, credential, tokenResult.maskedKeys);
  if (options.account) {
    const requested = defaultAccountService.loadApiKeyAccountsFromCodexHome("default", codexHome)
      .filter((entry) => defaultAccountService.accountMatchesQuery(entry.account, options.account));
    if (requested.length !== 1) {
      console.error(requested.length === 0
        ? `No API-key account matched ${JSON.stringify(options.account)}.`
        : `Multiple API-key accounts matched ${JSON.stringify(options.account)}.`);
      process.exit(1);
    }
    if (!discovered.some((entry) => entry.account.account_key === requested[0].account.account_key)) {
      console.error(`Dashboard user ${options.userId} does not own the stored API key for ${defaultAccountService.accountLabel(requested[0].account)}.`);
      process.exit(1);
    }
    return requested[0];
  }
  if (discovered.length === 1) return discovered[0];
  if (discovered.length === 0) {
    console.error(`No locally stored API key matched the masked tokens owned by dashboard user ${options.userId}.`);
  } else {
    console.error(`Dashboard user ${options.userId} matched multiple local API accounts; rerun with --account <account-key-or-alias>.`);
  }
  process.exit(1);
}

export function localTimestampLabel(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long"
  }).format(new Date(Number(seconds) * 1000));
}

export function subscriptionRemainingLabel(subscription) {
  if (subscription?.unlimited) return "unlimited";
  const usedPercent = Number(subscription?.usedPercent);
  if (!Number.isFinite(usedPercent)) return "unknown";
  return `${Math.max(0, 100 - Math.max(0, Math.min(100, usedPercent))).toFixed(0)}%`;
}

export async function configureVsllmDashboard(codexHome, options, { syncApiKeySpendLimits = null } = {}) {
  const accessToken = readVsllmDashboardAccessToken(options).replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    console.error("VSLLM dashboard access token cannot be empty.");
    process.exit(1);
  }
  const credential = {
    schema_version: 1,
    provider: "vsllm",
    origin: canonicalizeVsllmProviderOrigin(options.origin),
    user_id: options.userId,
    alias: options.alias || `vsllm-user-${options.userId}`,
    access_token: accessToken
  };
  const subscriptionResult = await fetchProviderDashboardJson(credential, "/api/subscription/self");
  const subscription = subscriptionResult.status === 200
    ? parseVsllmSubscriptionSelf(subscriptionResult.body)
    : null;
  if (!subscription) {
    const message = subscriptionResult.body?.message || subscriptionResult.error || `HTTP ${subscriptionResult.status}`;
    console.error(`Could not authenticate VSLLM dashboard user ${options.userId}: ${message}`);
    process.exit(1);
  }

  const tokenResult = await fetchDashboardMaskedTokenKeys(credential);
  if (!tokenResult.ok) {
    console.error(`Could not verify VSLLM API-key ownership for user ${options.userId}: ${tokenResult.message}`);
    process.exit(1);
  }
  const entry = selectDashboardApiEntry(codexHome, options, tokenResult, credential);
  credential.account_key = entry.account.account_key;
  credential.configured_at = Math.floor(Date.now() / 1000);

  const credentialsDir = providerDashboardCredentialsDir(codexHome);
  ensureDir(credentialsDir);
  const credentialPath = providerDashboardCredentialPath(codexHome, credential.origin, credential.user_id);
  writeJsonFile(credentialPath, credential);
  fs.chmodSync(credentialPath, 0o600);

  const filePath = registryPath(codexHome);
  const registry = readJsonFile(filePath);
  const account = registry?.accounts?.find((item) => item?.account_key === entry.account.account_key);
  if (!account) {
    console.error("The matched API account disappeared before dashboard credentials could be linked.");
    process.exit(1);
  }
  account.provider_dashboard = {
    provider: "vsllm",
    origin: credential.origin,
    user_id: credential.user_id,
    alias: credential.alias
  };
  writeJsonFile(filePath, registry);
  if (typeof syncApiKeySpendLimits === "function") {
    await syncApiKeySpendLimits();
  }

  process.stdout.write(`Configured ${credential.alias} (dashboard user ${credential.user_id}) for ${defaultAccountService.accountLabel(account)}.\n`);
  process.stdout.write(`subscription: ${subscription.exhausted ? "exhausted" : "active"}, ${subscriptionRemainingLabel(subscription)} remaining\n`);
  process.stdout.write(`next reset: ${localTimestampLabel(subscription.resetAt)}\n`);
  process.stdout.write(`subscription ends: ${localTimestampLabel(subscription.endAt)}\n`);
}

export async function maybeHandleVsllmDashboardConfig(argv, options = {}) {
  let codexHome = null;
  let args = null;
  if (argv[0] === "config" && argv[1] === "vsllm-dashboard") {
    codexHome = defaultCodexHome();
    args = argv.slice(2);
  } else if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "config" && argv[3] === "vsllm-dashboard") {
    codexHome = managedGroupCodexHome(argv[1]);
    args = argv.slice(4);
  } else {
    return false;
  }
  await configureVsllmDashboard(codexHome, parseVsllmDashboardConfigArgs(args), options);
  return true;
}


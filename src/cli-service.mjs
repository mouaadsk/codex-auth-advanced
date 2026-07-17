import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { apiKeyTemplate, defaultApiKeyConfig } from "./codex-config.mjs";
import {
  checkApiKeyAccount,
  fetchApiKeyCosts,
  fetchApiKeyHealth,
  fetchProviderDashboardJson,
  modelsEndpointFromBaseUrl,
  normalizeProviderOrigin,
  providerDashboardCredentialPath,
  providerOriginFromModelsEndpoint,
  readBaseUrl
} from "./provider-client.mjs";
import {
  apiSpendLimitUsd,
  apiSpendWindowMinutes,
  firstFinite,
  isApiKeyLimitExhausted,
  moneyLimitStatus,
  moneyUsed,
  parseVsllmSubscriptionSelf,
  usageSnapshotForApiSpend
} from "./provider-policy.mjs";
import {
  accountAuthPath,
  accountConfigPath,
  accountKeyFromApiKey,
  copyFilePrivate,
  defaultCodexHome,
  ensureDir,
  managedGroupCodexHome,
  providerDashboardCredentialsDir,
  readJsonFile,
  readTextFile,
  registryPath,
  rootConfigPath,
  userHome,
  writeJsonFile,
  writeTextFilePrivate
} from "./storage.mjs";

const apiSpendLimitFlags = new Set(["--api-spend-limit-usd", "--api-limit-usd", "--spend-limit-usd"]);

function isApiKeyAwareGroupList(argv) {
  return argv.length >= 3 && argv[0] === "group" && argv[2] === "list" && !argv.includes("--live");
}

function isApiKeyAwareManagedList(argv) {
  return argv.length >= 1 && argv[0] === "list" && !argv.includes("--live");
}

export function createCliService({
  providerProxy,
  accountService,
  clientConfigService,
  writeManagerPidFile,
  removeManagerPidFile,
  ensureAutoSwitchManagerRunning,
  stopAutoSwitchManager,
  childEnvForArgv,
  exitFromChild
}) {
  const providerProxyBaseUrl = providerProxy.baseUrl;
  const providerProxyAccountBaseUrl = providerProxy.accountBaseUrl;
  const providerProxyHealthUrl = providerProxy.healthUrl;
  const isProviderProxyBaseUrl = providerProxy.isBaseUrl;
  const startProviderProxyServer = providerProxy.startServer;
  const providerProxyIsRunning = providerProxy.isRunning;
  const ensureProviderProxyRunning = providerProxy.ensureRunning;
  const {
    loadApiKeyAccountsForGroup,
    loadManagedGroups,
    loadRegistryRecordsForGroups,
    loadManagedRegistryRecords,
    loadApiKeyAccountsForManagedList,
    loadApiKeyAccountsFromCodexHome,
    apiProxyAccountForSelector,
    accountMatchesQuery,
    accountLabel,
    accountPlanLabel,
    accountUsageLabel,
    accountIsExhausted,
    registryAutoThresholds,
    accountShouldAutoSwitch,
    sortedRegistryAccounts,
    findAccountForSwitch,
    switchToStoredAccount,
    activeRegistryAccountFromRegistry,
    firstUsableSwitchCandidate,
    autoSwitchEnabled
  } = accountService;
  const { ensureAllActiveAccountConfigs } = clientConfigService;

  async function maybeHandleProviderProxy(argv) {
    const command = argv[0] === "proxy"
      ? { codexHome: defaultCodexHome(), args: argv.slice(1) }
      : argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "proxy"
        ? { codexHome: managedGroupCodexHome(argv[1]), args: argv.slice(3) }
        : null;
    if (!command) return false;

    const subcommand = command.args[0] || "status";
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
    if (subcommand === "url") {
      const selector = command.args[1];
      if (command.args.length > 2) {
        console.error("Usage: codex-auth-advanced [group <name>] proxy url [account-key-or-alias]");
        process.exit(1);
      }

      const codexHome = command.codexHome;
      if (!selector) {
        process.stdout.write(`${providerProxyBaseUrl(codexHome)}\n`);
        return true;
      }

      const selected = apiProxyAccountForSelector(codexHome, selector);
      if (selected.error) {
        console.error(selected.error);
        process.exit(selected.status === 404 ? 2 : 1);
      }
      const url = providerProxyAccountBaseUrl(codexHome, selected.account);
      if (!url) {
        console.error(`Could not build a proxy URL for ${accountLabel(selected.account)}.`);
        process.exit(1);
      }
      process.stdout.write(`${url}\n`);
      return true;
    }
    if (subcommand === "urls") {
      const codexHome = command.codexHome;
      const registry = readJsonFile(registryPath(codexHome));
      const accounts = Array.isArray(registry?.accounts)
        ? registry.accounts.filter((account) => account?.auth_mode === "apikey")
        : [];
      if (accounts.length === 0) {
        console.error("No API-key accounts are available for pinned proxy URLs.");
        process.exit(2);
      }
      for (const account of sortedRegistryAccounts({ accounts })) {
        process.stdout.write(`${accountLabel(account)}\t${providerProxyAccountBaseUrl(codexHome, account)}\n`);
      }
      return true;
    }
    console.error("Usage: codex-auth-advanced [group <name>] proxy status|start|serve|url [account-key-or-alias]|urls");
    process.exit(1);
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
    const keys = accountTableKeys(false, ["account", "plan", "fiveHour", "weekly", "exhausted"]);
    const widths = accountTableWidths(rows, keys);
    const header = renderAccountTableHeader(keys, widths, 5);
    process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
    for (const row of rows) {
      process.stdout.write(`${renderAccountTableRow(row, keys, widths)}\n`);
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

  function accountResetLabel(account) {
    const resetAt = firstFinite(account.api_spend?.reset_at, account.last_usage?.primary?.resets_at);
    if (!Number.isFinite(resetAt)) return "-";
    const remaining = Math.max(0, Math.floor(resetAt - Date.now() / 1000));
    if (remaining === 0) return "Now";
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
  }

  const accountTableColumnLabels = {
    group: "GROUP",
    account: "ACCOUNT",
    plan: "PLAN",
    fiveHour: "PRIMARY LEFT",
    daily: "DAILY",
    weekly: "WEEKLY LEFT",
    reset: "RESET IN",
    last: "LAST ACTIVITY",
    exhausted: "EXHAUSTED"
  };

  function accountTableKeys(grouped, keys) {
    return grouped ? ["group", ...keys] : keys;
  }

  function accountTableWidths(rows, keys) {
    const widths = {};
    for (const key of keys) {
      const label = accountTableColumnLabels[key] || key.toUpperCase();
      widths[key] = Math.max(label.length, ...rows.map((row) => String(row[key] ?? "").length));
    }
    return widths;
  }

  function renderAccountTableHeader(keys, widths, prefixWidth) {
    return `${" ".repeat(prefixWidth)}${keys.map((key) => pad(accountTableColumnLabels[key] || key.toUpperCase(), widths[key])).join("  ")}`;
  }

  function renderAccountTableRow(row, keys, widths, indexWidth = null) {
    const index = Number.isFinite(indexWidth) ? String(row.index).padStart(indexWidth, "0") : row.index;
    const prefix = `${row.marker} ${index} `;
    return `${prefix}${keys.map((key) => pad(row[key], widths[key])).join("  ")}`;
  }

  function renderLocalList(groups) {
    const rows = [];
    const grouped = groups.length > 1;
    for (const group of loadRegistryRecordsForGroups(groups)) {
      const { registry } = group;
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
          reset: accountResetLabel(account),
          last: accountLastLabel(account)
        });
      }
    }
    if (!rows.length) {
      process.stdout.write("No accounts found.\n");
      return;
    }

    const keys = accountTableKeys(grouped, ["account", "plan", "fiveHour", "daily", "weekly", "reset", "last"]);
    const widths = accountTableWidths(rows, keys);
    const prefixWidth = 5;
    const header = renderAccountTableHeader(keys, widths, prefixWidth);
    process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
    for (const row of rows) {
      process.stdout.write(`${renderAccountTableRow(row, keys, widths)}\n`);
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
          const candidate = firstUsableSwitchCandidate(registry, { preferredAuthMode: active?.auth_mode || null });
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

  function autoConfigCommand(argv) {
    if (argv[0] === "config" && argv[1] === "auto") {
      return { codexHome: defaultCodexHome(), args: argv.slice(2) };
    }
    if (argv[0] === "group" && typeof argv[1] === "string" && argv[2] === "auto") {
      return { codexHome: managedGroupCodexHome(argv[1]), args: argv.slice(3) };
    }
    return null;
  }

  function parseAutoThreshold(value, label) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      console.error(`${label} requires a percent from 0 to 100.`);
      process.exit(1);
    }
    return parsed;
  }

  function parseAutoConfigArgs(args) {
    const options = {
      action: "",
      primaryThreshold: null,
      secondaryThreshold: null
    };

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "enable" || arg === "disable") {
        if (options.action) {
          console.error("auto config accepts only one action: enable or disable.");
          process.exit(1);
        }
        options.action = arg;
        continue;
      }
      if (arg === "--5h" || arg === "--primary") {
        options.primaryThreshold = parseAutoThreshold(args[++i], arg);
        continue;
      }
      if (arg.startsWith("--5h=")) {
        options.primaryThreshold = parseAutoThreshold(arg.slice("--5h=".length), "--5h");
        continue;
      }
      if (arg.startsWith("--primary=")) {
        options.primaryThreshold = parseAutoThreshold(arg.slice("--primary=".length), "--primary");
        continue;
      }
      if (arg === "--weekly" || arg === "--secondary") {
        options.secondaryThreshold = parseAutoThreshold(args[++i], arg);
        continue;
      }
      if (arg.startsWith("--weekly=")) {
        options.secondaryThreshold = parseAutoThreshold(arg.slice("--weekly=".length), "--weekly");
        continue;
      }
      if (arg.startsWith("--secondary=")) {
        options.secondaryThreshold = parseAutoThreshold(arg.slice("--secondary=".length), "--secondary");
        continue;
      }

      console.error("Usage: codex-auth-advanced config auto [enable|disable] [--5h <percent>] [--weekly <percent>]");
      process.exit(1);
    }

    return options;
  }

  function anyManagedAutoSwitchEnabled() {
    return loadManagedRegistryRecords().some((group) => autoSwitchEnabled(group.registry));
  }

  async function maybeHandleAutoConfig(argv) {
    const command = autoConfigCommand(argv);
    if (!command) return false;

    const options = parseAutoConfigArgs(command.args);
    const filePath = registryPath(command.codexHome);
    const registry = loadOrCreateRegistry(command.codexHome);
    registry.auto_switch = registry.auto_switch && typeof registry.auto_switch === "object" ? registry.auto_switch : {};

    if (options.action === "enable") registry.auto_switch.enabled = true;
    if (options.action === "disable") registry.auto_switch.enabled = false;
    if (options.primaryThreshold != null) {
      registry.auto_switch.threshold_5h_percent = options.primaryThreshold;
      registry.auto_switch.primary_threshold_percent = options.primaryThreshold;
    }
    if (options.secondaryThreshold != null) {
      registry.auto_switch.threshold_weekly_percent = options.secondaryThreshold;
      registry.auto_switch.secondary_threshold_percent = options.secondaryThreshold;
    }

    ensureDir(path.dirname(filePath));
    writeJsonFile(filePath, registry);
    fs.chmodSync(filePath, 0o600);

    if (options.action === "enable") {
      ensureAutoSwitchManagerRunning();
    } else if (options.action === "disable" && !anyManagedAutoSwitchEnabled()) {
      stopAutoSwitchManager();
    }

    const enabled = registry.auto_switch.enabled === true;
    const thresholds = registryAutoThresholds(registry);
    process.stdout.write(`auto-switch: ${enabled ? "ON" : "OFF"}\n`);
    process.stdout.write(`thresholds: 5h left<=${thresholds.primary}%, weekly left<=${thresholds.secondary}%\n`);
    return true;
  }

  async function autoSwitchCycleForGroup(group) {
    const registry = readJsonFile(registryPath(group.codexHome));
    if (!registry || !Array.isArray(registry.accounts) || !autoSwitchEnabled(registry)) return;
    const active = activeRegistryAccountFromRegistry(registry);
    if (!accountShouldAutoSwitch(active, registry)) return;
    const candidate = firstUsableSwitchCandidate(registry, { preferredAuthMode: active?.auth_mode || null });
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
    writeManagerPidFile();
    process.once("exit", removeManagerPidFile);
    process.once("SIGTERM", () => {
      removeManagerPidFile();
      process.exit(0);
    });
    process.once("SIGINT", () => {
      removeManagerPidFile();
      process.exit(0);
    });
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
    const endpoint = modelsEndpointFromBaseUrl(readBaseUrl(accountConfigPath(codexHome, matches[0].account_key)));
    const windowMinutes = apiSpendWindowMinutes(matches[0], { endpoint });
    if (Number.isFinite(windowMinutes)) {
      matches[0].api_spend_window_minutes = windowMinutes;
    }
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

  function parseVsllmDashboardConfigArgs(args) {
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

  function readVsllmDashboardAccessToken(options) {
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

  function maskedNewApiTokenKey(apiKey) {
    const key = String(apiKey || "").trim().replace(/^Bearer\s+/i, "").replace(/^sk-/, "");
    if (!key) return "";
    if (key.length <= 4) return "*".repeat(key.length);
    if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
    return `${key.slice(0, 4)}**********${key.slice(-4)}`;
  }

  function normalizeMaskedNewApiTokenKey(value) {
    return String(value || "").trim().replace(/^sk-/, "");
  }

  async function fetchDashboardMaskedTokenKeys(credential) {
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

  function matchingDashboardApiEntries(codexHome, credential, maskedKeys) {
    return loadApiKeyAccountsFromCodexHome("default", codexHome).filter((entry) => {
      if (providerOriginFromModelsEndpoint(entry.endpoint) !== normalizeProviderOrigin(credential.origin)) return false;
      const masked = maskedNewApiTokenKey(entry.apiKey);
      return masked && maskedKeys.has(masked);
    });
  }

  function selectDashboardApiEntry(codexHome, options, tokenResult, credential) {
    const discovered = matchingDashboardApiEntries(codexHome, credential, tokenResult.maskedKeys);
    if (options.account) {
      const requested = loadApiKeyAccountsFromCodexHome("default", codexHome)
        .filter((entry) => accountMatchesQuery(entry.account, options.account));
      if (requested.length !== 1) {
        console.error(requested.length === 0
          ? `No API-key account matched ${JSON.stringify(options.account)}.`
          : `Multiple API-key accounts matched ${JSON.stringify(options.account)}.`);
        process.exit(1);
      }
      if (!discovered.some((entry) => entry.account.account_key === requested[0].account.account_key)) {
        console.error(`Dashboard user ${options.userId} does not own the stored API key for ${accountLabel(requested[0].account)}.`);
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

  function localTimestampLabel(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "unknown";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "long"
    }).format(new Date(Number(seconds) * 1000));
  }

  function subscriptionRemainingLabel(subscription) {
    if (subscription?.unlimited) return "unlimited";
    const usedPercent = Number(subscription?.usedPercent);
    if (!Number.isFinite(usedPercent)) return "unknown";
    return `${Math.max(0, 100 - Math.max(0, Math.min(100, usedPercent))).toFixed(0)}%`;
  }

  async function configureVsllmDashboard(codexHome, options) {
    const accessToken = readVsllmDashboardAccessToken(options).replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      console.error("VSLLM dashboard access token cannot be empty.");
      process.exit(1);
    }
    const credential = {
      schema_version: 1,
      provider: "vsllm",
      origin: options.origin,
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
    await syncApiKeySpendLimits();

    process.stdout.write(`Configured ${credential.alias} (dashboard user ${credential.user_id}) for ${accountLabel(account)}.\n`);
    process.stdout.write(`subscription: ${subscription.exhausted ? "exhausted" : "active"}, ${subscriptionRemainingLabel(subscription)} remaining\n`);
    process.stdout.write(`next reset: ${localTimestampLabel(subscription.resetAt)}\n`);
    process.stdout.write(`subscription ends: ${localTimestampLabel(subscription.endAt)}\n`);
  }

  async function maybeHandleVsllmDashboardConfig(argv) {
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
    await configureVsllmDashboard(codexHome, parseVsllmDashboardConfigArgs(args));
    return true;
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
      const costs = health.status == null && !entry.dashboardCredential
        ? { spend: null, limitUsd: null, remaining: null, exhausted: false }
        : await fetchApiKeyCosts(entry);
      if (costs.dashboardUnavailable) continue;
      const limitUsd = apiSpendLimitUsd(entry.account, { endpoint: entry.endpoint }) ?? costs.limitUsd;
      const exhausted = isApiKeyLimitExhausted(health.status, costs.spend, limitUsd, {
        providerExhausted: costs.subscription ? costs.exhausted : health.exhausted || costs.exhausted,
        authoritativeSubscription: costs.subscription != null,
        remaining: costs.remaining
      });
      if (!costs.subscription && !Number.isFinite(limitUsd) && !exhausted && !Number.isFinite(costs.spend)) continue;
      const key = registryPath(entry.codexHome);
      if (!byRegistry.has(key)) byRegistry.set(key, []);
      byRegistry.get(key).push({
        accountKey: entry.account.account_key,
        status: health.status,
        spend: costs.spend,
        totalSpend: costs.totalSpend,
        limitUsd,
        exhausted,
        remaining: costs.remaining,
        resetsAt: costs.resetsAt,
        windowMinutes: costs.spendWindowMinutes,
        rollingState: costs.rollingState,
        providerUsedPercent: costs.providerUsedPercent,
        subscription: costs.subscription
      });
    }

    for (const [filePath, updates] of byRegistry) {
      const registry = readJsonFile(filePath);
      if (!registry || !Array.isArray(registry.accounts)) continue;
      const before = JSON.stringify(registry.accounts);
      for (const update of updates) {
        const account = registry.accounts.find((item) => item?.account_key === update.accountKey);
        if (!account) continue;
        if (!Number.isFinite(account.api_spend_limit_usd) && Number.isFinite(update.limitUsd) && !Number.isFinite(update.windowMinutes)) {
          account.api_spend_limit_usd = update.limitUsd;
        }
        account.api_spend = {
          spend_usd: Number.isFinite(update.spend) ? update.spend : null,
          total_spend_usd: Number.isFinite(update.totalSpend) ? update.totalSpend : null,
          limit_usd: update.limitUsd,
          remaining_usd: Number.isFinite(update.remaining) ? update.remaining : null,
          window_minutes: Number.isFinite(update.windowMinutes) ? update.windowMinutes : null,
          status: update.status,
          exhausted: update.exhausted,
          checked_at: Math.floor(Date.now() / 1000),
          source: update.subscription ? "provider_subscription" : "provider_billing"
        };
        if (update.subscription) {
          account.api_spend.subscription_id = update.subscription.subscriptionId;
          account.api_spend.plan_id = update.subscription.planId;
          account.api_spend.billing_preference = update.subscription.billingPreference;
          account.api_spend.active_subscription_count = update.subscription.activeSubscriptionCount;
          account.api_spend.last_reset_at = update.subscription.lastResetAt;
          account.api_spend.reset_at = update.subscription.resetAt;
          account.api_spend.subscription_end_at = update.subscription.endAt;
          account.api_spend.used_percent = update.subscription.usedPercent;
          account.api_spend.unlimited = update.subscription.unlimited;
          if (update.exhausted) {
            account.api_exhausted_reason = "subscription_limit";
          } else {
            delete account.api_exhausted_reason;
          }
        }
        if (update.rollingState) account.api_spend_window = update.rollingState;
        account.last_usage = usageSnapshotForApiSpend(update.spend, update.limitUsd, update.exhausted, {
          windowMinutes: update.windowMinutes,
          resetsAt: update.resetsAt,
          usedPercent: update.providerUsedPercent,
          unlimited: update.subscription?.unlimited === true
        });
        account.last_usage_at = Math.floor(Date.now() / 1000);
      }
      if (before !== JSON.stringify(registry.accounts)) {
        writeJsonFile(filePath, registry);
      }
    }
  }

  function syncMissingApiKeyConfigsAllGroups() {
    const groups = loadManagedRegistryRecords();
    const configByAccountKey = new Map();
    for (const group of groups) {
      for (const account of group.registry.accounts) {
        if (account?.auth_mode !== "apikey") continue;
        const configPath = accountConfigPath(group.codexHome, account.account_key);
        if (fs.existsSync(configPath) && !configByAccountKey.has(account.account_key)) {
          configByAccountKey.set(account.account_key, configPath);
        }
      }
    }

    for (const group of groups) {
      for (const account of group.registry.accounts) {
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
    const keys = accountTableKeys(grouped, ["account", "plan", "fiveHour", "daily", "weekly", "last"]);
    const widths = accountTableWidths(rows, keys);
    const indexWidth = Math.max(2, ...rows.map((row) => row.index.length));

    const prefixWidth = 2 + indexWidth + 1;
    const out = [];
    out.push(renderAccountTableHeader(keys, widths, prefixWidth));
    const totalWidth = out[0].length;
    out.push(renderSeparator(totalWidth));

    for (const item of items) {
      if (item.type === "group") {
        out.push(renderGroupSeparator(item.name, totalWidth));
        continue;
      }
      const row = item.row;
      out.push(renderAccountTableRow(row, keys, widths, indexWidth));
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

  return {
    maybeHandleProviderProxy,
    parseApiSpendLimitArgs,
    importCommandInfo,
    applyApiSpendLimitToImportedAccounts,
    maybeHandleStoredListLive,
    maybeHandleStoredSwitch,
    sleep,
    maybeHandleAutoConfig,
    maybeHandleDaemon,
    maybeHandleApiSpendLimitConfig,
    maybeHandleVsllmDashboardConfig,
    maybeHandleAddApiKey,
    syncApiKeySpendLimits,
    syncMissingApiKeyConfigsAllGroups,
    maybeRunApiKeyAwareGroupList
  };
}

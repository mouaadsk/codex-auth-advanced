// Per-source wire-shape chain planner.
//
// Decides which (account, shape) pair to try next given:
//   * the current request's source shape (responses / messages / chat_completions)
//   * the upstream account's known supported shapes
//   * the failure that just happened (transport / shape-fallback / exhaustion)
//
// Pure function of state; no I/O. The proxy loop in provider-proxy.mjs owns
// the actual request and just delegates the "what next" decision here.

import {
  WIRE_SHAPES,
  endpointChainForSource,
  isShapeFallbackStatus,
  isAccountExhaustionStatus,
  supportedShapesForAccount,
  supportedShapesForModelWithProbe,
  providerSlugForTarget
} from "./provider-policy.mjs";

const SHAPE_PATHS = {
  [WIRE_SHAPES.RESPONSES]: "/v1/responses",
  [WIRE_SHAPES.MESSAGES]: "/v1/messages",
  [WIRE_SHAPES.CHAT_COMPLETIONS]: "/v1/chat/completions",
  [WIRE_SHAPES.ANTIGRAVITY]: null // built by antigravity bridge, not by path-suffix swap.
};

const SHAPE_PATH_NAMES = {
  [WIRE_SHAPES.RESPONSES]: "responses",
  [WIRE_SHAPES.MESSAGES]: "messages",
  [WIRE_SHAPES.CHAT_COMPLETIONS]: "chat_completions",
  [WIRE_SHAPES.ANTIGRAVITY]: "antigravity"
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function shapePath(shape) {
  return SHAPE_PATHS[shape] || null;
}

function shapeName(shape) {
  return SHAPE_PATH_NAMES[shape] || shape;
}

function buildShapeAttempts({ sourceShape, account, isCompact, model = null, target = null }) {
  const supported = supportedShapesForAccount(account);
  // Key the per-model capability lookup by provider slug (e.g. "vsllm",
  // "llmapi") so the same model can have different capability sets on
  // different providers, and so probe results survive proxy restarts via
  // the persistent cache (which is also keyed by provider slug).
  const providerSlug = providerSlugForTarget(target, account);
  const modelSupported = supportedShapesForModelWithProbe(model, providerSlug);
  const chain = endpointChainForSource(sourceShape);
  const attempts = [];
  const seen = new Set();
  for (const shape of chain) {
    if (seen.has(shape)) continue;
    seen.add(shape);
    if (!supported.has(shape)) continue;
    // Per-model capability pruning: if VSLLM only advertises a subset for
    // this model (e.g. Grok only speaks /v1/chat/completions), drop the rest.
    if (modelSupported && !modelSupported.has(shape)) continue;
    // Compact walks every wire shape on the active account: the chain walker
    // builds a summarization request for each non-Responses shape (see
    // summarizeViaShape in proxy-transforms.mjs) so a /responses/compact
    // outage transparently retries on /v1/chat/completions, /v1/messages,
    // and the Antigravity endpoint on the SAME upstream. Responses still
    // stays first so the dedicated endpoint wins when it works.
    attempts.push(shape);
  }
  return attempts;
}

function buildAntigravityAttempt({ sourceShape, account, isCompact }) {
  if (isCompact) return null;
  const supported = supportedShapesForAccount(account);
  if (!supported.has(WIRE_SHAPES.ANTIGRAVITY)) return null;
  const chain = endpointChainForSource(sourceShape);
  return chain[WIRE_SHAPES.ANTIGRAVITY] != null ? WIRE_SHAPES.ANTIGRAVITY : null;
}

export function createEndpointChainPlanner({
  sourceShape,
  isCompact = false,
  requestUrl = "",
  model = null
} = {}) {
  const attemptsByAccount = new Map(); // account_key -> ordered shapes
  let lastAccountKey = null;
  let currentTarget = null;
  let currentShapes = [];
  let cursor = -1;

  function ensureAccountShapes(account) {
    if (!account || typeof account !== "object") return [];
    const acctKey = account.account_key || account.email || account.alias || "anonymous";
    const slugKey = providerSlugForTarget(currentTarget, account);
    // Cache key includes both the account and the provider slug so two
    // requests on different providers that happen to share an account key
    // (or in tests, the same account) compute distinct shape chains.
    const key = `${acctKey}\u0000${slugKey}`;
    if (attemptsByAccount.has(key)) return attemptsByAccount.get(key);
    const attempts = buildShapeAttempts({ sourceShape, account, isCompact, model, target: currentTarget });
    attemptsByAccount.set(key, attempts);
    return attempts;
  }

  function prime(account, targetArg = null) {
    lastAccountKey = account?.account_key || account?.email || account?.alias || null;
    currentTarget = targetArg || currentTarget;
    currentShapes = ensureAccountShapes(account);
    // Shapes are tried in order. The caller is responsible for tracking which
    // shape was just attempted; this planner only exposes the ordered list.
  }

  function shapes() {
    return currentShapes.slice();
  }

  function shapesForAccount(account) {
        if (!account || account.account_key !== lastAccountKey) prime(account);
    return currentShapes.slice();
  }

  function remaining() {
    return currentShapes.slice(cursor + 1);
  }

  function exhaustedThisAccount() {
    return cursor >= currentShapes.length - 1;
  }

  function shouldFailOverToNextShape({ status, body }) {
    if (status == null) return true;
    return isShapeFallbackStatus(status, body);
  }

  function shouldSwitchAccount({ status, body, account }) {
    return isAccountExhaustionStatus(status, body, account);
  }

  return {
    sourceShape,
    isCompact,
    prime,
    shapesForAccount,
    remaining,
    exhaustedThisAccount,
    shouldFailOverToNextShape,
    shouldSwitchAccount,
    shapeName
  };
}

export { shapeName, shapePath, buildShapeAttempts };

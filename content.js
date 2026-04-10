const FLUSH_DELAY_MS = 1200;
const FAST_FLUSH_DELAY_MS = 250;
const EVENT_COOLDOWN_MS = 5000;
const NETWORK_EVENT_COOLDOWN_MS = 3000;
const PRICE_SCAN_INTERVAL_MS = 2000;
const SNAPSHOT_SCAN_INTERVAL_MS = 4000;
const MAX_CANDIDATES = 20;
const MAX_SNAPSHOT_BLOCKS = 12;
const INJECTED_EVENT_NAME = "revere-network-message";
const SESSION_ID_PATTERN = /\(\d{5,}\)/;
const PRICE_SELECTORS = [
  "[data-price]",
  "[data-test='price']",
  "[data-testid='price']",
  "[class*='price']",
  "[class*='ticker']",
  "[class*='quote']",
  "h1",
  "h2"
].join(", ");
const SNAPSHOT_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  "section",
  "li",
  "article a",
  "section a",
  "main a",
  "h1",
  "h2",
  "h3"
].join(", ");
const CARD_CLASS_PATTERN = /(card|item|tile|product|listing|drop|grid|row|score|matchup|game|price|ticker|quote|question|answer|comment|post|message|thread|discussion)/;
const IGNORE_CLASS_PATTERN = /(countdown|timer|carousel|slider|ticker|marquee|toast|modal)/;
const IGNORE_ID_PATTERN = /(countdown|timer|toast|modal)/;
const LOADING_TEXT_PATTERN = /^(loading|please wait|updated just now|just now)$/i;
const SIMPLE_CLOCK_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const PRICE_KEYWORDS = ["price", "ticker", "quote"];
const SPORTS_KEYWORDS = ["score", "goal", "touchdown", "home_score", "away_score", "clock", "period", "inning", "quarter"];
const LEARNING_CATALYTICS_KEYWORDS = [
  "active sessions",
  "session",
  "chapter",
  "assignment",
  "pearson",
  "learning catalytics"
];
const LIVE_FEED_KEYWORDS = [
  "q&a",
  "question",
  "questions",
  "latest",
  "recent",
  "response",
  "responses",
  "live",
  "session",
  "sessions",
  "activity",
  "announcements",
  "updates",
  "messages",
  "feed"
];
const INLINE_DISCUSSION_KEYWORDS = [
  "question",
  "answer",
  "reply",
  "comment",
  "anonymous",
  "discussion",
  "asked"
];
const PRICE_REGEX = /\$?(?:\d{1,3}(?:,\d{3})+|\d{4,6}|\d{1,3})(?:\.\d{1,8})?/;
const RECENT_FINGERPRINT_TTL_MS = 15000;
const FINGERPRINT_CACHE_TTL_MS = 30000;
const DEBUG_DOM_CANDIDATES = false;

const pendingNodes = new Set();
const pendingNodeMeta = new Map();
const recentDomFingerprints = new Map();
const candidateStateSnapshots = new WeakMap();

let flushTimer = null;
let domObserver = null;
let snapshotIntervalId = null;
let cryptoIntervalId = null;
let startupSnapshotTimeoutId = null;
let startupPriceTimeoutId = null;
let extensionActive = true;
let lastSentAt = 0;
let lastNetworkSentAt = 0;
let lastPriceValue = "";
let lastSnapshotFingerprint = "";
let lastSnapshotBlocks = [];

const siteProfile = detectSiteProfile(location.hostname);
const pageHasBitcoinContext = looksLikeBitcoinContext(`${location.href} ${document.title || ""}`);

boot();

function boot() {
  if (!isExtensionContextAvailable()) {
    extensionActive = false;
    return;
  }

  injectPageHook();
  window.addEventListener(INJECTED_EVENT_NAME, handleInjectedNetworkEvent);

  waitForDocumentElement(() => {
    if (!extensionActive) {
      return;
    }

    startDomObserver();
    snapshotIntervalId = window.setInterval(scanSnapshotSignals, SNAPSHOT_SCAN_INTERVAL_MS);
    startupSnapshotTimeoutId = window.setTimeout(scanSnapshotSignals, 2500);
    window.addEventListener("focus", scanSnapshotSignals);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scanSnapshotSignals();
      }
    });

    if (siteProfile.name === "crypto") {
      cryptoIntervalId = window.setInterval(scanPriceSignals, PRICE_SCAN_INTERVAL_MS);
      startupPriceTimeoutId = window.setTimeout(scanPriceSignals, 1500);
    }
  });
}

function startDomObserver() {
  if (!extensionActive) {
    return;
  }

  domObserver = new MutationObserver((mutations) => {
    if (!extensionActive) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          collectCandidateNode(node, "insert");
        }
      }

      if (mutation.type === "characterData") {
        collectCandidateNode(mutation.target?.parentElement, "text");
      }

      if (mutation.type === "attributes") {
        collectCandidateNode(mutation.target, "attribute");
      }
    }

    scheduleFlush();
  });

  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "disabled"]
  });
}

function injectPageHook() {
  if (!extensionActive || !isExtensionContextAvailable()) {
    extensionActive = false;
    return;
  }

  const target = document.head || document.documentElement;
  if (!target) {
    window.setTimeout(injectPageHook, 0);
    return;
  }

  const script = document.createElement("script");
  try {
    script.src = chrome.runtime.getURL("injected.js");
  } catch (error) {
    handleExtensionContextInvalidated(error);
    return;
  }

  script.dataset.eventName = INJECTED_EVENT_NAME;
  script.async = false;
  target.appendChild(script);
  script.remove();
}

function waitForDocumentElement(callback) {
  if (document.documentElement) {
    callback();
    return;
  }

  const observer = new MutationObserver(() => {
    if (!document.documentElement) {
      return;
    }

    observer.disconnect();
    callback();
  });

  observer.observe(document, { childList: true, subtree: true });
}

function handleInjectedNetworkEvent(event) {
  if (!extensionActive) {
    return;
  }

  const detail = event.detail;
  if (!detail || typeof detail.payload !== "string") {
    return;
  }

  const candidate = buildNetworkCandidate(detail);
  if (!candidate) {
    return;
  }

  const now = Date.now();
  if (now - lastNetworkSentAt < NETWORK_EVENT_COOLDOWN_MS) {
    return;
  }

  lastNetworkSentAt = now;
  sendEvent(candidate.summary, candidate.fingerprint, candidate.score, candidate.profile, "network");
}

function scanPriceSignals() {
  if (!extensionActive) {
    return;
  }

  const candidate = buildPriceCandidate();
  if (!candidate) {
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < EVENT_COOLDOWN_MS) {
    return;
  }

  lastSentAt = now;
  lastPriceValue = candidate.price;
  sendEvent(candidate.summary, candidate.fingerprint, candidate.score, "crypto", "price_scan");
}

function scanSnapshotSignals() {
  if (!extensionActive) {
    return;
  }

  const candidate = buildSnapshotCandidate();
  if (!candidate) {
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < EVENT_COOLDOWN_MS) {
    return;
  }

  lastSentAt = now;
  sendEvent(candidate.summary, candidate.fingerprint, candidate.score, getActiveProfile().name, "snapshot");
}

function buildPriceCandidate() {
  const samples = collectPriceSamples();
  for (const sample of samples) {
    const match = sample.text.match(PRICE_REGEX);
    if (!match) {
      continue;
    }

    const price = match[0].startsWith("$") ? match[0] : `$${match[0]}`;
    if (price === lastPriceValue) {
      continue;
    }

    const direction = inferDirection(lastPriceValue, price);
    const summary = direction
      ? `Bitcoin price ${direction}: ${price}`
      : `Bitcoin price update: ${price}`;

    return {
      summary,
      fingerprint: `${location.hostname}:price:${normalizeFingerprint(price)}`,
      score: 10,
      price
    };
  }

  return null;
}

function buildSnapshotCandidate() {
  const activeProfile = getActiveProfile();
  const blocks = collectSnapshotBlocks(activeProfile);
  if (!blocks.length) {
    return null;
  }

  const fingerprint = normalizeFingerprint(blocks.join(" || "));
  if (!fingerprint) {
    return null;
  }

  if (!lastSnapshotFingerprint) {
    lastSnapshotFingerprint = fingerprint;
    lastSnapshotBlocks = blocks;
    return null;
  }

  if (fingerprint === lastSnapshotFingerprint) {
    return null;
  }

  const changedBlock = blocks.find((block) => !lastSnapshotBlocks.includes(block)) || blocks[0];
  const summaryPrefix = activeProfile.name === "generic" ? "Page snapshot changed" : `${activeProfile.prefix} snapshot`;

  lastSnapshotFingerprint = fingerprint;
  lastSnapshotBlocks = blocks;

  return {
    summary: `${summaryPrefix}: ${clip(changedBlock)}`,
    fingerprint: `${location.hostname}:snapshot:${fingerprint}`,
    score: Math.max(activeProfile.minScore, 8)
  };
}

function collectSnapshotBlocks(activeProfile) {
  const blocks = [];
  const seen = new Set();
  const snapshotSelectors =
    activeProfile.name === "learning"
      ? `${SNAPSHOT_SELECTORS}, div, span`
      : activeProfile.name === "live_feed"
        ? `${SNAPSHOT_SELECTORS}, div`
        : SNAPSHOT_SELECTORS;

  pushUniqueText(blocks, seen, document.title, (text) => isSnapshotWorthy(text, activeProfile));
  collectVisibleTexts(
    snapshotSelectors,
    MAX_SNAPSHOT_BLOCKS - blocks.length,
    (text) => isSnapshotWorthy(text, activeProfile),
    seen,
    blocks,
    (text) => text
  );
  return blocks;
}

function isSnapshotWorthy(text, profile = getActiveProfile()) {
  if (!text) {
    return false;
  }

  if (text.length < profile.minLineLength) {
    return false;
  }

  if (text.length > 220) {
    return false;
  }

  if (isIgnoredText(text, profile)) {
    return false;
  }

  const normalized = text.toLowerCase();
  if (SIMPLE_CLOCK_PATTERN.test(normalized)) {
    return false;
  }

  return !LOADING_TEXT_PATTERN.test(text);
}

function collectPriceSamples() {
  const samples = [];
  pushUniqueText(samples, new Set(), document.title, looksLikeBitcoinContext, "title");
  collectVisibleTexts(
    PRICE_SELECTORS,
    7,
    (text, element) => {
      const selectorHintsPrice = PRICE_KEYWORDS.some((word) => element.matches?.(`[class*='${word}'], [data-${word}], [data-test='${word}'], [data-testid='${word}']`));
      const allowByPageContext = siteProfile.name === "crypto" && pageHasBitcoinContext && selectorHintsPrice;
      return PRICE_REGEX.test(text) && (looksLikeBitcoinContext(text) || allowByPageContext);
    },
    new Set(samples.map((sample) => sample.text)),
    samples,
    (text) => ({ text, source: "page" })
  );

  const bodyText = normalizeText(document.body?.innerText || "").slice(0, 5000);
  if (looksLikeBitcoinContext(bodyText)) {
    samples.push({ text: bodyText, source: "body" });
  }

  return samples;
}

function looksLikeBitcoinContext(text) {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("bitcoin") ||
    normalized.includes("btc") ||
    location.href.toLowerCase().includes("bitcoin") ||
    location.href.toLowerCase().includes("btc")
  );
}

function inferDirection(previousPrice, nextPrice) {
  const previous = parsePrice(previousPrice);
  const next = parsePrice(nextPrice);
  if (!previous || !next || previous === next) {
    return "";
  }

  return next > previous ? "up" : "down";
}

function parsePrice(value) {
  if (!value) {
    return 0;
  }

  const cleaned = value.replace(/[^0-9.]/g, "");
  return Number(cleaned);
}

function collectCandidateNode(node, mutationKind = "text") {
  if (!extensionActive) {
    return;
  }

  if (node instanceof Text) {
    collectCandidateNode(node.parentElement, mutationKind);
    return;
  }

  if (!(node instanceof HTMLElement) || shouldIgnoreNode(node)) {
    return;
  }

  if (mutationKind === "insert" && tryDispatchImmediateInsertCandidate(node)) {
    return;
  }

  pendingNodes.add(node);
  const previous = pendingNodeMeta.get(node);
  const nextMutationKind =
    previous?.mutationKind === "insert"
      ? "insert"
      : previous?.mutationKind === "attribute" || mutationKind === "attribute"
        ? "attribute"
        : mutationKind;
  pendingNodeMeta.set(node, {
    mutationKind: nextMutationKind,
    seenAt: previous?.seenAt || Date.now()
  });

  if (pendingNodes.size > MAX_CANDIDATES) {
    const first = pendingNodes.values().next().value;
    pendingNodes.delete(first);
    pendingNodeMeta.delete(first);
  }
}

function tryDispatchImmediateInsertCandidate(node) {
  const candidate = buildInsertedNodeCandidate(node);
  if (!candidate) {
    return false;
  }

  const now = Date.now();
  if (isRecentlySentFingerprint(candidate.fingerprint, now)) {
    return false;
  }

  rememberFingerprint(candidate.fingerprint, now);
  lastSentAt = now;
  updateCandidateStateSnapshot(node);
  sendEvent(candidate.summary, candidate.fingerprint, candidate.score, candidate.profile, "dom_insert");
  return true;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flushCandidates, getFlushDelayMs());
}

function flushCandidates() {
  if (!extensionActive || !pendingNodes.size) {
    return;
  }

  const candidates = [];
  const candidateLogs = [];
  for (const node of pendingNodes) {
    const candidate = buildDomCandidate(node, pendingNodeMeta.get(node));
    updateCandidateStateSnapshot(node);
    if (candidate) {
      candidates.push(candidate);
      candidateLogs.push({
        source: candidate.source,
        score: candidate.score,
        trigger: candidate.triggerSummary,
        rootSize: candidate.rootTextLength,
        mutationKind: candidate.mutationKind,
        availabilityBoosted: candidate.availabilityBoosted
      });
    }
  }

  pendingNodes.clear();
  pendingNodeMeta.clear();

  if (!candidates.length) {
    return;
  }

  candidates.sort((left, right) => right.score - left.score);

  const now = Date.now();
  let best = null;
  for (const candidate of candidates) {
    if (isRecentlySentFingerprint(candidate.fingerprint, now)) {
      candidate.rejectionReason = "recent_fingerprint";
      debugDomCandidates("duplicate_dom_candidate", candidateLogs, candidate);
      continue;
    }

    if (now - lastSentAt < EVENT_COOLDOWN_MS && candidate.source !== "dom_insert") {
      candidate.rejectionReason = "global_cooldown";
      debugDomCandidates("cooldown_dom_candidate", candidateLogs, candidate);
      continue;
    }

    best = candidate;
    break;
  }

  debugDomCandidates("send_dom_candidate", candidateLogs, best);
  debugSuddenlyAvailableWinner(best);

  if (!best) {
    return;
  }

  lastSentAt = now;
  rememberFingerprint(best.fingerprint, now);
  sendEvent(best.summary, best.fingerprint, best.score, best.profile || siteProfile.name, best.source);
}

function sendEvent(summary, fingerprint, score, profile, source) {
  if (!extensionActive || !isExtensionContextAvailable()) {
    extensionActive = false;
    shutdownContentScript();
    return;
  }

  try {
    chrome.runtime.sendMessage({
      type: "page-update",
      payload: {
        url: location.href,
        title: document.title,
        summary,
        fingerprint,
        profile,
        score,
        source
      }
    });
  } catch (error) {
    handleExtensionContextInvalidated(error);
  }
}

function buildInsertedNodeCandidate(node) {
  return buildDomCandidate(node, { mutationKind: "insert" });
}

function buildDomCandidate(node, meta = {}) {
  const activeProfile = getActiveProfile();
  const triggerNode = getBestTriggerNode(node);
  if (!triggerNode || shouldIgnoreNode(triggerNode) || !isVisible(triggerNode)) {
    return null;
  }

  const triggerLines = extractTriggerLines(triggerNode, meta.mutationKind);
  if (!triggerLines.length) {
    return null;
  }

  const previousSnapshot = getClosestCandidateSnapshot(triggerNode) || getClosestCandidateSnapshot(node);
  const currentSnapshot = getElementStateSnapshot(triggerNode);
  const availabilityState = getAvailabilityState(triggerNode, previousSnapshot, meta.mutationKind);

  const candidateRoot = elevateCandidate(triggerNode, triggerLines);
  if (!candidateRoot || shouldIgnoreNode(candidateRoot) || !isVisible(candidateRoot)) {
    return null;
  }

  const lines = extractLines(candidateRoot, {
    allowShortFeedLine:
      meta.mutationKind === "insert" &&
      (looksLikeRepeatedFeedItem(candidateRoot) || hasRepeatedSiblingStructure(candidateRoot)),
    allowShortInteractiveLine: looksLikeSuddenlyAvailableAction(triggerNode)
  });
  const summaryLines = looksLikeSuddenlyAvailableAction(triggerNode) ? triggerLines : (triggerLines.length ? triggerLines : lines);
  const nearbyContext = getNearbySectionContext(candidateRoot);
  const score = scoreCandidate(candidateRoot, lines, {
    triggerNode,
    triggerLines,
    candidateRoot,
    nearbyContext,
    mutationKind: meta.mutationKind || "text",
    activeProfile,
    previousSnapshot,
    currentSnapshot,
    availabilityState
  });

  if (!summaryLines.length || score < activeProfile.minScore) {
    debugSuddenlyAvailableAction(meta.mutationKind, triggerNode, previousSnapshot, currentSnapshot, availabilityState, false, null);
    return null;
  }

  const summaryText = summaryLines.slice(0, 3).join(" | ");
  const fingerprintSeed = [
    meta.mutationKind || "text",
    getNodePath(triggerNode),
    summaryText
  ].join(" | ");

  const candidate = {
    score,
    summary: `${activeProfile.prefix}: ${clip(summaryText)}`,
    fingerprint: `${location.hostname}:dom:${normalizeFingerprint(fingerprintSeed)}`,
    source: meta.mutationKind === "attribute" ? "dom_attribute" : meta.mutationKind === "insert" ? "dom_insert" : "dom_text",
    profile: activeProfile.name,
    triggerSummary: summaryText,
    rootTextLength: normalizeText(candidateRoot.innerText || candidateRoot.textContent || "").length,
    mutationKind: meta.mutationKind || "text",
    availabilityBoosted: availabilityState.becameAvailable,
    scoreDetails: {
      triggerLines,
      lines,
      nearbyContext,
      availabilityState
    }
  };

  debugSuddenlyAvailableAction(meta.mutationKind, triggerNode, previousSnapshot, currentSnapshot, availabilityState, true, candidate);
  return candidate;
}

function buildNetworkCandidate(detail) {
  const payload = safeCompact(detail.payload);
  if (!payload || payload.length < 8) {
    return null;
  }

  const cryptoCandidate = extractCryptoSignal(payload);
  if (cryptoCandidate) {
    return {
      summary: cryptoCandidate.summary,
      fingerprint: `${location.hostname}:network:${cryptoCandidate.fingerprint}`,
      score: cryptoCandidate.score,
      profile: cryptoCandidate.profile
    };
  }

  const sportsCandidate = extractSportsSignal(payload);
  if (!sportsCandidate) {
    return null;
  }

  return {
    summary: sportsCandidate.summary,
    fingerprint: `${location.hostname}:network:${sportsCandidate.fingerprint}`,
    score: sportsCandidate.score,
    profile: sportsCandidate.profile
  };
}

function extractCryptoSignal(payload) {
  const normalized = payload.toLowerCase();
  const hasBitcoinContext =
    normalized.includes("bitcoin") ||
    normalized.includes("\"btc") ||
    normalized.includes("btcusd") ||
    normalized.includes("xbt") ||
    siteProfile.name === "crypto";

  if (!hasBitcoinContext) {
    return null;
  }

  const priceMatch =
    payload.match(/(?:price|last_price|mark_price|close|rate)["':=\s]+["$]?((?:\d{1,3}(?:,\d{3})+|\d{4,6}|\d{1,3})(?:\.\d{1,8})?)/i) ||
    payload.match(/\$?((?:\d{1,3}(?:,\d{3})+|\d{4,6}|\d{1,3})(?:\.\d{1,8})?)/);

  if (!priceMatch) {
    return null;
  }

  const price = `$${priceMatch[1]}`;
  if (price === lastPriceValue) {
    return null;
  }

  lastPriceValue = price;

  return {
    summary: `Bitcoin network update: ${price}`,
    fingerprint: normalizeFingerprint(`btc-${price}`),
    score: 11,
    profile: "crypto"
  };
}

function extractSportsSignal(payload) {
  const normalized = payload.toLowerCase();
  const scoreMatch = payload.match(/\b([A-Z]{2,4}|\d{1,2})\s{0,2}(\d{1,3})\s*[-:]\s*(\d{1,3})\s{0,2}([A-Z]{2,4}|\d{1,2})\b/);
  const gameStateMatch = payload.match(/\b(q[1-4]|ot|final|halftime|period\s*\d|inning\s*\d)\b/i);
  const keywordHits = SPORTS_KEYWORDS.filter((word) => normalized.includes(word)).length;

  if (!scoreMatch && keywordHits < 2 && !gameStateMatch) {
    return null;
  }

  let summary = "Sports update detected";
  let fingerprintSeed = payload.slice(0, 220);
  let score = 6 + keywordHits;

  if (scoreMatch) {
    const leftTeam = scoreMatch[1];
    const leftScore = scoreMatch[2];
    const rightScore = scoreMatch[3];
    const rightTeam = scoreMatch[4];
    summary = `Live sports update: ${leftTeam} ${leftScore}-${rightScore} ${rightTeam}`;
    fingerprintSeed = `${leftTeam}-${leftScore}-${rightScore}-${rightTeam}`;
    score += 4;
  }

  if (gameStateMatch) {
    summary = `${summary} (${gameStateMatch[1].toUpperCase()})`;
    fingerprintSeed += `-${gameStateMatch[1].toUpperCase()}`;
    score += 2;
  }

  return {
    summary,
    fingerprint: normalizeFingerprint(fingerprintSeed),
    score,
    profile: "sports"
  };
}

function elevateCandidate(node, triggerLines = []) {
  let current = node;
  let best = node;
  let bestTextLength = normalizeText(node.innerText || node.textContent || "").length || 1;
  const triggerTextLength = normalizeText(triggerLines.join(" | ") || node.innerText || node.textContent || "").length || 1;

  for (let i = 0; i < 5 && current; i += 1) {
    if (!(current instanceof HTMLElement)) {
      break;
    }

    const currentTextLength = normalizeText(current.innerText || current.textContent || "").length || 1;
    if (isLikelyFeedContainer(current, triggerTextLength)) {
      break;
    }

    if (
      current === node ||
      looksLikeCard(current) ||
      looksLikeRepeatedFeedItem(current) ||
      (currentTextLength <= Math.max(triggerTextLength * 3, 180) && currentTextLength >= triggerTextLength)
    ) {
      best = current;
      bestTextLength = currentTextLength;
    }

    const parent = current.parentElement;
    if (!(parent instanceof HTMLElement)) {
      break;
    }

    const parentTextLength = normalizeText(parent.innerText || parent.textContent || "").length || 1;
    if (parentTextLength > Math.max(bestTextLength * 3, triggerTextLength * 5)) {
      break;
    }

    if (parentTextLength > currentTextLength * 5 && currentTextLength >= 4) {
      break;
    }

    if (hasRepeatedSiblingStructure(current) && hasRepeatedSiblingStructure(parent)) {
      break;
    }

    if (isLikelyFeedContainer(parent, triggerTextLength)) {
      break;
    }

    current = parent;
  }

  return best;
}

function looksLikeCard(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  const tag = node.tagName.toLowerCase();
  const className = (node.className || "").toString().toLowerCase();
  const role = (node.getAttribute("role") || "").toLowerCase();

  return (
    ["article", "li", "section", "a"].includes(tag) ||
    role === "listitem" ||
    CARD_CLASS_PATTERN.test(className)
  );
}

function extractLines(element, options = {}) {
  const text = normalizeText(element.innerText || element.textContent || "");
  if (!text) {
    return [];
  }

  const allowShortFeedLine = Boolean(options.allowShortFeedLine);
  const allowShortInteractiveLine = Boolean(options.allowShortInteractiveLine);
  const rawLines = text
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const unique = [];
  const seen = new Set();
  for (const line of rawLines) {
    const allowShortLearningCatalyticsLine =
      siteProfile.name === "learning" && isLearningCatalyticsSessionLine(line);
    const allowShortDiscussionLine = isInlineDiscussionLine(line);
    const allowShortGenericFeedLine = allowShortFeedLine && line.length >= 4 && !isIgnoredText(line, getActiveProfile());
    const allowShortClickableLine =
      allowShortInteractiveLine &&
      isClickableElement(element) &&
      isVisible(element) &&
      line.length >= 3 &&
      !isIgnoredText(line, getActiveProfile());

    if (
      (!looksLikeCompactPriceLine(line) &&
        !allowShortLearningCatalyticsLine &&
        !allowShortDiscussionLine &&
        !allowShortGenericFeedLine &&
        !allowShortClickableLine &&
        line.length < getActiveProfile().minLineLength) ||
      line.length > 120 ||
      isIgnoredText(line, getActiveProfile()) ||
      seen.has(line)
    ) {
      continue;
    }

    unique.push(line);
    seen.add(line);
    if (unique.length === 5) {
      break;
    }
  }

  return unique;
}

function extractTriggerLines(element, mutationKind = "text") {
  const lines = extractLines(element, {
    allowShortFeedLine:
      mutationKind === "insert" &&
      (looksLikeRepeatedFeedItem(element) || hasRepeatedSiblingStructure(element)),
    allowShortInteractiveLine: mutationKind === "attribute" || looksLikeSuddenlyAvailableAction(element)
  });
  if (lines.length) {
    return lines.slice(0, mutationKind === "insert" ? 4 : 3);
  }

  const rawText = normalizeText(element.innerText || element.textContent || "");
  if (!rawText) {
    return [];
  }

  if (
    ((mutationKind === "insert" && rawText.length >= 4) ||
      ((mutationKind === "attribute" || isClickableElement(element)) && rawText.length >= 3)) &&
    rawText.length <= 220 &&
    !isIgnoredText(rawText, getActiveProfile())
  ) {
    return [rawText];
  }

  return [];
}

function looksLikeCompactPriceLine(line) {
  return siteProfile.name === "crypto" && PRICE_REGEX.test(line);
}

function isInlineDiscussionLine(line) {
  const normalized = line.toLowerCase();
  return (
    normalized.length >= 4 &&
    normalized.length <= 220 &&
    normalized !== "anonymous" &&
    normalized !== "q&a" &&
    !SIMPLE_CLOCK_PATTERN.test(normalized) &&
    !/^\d+$/.test(normalized) &&
    (
      normalized.includes("?") ||
      INLINE_DISCUSSION_KEYWORDS.some((keyword) => normalized.includes(keyword))
    )
  );
}

function isLearningCatalyticsSessionLine(line) {
  const normalized = line.toLowerCase();
  return (
    SESSION_ID_PATTERN.test(line) &&
    (normalized.includes("chapter") ||
      normalized.includes("session") ||
      normalized.includes("assignment"))
  );
}

function hasRepeatedSiblingStructure(element) {
  if (!(element instanceof HTMLElement) || !(element.parentElement instanceof HTMLElement)) {
    return false;
  }

  const siblings = Array.from(element.parentElement.children).filter((child) => child instanceof HTMLElement);
  if (siblings.length < 2) {
    return false;
  }

  const sameTagSiblings = siblings.filter((sibling) => sibling.tagName === element.tagName);
  const classTokens = (element.className || "").toString().toLowerCase().split(/\s+/).filter(Boolean);
  const sameClassSiblings = classTokens.length
    ? siblings.filter((sibling) => classTokens.some((token) => (sibling.className || "").toString().toLowerCase().includes(token)))
    : [];
  const similarVisibleSiblings = siblings.filter((sibling) => {
    if (!(sibling instanceof HTMLElement) || !isVisible(sibling)) {
      return false;
    }

    const siblingText = normalizeText(sibling.innerText || sibling.textContent || "");
    return siblingText.length >= 4 && siblingText.length <= 260;
  });

  return sameTagSiblings.length >= 2 || sameClassSiblings.length >= 2 || similarVisibleSiblings.length >= 3;
}

function looksLikeRepeatedFeedItem(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const text = normalizeText(element.innerText || element.textContent || "");
  return (
    text.length >= 4 &&
    text.length <= 260 &&
    hasRepeatedSiblingStructure(element) &&
    !isLikelyFeedContainer(element, text.length)
  );
}

function getNearbySectionContext(element) {
  if (!(element instanceof HTMLElement)) {
    return [];
  }

  const contextTexts = [];
  const section = element.closest("section, article, main, [role='main'], [role='region']");
  const candidates = [
    section,
    section?.querySelector("h1, h2, h3, h4, [aria-label]"),
    element.previousElementSibling,
    section?.previousElementSibling
  ].filter(Boolean);

  for (const candidate of candidates) {
    const label = normalizeText(
      candidate.getAttribute?.("aria-label") ||
      candidate.innerText ||
      candidate.textContent ||
      ""
    ).toLowerCase();
    if (label) {
      contextTexts.push(label);
    }
  }

  return contextTexts.join(" ").split(/\s+/).filter(Boolean);
}

function isLikelyFeedContainer(element, triggerTextLength = 0) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const text = normalizeText(element.innerText || element.textContent || "");
  const childCount = Array.from(element.children).filter((child) => child instanceof HTMLElement && isVisible(child)).length;
  const repeatedChildren = Array.from(element.children).filter((child) => child instanceof HTMLElement && hasRepeatedSiblingStructure(child));
  const rect = element.getBoundingClientRect();
  const area = rect.width * rect.height;

  return (
    childCount >= 3 &&
    (
      text.length > Math.max(triggerTextLength * 5, 260) ||
      area > 220000 ||
      repeatedChildren.length >= 2
    )
  );
}

function scoreInlineFeedSignals(element, lines, triggerLines = [], nearbyContext = [], mutationKind = "text") {
  let score = 0;
  const combined = lines.join(" ").toLowerCase();
  const triggerCombined = triggerLines.join(" ").toLowerCase();
  const contextWords = nearbyContext;

  if (looksLikeRepeatedFeedItem(element)) {
    score += 5;
  }

  if (hasRepeatedSiblingStructure(element)) {
    score += 3;
  }

  if (triggerLines.some(isInlineDiscussionLine) || lines.some(isInlineDiscussionLine)) {
    score += 4;
  }

  for (const keyword of LIVE_FEED_KEYWORDS) {
    if (contextWords.includes(keyword) || combined.includes(keyword)) {
      score += 2;
    }
  }

  if (triggerCombined.includes("anonymous") || combined.includes("anonymous")) {
    score += 1;
  }

  if (isLikelyFeedContainer(element, triggerCombined.length)) {
    score -= 4;
  }

  if (combined.length > 320 && mutationKind !== "insert") {
    score -= 3;
  }

  return score;
}

function scoreCandidate(element, lines, context = {}) {
  let score = 0;
  const combinedText = lines.join(" ");
  const combined = combinedText.toLowerCase();
  const className = (element.className || "").toString().toLowerCase();
  const triggerLines = context.triggerLines || [];
  const activeProfile = context.activeProfile || getActiveProfile();
  const nearbyContext = context.nearbyContext || [];
  const triggerNode = context.triggerNode instanceof HTMLElement ? context.triggerNode : element;
  const availabilityState = context.availabilityState || {};

  score += Math.min(combinedText.length / 20, 6);
  score += Math.min(lines.length, 4);

  if (element.querySelector("a[href]")) {
    score += 2;
  }

  if (element.querySelector("img")) {
    score += 1;
  }

  if (CARD_CLASS_PATTERN.test(className)) {
    score += 2;
  }

  if (siteProfile.name === "crypto" && PRICE_REGEX.test(combined)) {
    score += 4;
  }

  for (const keyword of activeProfile.keywords) {
    if (combined.includes(keyword)) {
      score += 2;
    }
  }

  for (const noiseWord of activeProfile.noiseWords) {
    if (combined.includes(noiseWord)) {
      score -= 2;
    }
  }

  if (siteProfile.name === "learning") {
    if (isInsideActiveSessionsRegion(element)) {
      score += 4;
    }

    if (lines.some(isLearningCatalyticsSessionLine)) {
      score += 5;
    }

    for (const keyword of LEARNING_CATALYTICS_KEYWORDS) {
      if (combined.includes(keyword)) {
        score += 2;
      }
    }
  }

  score += scoreInlineFeedSignals(element, lines, triggerLines, nearbyContext, context.mutationKind);

  if (context.mutationKind === "insert") {
    score += 3;
  }

  if (availabilityState.becameVisible) {
    score += 5;
  }

  if (availabilityState.becameEnabled || availabilityState.becameClickable) {
    score += 4;
  }

  if (isClickableElement(triggerNode) && isVisible(triggerNode) && combinedText.length >= 4 && combinedText.length <= 80) {
    score += 3;
  }

  if (looksLikeSuddenlyAvailableAction(triggerNode)) {
    score += 3;
  }

  const rect = element.getBoundingClientRect();
  const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
  if ((rect.width * rect.height) / viewportArea > 0.35) {
    score -= 2;
  }

  return score;
}

function shouldIgnoreNode(node) {
  if (!(node instanceof HTMLElement)) {
    return true;
  }

  const tag = node.tagName.toLowerCase();
  const className = (node.className || "").toString().toLowerCase();
  const id = (node.id || "").toLowerCase();

  if (["script", "style", "noscript", "svg", "path"].includes(tag)) {
    return true;
  }

  if (node.closest("script, style, noscript, svg")) {
    return true;
  }

  if (IGNORE_CLASS_PATTERN.test(className)) {
    return true;
  }

  if (IGNORE_ID_PATTERN.test(id)) {
    return true;
  }

  return false;
}

function isClickableElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "a") {
    return true;
  }

  if ((element.getAttribute("role") || "").toLowerCase() === "button") {
    return true;
  }

  if (typeof element.onclick === "function" || element.hasAttribute("onclick")) {
    return true;
  }

  const tabIndex = element.tabIndex;
  return Number.isFinite(tabIndex) && tabIndex >= 0;
}

function isElementDisabled(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

function hasHiddenAttributes(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return element.hidden || element.getAttribute("aria-hidden") === "true";
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    !hasHiddenAttributes(element)
  );
}

function wasElementHiddenBefore(element, previousSnapshot, mutationKind = "text") {
  if (previousSnapshot) {
    return Boolean(previousSnapshot.hidden || previousSnapshot.visible === false);
  }

  if (mutationKind === "attribute") {
    return isVisible(element);
  }

  return mutationKind !== "insert" && !isVisible(element);
}

function looksLikeSuddenlyAvailableAction(element) {
  if (!(element instanceof HTMLElement) || !isVisible(element) || !isClickableElement(element)) {
    return false;
  }

  const text = normalizeText(element.innerText || element.textContent || "");
  if (text.length < 3 || text.length > 80) {
    return false;
  }

  if (isObviousNavChrome(element, text) || isIgnoredText(text, getActiveProfile())) {
    return false;
  }

  return true;
}

function isObviousNavChrome(element, text = "") {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.closest("nav, header, [role='navigation'], [aria-label*='nav' i], [class*='nav'], [class*='menu'], [id*='nav'], [id*='menu']")) {
    return true;
  }

  const normalized = text.toLowerCase();
  return /^(home|back|next|previous|menu|search|profile|settings|help|log in|sign in)$/i.test(normalized);
}

function getElementStateSnapshot(element) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const text = normalizeText(element.innerText || element.textContent || "");
  const visible = isVisible(element);
  const clickable = isClickableElement(element);
  const disabled = isElementDisabled(element);
  const hidden = !visible || hasHiddenAttributes(element);

  return {
    text,
    visible,
    clickable,
    disabled,
    hidden
  };
}

function getClosestCandidateSnapshot(element) {
  let current = element instanceof HTMLElement ? element : null;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const snapshot = candidateStateSnapshots.get(current);
    if (snapshot) {
      return snapshot;
    }

    current = current.parentElement;
  }

  return null;
}

function updateCandidateStateSnapshot(element) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  candidateStateSnapshots.set(element, getElementStateSnapshot(element));
}

function getAvailabilityState(element, previousSnapshot, mutationKind = "text") {
  const currentSnapshot = getElementStateSnapshot(element);
  const hiddenBefore = wasElementHiddenBefore(element, previousSnapshot, mutationKind);
  const becameVisible = Boolean(currentSnapshot?.visible && hiddenBefore);
  const becameEnabled = Boolean(previousSnapshot?.disabled && !currentSnapshot?.disabled);
  const becameClickable = Boolean(previousSnapshot && !previousSnapshot.clickable && currentSnapshot?.clickable);

  return {
    previousSnapshot,
    currentSnapshot,
    becameVisible,
    becameEnabled,
    becameClickable,
    becameAvailable: becameVisible || becameEnabled || becameClickable
  };
}

function isIgnoredText(text, profile = getActiveProfile()) {
  const normalized = text.toLowerCase();

  if (/^[\W\d_]+$/.test(normalized)) {
    return true;
  }

  return profile.noiseWords.some((word) => normalized.includes(word));
}

function collectVisibleTexts(selector, limit, predicate, seen, target, mapItem) {
  if (limit <= 0) {
    return target;
  }

  const initialLength = target.length;
  for (const element of document.querySelectorAll(selector)) {
    if (!(element instanceof HTMLElement) || !isVisible(element) || shouldIgnoreNode(element)) {
      continue;
    }

    const text = normalizeText(element.innerText || element.textContent || "");
    if (!text || seen.has(text) || !predicate(text, element)) {
      continue;
    }

    target.push(mapItem(text, element));
    seen.add(text);
    if (target.length - initialLength >= limit) {
      break;
    }
  }

  return target;
}

function pushUniqueText(target, seen, text, predicate, source = "") {
  const normalized = normalizeText(text || "");
  if (!normalized || seen.has(normalized) || !predicate(normalized)) {
    return;
  }

  target.push(source ? { text: normalized, source } : normalized);
  seen.add(normalized);
}

function detectSiteProfile(hostname) {
  const host = hostname.toLowerCase();

  if (
    host.includes("coinbase") ||
    host.includes("coinmarketcap") ||
    host.includes("coingecko") ||
    host.includes("tradingview") ||
    host.includes("binance") ||
    host.includes("kraken")
  ) {
    return {
      name: "crypto",
      prefix: "Crypto update",
      minScore: 4,
      minLineLength: 4,
      keywords: ["bitcoin", "btc", "usd", "price", "market cap", "volume"],
      noiseWords: ["cookie", "privacy", "sign in", "log in", "download app"]
    };
  }

  if (
    host.includes("espn") ||
    host.includes("nba") ||
    host.includes("nfl") ||
    host.includes("mlb") ||
    host.includes("nhl") ||
    host.includes("fanduel") ||
    host.includes("draftkings")
  ) {
    return {
      name: "sports",
      prefix: "Sports update",
      minScore: 5,
      minLineLength: 4,
      keywords: ["final", "score", "goal", "touchdown", "inning", "quarter", "period"],
      noiseWords: ["cookie", "privacy", "bet responsibly", "odds boost"]
    };
  }

  if (host.includes("learningcatalytics") || host.includes("pearson")) {
    return {
      name: "learning",
      prefix: "Learning session update",
      minScore: 4,
      minLineLength: 8,
      keywords: ["active sessions", "session", "chapter", "assignment", "join"],
      noiseWords: ["cookie", "privacy", "terms", "sign in", "log in"]
    };
  }

  return {
    name: "generic",
    prefix: "New content detected",
    minScore: 7,
    minLineLength: 12,
    keywords: ["new", "drop", "launch", "buy", "shop", "listing", "available"],
    noiseWords: ["cookie", "privacy", "terms", "sign in", "log in"]
  };
}

function getActiveProfile() {
  if (siteProfile.name !== "generic") {
    return siteProfile;
  }

  if (looksLikeLiveFeedPage()) {
    return {
      name: "live_feed",
      prefix: "Live feed update",
      minScore: 4,
      minLineLength: 4,
      keywords: ["q&a", "question", "latest", "recent", "response", "live", "session", "activity"],
      noiseWords: ["cookie", "privacy", "terms", "sign in", "log in"]
    };
  }

  return siteProfile;
}

function looksLikeLiveFeedPage() {
  const bodyText = normalizeText(document.body?.innerText || "").toLowerCase().slice(0, 3000);
  const headingHits = LIVE_FEED_KEYWORDS.filter((keyword) => bodyText.includes(keyword)).length;
  const repeatedCards = document.querySelectorAll("article, li, [role='listitem'], [class*='card'], [class*='item']").length;
  return headingHits >= 2 || repeatedCards >= 4;
}

function isInsideActiveSessionsRegion(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const region = element.closest("section, article, div, li, ul, ol");
  if (!region) {
    return false;
  }

  const regionText = normalizeText(region.innerText || region.textContent || "").toLowerCase().slice(0, 500);
  return regionText.includes("active sessions");
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function safeCompact(text) {
  return normalizeText(String(text || "").slice(0, 4000));
}

function clip(text) {
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function normalizeFingerprint(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getNodePath(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  const parts = [];
  let current = element;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const tag = current.tagName.toLowerCase();
    const siblingIndex = current.parentElement
      ? Array.from(current.parentElement.children).indexOf(current)
      : 0;
    parts.unshift(`${tag}:${siblingIndex}`);
    current = current.parentElement;
  }
  return parts.join(">");
}

function getBestTriggerNode(node) {
  if (!(node instanceof HTMLElement)) {
    return null;
  }

  let best = node;
  let bestTextLength = normalizeText(node.innerText || node.textContent || "").length || Infinity;
  const descendants = node.querySelectorAll?.("*") || [];

  for (const descendant of descendants) {
    if (!(descendant instanceof HTMLElement) || !isVisible(descendant) || shouldIgnoreNode(descendant)) {
      continue;
    }

    const textLength = normalizeText(descendant.innerText || descendant.textContent || "").length;
    if (looksLikeSuddenlyAvailableAction(descendant)) {
      return descendant;
    }

    if (((isClickableElement(descendant) && textLength >= 3) || textLength >= 4) && textLength < bestTextLength) {
      best = descendant;
      bestTextLength = textLength;
    }
  }

  return best;
}

function isRecentlySentFingerprint(fingerprint, now) {
  const sentAt = recentDomFingerprints.get(fingerprint);
  if (!sentAt) {
    return false;
  }

  return now - sentAt < RECENT_FINGERPRINT_TTL_MS;
}

function rememberFingerprint(fingerprint, now) {
  recentDomFingerprints.set(fingerprint, now);
  for (const [key, timestamp] of recentDomFingerprints.entries()) {
    if (now - timestamp > FINGERPRINT_CACHE_TTL_MS) {
      recentDomFingerprints.delete(key);
    }
  }
}

function getFlushDelayMs() {
  const activeProfile = getActiveProfile();
  if (activeProfile.name === "learning" || activeProfile.name === "live_feed") {
    return FAST_FLUSH_DELAY_MS;
  }

  for (const [node, meta] of pendingNodeMeta.entries()) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }

    const text = normalizeText(node.innerText || node.textContent || "");
    if (
      meta?.mutationKind === "insert" &&
      (isInlineDiscussionLine(text) || hasRepeatedSiblingStructure(node) || looksLikeRepeatedFeedItem(node))
    ) {
      return FAST_FLUSH_DELAY_MS;
    }
  }

  return FLUSH_DELAY_MS;
}

function debugDomCandidates(reason, candidateLogs, best) {
  if (!DEBUG_DOM_CANDIDATES) {
    return;
  }

  console.debug("Revere DOM candidates", {
    reason,
    best,
    candidates: candidateLogs.slice(0, 5)
  });
}

function debugSuddenlyAvailableAction(mutationKind, element, previousSnapshot, currentSnapshot, availabilityState, accepted, candidate) {
  if (!DEBUG_DOM_CANDIDATES || mutationKind !== "attribute") {
    return;
  }

  console.debug("Revere sudden action candidate", {
    mutationKind,
    text: normalizeText(element?.innerText || element?.textContent || ""),
    before: previousSnapshot
      ? {
          visible: previousSnapshot.visible,
          clickable: previousSnapshot.clickable,
          disabled: previousSnapshot.disabled,
          hidden: previousSnapshot.hidden
        }
      : null,
    after: currentSnapshot
      ? {
          visible: currentSnapshot.visible,
          clickable: currentSnapshot.clickable,
          disabled: currentSnapshot.disabled,
          hidden: currentSnapshot.hidden
        }
      : null,
    availabilityBoosted: availabilityState?.becameAvailable,
    accepted,
    winningCandidate: candidate ? { summary: candidate.summary, score: candidate.score } : null
  });
}

function debugSuddenlyAvailableWinner(candidate) {
  if (!DEBUG_DOM_CANDIDATES || candidate?.mutationKind !== "attribute") {
    return;
  }

  console.debug("Revere sudden action winner", {
    mutationKind: candidate.mutationKind,
    text: candidate.triggerSummary,
    availabilityBoosted: candidate.availabilityBoosted,
    winningCandidate: {
      summary: candidate.summary,
      score: candidate.score,
      source: candidate.source
    }
  });
}

function isExtensionContextAvailable() {
  try {
    return Boolean(globalThis.chrome?.runtime?.id);
  } catch (error) {
    return false;
  }
}

function handleExtensionContextInvalidated(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message.toLowerCase().includes("extension context invalidated")) {
    console.error(error);
  }

  extensionActive = false;
  shutdownContentScript();
}

function shutdownContentScript() {
  clearTimeout(flushTimer);
  flushTimer = null;

  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }

  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }

  if (cryptoIntervalId) {
    clearInterval(cryptoIntervalId);
    cryptoIntervalId = null;
  }

  if (startupSnapshotTimeoutId) {
    clearTimeout(startupSnapshotTimeoutId);
    startupSnapshotTimeoutId = null;
  }

  if (startupPriceTimeoutId) {
    clearTimeout(startupPriceTimeoutId);
    startupPriceTimeoutId = null;
  }

  pendingNodes.clear();
  pendingNodeMeta.clear();
}

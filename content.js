const FLUSH_DELAY_MS = 1200;
const EVENT_COOLDOWN_MS = 5000;
const NETWORK_EVENT_COOLDOWN_MS = 3000;
const PRICE_SCAN_INTERVAL_MS = 2000;
const SNAPSHOT_SCAN_INTERVAL_MS = 4000;
const MAX_CANDIDATES = 20;
const MAX_SNAPSHOT_BLOCKS = 12;
const INJECTED_EVENT_NAME = "website-updater-network-message";
const PRICE_REGEX = /\$?(?:\d{1,3}(?:,\d{3})+|\d{4,6}|\d{1,3})(?:\.\d{1,8})?/;

const pendingNodes = new Set();

let flushTimer = null;
let lastSentAt = 0;
let lastNetworkSentAt = 0;
let lastPriceValue = "";
let lastSnapshotFingerprint = "";
let lastSnapshotBlocks = [];

const siteProfile = detectSiteProfile(location.hostname);
const pageHasBitcoinContext = looksLikeBitcoinContext(`${location.href} ${document.title || ""}`);

boot();

function boot() {
  injectPageHook();
  window.addEventListener(INJECTED_EVENT_NAME, handleInjectedNetworkEvent);

  waitForDocumentElement(() => {
    startDomObserver();
    setInterval(scanSnapshotSignals, SNAPSHOT_SCAN_INTERVAL_MS);
    setTimeout(scanSnapshotSignals, 2500);
    window.addEventListener("focus", scanSnapshotSignals);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scanSnapshotSignals();
      }
    });

    if (siteProfile.name === "crypto") {
      setInterval(scanPriceSignals, PRICE_SCAN_INTERVAL_MS);
      setTimeout(scanPriceSignals, 1500);
    }
  });
}

function startDomObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          collectCandidateNode(node);
        }
      }

      if (mutation.type === "characterData") {
        collectCandidateNode(mutation.target?.parentElement);
      }
    }

    scheduleFlush();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function injectPageHook() {
  const target = document.head || document.documentElement;
  if (!target) {
    setTimeout(injectPageHook, 0);
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
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
  const candidate = buildSnapshotCandidate();
  if (!candidate) {
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < EVENT_COOLDOWN_MS) {
    return;
  }

  lastSentAt = now;
  sendEvent(candidate.summary, candidate.fingerprint, candidate.score, siteProfile.name, "snapshot");
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
  const blocks = collectSnapshotBlocks();
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
  const summaryPrefix = siteProfile.name === "generic" ? "Page snapshot changed" : `${siteProfile.prefix} snapshot`;

  lastSnapshotFingerprint = fingerprint;
  lastSnapshotBlocks = blocks;

  return {
    summary: `${summaryPrefix}: ${clip(changedBlock)}`,
    fingerprint: `${location.hostname}:snapshot:${fingerprint}`,
    score: Math.max(siteProfile.minScore, 8)
  };
}

function collectSnapshotBlocks() {
  const selectors = [
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
  ];
  const blocks = [];
  const seen = new Set();

  const title = normalizeText(document.title || "");
  if (isSnapshotWorthy(title)) {
    blocks.push(title);
    seen.add(title);
  }

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !isVisible(element) || shouldIgnoreNode(element)) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || "");
      if (!isSnapshotWorthy(text) || seen.has(text)) {
        continue;
      }

      blocks.push(text);
      seen.add(text);

      if (blocks.length >= MAX_SNAPSHOT_BLOCKS) {
        return blocks;
      }
    }
  }

  return blocks;
}

function isSnapshotWorthy(text) {
  if (!text) {
    return false;
  }

  if (text.length < siteProfile.minLineLength) {
    return false;
  }

  if (text.length > 220) {
    return false;
  }

  if (isIgnoredText(text)) {
    return false;
  }

  const normalized = text.toLowerCase();
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(normalized)) {
    return false;
  }

  if (/^(loading|please wait|updated just now|just now)$/i.test(text)) {
    return false;
  }

  return true;
}

function collectPriceSamples() {
  const samples = [];
  const title = normalizeText(document.title || "");
  if (looksLikeBitcoinContext(title)) {
    samples.push({ text: title, source: "title" });
  }

  const selectors = [
    "[data-price]",
    "[data-test='price']",
    "[data-testid='price']",
    "[class*='price']",
    "[class*='ticker']",
    "[class*='quote']",
    "h1",
    "h2"
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      const text = normalizeText(element.innerText || element.textContent || "");
      if (!text) {
        continue;
      }

      const selectorLooksPriceLike =
        selector.includes("price") || selector.includes("ticker") || selector.includes("quote");
      const allowByPageContext =
        siteProfile.name === "crypto" && pageHasBitcoinContext && selectorLooksPriceLike;

      if (!looksLikeBitcoinContext(text) && !allowByPageContext) {
        continue;
      }

      if (!PRICE_REGEX.test(text)) {
        continue;
      }

      samples.push({ text, source: selector });
      if (samples.length >= 8) {
        return samples;
      }
    }
  }

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

function collectCandidateNode(node) {
  if (!(node instanceof HTMLElement)) {
    return;
  }

  if (shouldIgnoreNode(node)) {
    return;
  }

  pendingNodes.add(node);
  if (pendingNodes.size > MAX_CANDIDATES) {
    const first = pendingNodes.values().next().value;
    pendingNodes.delete(first);
  }
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushCandidates, FLUSH_DELAY_MS);
}

function flushCandidates() {
  if (!pendingNodes.size) {
    return;
  }

  const candidates = [];
  for (const node of pendingNodes) {
    const candidate = buildDomCandidate(node);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  pendingNodes.clear();

  if (!candidates.length) {
    return;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < EVENT_COOLDOWN_MS) {
    return;
  }

  lastSentAt = now;
  sendEvent(best.summary, best.fingerprint, best.score, siteProfile.name, "dom");
}

function sendEvent(summary, fingerprint, score, profile, source) {
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
}

function buildDomCandidate(node) {
  const element = elevateCandidate(node);
  if (!element || shouldIgnoreNode(element) || !isVisible(element)) {
    return null;
  }

  const lines = extractLines(element);
  if (!lines.length) {
    return null;
  }

  const summaryText = lines.slice(0, 3).join(" | ");
  const score = scoreCandidate(element, lines);

  if (score < siteProfile.minScore) {
    return null;
  }

  return {
    score,
    summary: `${siteProfile.prefix}: ${clip(summaryText)}`,
    fingerprint: `${location.hostname}:dom:${normalizeFingerprint(summaryText)}`
  };
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
  const keywords = ["score", "goal", "touchdown", "home_score", "away_score", "clock", "period", "inning", "quarter"];
  const keywordHits = keywords.filter((word) => normalized.includes(word)).length;

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

function elevateCandidate(node) {
  let current = node;

  for (let i = 0; i < 4 && current; i += 1) {
    if (looksLikeCard(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return node;
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
    /(card|item|tile|product|listing|drop|grid|row|score|matchup|game|price|ticker|quote)/.test(className)
  );
}

function extractLines(element) {
  const text = normalizeText(element.innerText || element.textContent || "");
  if (!text) {
    return [];
  }

  const rawLines = text
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const unique = [];
  for (const line of rawLines) {
    if (
      (!looksLikeCompactPriceLine(line) && line.length < siteProfile.minLineLength) ||
      line.length > 120 ||
      isIgnoredText(line) ||
      unique.includes(line)
    ) {
      continue;
    }

    unique.push(line);
    if (unique.length === 5) {
      break;
    }
  }

  return unique;
}

function looksLikeCompactPriceLine(line) {
  return siteProfile.name === "crypto" && PRICE_REGEX.test(line);
}

function scoreCandidate(element, lines) {
  let score = 0;
  const combined = lines.join(" ").toLowerCase();
  const className = (element.className || "").toString().toLowerCase();

  score += Math.min(lines.join(" ").length / 20, 6);
  score += Math.min(lines.length, 4);

  if (element.querySelector("a[href]")) {
    score += 2;
  }

  if (element.querySelector("img")) {
    score += 1;
  }

  if (/(product|item|card|tile|listing|grid|score|game|price|ticker|quote)/.test(className)) {
    score += 2;
  }

  if (siteProfile.name === "crypto" && PRICE_REGEX.test(combined)) {
    score += 4;
  }

  for (const keyword of siteProfile.keywords) {
    if (combined.includes(keyword)) {
      score += 2;
    }
  }

  for (const noiseWord of siteProfile.noiseWords) {
    if (combined.includes(noiseWord)) {
      score -= 2;
    }
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

  if (/(countdown|timer|carousel|slider|ticker|marquee|toast|modal)/.test(className)) {
    return true;
  }

  if (/(countdown|timer|toast|modal)/.test(id)) {
    return true;
  }

  return false;
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function isIgnoredText(text) {
  const normalized = text.toLowerCase();

  if (/^[\W\d_]+$/.test(normalized)) {
    return true;
  }

  return siteProfile.noiseWords.some((word) => normalized.includes(word));
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

  return {
    name: "generic",
    prefix: "New content detected",
    minScore: 7,
    minLineLength: 12,
    keywords: ["new", "drop", "launch", "buy", "shop", "listing", "available"],
    noiseWords: ["cookie", "privacy", "terms", "sign in", "log in"]
  };
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

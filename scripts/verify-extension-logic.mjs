#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const backgroundPath = new URL("../background.js", import.meta.url);
const source = fs.readFileSync(backgroundPath, "utf8");
const storageData = {};

const chrome = {
  runtime: {
    getURL: (assetPath) => `chrome-extension://revere/${assetPath}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} }
  },
  alarms: {
    onAlarm: { addListener() {} },
    async clear() {},
    async create() {}
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") {
          return { [keys]: storageData[keys] };
        }
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      }
    },
    onChanged: { addListener() {} }
  },
  notifications: {
    onClicked: { addListener() {} },
    async create() {},
    async clear() {}
  },
  tabs: {
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    async create() {}
  },
  windows: {
    async get() {
      return { focused: true };
    }
  },
  debugger: {}
};

const context = {
  chrome,
  console,
  fetch,
  setInterval() {
    return 1;
  },
  clearInterval() {},
  URL,
  Uint8Array,
  Math,
  Date
};

vm.createContext(context);
vm.runInContext(
  `${source}
globalThis.__revereTestAPI = {
  buildVisualSummary,
  compareScreenshotSamples,
  isCapturableTabUrl,
  isThinEdgeStrip,
  normalizeVisualScanInterval,
  renderTemplate,
  rotateVisualWatches
};`,
  context,
  { filename: "background.js" }
);

const api = context.__revereTestAPI;
assert.ok(api, "background.js test API should load");

function sample(changedRect) {
  const width = 128;
  const height = 72;
  const pixels = new Uint8Array(width * height);
  pixels.fill(24);

  if (changedRect) {
    const maxY = Math.min(height, changedRect.y + changedRect.height);
    const maxX = Math.min(width, changedRect.x + changedRect.width);
    for (let y = changedRect.y; y < maxY; y += 1) {
      for (let x = changedRect.x; x < maxX; x += 1) {
        pixels[y * width + x] = 220;
      }
    }
  }

  return { width, height, pixels };
}

const baseline = sample();
const centerDiff = api.compareScreenshotSamples(
  baseline,
  sample({ x: 44, y: 22, width: 40, height: 20 })
);
assert.ok(centerDiff, "center visual change should produce a diff");
assert.equal(centerDiff.changedPixels, 800);
assert.equal(api.isThinEdgeStrip(centerDiff, 128, 72), false);
assert.match(api.buildVisualSummary("debugger_screenshot", centerDiff), /Background tab visual change/);
assert.equal(baseline.pixels.byteLength, 128 * 72, "samples should stay tiny and in-memory");

const edgeDiff = api.compareScreenshotSamples(
  baseline,
  sample({ x: 0, y: 0, width: 1, height: 72 })
);
assert.ok(edgeDiff, "edge movement should still produce a raw diff");
assert.equal(api.isThinEdgeStrip(edgeDiff, 128, 72), true, "thin edge noise should be filtered");

assert.equal(api.normalizeVisualScanInterval(1), 2);
assert.equal(api.normalizeVisualScanInterval(5), 5);
assert.equal(api.normalizeVisualScanInterval(500), 60);
assert.equal(api.isCapturableTabUrl("https://example.com"), true);
assert.equal(api.isCapturableTabUrl("file:///tmp/revere-test.html"), true);
assert.equal(api.isCapturableTabUrl("chrome://extensions"), false);
assert.equal(
  api.renderTemplate("{{title}} on {{domain}} via {{source}}", {
    title: "Changed",
    domain: "example.com",
    source: "visual"
  }),
  "Changed on example.com via visual"
);
assert.deepEqual(
  api.rotateVisualWatches([{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }]).map((watch) => watch.tabId),
  [1, 2, 3]
);

console.log("PASS: extension visual-diff logic, capture guards, templates, and sample size verified.");

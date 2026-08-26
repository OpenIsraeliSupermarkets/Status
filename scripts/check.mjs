#!/usr/bin/env node
/**
 * Public surface checks for Open Israeli Supermarkets.
 * Website + API every run (workflow ~5 min); Kaggle about once per hour.
 * Writes docs/status.json and appends to docs/history.json (capped).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS = join(ROOT, "docs");
const STATUS_PATH = join(DOCS, "status.json");
const HISTORY_PATH = join(DOCS, "history.json");
const PREV_STATUS_PATH = join(DOCS, "status.json");

const HISTORY_CAP = 2016; // ~7 days at 5-minute intervals
const KAGGLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KAGGLE_CHECK_INTERVAL_MS = 55 * 60 * 1000; // slightly under 1h for cron drift

const CHECKS = {
  website: {
    id: "website",
    name: "Website",
    url: "https://www.openisraelisupermarkets.co.il/",
  },
  api_ping: {
    id: "api_ping",
    name: "API /ping",
    url: "https://data.openisraelisupermarkets.co.il/ping",
  },
  kaggle: {
    id: "kaggle",
    name: "Kaggle dataset freshness",
    url: "https://www.kaggle.com/api/v1/datasets/view/erlichsefi/israeli-supermarkets-2024",
  },
};

function basicAuthHeader(user, key) {
  const token = Buffer.from(`${user}:${key}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function timedFetch(url, options = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...options,
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
    });
    const latency_ms = Date.now() - started;
    const text = await res.text();
    return { ok: res.ok, status: res.status, latency_ms, text, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
      text: null,
      error: err.message || String(err),
    };
  }
}

async function checkWebsite() {
  const meta = CHECKS.website;
  const r = await timedFetch(meta.url, {
    headers: { "User-Agent": "OpenIsraeliSupermarkets-status/1.0" },
  });
  const pass = r.ok && r.status === 200;
  return {
    id: meta.id,
    name: meta.name,
    url: meta.url,
    ok: pass,
    http_status: r.status,
    latency_ms: r.latency_ms,
    detail: pass ? "HTTP 200" : r.error || `HTTP ${r.status}`,
  };
}

async function checkApiPing() {
  const meta = CHECKS.api_ping;
  const r = await timedFetch(meta.url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "OpenIsraeliSupermarkets-status/1.0",
    },
  });
  let message = null;
  let pass = false;
  if (r.ok && r.text) {
    try {
      const body = JSON.parse(r.text);
      message = body.message;
      pass = r.status === 200 && message === "pong";
    } catch {
      pass = false;
    }
  }
  return {
    id: meta.id,
    name: meta.name,
    url: meta.url,
    ok: pass,
    http_status: r.status,
    latency_ms: r.latency_ms,
    detail: pass
      ? 'message="pong"'
      : r.error || `expected message=pong, got ${JSON.stringify(message)} (HTTP ${r.status})`,
  };
}

async function checkKaggle() {
  const meta = CHECKS.kaggle;
  const user = process.env.KAGGLE_USERNAME;
  const key = process.env.KAGGLE_KEY;
  if (!user || !key) {
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      ok: false,
      http_status: null,
      latency_ms: 0,
      last_updated: null,
      detail: "Missing KAGGLE_USERNAME or KAGGLE_KEY",
    };
  }

  const r = await timedFetch(meta.url, {
    headers: {
      Authorization: basicAuthHeader(user, key),
      Accept: "application/json",
      "User-Agent": "OpenIsraeliSupermarkets-status/1.0",
    },
  });

  if (!r.ok || !r.text) {
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      ok: false,
      http_status: r.status,
      latency_ms: r.latency_ms,
      last_updated: null,
      detail: r.error || `HTTP ${r.status}`,
    };
  }

  let lastUpdated = null;
  try {
    const body = JSON.parse(r.text);
    lastUpdated =
      body.lastUpdated ||
      body.lastUpdatedUtc ||
      body.lastUpdatedDate ||
      (body.dataset && body.dataset.lastUpdated) ||
      null;
  } catch {
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      ok: false,
      http_status: r.status,
      latency_ms: r.latency_ms,
      last_updated: null,
      detail: "Invalid JSON from Kaggle API",
    };
  }

  if (!lastUpdated) {
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      ok: false,
      http_status: r.status,
      latency_ms: r.latency_ms,
      last_updated: null,
      detail: "No lastUpdated field in Kaggle response",
    };
  }

  const updatedMs = Date.parse(lastUpdated);
  if (Number.isNaN(updatedMs)) {
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url,
      ok: false,
      http_status: r.status,
      latency_ms: r.latency_ms,
      last_updated: lastUpdated,
      detail: `Unparseable lastUpdated: ${lastUpdated}`,
    };
  }

  const ageMs = Date.now() - updatedMs;
  const pass = ageMs <= KAGGLE_MAX_AGE_MS;
  const ageHours = (ageMs / 3600000).toFixed(1);

  return {
    id: meta.id,
    name: meta.name,
    url: "https://www.kaggle.com/datasets/erlichsefi/israeli-supermarkets-2024",
    ok: pass,
    http_status: r.status,
    latency_ms: r.latency_ms,
    last_updated: new Date(updatedMs).toISOString(),
    detail: pass
      ? `Updated ${ageHours}h ago (within 24h)`
      : `Stale: last updated ${ageHours}h ago (limit 24h)`,
  };
}

function loadPreviousStatus() {
  if (!existsSync(PREV_STATUS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PREV_STATUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
    return Array.isArray(data) ? data : data.runs || [];
  } catch {
    return [];
  }
}

function previousKaggle(previous) {
  return previous?.checks?.find((c) => c.id === "kaggle") || null;
}

function shouldRunKaggle(previous) {
  if (process.env.SKIP_KAGGLE === "1") return false;
  if (process.env.FORCE_KAGGLE === "1") return true;

  // Hourly slot among */5 runs (UTC minute 0–4)
  if (new Date().getUTCMinutes() < 5) return true;

  const prev = previousKaggle(previous);
  if (!prev || prev.skipped) return true;
  const checkedAt = prev.checked_at || previous?.checked_at;
  if (!checkedAt) return true;
  const age = Date.now() - Date.parse(checkedAt);
  return Number.isNaN(age) || age >= KAGGLE_CHECK_INTERVAL_MS;
}

function carryForwardKaggle(previous, checked_at) {
  const prev = previousKaggle(previous);
  const meta = CHECKS.kaggle;
  if (!prev || typeof prev.ok !== "boolean") {
    return {
      id: meta.id,
      name: meta.name,
      url: "https://www.kaggle.com/datasets/erlichsefi/israeli-supermarkets-2024",
      ok: false,
      http_status: null,
      latency_ms: 0,
      last_updated: null,
      checked_at,
      skipped: true,
      detail: "No prior Kaggle result to reuse",
    };
  }

  return {
    ...prev,
    id: meta.id,
    name: meta.name,
    url: prev.url || "https://www.kaggle.com/datasets/erlichsefi/israeli-supermarkets-2024",
    skipped: true,
    detail: `${prev.detail || "Cached result"} (hourly check; last run ${prev.checked_at || previous?.checked_at || "unknown"})`,
  };
}

async function notifyDiscord(status, previous) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    console.log("DISCORD_WEBHOOK_URL not set; skipping Discord notify");
    return;
  }

  const prevOverall = previous?.overall ?? null;
  const nowOverall = status.overall;
  const failed = status.checks.filter((c) => !c.ok);
  const recovered = nowOverall === "up" && prevOverall === "down";
  const newlyDown = nowOverall === "down" && prevOverall !== "down";

  // Only notify on transition (new failure or recovery)
  if (!newlyDown && !recovered) return;

  let content;
  if (recovered) {
    content = "✅ **Open Israeli Supermarkets — recovered**\nAll checks are passing again.";
  } else {
    const lines = failed.map((c) => `• **${c.name}**: ${c.detail}`).join("\n");
    content = `🔴 **Open Israeli Supermarkets — degraded**\n${lines}\n\nStatus: https://openisraelisupermarkets.github.io/Status/`;
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: HTTP ${res.status}`);
  } else {
    console.log("Discord notification sent");
  }
}

async function main() {
  mkdirSync(DOCS, { recursive: true });

  const previous = loadPreviousStatus();
  const checked_at = new Date().toISOString();
  const runKaggle = shouldRunKaggle(previous);

  console.log(`Running checks at ${checked_at} (kaggle=${runKaggle ? "yes" : "skip"})...`);

  const [website, api_ping] = await Promise.all([checkWebsite(), checkApiPing()]);
  website.checked_at = checked_at;
  api_ping.checked_at = checked_at;

  let kaggle;
  if (runKaggle) {
    kaggle = await checkKaggle();
    kaggle.checked_at = checked_at;
    kaggle.skipped = false;
  } else {
    kaggle = carryForwardKaggle(previous, checked_at);
    console.log(`  SKIP Kaggle dataset freshness: using cached result`);
  }

  const checks = [website, api_ping, kaggle];
  for (const c of checks) {
    if (c.skipped) continue;
    console.log(`  ${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`);
  }

  const overall = checks.every((c) => c.ok) ? "up" : "down";
  const status = {
    overall,
    checked_at,
    intervals: {
      website: "5m",
      api_ping: "5m",
      kaggle: "1h",
    },
    checks,
    pages_url: "https://openisraelisupermarkets.github.io/Status/",
    repo: "https://github.com/OpenIsraeliSupermarkets/status",
  };

  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + "\n");

  const history = loadHistory();
  history.push({
    checked_at,
    overall,
    checks: checks.map((c) => ({
      id: c.id,
      ok: c.skipped ? null : c.ok,
      skipped: !!c.skipped,
      latency_ms: c.skipped ? undefined : c.latency_ms,
      last_updated: c.last_updated ?? undefined,
    })),
  });
  while (history.length > HISTORY_CAP) history.shift();
  writeFileSync(HISTORY_PATH, JSON.stringify({ runs: history }, null, 2) + "\n");

  await notifyDiscord(status, previous);

  if (overall === "down") {
    console.error("One or more checks failed");
    process.exitCode = 1;
  } else {
    console.log("All checks passed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Public surface checks for Open Israeli Supermarkets.
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

const HISTORY_CAP = 288; // ~48h at 10-minute intervals
const KAGGLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

  // Only notify on transition (new failure or recovery), not every 10 minutes while down
  if (!newlyDown && !recovered) return;

  let content;
  if (recovered) {
    content = "✅ **Open Israeli Supermarkets — recovered**\nAll checks are passing again.";
  } else {
    const lines = failed.map((c) => `• **${c.name}**: ${c.detail}`).join("\n");
    content = `🔴 **Open Israeli Supermarkets — degraded**\n${lines}\n\nStatus: https://openisraelisupermarkets.github.io/status/`;
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

  console.log(`Running checks at ${checked_at}...`);
  const [website, api_ping, kaggle] = await Promise.all([
    checkWebsite(),
    checkApiPing(),
    checkKaggle(),
  ]);

  const checks = [website, api_ping, kaggle];
  for (const c of checks) {
    console.log(`  ${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`);
  }

  const overall = checks.every((c) => c.ok) ? "up" : "down";
  const status = {
    overall,
    checked_at,
    checks,
    pages_url: "https://openisraelisupermarkets.github.io/status/",
    repo: "https://github.com/OpenIsraeliSupermarkets/status",
  };

  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + "\n");

  const history = loadHistory();
  history.push({
    checked_at,
    overall,
    checks: checks.map((c) => ({
      id: c.id,
      ok: c.ok,
      latency_ms: c.latency_ms,
      last_updated: c.last_updated ?? undefined,
    })),
  });
  while (history.length > HISTORY_CAP) history.shift();
  writeFileSync(HISTORY_PATH, JSON.stringify({ runs: history }, null, 2) + "\n");

  await notifyDiscord(status, previous);

  // Non-zero exit so the workflow can mark the job as failed while still deploying Pages
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

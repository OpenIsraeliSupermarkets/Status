async function loadJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
  return res.json();
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function ageLabel(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.round(ms / 60000)}m ago`;
  return `${hours.toFixed(1)}h ago`;
}

function getRuns(history) {
  return history?.runs || (Array.isArray(history) ? history : []);
}

function checkSeries(runs, checkId, { omitSkipped = false } = {}) {
  const series = runs.map((run) => {
    const entry = (run.checks || []).find((c) => c.id === checkId);
    const skipped = !entry || entry.skipped || entry.ok === null || entry.ok === undefined;
    if (omitSkipped && skipped) {
      return null;
    }
    return {
      checked_at: run.checked_at,
      ok: skipped ? null : !!entry.ok,
      skipped,
      latency_ms: entry?.latency_ms,
      last_updated: entry?.last_updated,
    };
  });
  return omitSkipped ? series.filter(Boolean) : series;
}

function intervalLabel(status, checkId) {
  const fromStatus = status?.intervals?.[checkId];
  if (fromStatus === "5m") return "every 5 min";
  if (fromStatus === "1h") return "hourly";
  if (checkId === "kaggle") return "hourly";
  return "every 5 min";
}

function historyLabel(status, checkId, name) {
  const cadence = intervalLabel(status, checkId);
  return name ? `${name} · ${cadence}` : `Last 7 days · ${cadence}`;
}

function uptimePct(series) {
  const known = series.filter((p) => p.ok !== null);
  if (!known.length) return null;
  const up = known.filter((p) => p.ok).length;
  return Math.round((up / known.length) * 1000) / 10;
}

function appendTimeline(container, series, label) {
  const wrap = document.createElement("div");
  wrap.className = "check-history";

  const meta = document.createElement("div");
  meta.className = "check-history-meta";
  const pct = uptimePct(series);
  const known = series.filter((p) => p.ok !== null).length;
  meta.innerHTML = `<span>${label || "History"}</span><span class="muted">${
    known
      ? `${known} checks${pct != null ? ` · ${pct}% up` : ""}`
      : "No samples yet"
  }</span>`;

  const track = document.createElement("div");
  track.className = "history";
  track.setAttribute("role", "img");
  track.setAttribute(
    "aria-label",
    `${label || "History"} timeline (${known} samples)`
  );

  if (!series.length) {
    track.textContent = "No history yet.";
  } else {
    for (const point of series) {
      const bar = document.createElement("div");
      const state =
        point.ok === true ? "up" : point.ok === false ? "down" : "unknown";
      bar.className = `bar ${state}`;
      const statusText =
        point.ok === true ? "up" : point.ok === false ? "down" : "unknown";
      bar.title = `${fmtTime(point.checked_at)} — ${statusText}${
        point.latency_ms != null ? ` · ${point.latency_ms} ms` : ""
      }`;
      track.append(bar);
    }
  }

  wrap.append(meta, track);
  container.append(wrap);
}

function renderOverall(status) {
  const section = document.getElementById("overall");
  const badge = document.getElementById("overall-badge");
  const checkedAt = document.getElementById("checked-at");
  const subtitle = document.getElementById("overall-subtitle");

  section.classList.remove("up", "down", "unknown");
  section.classList.add(status.overall === "up" ? "up" : "down");

  badge.textContent = status.overall === "up" ? "All systems operational" : "Degraded";
  checkedAt.textContent = `Last checked: ${fmtTime(status.checked_at)}`;
  subtitle.textContent =
    status.overall === "up"
      ? "Website, API, and Kaggle publish look healthy."
      : "One or more public checks are failing.";
}

function renderChecks(status, history) {
  const root = document.getElementById("checks");
  root.innerHTML = "";
  const runs = getRuns(history);

  for (const check of status.checks) {
    const card = document.createElement("article");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "card-head";

    const title = document.createElement("h2");
    title.textContent = check.name;

    const pill = document.createElement("span");
    pill.className = `pill ${check.ok ? "up" : "down"}`;
    pill.textContent = check.ok ? "Up" : "Down";

    head.append(title, pill);

    const dl = document.createElement("dl");
    const rows = [
      ["Detail", check.detail || "—"],
      ["Interval", intervalLabel(status, check.id)],
      ["HTTP", check.http_status ?? "—"],
      ["Latency", check.latency_ms != null ? `${check.latency_ms} ms` : "—"],
    ];

    if (check.checked_at) {
      rows.push(["Last probed", fmtTime(check.checked_at)]);
    }

    if (check.url) {
      rows.push([
        "URL",
        `<a href="${check.url}" target="_blank" rel="noopener noreferrer">${check.url}</a>`,
      ]);
    }

    if (check.last_updated) {
      const age = ageLabel(check.last_updated);
      rows.push([
        "Kaggle last updated",
        `${fmtTime(check.last_updated)}${age ? ` (${age})` : ""}`,
      ]);
    }

    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.innerHTML = v;
      dl.append(dt, dd);
    }

    card.append(head, dl);
    const omitSkipped = check.id === "kaggle";
    appendTimeline(
      card,
      checkSeries(runs, check.id, { omitSkipped }),
      historyLabel(status, check.id, "Last 7 days")
    );
    root.append(card);
  }
}

function renderHistoryOverview(status, history) {
  const root = document.getElementById("history");
  root.innerHTML = "";
  const runs = getRuns(history);

  if (!runs.length) {
    root.innerHTML = `<p class="muted">No history yet — website/API build every 5 minutes; Kaggle hourly.</p>`;
    return;
  }

  const checks = status.checks?.length
    ? status.checks
    : [
        { id: "website", name: "Website" },
        { id: "api_ping", name: "API /ping" },
        { id: "kaggle", name: "Kaggle dataset freshness" },
      ];

  for (const check of checks) {
    const row = document.createElement("div");
    row.className = "history-row";
    const omitSkipped = check.id === "kaggle";
    appendTimeline(
      row,
      checkSeries(runs, check.id, { omitSkipped }),
      historyLabel(status, check.id, check.name)
    );
    root.append(row);
  }
}

async function main() {
  try {
    const [status, history] = await Promise.all([
      loadJson("./status.json"),
      loadJson("./history.json").catch(() => ({ runs: [] })),
    ]);
    renderOverall(status);
    renderChecks(status, history);
    renderHistoryOverview(status, history);
  } catch (err) {
    const section = document.getElementById("overall");
    section.className = "overall down";
    document.getElementById("overall-badge").textContent = "Status unavailable";
    document.getElementById("overall-subtitle").textContent =
      "Could not load status.json. The first workflow run may still be pending.";
    document.getElementById("checked-at").textContent = String(err.message || err);
    document.getElementById("checks").innerHTML =
      `<div class="error-banner">${String(err.message || err)}</div>`;
  }
}

main();

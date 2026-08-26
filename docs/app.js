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

function renderChecks(status) {
  const root = document.getElementById("checks");
  root.innerHTML = "";

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
      ["HTTP", check.http_status ?? "—"],
      ["Latency", check.latency_ms != null ? `${check.latency_ms} ms` : "—"],
    ];

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
    root.append(card);
  }
}

function renderHistory(history) {
  const root = document.getElementById("history");
  root.innerHTML = "";
  const runs = history.runs || history || [];
  if (!runs.length) {
    root.textContent = "No history yet.";
    return;
  }

  for (const run of runs) {
    const bar = document.createElement("div");
    bar.className = `bar ${run.overall === "up" ? "up" : "down"}`;
    bar.title = `${fmtTime(run.checked_at)} — ${run.overall}`;
    root.append(bar);
  }
}

async function main() {
  try {
    const [status, history] = await Promise.all([
      loadJson("./status.json"),
      loadJson("./history.json").catch(() => ({ runs: [] })),
    ]);
    renderOverall(status);
    renderChecks(status);
    renderHistory(history);
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

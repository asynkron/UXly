(function () {
  "use strict";

  let analysisResult = null;

  const btnAnalyze = document.getElementById("btn-analyze");
  const btnExport = document.getElementById("btn-export");
  const btnClear = document.getElementById("btn-clear");
  const statusEl = document.getElementById("status");
  const tabs = document.querySelectorAll(".tab");
  const tabContents = document.querySelectorAll(".tab-content");

  // ─── Tabs ──────────────────────────────────────────────────

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tabContents.forEach((tc) => tc.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    });
  });

  // ─── Analyze ───────────────────────────────────────────────

  btnAnalyze.addEventListener("click", async () => {
    btnAnalyze.disabled = true;
    btnAnalyze.classList.add("analyzing");
    setStatus("Analyzing...", "");

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("No active tab found.");

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });

      if (!result) throw new Error("Analysis returned no data. The page might block content scripts.");

      analysisResult = result;
      renderAll(result);
      btnExport.disabled = false;
      btnClear.disabled = false;
      const fc = result.summary.findingCounts || {};
      setStatus(
        `${result.score}/100  \u2022  ${fc.error || 0}E ${fc.warn || 0}W ${fc.info || 0}I  \u2022  ${result.visualUnits.length} components`,
        result.score >= 80 ? "success" : ""
      );
    } catch (err) {
      setStatus("Error: " + err.message, "error");
    } finally {
      btnAnalyze.disabled = false;
      btnAnalyze.classList.remove("analyzing");
    }
  });

  // ─── Export ────────────────────────────────────────────────

  btnExport.addEventListener("click", () => {
    if (!analysisResult) return;
    const blob = new Blob([JSON.stringify(analysisResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uxly-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ─── Clear ─────────────────────────────────────────────────

  btnClear.addEventListener("click", async () => {
    analysisResult = null;
    btnExport.disabled = true;
    btnClear.disabled = true;
    document.getElementById("findings-content").innerHTML = '<div class="empty-state"><p>Analyze a page to inspect its UI consistency</p></div>';
    document.getElementById("consistency-content").innerHTML = '<div class="empty-state"><p>No data yet</p></div>';
    document.getElementById("components-content").innerHTML = '<div class="empty-state"><p>No data yet</p></div>';
    document.getElementById("json-content").textContent = "No data yet.";
    setStatus("", "");

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.querySelectorAll("[data-uxly-highlight]").forEach((el) => el.remove()),
        });
      }
    } catch (_) {}
  });

  // ─── Helpers ───────────────────────────────────────────────

  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function scoreRingSVG(score) {
    const r = 50;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - score / 100);
    const cls = score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
    return `
      <div class="score-ring-container">
        <div class="score-ring">
          <svg viewBox="0 0 120 120">
            <circle class="score-ring-bg" cx="60" cy="60" r="${r}"/>
            <circle class="score-ring-fill ${cls}" cx="60" cy="60" r="${r}"
              stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
          </svg>
          <div class="score-ring-value">
            <span class="score-number ${cls}">${score}</span>
            <span class="score-label">Score</span>
          </div>
        </div>
      </div>`;
  }

  // ─── Render Findings ──────────────────────────────────────

  function renderFindings(data) {
    const container = document.getElementById("findings-content");
    const findings = data.findings || [];

    if (findings.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No issues found \u2014 the page looks consistent</p></div>';
      return;
    }

    const counts = data.summary.findingCounts || { error: 0, warn: 0, info: 0 };

    let html = scoreRingSVG(data.score);

    html += `
      <div class="severity-counters">
        <div class="sev-counter">
          <div class="sev-counter-value error">${counts.error}</div>
          <div class="sev-counter-label">Errors</div>
        </div>
        <div class="sev-counter">
          <div class="sev-counter-value warn">${counts.warn}</div>
          <div class="sev-counter-label">Warnings</div>
        </div>
        <div class="sev-counter">
          <div class="sev-counter-value info">${counts.info}</div>
          <div class="sev-counter-label">Info</div>
        </div>
      </div>
    `;

    for (const f of findings) {
      html += `<div class="finding-card ${f.severity}">
        <div class="finding-header">
          <span class="finding-severity">${f.severity}</span>
          <span class="finding-category">${esc(f.category)}</span>
        </div>
        <div class="finding-message">${esc(f.message)}</div>
      </div>`;
    }

    container.innerHTML = html;
  }

  // ─── Render Consistency ────────────────────────────────────

  function renderConsistency(data) {
    const container = document.getElementById("consistency-content");

    if (Object.keys(data.consistency).length === 0) {
      container.innerHTML = '<div class="empty-state"><p>Not enough elements to compare</p></div>';
      return;
    }

    let html = "";

    for (const [role, group] of Object.entries(data.consistency)) {
      html += `<div class="consistency-group">`;
      html += `<div class="group-header">
        <span class="severity-dot ${group.severity}"></span>
        ${esc(role)}
        <span class="group-meta">${group.elementCount} el, ${group.inconsistentCount} issues</span>
      </div>`;

      for (const [prop, info] of Object.entries(group.properties)) {
        if (info.isConsistent) continue;

        html += `<div class="prop-group">`;
        html += `<div class="prop-name">${esc(prop)}</div>`;
        html += `<ul class="variant-list">`;
        for (const v of info.variants) {
          const isColor = prop.toLowerCase().includes("color");
          const swatch = isColor
            ? `<span class="color-swatch" style="background:${esc(v.value)}"></span>`
            : "";
          const isDominant = v.value === info.dominant;
          html += `<li class="variant-item">
            <span class="variant-count">${v.count}x</span>
            ${swatch}
            <span class="variant-value${isDominant ? "" : " outlier"}">${esc(v.value)}</span>
          </li>`;
        }
        html += `</ul></div>`;
      }

      html += `</div>`;
    }

    container.innerHTML = html;
  }

  // ─── Render Components ─────────────────────────────────────

  function renderComponents(data) {
    const container = document.getElementById("components-content");

    if (data.visualUnits.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No visual units detected</p></div>';
      return;
    }

    let html = "";

    for (let i = 0; i < data.visualUnits.length; i++) {
      const u = data.visualUnits[i];
      const hasChildren = u.children && u.children.length > 0;
      html += `<div class="component-item" data-index="${i}">
        <div class="component-type">${esc(u.type)}</div>
        <div class="component-selector">${esc(u.selector)}</div>
        <div class="component-details">${u.rect.width}\u00d7${u.rect.height}  \u2022  (${u.rect.left}, ${u.rect.top})</div>
        <div class="component-children">${u.memberCount} element${u.memberCount > 1 ? "s" : ""}${hasChildren ? ` \u2022 ${u.children.length} sub-component${u.children.length > 1 ? "s" : ""}` : ""}</div>
      </div>`;

      if (hasChildren) {
        html += `<div class="component-children-list">`;
        for (let ci = 0; ci < u.children.length; ci++) {
          const c = u.children[ci];
          html += `<div class="component-child" data-parent="${i}" data-child="${ci}">
            <span class="child-type">${esc(c.type)}</span>
            <span class="child-selector">${esc(c.selector)}</span>
            <span class="child-details">${c.rect.width}\u00d7${c.rect.height}</span>
          </div>`;
        }
        html += `</div>`;
      }
    }

    container.innerHTML = html;

    container.querySelectorAll(".component-item").forEach((item) => {
      item.addEventListener("click", () => {
        const idx = parseInt(item.dataset.index, 10);
        highlightComponent(data.visualUnits[idx]);
      });
    });

    container.querySelectorAll(".component-child").forEach((item) => {
      item.addEventListener("click", () => {
        const pi = parseInt(item.dataset.parent, 10);
        const ci = parseInt(item.dataset.child, 10);
        const child = data.visualUnits[pi].children[ci];
        highlightComponent(child);
      });
    });
  }

  // ─── Highlight on page ─────────────────────────────────────

  async function highlightComponent(unit) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (rect, label) => {
          document.querySelectorAll("[data-uxly-highlight]").forEach((el) => el.remove());

          const overlay = document.createElement("div");
          overlay.setAttribute("data-uxly-highlight", "true");
          overlay.style.cssText = `
            position: fixed;
            top: ${rect.top}px; left: ${rect.left}px;
            width: ${rect.width}px; height: ${rect.height}px;
            border: 2px solid #8b7cf0;
            background: rgba(139, 124, 240, 0.08);
            z-index: 2147483647;
            pointer-events: none;
            border-radius: 4px;
            box-shadow: 0 0 16px rgba(139, 124, 240, 0.2);
          `;

          const labelEl = document.createElement("div");
          labelEl.style.cssText = `
            position: absolute;
            top: -22px; left: 0;
            background: #8b7cf0;
            color: #fff;
            font-size: 10px;
            font-family: -apple-system, system-ui, sans-serif;
            padding: 2px 8px;
            border-radius: 4px;
            white-space: nowrap;
            font-weight: 700;
            letter-spacing: 0.02em;
          `;
          labelEl.textContent = label;
          overlay.appendChild(labelEl);
          document.body.appendChild(overlay);

          setTimeout(() => overlay.remove(), 3000);
        },
        args: [unit.rect, unit.type],
      });
    } catch (_) {}
  }

  // ─── Render JSON ───────────────────────────────────────────

  function renderJson(data) {
    document.getElementById("json-content").textContent = JSON.stringify(data, null, 2);
  }

  // ─── Render All ────────────────────────────────────────────

  function renderAll(data) {
    renderFindings(data);
    renderConsistency(data);
    renderComponents(data);
    renderJson(data);
  }
})();

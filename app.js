/* ---------- constants & state ---------- */
const REGION_LABEL = { north: "北部", central: "中部", south: "南部", east: "東部" };
const MONTH_NAMES = ["一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月"];
const UNIT = { rainfall: "mm", level: "m", discharge: "cms" };
const TYPE_LABEL = { rainfall: "雨量", level: "水位", discharge: "流量" };
const TYPE_COLOR_VAR = { rainfall: "--series-1", level: "--series-1", discharge: "--series-2" };

let state = {
  dataType: "rainfall",
  region: "all",
  stationId: null,
  mode: "query",
  gran: "day",
  mapgran: "day",
  mapmode: "single",
};

let lastQueryRows = null; // for CSV export
let lastCompareRows = null; // for CSV export
let queryChart = null;
let compareChart = null;

/* ---------- helpers ---------- */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function fmt(n, digits) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("zh-TW", { minimumFractionDigits: digits ?? 1, maximumFractionDigits: digits ?? 1 });
}
function pad2(n) { return String(n).padStart(2, "0"); }
function dateStr(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function dateRangeArray(start, end) {
  const out = [];
  let cur = new Date(start + "T00:00:00");
  const last = new Date(end + "T00:00:00");
  while (cur <= last) {
    out.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}-${pad2(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function allStations() {
  if (state.dataType === "rainfall") {
    return RAINFALL.map(s => ({ ...s, _series: "daily" }));
  }
  return RIVER
    .filter(s => (state.dataType === "level" ? Object.keys(s.level).length : Object.keys(s.discharge).length) > 0)
    .map(s => ({ ...s, _series: state.dataType }));
}

function filteredStations() {
  let list = allStations();
  if (state.region !== "all") list = list.filter(s => s.region === state.region);
  const q = document.getElementById("stationSearch").value.trim().toLowerCase();
  if (q) {
    list = list.filter(s => {
      const hay = [s.name_zh, s.name_en, s.code, s.basin_zh, s.tributary_zh].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  list.sort((a, b) => {
    const r = (a.region || "").localeCompare(b.region || "");
    if (r !== 0) return r;
    return (a.name_zh || "").localeCompare(b.name_zh || "", "zh-Hant");
  });
  return list;
}

function getStationById(id) {
  if (state.dataType === "rainfall") return RAINFALL.find(s => s.id === id);
  return RIVER.find(s => s.id === id);
}
function getSeries(station) {
  if (state.dataType === "rainfall") return station.daily;
  return station[state.dataType];
}

/* ---------- station list UI ---------- */
function renderStationOptions() {
  const list = filteredStations();
  const sel = document.getElementById("stationSelect");
  const prev = state.stationId;
  sel.innerHTML = "";
  let lastRegion = null;
  let group = null;
  list.forEach(s => {
    if (s.region !== lastRegion) {
      group = document.createElement("optgroup");
      group.label = REGION_LABEL[s.region] || s.region || "其他";
      sel.appendChild(group);
      lastRegion = s.region;
    }
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.name_zh || "(未知)"}（${s.code || "無代碼"}）`;
    (group || sel).appendChild(opt);
  });
  document.getElementById("stationCountLabel").textContent = list.length;
  if (list.length === 0) {
    state.stationId = null;
    document.getElementById("stationInfo").innerHTML = "";
    return;
  }
  const stillThere = list.some(s => s.id === prev);
  state.stationId = stillThere ? prev : list[0].id;
  sel.value = state.stationId;
  renderStationInfo();
}

function renderStationInfo() {
  const el = document.getElementById("stationInfo");
  const s = getStationById(state.stationId);
  if (!s) { el.innerHTML = ""; return; }
  const parts = [];
  parts.push(`<span><b>${s.name_zh || ""}</b> ${s.name_en || ""}</span>`);
  parts.push(`<span>代碼：${s.code || "無"}</span>`);
  parts.push(`<span>區域：${REGION_LABEL[s.region] || "未知"}</span>`);
  if (s.basin_zh) parts.push(`<span>流域：${s.basin_zh}</span>`);
  if (s.tributary_zh && s.tributary_zh !== s.basin_zh) parts.push(`<span>河流：${s.tributary_zh}</span>`);
  if (s.years) parts.push(`<span>資料年份：${s.years.map(y => `<span class="badge">${y}</span>`).join(" ")}</span>`);
  if (state.dataType !== "rainfall") {
    const flags = [];
    if (Object.keys(s.level).length) flags.push(`<span class="badge">有水位資料</span>`);
    if (Object.keys(s.discharge).length) flags.push(`<span class="badge">有流量資料</span>`);
    parts.push(flags.join(" "));
  }
  el.innerHTML = parts.join("");
}

/* ---------- aggregation ---------- */
function aggregate(series, dates) {
  const vals = [];
  let sum = 0, max = -Infinity, maxDate = null, min = Infinity, minDate = null;
  dates.forEach(d => {
    const v = series[d];
    if (v === undefined || v === null) return;
    vals.push(v);
    sum += v;
    if (v > max) { max = v; maxDate = d; }
    if (v < min) { min = v; minDate = d; }
  });
  const count = vals.length;
  const avg = count ? sum / count : null;
  const rainDays = state.dataType === "rainfall" ? vals.filter(v => v >= 0.1).length : null;
  return {
    count, sum: count ? sum : null, avg,
    max: count ? max : null, maxDate,
    min: count ? min : null, minDate,
    rainDays,
    totalDays: dates.length,
  };
}

/* ---------- gran inputs ---------- */
function renderGranInputs() {
  const el = document.getElementById("granInputs");
  if (state.gran === "day") {
    el.innerHTML = `<label class="field">選擇日期
      <input type="date" id="qDate" min="2023-01-01" max="2024-12-31" value="2024-01-01">
    </label>`;
  } else if (state.gran === "month") {
    el.innerHTML = `<label class="field">選擇年份
      <select id="qYear"><option value="2024">2024</option><option value="2023">2023</option></select>
    </label>
    <label class="field">選擇月份
      <select id="qMonth">${MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select>
    </label>`;
  } else {
    el.innerHTML = `<label class="field">開始日期
      <input type="date" id="qStart" min="2023-01-01" max="2024-12-31" value="2024-01-01">
    </label>
    <label class="field">結束日期
      <input type="date" id="qEnd" min="2023-01-01" max="2024-12-31" value="2024-01-31">
    </label>
    <label class="field">颱風快選<select class="typhoon-pick" data-start="qStart" data-end="qEnd"><option value="">不套用</option></select></label>`;
  }
  populateTyphoonSelects();
}

function currentQueryDates() {
  if (state.gran === "day") {
    const d = document.getElementById("qDate").value;
    return d ? [d] : [];
  }
  if (state.gran === "month") {
    const y = parseInt(document.getElementById("qYear").value, 10);
    const m = parseInt(document.getElementById("qMonth").value, 10);
    const n = daysInMonth(y, m);
    return Array.from({ length: n }, (_, i) => dateStr(y, m, i + 1));
  }
  const s = document.getElementById("qStart").value;
  const e = document.getElementById("qEnd").value;
  if (!s || !e || s > e) return [];
  return dateRangeArray(s, e);
}

/* ---------- rendering: stats tiles ---------- */
function statsTilesHtml(stats) {
  const unit = UNIT[state.dataType];
  const tiles = [];
  if (state.dataType === "rainfall") {
    tiles.push(["總雨量", stats.sum !== null ? `${fmt(stats.sum)} ${unit}` : "—"]);
    tiles.push(["平均日雨量", stats.avg !== null ? `${fmt(stats.avg)} ${unit}` : "—", `${stats.count} 天有資料`]);
    tiles.push(["最大日雨量", stats.max !== null ? `${fmt(stats.max)} ${unit}` : "—", stats.maxDate || ""]);
    tiles.push(["降雨天數", stats.rainDays !== null ? `${stats.rainDays} 天` : "—", `共 ${stats.totalDays} 天`]);
  } else {
    tiles.push(["平均值", stats.avg !== null ? `${fmt(stats.avg, 2)} ${unit}` : "—", `${stats.count}/${stats.totalDays} 天有資料`]);
    tiles.push(["最大值", stats.max !== null ? `${fmt(stats.max, 2)} ${unit}` : "—", stats.maxDate || ""]);
    tiles.push(["最小值", stats.min !== null ? `${fmt(stats.min, 2)} ${unit}` : "—", stats.minDate || ""]);
    tiles.push(["資料完整度", stats.totalDays ? `${Math.round((stats.count / stats.totalDays) * 100)}%` : "—", ""]);
  }
  return `<div class="stats-grid">${tiles.map(([k, v, sub]) => `
    <div class="stat-tile"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
  `).join("")}</div>`;
}

/* ---------- query mode ---------- */
function runQuery() {
  const station = getStationById(state.stationId);
  const resultEl = document.getElementById("queryResult");
  if (!station) { resultEl.innerHTML = `<p class="empty-note">請先選擇測站</p>`; return; }
  const series = getSeries(station);
  const dates = currentQueryDates();
  if (dates.length === 0) { resultEl.innerHTML = `<p class="empty-note">請輸入有效的日期範圍</p>`; return; }
  const stats = aggregate(series, dates);
  lastQueryRows = dates.map(d => [d, series[d] !== undefined && series[d] !== null ? series[d] : ""]);

  const color = cssVar(TYPE_COLOR_VAR[state.dataType]);
  const chartType = state.dataType === "rainfall" ? "bar" : "line";

  resultEl.innerHTML = `
    <div class="legend-row"><span><span class="swatch" style="background:${color}"></span>${station.name_zh} — ${TYPE_LABEL[state.dataType]}（${UNIT[state.dataType]}）</span></div>
    ${statsTilesHtml(stats)}
    <div class="chart-wrap"><canvas id="queryCanvas"></canvas></div>
    <details class="table-details"><summary>顯示每日資料表格（${dates.length} 筆）</summary>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>日期</th><th>${TYPE_LABEL[state.dataType]} (${UNIT[state.dataType]})</th></tr></thead>
        <tbody>${lastQueryRows.map(([d, v]) => `<tr><td>${d}</td><td>${v === "" ? "—" : fmt(v, state.dataType === "rainfall" ? 1 : 2)}</td></tr>`).join("")}</tbody>
      </table></div>
    </details>
  `;

  if (queryChart) queryChart.destroy();
  const ctx = document.getElementById("queryCanvas").getContext("2d");
  queryChart = new Chart(ctx, {
    type: chartType,
    data: {
      labels: dates,
      datasets: [{
        label: `${TYPE_LABEL[state.dataType]} (${UNIT[state.dataType]})`,
        data: dates.map(d => (series[d] !== undefined ? series[d] : null)),
        borderColor: color,
        backgroundColor: chartType === "bar" ? color : "transparent",
        pointRadius: dates.length > 60 ? 0 : 2,
        borderWidth: 2,
        spanGaps: false,
        tension: 0.15,
      }]
    },
    options: chartOptions(dates.length, state.dataType === "rainfall")
  });
}

function chartOptions(n, beginAtZero) {
  const grid = cssVar("--gridline");
  const muted = cssVar("--text-muted");
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { mode: "index", intersect: false },
    },
    scales: {
      x: {
        grid: { color: grid },
        ticks: { color: muted, maxTicksLimit: n > 40 ? 12 : n, autoSkip: true },
      },
      y: {
        grid: { color: grid },
        ticks: { color: muted },
        beginAtZero: !!beginAtZero,
      }
    }
  };
}

/* ---------- compare mode ---------- */
function runCompare() {
  const station = getStationById(state.stationId);
  const resultEl = document.getElementById("compareResult");
  if (!station) { resultEl.innerHTML = `<p class="empty-note">請先選擇測站</p>`; return; }
  const series = getSeries(station);
  const aS = document.getElementById("aStart").value, aE = document.getElementById("aEnd").value;
  const bS = document.getElementById("bStart").value, bE = document.getElementById("bEnd").value;
  if (!aS || !aE || aS > aE || !bS || !bE || bS > bE) {
    resultEl.innerHTML = `<p class="empty-note">請確認期間 A、B 的日期範圍正確</p>`;
    return;
  }
  const datesA = dateRangeArray(aS, aE);
  const datesB = dateRangeArray(bS, bE);
  const statsA = aggregate(series, datesA);
  const statsB = aggregate(series, datesB);

  const nRows = Math.max(datesA.length, datesB.length);
  lastCompareRows = [];
  for (let i = 0; i < nRows; i++) {
    const dA = datesA[i], dB = datesB[i];
    const vA = dA !== undefined ? series[dA] : undefined;
    const vB = dB !== undefined ? series[dB] : undefined;
    lastCompareRows.push([i + 1, dA || "", vA !== undefined && vA !== null ? vA : "", dB || "", vB !== undefined && vB !== null ? vB : ""]);
  }

  const colorA = cssVar("--series-a");
  const colorB = cssVar("--series-b");
  const unit = UNIT[state.dataType];

  const metric = state.dataType === "rainfall" ? "sum" : "avg";
  const metricLabel = state.dataType === "rainfall" ? "總雨量" : "平均值";
  const delta = (statsA[metric] ?? 0) - (statsB[metric] ?? 0);
  const deltaClass = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
  const sign = delta > 0 ? "+" : "";

  function colCard(label, s, color, range) {
    return `<div class="compare-col">
      <h3><span class="swatch" style="background:${color}"></span>${label}</h3>
      <div class="badge">${range}</div>
      ${statsTilesHtml(s)}
    </div>`;
  }

  resultEl.innerHTML = `
    <div class="compare-cols">
      ${colCard("期間 A", statsA, colorA, `${aS} ~ ${aE}（${datesA.length} 天）`)}
      ${colCard("期間 B", statsB, colorB, `${bS} ~ ${bE}（${datesB.length} 天）`)}
      <div class="compare-col">
        <h3>差異 A − B</h3>
        <div class="badge">依「${metricLabel}」計算</div>
        <div class="stats-grid">
          <div class="stat-tile">
            <div class="k">${metricLabel}差異</div>
            <div class="v ${deltaClass}">${sign}${fmt(delta, state.dataType === "rainfall" ? 1 : 2)} ${unit}</div>
            <div class="sub">${statsA[metric] !== null && statsB[metric] !== null ? `${fmt(statsA[metric], 1)} − ${fmt(statsB[metric], 1)}` : "資料不足"}</div>
          </div>
          <div class="stat-tile">
            <div class="k">最大值差異</div>
            <div class="v">${statsA.max !== null && statsB.max !== null ? fmt(statsA.max - statsB.max, state.dataType === "rainfall" ? 1 : 2) + " " + unit : "—"}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="legend-row">
      <span><span class="swatch" style="background:${colorA}"></span>期間 A（依天數序，第 1 天起）</span>
      <span><span class="swatch" style="background:${colorB}"></span>期間 B（依天數序，第 1 天起）</span>
    </div>
    <div class="chart-wrap"><canvas id="compareCanvas"></canvas></div>
    <details class="table-details"><summary>顯示逐日對照表格</summary>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>第幾天</th><th>期間A日期</th><th>A值</th><th>期間B日期</th><th>B值</th></tr></thead>
        <tbody>${renderCompareRows(datesA, datesB, series)}</tbody>
      </table></div>
    </details>
  `;

  const n = Math.max(datesA.length, datesB.length);
  const idxLabels = Array.from({ length: n }, (_, i) => `第 ${i + 1} 天`);
  const dataA = idxLabels.map((_, i) => (i < datesA.length ? (series[datesA[i]] ?? null) : null));
  const dataB = idxLabels.map((_, i) => (i < datesB.length ? (series[datesB[i]] ?? null) : null));

  if (compareChart) compareChart.destroy();
  const ctx = document.getElementById("compareCanvas").getContext("2d");
  compareChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: idxLabels,
      datasets: [
        { label: "期間 A", data: dataA, borderColor: colorA, backgroundColor: "transparent", pointRadius: n > 60 ? 0 : 2, borderWidth: 2, spanGaps: false, tension: 0.15 },
        { label: "期間 B", data: dataB, borderColor: colorB, backgroundColor: "transparent", pointRadius: n > 60 ? 0 : 2, borderWidth: 2, spanGaps: false, tension: 0.15 },
      ]
    },
    options: chartOptions(n, state.dataType === "rainfall")
  });
}

function renderCompareRows(datesA, datesB, series) {
  const n = Math.max(datesA.length, datesB.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const dA = datesA[i], dB = datesB[i];
    const vA = dA !== undefined ? series[dA] : undefined;
    const vB = dB !== undefined ? series[dB] : undefined;
    rows.push(`<tr>
      <td>${i + 1}</td>
      <td>${dA || "—"}</td><td>${vA !== undefined && vA !== null ? fmt(vA, state.dataType === "rainfall" ? 1 : 2) : "—"}</td>
      <td>${dB || "—"}</td><td>${vB !== undefined && vB !== null ? fmt(vB, state.dataType === "rainfall" ? 1 : 2) : "—"}</td>
    </tr>`);
  }
  return rows.join("");
}

/* ---------- CSV export ---------- */
function downloadCsv(filename, rows) {
  // rows: array of arrays (first row = header)
  const body = rows.map(r => r.map(v => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  if (!lastQueryRows || !lastQueryRows.length) { alert("請先執行查詢"); return; }
  const station = getStationById(state.stationId);
  const header = ["date", `${state.dataType}_${UNIT[state.dataType]}`];
  downloadCsv(`${station.name_zh}_${state.dataType}_${Date.now()}.csv`, [header, ...lastQueryRows]);
}

function exportCompareCsv() {
  if (!lastCompareRows || !lastCompareRows.length) { alert("請先執行比較"); return; }
  const station = getStationById(state.stationId);
  const header = ["day_index", "dateA", "valueA", "dateB", "valueB"];
  downloadCsv(`${station.name_zh}_${state.dataType}_比較_${Date.now()}.csv`, [header, ...lastCompareRows]);
}

/* ---------- typhoon quick-pick ---------- */
function populateTyphoonSelects() {
  document.querySelectorAll("select.typhoon-pick").forEach(sel => {
    if (sel.dataset.populated) return;
    sel.dataset.populated = "1";
    TYPHOON_PERIODS.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${t.start.slice(0, 4)} ${t.name_zh}(${t.name_en}) ${t.start}~${t.end}`;
      sel.appendChild(opt);
    });
  });
}

/* ---------- event wiring ---------- */
function setSeg(segId, key, onChange) {
  document.getElementById(segId).addEventListener("click", e => {
    const btn = e.target.closest("button[data-" + key + "]");
    if (!btn) return;
    document.querySelectorAll(`#${segId} button`).forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state[key === "type" ? "dataType" : key] = btn.dataset[key];
    onChange && onChange();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("rainCount").textContent = RAINFALL.length;
  document.getElementById("riverCount").textContent = RIVER.length;

  setSeg("dataTypeSeg", "type", () => { renderStationOptions(); });
  setSeg("regionSeg", "region", () => { renderStationOptions(); });
  setSeg("modeSeg", "mode", () => {
    document.getElementById("queryPanel").style.display = state.mode === "query" ? "" : "none";
    document.getElementById("comparePanel").style.display = state.mode === "compare" ? "" : "none";
    document.getElementById("mapPanel").style.display = state.mode === "map" ? "" : "none";
    if (state.mode === "map") {
      const map = ensureMap();
      renderMapGranInputs();
      setTimeout(() => { map.invalidateSize(); }, 0);
    }
  });
  setSeg("granSeg", "gran", () => { renderGranInputs(); });
  setSeg("mapGranSeg", "mapgran", () => { renderMapGranInputs(); });
  setSeg("mapModeSeg", "mapmode", () => {
    document.getElementById("mapSingleInputs").style.display = state.mapmode === "single" ? "" : "none";
    document.getElementById("mapDiffInputs").style.display = state.mapmode === "diff" ? "" : "none";
  });

  document.addEventListener("change", e => {
    if (e.target.matches("select.typhoon-pick")) {
      const idx = e.target.value;
      if (idx === "") return;
      const t = TYPHOON_PERIODS[idx];
      const startEl = document.getElementById(e.target.dataset.start);
      const endEl = document.getElementById(e.target.dataset.end);
      if (startEl) startEl.value = t.start;
      if (endEl) endEl.value = t.end;
    }
  });
  populateTyphoonSelects();

  document.getElementById("stationSearch").addEventListener("input", renderStationOptions);
  document.getElementById("stationSelect").addEventListener("change", e => {
    state.stationId = e.target.value;
    renderStationInfo();
  });

  document.getElementById("queryBtn").addEventListener("click", runQuery);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
  document.getElementById("compareBtn").addEventListener("click", runCompare);
  document.getElementById("exportCompareCsvBtn").addEventListener("click", exportCompareCsv);
  document.getElementById("mapQueryBtn").addEventListener("click", () => {
    if (state.mapmode === "diff") runMapDiffQuery(); else runMapQuery();
  });
  document.getElementById("exportMapCsvBtn").addEventListener("click", exportMapCsv);

  document.getElementById("themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
  });

  renderGranInputs();
  renderStationOptions();
  runQuery();
});

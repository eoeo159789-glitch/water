/* ---------- typhoon-event rainfall map (中央氣象署颱風資料庫 1958–2026) ----------
   Data files are lazy-loaded so the page opens as fast as before:
     typhoon_meta.js                    stations, typhoon list, per-station event statistics
     typhoon_hourly/ty_hourly_<YYYY>.js sparse hourly rainfall, one file per year
   All stored rainfall values are integers in 0.1 mm. */

const TY_STATS = [
  { key: "total",  label: "事件總雨量",                 short: "事件總雨量",   col: 1, tcol: -1 },
  { key: "warn",   label: "警報期間累積雨量",           short: "警報期間累積", col: 7, tcol: -1 },
  { key: "m1",     label: "最大 1 小時雨量",            short: "最大1小時",    col: 2, tcol: 9 },
  { key: "m3",     label: "最大 3 小時累積雨量",        short: "最大3小時",    col: 3, tcol: 10 },
  { key: "m6",     label: "最大 6 小時累積雨量",        short: "最大6小時",    col: 4, tcol: 11 },
  { key: "m12",    label: "最大 12 小時累積雨量",       short: "最大12小時",   col: 5, tcol: 12 },
  { key: "m24",    label: "最大 24 小時累積雨量",       short: "最大24小時",   col: 6, tcol: 13 },
  { key: "hourly", label: "指定時段累積（逐時，可播放）", short: "時段累積" },
];
const TY_CLS = ["—", "大雨", "豪雨", "大豪雨", "超大豪雨"];
const TY_WIN_OPTS = [[0, "自事件開始累積"], [1, "1 小時"], [3, "3 小時"], [6, "6 小時"], [12, "12 小時"], [24, "24 小時"], [48, "48 小時"]];

const tyState = { id: null, stat: "total", cmp: "", winLen: 0, endIdx: null, zeroFill: true, radius: "auto", scale: "auto", step: "1", si: null };

// Typhoon event totals often reach 1,000–2,000+ mm, far past the standard daily scale's open-ended
// ">=300" bin. This extension keeps the CWA bins up to 300 mm and continues in steps above it.
const TY_EXT_BINS = CWA_RAIN_BINS.slice(0, -1).concat([
  { min: 300,  max: 400,      color: [255, 206, 255] },
  { min: 400,  max: 500,      color: [232, 170, 242] },
  { min: 500,  max: 600,      color: [204, 138, 230] },
  { min: 600,  max: 800,      color: [170, 104, 216] },
  { min: 800,  max: 1000,     color: [135, 74, 196] },
  { min: 1000, max: 1200,     color: [104, 54, 170] },
  { min: 1200, max: 1500,     color: [78, 40, 140] },
  { min: 1500, max: 2000,     color: [52, 28, 108] },
  { min: 2000, max: Infinity, color: [28, 16, 66] },
]);
let tyUseExt = false;
// hooked into map.js activeRainBins(): only affects the typhoon sub-mode, and a user-defined
// scale from the color-scale editor still takes precedence
function tyActiveBins() {
  if (state.mode !== "map" || state.mapmode !== "typhoon") return null;
  // while an official CWA map is shown, "auto" uses that map's own classes & colours for a 1:1 comparison
  if (tyState.scale === "auto" && typeof tyOff !== "undefined" && tyOff.overlay && tyOff.entry) return tyOfficialBins();
  if (tyState.scale === "std") return null;
  if (tyState.scale === "ext" || tyUseExt) return TY_EXT_BINS;
  return null;
}
// reference maximum for the "auto" scale: stable for a typhoon/statistic so it does not flip mid-animation
function tyRefMax(t) {
  const colByLen = { 1: 2, 3: 3, 6: 4, 12: 5, 24: 6 };
  let col = 1;
  if (tyState.stat === "hourly") col = colByLen[tyState.winLen] || 1;
  else if (tyState.stat !== "total" && tyState.stat !== "warn") col = tyStatDef(tyState.stat).col;
  let m = 0;
  for (const r of CWA_TY_STATS[t.id] || []) if (r[col] > m) m = r[col];
  return m / 10;
}
const tyPrepCache = {};
let tyIndex = null;              // id -> typhoon
let tyControlsReady = false;
let tyPlayTimer = null;
let tyChart = null;
let tyStationRefLayer = null;    // reference overlay: all CWA rain-gauge locations
let tyMarkers = new Map();       // stIdx -> circleMarker on the current typhoon map
let tyLastExport = null;
let tyRenderSeq = 0;
let tyLastPts = null;

/* ---------- loading ---------- */
function loadScriptOnce(src) {
  loadScriptOnce.cache = loadScriptOnce.cache || {};
  if (!loadScriptOnce.cache[src]) {
    loadScriptOnce.cache[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { delete loadScriptOnce.cache[src]; reject(new Error("無法載入資料檔 " + src + "（請確認 typhoon 相關檔案與網頁放在同一資料夾）")); };
      document.head.appendChild(s);
    });
  }
  return loadScriptOnce.cache[src];
}

async function ensureTyphoonMeta() {
  if (typeof CWA_TYPHOONS === "undefined") await loadScriptOnce("typhoon_meta.js");
  if (!tyIndex) {
    tyIndex = {};
    CWA_TYPHOONS.forEach(t => { tyIndex[t.id] = t; });
  }
  await tyLoadMapIndex();
  tyAddStationRefLayer();
}
function tyById(id) { return tyIndex ? tyIndex[id] : null; }

async function ensureTyHourly(t) {
  if (!(window.CWA_HOURLY && window.CWA_HOURLY[t.id])) {
    await loadScriptOnce(`typhoon_hourly/ty_hourly_${t.y}.js`);
  }
  return tyPrepared(t);
}

// dense cumulative arrays per station: cum[i] = rainfall of hours [0, i)
function tyPrepared(t) {
  if (tyPrepCache[t.id]) return tyPrepCache[t.id];
  const H = window.CWA_HOURLY[t.id];
  const n = t.n;
  const cum = new Map();
  H.si.forEach((si, k) => {
    const dense = new Float64Array(n);
    const d = H.d[k];
    for (let j = 0; j < d.length; j += 2) dense[d[j]] = d[j + 1] / 10;
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + dense[i];
    cum.set(si, c);
  });
  const rowBySi = new Map((CWA_TY_STATS[t.id] || []).map(r => [r[0], r]));
  return (tyPrepCache[t.id] = { cum, rowBySi });
}

/* ---------- time helpers (UTC arithmetic avoids historical DST shifts in the viewer's time zone) ---------- */
function tyHourDate(t, idx) {
  const d = new Date(t.t0.replace(" ", "T") + ":00Z");
  d.setUTCHours(d.getUTCHours() + idx);
  return d;
}
function tyFmtHour(t, idx, withYear) {
  if (idx === undefined || idx === null || idx < 0) return "—";
  const d = tyHourDate(t, idx);
  const s = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:00`;
  return withYear ? `${d.getUTCFullYear()}-${s}` : s;
}
function tyWindow(t) {
  const end = Math.max(0, Math.min(t.n - 1, tyState.endIdx ?? t.n - 1));
  const L = tyState.winLen;
  const start = L === 0 ? 0 : Math.max(0, end - L + 1);
  return { start, end };
}
function tyWindowLabel(t) {
  const { start, end } = tyWindow(t);
  // hour "start" ends at tyFmtHour(start); it begins one hour earlier
  const begin = new Date(tyHourDate(t, start).getTime() - 3600e3);
  const b = `${pad2(begin.getUTCMonth() + 1)}-${pad2(begin.getUTCDate())} ${pad2(begin.getUTCHours())}:00`;
  return `${b} ～ ${tyFmtHour(t, end)}（${end - start + 1} 小時）`;
}

/* ---------- values ---------- */
function tyStatDef(key) { return TY_STATS.find(s => s.key === key); }
function tyHasWarn(t) { return (CWA_TY_STATS[t.id] || []).some(r => r[7] >= 0); }

function tyValues(t, statKey) {
  const out = new Map();
  const listed = new Set((CWA_TY_STATS[t.id] || []).map(r => r[0])); // stations with rain records this typhoon
  let statMissing = 0; // listed stations whose value for this statistic the database does not provide
  if (statKey === "hourly") {
    const prep = tyPrepared(t);
    const { start, end } = tyWindow(t);
    for (const [si, c] of prep.cum) out.set(si, { v: c[end + 1] - c[start], row: prep.rowBySi.get(si) });
  } else {
    const def = tyStatDef(statKey);
    for (const r of CWA_TY_STATS[t.id] || []) {
      if (r[def.col] < 0) { statMissing++; continue; }
      out.set(r[0], { v: r[def.col] / 10, row: r });
    }
    if (out.size === 0) return { vals: out, missingStat: true, zeroCount: 0, statMissing };
  }
  // the database only lists hours with >= 0.1 mm, so a station operating during the typhoon
  // with no rain at all is absent; stations with records both before and after this year are
  // treated as operating (0 mm) so the interpolation tapers correctly at the rain-area edges
  let zeroCount = 0;
  if (tyState.zeroFill) {
    CWA_STATIONS.forEach((s, si) => {
      if (out.has(si) || listed.has(si) || !s[7]) return; // never zero-fill a station that did record rain
      if (s[7] <= t.y && t.y <= s[8]) { out.set(si, { v: 0, row: null, zero: true }); zeroCount++; }
    });
  }
  return { vals: out, zeroCount, statMissing };
}

function tyRadiusKm(nMain) {
  if (tyState.radius !== "auto") return parseFloat(tyState.radius);
  if (nMain >= 300) return 22;   // same as the WRA yearbook map
  if (nMain >= 150) return 28;
  if (nMain >= 60) return 40;
  return 60;                     // 1950s–80s: only a few dozen manned stations
}

/* ---------- map rendering ---------- */
async function runTyphoonMap(opts) {
  opts = opts || {};
  const seq = ++tyRenderSeq;
  const statusEl = document.getElementById("mapStatus");
  const map = ensureMap();
  try {
    await ensureTyphoonMeta();
  } catch (e) { statusEl.textContent = e.message; return; }
  if (!tyControlsReady) tyInitControls();
  const t = tyById(tyState.id);
  if (!t) { statusEl.textContent = "請選擇颱風"; return; }
  const cmpT = tyState.cmp ? tyById(tyState.cmp) : null;
  const def = tyStatDef(tyState.stat);

  if (tyState.stat === "hourly") {
    if (cmpT) {
      clearMapLayers();
      statusEl.textContent = "「指定時段累積」無法與對照颱風相減（兩場颱風時間軸不同），請改選固定統計量，或將對照颱風設為「不比較」";
      tyRenderSummary(null);
      return;
    }
    if (!opts.frame) statusEl.textContent = "載入逐時資料中…";
    try { await ensureTyHourly(t); } catch (e) { statusEl.textContent = e.message; return; }
    if (seq !== tyRenderSeq) return; // superseded by a newer request
  }

  const A = tyValues(t, tyState.stat);
  const B = cmpT ? tyValues(cmpT, tyState.stat) : null;
  if (A.missingStat || (B && B.missingStat)) {
    clearMapLayers();
    const who = A.missingStat ? `${t.zh}` : `${cmpT.zh}`;
    statusEl.textContent = `颱風資料庫未提供「${who}」的${def.label}，請改選其他統計量`;
    tyRenderSummary(null);
    return;
  }

  const pts = [];
  for (const [si, a] of A.vals) {
    const s = CWA_STATIONS[si];
    const base = { si, lat: s[6], lon: s[5], name: s[1], code: s[0], county: s[4], outer: s[3] === "外島" };
    if (B) {
      const b = B.vals.get(si);
      if (!b) continue;
      pts.push({ ...base, value: a.v - b.v, valueA: a.v, valueB: b.v, zero: !!(a.zero && b.zero), row: a.row });
    } else {
      pts.push({ ...base, value: a.v, zero: !!a.zero, row: a.row });
    }
  }
  if (pts.length === 0) {
    clearMapLayers();
    statusEl.textContent = B ? "兩場颱風沒有共同測站，無法相減" : "此颱風沒有可用的測站資料";
    tyRenderSummary(null);
    return;
  }
  const ipts = pts.filter(p => !p.outer);
  const radius = tyRadiusKm(ipts.length);
  const diverging = B ? { maxAbs: Math.max(1, ...pts.map(p => Math.abs(p.value))) } : null;
  const unitTitle = B
    ? `${def.short}差 A－B (mm)`
    : (tyState.stat === "hourly" ? `${tyState.winLen === 0 ? "事件開始至今累積" : tyState.winLen + " 小時累積"} (mm)` : `${def.short} (mm)`);

  tyUseExt = !B && tyRefMax(t) > 350;
  const fastFrame = opts.frame && mapImageOverlay && tyMarkers.size > 0 && !B;
  const { dataUrl, bounds } = renderRainfallHeatmap(ipts, diverging, { maxDistKm: radius, width: opts.frame ? 360 : undefined });
  if (seq !== tyRenderSeq) return;

  if (fastFrame) {
    mapImageOverlay.setUrl(dataUrl);
    pts.forEach(p => { const m = tyMarkers.get(p.si); if (m) m.setTooltipContent(tyTooltip(p, t, cmpT, def)); });
    lastHeatmapPoints = ipts;
  } else {
    clearMapLayers();
    lastHeatmapPoints = ipts;
    lastHeatmapDiverging = diverging;
    lastHeatmapOpts = { maxDistKm: radius };
    mapImageOverlay = L.imageOverlay(dataUrl, bounds, { opacity: HEATMAP_OPACITY }).addTo(map);
    mapMarkersLayer = L.featureGroup();
    pts.forEach(p => {
      const m = L.circleMarker([p.lat, p.lon], tyMarkerStyle(p, p.si === tyState.si))
        .bindTooltip(tyTooltip(p, t, cmpT, def));
      m.on("click", () => tySelectStation(p.si));
      tyMarkers.set(p.si, m);
      mapMarkersLayer.addLayer(m);
    });
    addDotsLayer(mapMarkersLayer);
    if (B) addDivergingRainLegend(unitTitle, diverging.maxAbs); else addRainLegend(unitTitle);
  }
  lastHeatmapOpts = { maxDistKm: radius };

  const nOuter = pts.length - ipts.length;
  const zeroN = B ? pts.filter(p => p.zero).length : A.zeroCount;
  const sparse = ipts.length < 60 ? "；早年測站稀少，雨量圖為粗略推估" : "";
  statusEl.textContent = `${B ? "兩場共同測站" : "參與內插"} ${ipts.length} 站` +
    (zeroN ? `（含推定 0 mm ${zeroN} 站）` : "") +
    (nOuter ? `，外島 ${nOuter} 站僅標示` : "") +
    `；內插半徑 ${radius} km${sparse}` +
    (A.statMissing ? `；${A.statMissing} 站資料庫未提供此統計值，已排除` : "");

  tyLastPts = pts;
  tyRenderSummary({ t, cmpT, def, pts, zeroCount: A.zeroCount });
  tyBuildExport(t, cmpT, def, pts);
  if (!opts.frame && tyState.si !== null && tyState.si !== undefined) tyRenderDetail(tyState.si);
  tyOfficialAfterRender();
}

function tyMarkerStyle(p, selected) {
  if (selected) return { radius: 6, color: "#e34948", weight: 2.5, opacity: 1, fillColor: "#fff", fillOpacity: 1 };
  // small, thin dots: up to ~1,000 gauges must not hide the rainfall raster underneath
  return { radius: p.zero ? 1.6 : 2.3, color: p.zero ? "#8a8a8a" : "#333", weight: 0.8, opacity: STATION_OPACITY, fillColor: "#fff", fillOpacity: STATION_OPACITY };
}

function tyTooltip(p, t, cmpT, def) {
  const head = `${p.name}（${p.code}，${p.county}）`;
  if (cmpT) return `${head}：${p.value > 0 ? "+" : ""}${fmt(p.value, 1)} mm（A ${t.zh}: ${fmt(p.valueA, 1)}，B ${cmpT.zh}: ${fmt(p.valueB, 1)}）`;
  if (p.zero) return `${head}：推定 0 mm（資料庫未列此站）`;
  let s = `${head}：${fmt(p.value, 1)} mm`;
  if (def.tcol > 0 && p.row && p.row[def.tcol] >= 0) s += `（${tyFmtHour(t, p.row[def.tcol])} 止）`;
  return s;
}

/* ---------- summary panel (typhoon facts + top-10 stations for the current statistic) ---------- */
function tyRenderSummary(ctx) {
  const el = document.getElementById("tySummary");
  if (!el) return;
  if (!ctx) { el.innerHTML = ""; return; }
  const { t, cmpT, def, pts, zeroCount } = ctx;
  const tiles = [
    ["颱風", `${t.y} ${t.zh}`, `${t.en}${cmpT ? `｜對照 B：${cmpT.y} ${cmpT.zh}` : ""}`],
    ["逐時資料期間", `${tyFmtHour(t, 0)} ～ ${tyFmtHour(t, t.n - 1)}`, `${t.n} 小時（時間為該小時結束）`],
    ["警報期間", t.ws ? `${t.ws.slice(5)} ～ ${t.we.slice(5)}` : "資料庫未提供", t.wh ? `${t.wh} 小時` : ""],
    ["有雨量紀錄測站", `${t.ns} 站`, zeroCount ? `另推定 0 mm ${zeroCount} 站` : ""],
    ["雨量分級站數", `${t.cls.join("／")}`, "大雨／豪雨／大豪雨／超大豪雨"],
  ];
  const sorted = pts.filter(p => !p.zero || cmpT).slice().sort((a, b) => cmpT ? Math.abs(b.value) - Math.abs(a.value) : b.value - a.value).slice(0, 10);
  const timeCol = !cmpT && def.tcol > 0;
  const title = cmpT
    ? `${def.label}差異最大的 10 站（A ${t.zh} − B ${cmpT.zh}）`
    : (tyState.stat === "hourly" ? `時段累積雨量前 10 站：${tyWindowLabel(t)}` : `${def.label}前 10 站`);
  el.innerHTML = `
    <div class="stats-grid">${tiles.map(([k, v, sub]) => `<div class="stat-tile"><div class="k">${k}</div><div class="v ty-v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`).join("")}</div>
    <h3 class="ty-h3">${title}<span class="ty-hint">點選列可查看該站逐時雨量</span></h3>
    <div class="table-scroll"><table class="data-table ty-table">
      <thead><tr><th class="num">排名</th><th>測站</th><th>縣市</th>${cmpT ? `<th class="num">A (mm)</th><th class="num">B (mm)</th><th class="num">A−B (mm)</th>` : `<th class="num">雨量 (mm)</th>`}${timeCol ? "<th>發生時段止</th>" : ""}${cmpT ? "" : "<th>分級</th>"}</tr></thead>
      <tbody>${sorted.map((p, i) => `<tr class="ty-row${p.si === tyState.si ? " ty-hl" : ""}" data-si="${p.si}">
        <td class="num">${i + 1}</td><td>${p.name}（${p.code}）</td><td>${p.county}</td>
        ${cmpT ? `<td class="num">${fmt(p.valueA, 1)}</td><td class="num">${fmt(p.valueB, 1)}</td><td class="num ${p.value > 0 ? "delta-up" : p.value < 0 ? "delta-down" : ""}">${p.value > 0 ? "+" : ""}${fmt(p.value, 1)}</td>` : `<td class="num">${fmt(p.value, 1)}</td>`}
        ${timeCol ? `<td>${p.row ? tyFmtHour(t, p.row[def.tcol]) : "—"}</td>` : ""}
        ${cmpT ? "" : `<td>${p.row ? TY_CLS[p.row[8]] : "—"}</td>`}
      </tr>`).join("")}</tbody>
    </table></div>`;
}

/* ---------- station detail: hourly hyetograph + this station's history across all typhoons ---------- */
function tySelectStation(si) {
  const prev = tyState.si;
  tyState.si = si;
  if (tyLastPts) {
    [prev, si].forEach(k => {
      const m = tyMarkers.get(k);
      const p = tyLastPts.find(q => q.si === k);
      if (m && p) m.setStyle(tyMarkerStyle(p, k === si));
    });
    const m = tyMarkers.get(si);
    if (m) m.bringToFront();
  }
  document.querySelectorAll("#tySummary .ty-row").forEach(r => r.classList.toggle("ty-hl", +r.dataset.si === si));
  tyRenderDetail(si);
}

function tyStationHistory(si) {
  const list = [];
  for (const t of CWA_TYPHOONS) {
    const r = (CWA_TY_STATS[t.id] || []).find(r => r[0] === si);
    if (r) list.push({ t, total: r[1] / 10, m24: r[6] / 10, m1: r[2] / 10, cls: r[8] });
  }
  return list.sort((a, b) => b.total - a.total);
}

async function tyRenderDetail(si) {
  const el = document.getElementById("tyDetail");
  const t = tyById(tyState.id);
  if (!el || !t) return;
  const s = CWA_STATIONS[si];
  const row = (CWA_TY_STATS[t.id] || []).find(r => r[0] === si);
  const hist = tyStationHistory(si);
  const rank = hist.findIndex(h => h.t.id === t.id);
  const top = hist.slice(0, 10);
  if (rank >= 10) top.push(hist[rank]);
  const tile = (k, v, sub) => `<div class="stat-tile"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  const mm = (col) => row ? `${fmt(row[col] / 10, 1)} mm` : "0 mm";
  const at = (col) => row && row[col] >= 0 ? `${tyFmtHour(t, row[col])} 止` : "";
  el.innerHTML = `
    <div class="ty-detail-head">
      <h3 class="ty-h3">${s[1]}（${s[0]}）<span class="ty-hint">${s[4]}｜${s[2] === "CWA" ? "氣象署測站" : "自動雨量站"}｜${s[6]}°N, ${s[5]}°E${s[7] ? `｜颱風雨量紀錄 ${s[7]}–${s[8]} 年` : ""}</span></h3>
      <button class="ghost" id="tyDetailClose" type="button">關閉</button>
    </div>
    <div class="stats-grid">
      ${tile(`${t.zh} 事件總雨量`, mm(1), row ? `歷年颱風第 ${rank + 1} 名（共 ${hist.length} 場）` : "本場颱風無雨量紀錄")}
      ${tile("最大 1 小時", mm(2), at(9))}
      ${tile("最大 3 小時", mm(3), at(10))}
      ${tile("最大 24 小時", mm(6), at(13))}
      ${tile("警報期間累積", row && row[7] >= 0 ? `${fmt(row[7] / 10, 1)} mm` : "—", row && row[7] < 0 ? "資料庫未提供" : "")}
      ${tile("雨量分級", row ? TY_CLS[row[8]] : "—", "")}
    </div>
    <div class="legend-row"><span><span class="swatch" style="background:${cssVar("--series-1")}"></span>時雨量 (mm，左軸)</span><span><span class="swatch" style="background:${cssVar("--series-2")}"></span>累積雨量 (mm，右軸)</span></div>
    <div class="chart-wrap ty-chart"><canvas id="tyCanvas"></canvas><p class="empty-note" id="tyChartNote" style="display:none;"></p></div>
    <details class="table-details" open><summary>本站歷年颱風事件總雨量排名（前 10 名${rank >= 10 ? "，另列本場" : ""}；點選可切換颱風）</summary>
      <div class="table-scroll"><table class="data-table ty-table">
        <thead><tr><th class="num">排名</th><th>颱風</th><th class="num">事件總雨量 (mm)</th><th class="num">最大24小時 (mm)</th><th class="num">最大1小時 (mm)</th><th>分級</th></tr></thead>
        <tbody>${top.map(h => `<tr class="ty-hist-row${h.t.id === t.id ? " ty-hl" : ""}" data-id="${h.t.id}">
          <td class="num">${hist.indexOf(h) + 1}</td><td>${h.t.y} ${h.t.zh}（${h.t.en}）</td><td class="num">${fmt(h.total, 1)}</td><td class="num">${fmt(h.m24, 1)}</td><td class="num">${fmt(h.m1, 1)}</td><td>${TY_CLS[h.cls]}</td>
        </tr>`).join("") || `<tr><td colspan="6">此站無任何颱風雨量紀錄</td></tr>`}</tbody>
      </table></div>
    </details>`;
  document.getElementById("tyDetailClose").addEventListener("click", () => {
    el.innerHTML = "";
    const prev = tyState.si;
    tyState.si = null;
    const m = tyMarkers.get(prev), p = tyLastPts && tyLastPts.find(q => q.si === prev);
    if (m && p) m.setStyle(tyMarkerStyle(p, false));
    document.querySelectorAll("#tySummary .ty-row").forEach(r => r.classList.remove("ty-hl"));
  });

  let prep;
  try { prep = await ensureTyHourly(t); } catch (e) {
    const note = document.getElementById("tyChartNote");
    if (note) { note.style.display = ""; note.textContent = e.message; }
    return;
  }
  if (tyState.si !== si || tyById(tyState.id) !== t) return; // user moved on meanwhile
  const c = prep.cum.get(si);
  const canvas = document.getElementById("tyCanvas");
  if (tyChart) { tyChart.destroy(); tyChart = null; }
  if (!c) {
    canvas.style.display = "none";
    const note = document.getElementById("tyChartNote");
    note.style.display = "";
    note.textContent = "本場颱風此站無時雨量紀錄（0 mm 或當時無觀測）";
    return;
  }
  const labels = Array.from({ length: t.n }, (_, i) => tyFmtHour(t, i));
  const hourly = Array.from({ length: t.n }, (_, i) => Math.round((c[i + 1] - c[i]) * 10) / 10);
  const cumul = Array.from({ length: t.n }, (_, i) => Math.round(c[i + 1] * 10) / 10);
  const grid = cssVar("--gridline"), muted = cssVar("--text-muted");
  tyChart = new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "時雨量 (mm)", data: hourly, backgroundColor: cssVar("--series-1"), yAxisID: "y", order: 2 },
        { type: "line", label: "累積雨量 (mm)", data: cumul, borderColor: cssVar("--series-2"), backgroundColor: "transparent", pointRadius: 0, borderWidth: 2, tension: 0.1, yAxisID: "y1", order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
      scales: {
        x: { grid: { color: grid }, ticks: { color: muted, maxTicksLimit: 12, autoSkip: true, maxRotation: 0 } },
        y: { grid: { color: grid }, ticks: { color: muted }, beginAtZero: true, title: { display: true, text: "時雨量 (mm)", color: muted } },
        y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: muted }, beginAtZero: true, title: { display: true, text: "累積 (mm)", color: muted } },
      },
    },
  });
}

/* ---------- CSV export ---------- */
function tyBuildExport(t, cmpT, def, pts) {
  const label = tyState.stat === "hourly" ? `時段累積_${tyWindowLabel(t).replace(/[：:（）\s～]/g, "")}` : def.short;
  if (cmpT) {
    tyLastExport = {
      filename: `颱風雨量_${t.y}${t.zh}_減_${cmpT.y}${cmpT.zh}_${def.short}.csv`,
      header: ["stno", "name", "county", "lon", "lat", `A_${t.zh}_mm`, `B_${cmpT.zh}_mm`, "A_minus_B_mm", "推定0mm"],
      rows: pts.map(p => [p.code, p.name, p.county, p.lon, p.lat, round3(p.valueA), round3(p.valueB), round3(p.value), p.zero ? "Y" : ""]),
    };
  } else {
    tyLastExport = {
      filename: `颱風雨量_${t.y}${t.zh}_${label}.csv`,
      header: ["stno", "name", "county", "lon", "lat", `${def.short}_mm`, "雨量分級", "推定0mm"],
      rows: pts.map(p => [p.code, p.name, p.county, p.lon, p.lat, round3(p.value), p.row ? TY_CLS[p.row[8]] : "", p.zero ? "Y" : ""]),
    };
  }
}

/* ---------- reference layer of all CWA gauges (added to the map's layer control) ---------- */
function tyAddStationRefLayer() {
  if (tyStationRefLayer || !layersControlRef || typeof CWA_STATIONS === "undefined") return;
  tyStationRefLayer = L.featureGroup();
  CWA_STATIONS.forEach(s => {
    const icon = L.divIcon({ className: "station-icon cwa", iconSize: [10, 10], iconAnchor: [5, 5] });
    tyStationRefLayer.addLayer(L.marker([s[6], s[5]], { icon, opacity: STATION_OPACITY })
      .bindTooltip(`氣象署雨量站：${s[1]}（${s[0]}，${s[4]}）${s[7] ? `｜颱風雨量紀錄 ${s[7]}–${s[8]}` : "｜無颱風雨量紀錄"}`));
  });
  layersControlRef.addOverlay(tyStationRefLayer, "氣象署雨量站位置（颱風資料）");
}

/* ---------- controls ---------- */
function tyTyphoonLabel(t) {
  const d0 = tyFmtHour(t, 0).slice(0, 5), d1 = tyFmtHour(t, t.n - 1).slice(0, 5);
  return `${t.y} ${t.zh} ${t.en}（${d0}～${d1}，${t.ns} 站）`;
}

function tyFillTyphoonSelect() {
  const sel = document.getElementById("tySelect");
  const year = document.getElementById("tyYear").value;
  const q = document.getElementById("tySearch").value.trim().toLowerCase();
  const list = CWA_TYPHOONS.filter(t => (year === "all" || String(t.y) === year) &&
    (!q || t.zh.includes(q) || t.en.toLowerCase().includes(q) || String(t.y).includes(q))).slice().reverse();
  sel.innerHTML = list.length ? list.map(t => `<option value="${t.id}">${tyTyphoonLabel(t)}</option>`).join("") : `<option value="">（沒有符合的颱風）</option>`;
  if (list.some(t => t.id === tyState.id)) sel.value = tyState.id;
  else if (list.length) { tyState.id = list[0].id; sel.value = tyState.id; tyOnTyphoonChanged(); }
}

function tyFillCompareSelect() {
  const sel = document.getElementById("tyCompare");
  const years = [...new Set(CWA_TYPHOONS.map(t => t.y))].sort((a, b) => b - a);
  sel.innerHTML = `<option value="">不比較</option>` + years.map(y =>
    `<optgroup label="${y}">${CWA_TYPHOONS.filter(t => t.y === y).map(t => `<option value="${t.id}">${t.zh} ${t.en}</option>`).join("")}</optgroup>`).join("");
  sel.value = tyState.cmp;
}

function tyFillStatSelect() {
  const t = tyById(tyState.id);
  const hasWarn = t ? tyHasWarn(t) : true;
  const sel = document.getElementById("tyStat");
  sel.innerHTML = TY_STATS.map(s => `<option value="${s.key}"${s.key === "warn" && !hasWarn ? " disabled" : ""}>${s.label}${s.key === "warn" && !hasWarn ? "（此颱風資料庫未提供）" : ""}</option>`).join("");
  if (tyState.stat === "warn" && !hasWarn) tyState.stat = "total";
  sel.value = tyState.stat;
}

function tyOnTyphoonChanged() {
  tyStopPlay(true);
  const t = tyById(tyState.id);
  if (!t) return;
  tyState.endIdx = t.n - 1;
  const slider = document.getElementById("tyEnd");
  slider.max = t.n - 1;
  slider.value = tyState.endIdx;
  tyUpdateEndLabel();
  tyFillStatSelect();
  document.getElementById("tyDetail").innerHTML = "";
  if (tyChart) { tyChart.destroy(); tyChart = null; }
  tyRefreshOfficialControls();
  // keep the selected station if it has data in the new typhoon too; the detail panel re-renders after the map
}

function tyUpdateEndLabel() {
  const t = tyById(tyState.id);
  const el = document.getElementById("tyEndLabel");
  if (t && el) el.textContent = tyWindowLabel(t);
}

function tyShowHourlyControls() {
  document.getElementById("tyHourlyControls").style.display = tyState.stat === "hourly" ? "" : "none";
}

function tyTogglePlay() {
  if (tyPlayTimer) { tyStopPlay(); return; }
  const t = tyById(tyState.id);
  if (!t) return;
  if (tyState.stat !== "hourly") {
    tyState.stat = "hourly";
    document.getElementById("tyStat").value = "hourly";
    tyShowHourlyControls();
  }
  if (tyState.cmp) { tyState.cmp = ""; document.getElementById("tyCompare").value = ""; }
  if (tyState.endIdx >= t.n - 1) tyState.endIdx = tyState.step === "day" ? tyNextMidnight(t, -1) : 0;
  const slider = document.getElementById("tyEnd");
  document.getElementById("tyPlayBtn").textContent = "❚❚ 暫停";
  const step = async () => {
    if (!tyPlayTimer) return;
    slider.value = tyState.endIdx;
    tyUpdateEndLabel();
    await runTyphoonMap({ frame: true });
    if (!tyPlayTimer) return;
    if (tyState.endIdx >= t.n - 1) { tyStopPlay(); return; }
    tyState.endIdx = tyNextStep(t, tyState.endIdx);
    tyPlayTimer = setTimeout(step, 350);
  };
  tyPlayTimer = setTimeout(step, 0);
}

// hour index of the next hour ending at 00:00 after idx (or the last hour when none is left)
function tyNextMidnight(t, idx) {
  for (let j = idx + 1; j < t.n; j++) if (tyHourDate(t, j).getUTCHours() === 0) return j;
  return t.n - 1;
}
function tyNextStep(t, idx) {
  if (tyState.step === "day") return tyNextMidnight(t, idx);
  return Math.min(t.n - 1, idx + parseInt(tyState.step, 10));
}

function tyStopPlay(silent) {
  if (!tyPlayTimer) return;
  clearTimeout(tyPlayTimer);
  tyPlayTimer = null;
  const btn = document.getElementById("tyPlayBtn");
  if (btn) btn.textContent = "▶ 播放";
  if (!silent) runTyphoonMap(); // final frame at full resolution
}

function tyInitControls() {
  if (tyControlsReady) return;
  tyControlsReady = true;
  const years = [...new Set(CWA_TYPHOONS.map(t => t.y))].sort((a, b) => b - a);
  document.getElementById("tyYear").innerHTML = `<option value="all">全部年份（${CWA_TYPHOONS.length} 場）</option>` +
    years.map(y => `<option value="${y}">${y}（${CWA_TYPHOONS.filter(t => t.y === y).length} 場）</option>`).join("");
  // default: the most recent year, its typhoon with the highest station rainfall
  const latest = years[0];
  const cand = CWA_TYPHOONS.filter(t => t.y === latest);
  const best = cand.slice().sort((a, b) => ((CWA_TY_STATS[b.id] || [[0, 0]])[0][1]) - ((CWA_TY_STATS[a.id] || [[0, 0]])[0][1]))[0];
  document.getElementById("tyYear").value = String(latest);
  tyState.id = best ? best.id : CWA_TYPHOONS[CWA_TYPHOONS.length - 1].id;
  document.getElementById("tyWinLen").innerHTML = TY_WIN_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  document.getElementById("tyWinLen").value = String(tyState.winLen);
  tyFillTyphoonSelect();
  tyFillCompareSelect();
  tyOnTyphoonChanged();
  tyShowHourlyControls();

  const rerender = () => runTyphoonMap();
  document.getElementById("tyYear").addEventListener("change", () => { tyFillTyphoonSelect(); rerender(); });
  document.getElementById("tySearch").addEventListener("input", () => {
    const before = tyState.id;
    tyFillTyphoonSelect();
    if (tyState.id !== before) rerender();
  });
  document.getElementById("tySelect").addEventListener("change", e => {
    if (!e.target.value) return;
    tyState.id = e.target.value;
    tyOnTyphoonChanged();
    rerender();
  });
  document.getElementById("tyStat").addEventListener("change", e => {
    tyStopPlay(true);
    tyState.stat = e.target.value;
    tyShowHourlyControls();
    rerender();
  });
  document.getElementById("tyCompare").addEventListener("change", e => { tyStopPlay(true); tyState.cmp = e.target.value; rerender(); });
  document.getElementById("tyRadius").addEventListener("change", e => { tyState.radius = e.target.value; rerender(); });
  document.getElementById("tyScale").addEventListener("change", e => { tyState.scale = e.target.value; rerender(); });
  document.getElementById("tyZeroFill").addEventListener("change", e => { tyState.zeroFill = e.target.checked; rerender(); if (tyOff.entry) tyRefreshOfficialNote(); });
  document.getElementById("tyWinLen").addEventListener("change", e => { tyState.winLen = parseInt(e.target.value, 10); tyUpdateEndLabel(); rerender(); });
  let sliderTimer = null;
  document.getElementById("tyEnd").addEventListener("input", e => {
    tyState.endIdx = parseInt(e.target.value, 10);
    tyUpdateEndLabel();
    if (tyPlayTimer) return;
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => runTyphoonMap({ frame: true }), 60);
  });
  document.getElementById("tyEnd").addEventListener("change", () => { if (!tyPlayTimer) runTyphoonMap(); });
  document.getElementById("tyPlayBtn").addEventListener("click", tyTogglePlay);
  document.getElementById("tyStep").addEventListener("change", e => {
    tyState.step = e.target.value;
    // daily steps: show each calendar day's rainfall unless the user is accumulating from the start
    if (tyState.step === "day" && tyState.winLen !== 0 && tyState.winLen !== 24) {
      tyState.winLen = 24;
      document.getElementById("tyWinLen").value = "24";
      tyUpdateEndLabel();
    }
  });
  document.getElementById("tySummary").addEventListener("click", e => {
    const tr = e.target.closest(".ty-row");
    if (tr) tySelectStation(parseInt(tr.dataset.si, 10));
  });
  document.getElementById("tyDetail").addEventListener("click", e => {
    const tr = e.target.closest(".ty-hist-row");
    if (!tr || tr.dataset.id === tyState.id) return;
    tyState.id = tr.dataset.id;
    const t = tyById(tyState.id);
    document.getElementById("tyYear").value = String(t.y);
    document.getElementById("tySearch").value = "";
    tyFillTyphoonSelect();
    document.getElementById("tySelect").value = tyState.id;
    const keepSi = tyState.si;
    tyOnTyphoonChanged();
    tyState.si = keepSi;
    rerender();
  });
}

// called when the map sub-mode changes
async function tyEnterMode() {
  document.getElementById("mapStatus").textContent = "載入颱風資料中…";
  try {
    await ensureTyphoonMeta();
  } catch (e) {
    document.getElementById("mapStatus").textContent = e.message;
    return;
  }
  tyInitControls();
  runTyphoonMap();
}
function tyLeaveMode() {
  tyStopPlay(true);
  tyClearOfficial();
}

/* ---------- official CWA accumulated-rainfall maps (user-supplied images, georeferenced offline) ----------
   typhoon_maps/index.js     frame of the 0.01° lat/lon image grid + which typhoons have maps
   typhoon_maps/maps_<Y>.js  per-year entries: {start, end, png (data URI, pre-warped to web-mercator), rle} */
const tyOff = { entry: null, overlay: null, grid: null, control: null, legendOpen: true, opacity: 0.8, hideOwn: false, seq: 0 };

async function tyLoadMapIndex() {
  if (window.CWA_TY_MAP_INDEX) return;
  try { await loadScriptOnce("typhoon_maps/index.js"); } catch (e) { window.CWA_TY_MAP_INDEX = {}; }
}
function tyOffLabel(e) { return `${e[0].slice(5)} ～ ${e[1].slice(5)}`; }
function tyHourIndex(t, s) {
  return Math.round((new Date(s.replace(" ", "T") + ":00Z") - new Date(t.t0.replace(" ", "T") + ":00Z")) / 3600e3);
}
function tyOffWindow(t, e) {
  const a = tyHourIndex(t, e[0]) + 1, b = tyHourIndex(t, e[1]);   // hours ending in (start, end]
  return { a, b, covered: a >= 0 && b <= t.n - 1, overlap: Math.max(0, Math.min(b, t.n - 1) - Math.max(a, 0) + 1), len: b - a + 1 };
}
// each map carries its own template frame and legend scale ("std" 1–300 mm or "large" 10–1500 mm)
function tyOffFrame(e) { e = e || tyOff.entry; return e ? CWA_MAP_FRAMES[e.frame || "new"] : null; }
function tyOffEdges(e) { e = e || tyOff.entry; return CWA_MAP_LEGENDS[(e && e.legend) || "std"]; }
function tyOffClassOf(v, e) {
  if (!(v > 0)) return -1;
  const E = tyOffEdges(e);
  for (let k = 0; k < 17; k++) if (E[k + 1] === null || v < E[k + 1]) return k;
  return 16;
}
function tyOffClassLabel(k, e) {
  if (k < 0) return "無降雨";
  const E = tyOffEdges(e);
  if (k === 0) return `< ${E[1]} mm`;
  return E[k + 1] === null ? `≥ ${E[k]} mm` : `${E[k]}–${E[k + 1]} mm`;
}
function tyOffGridAt(lat, lon) {
  const F = tyOffFrame();
  if (!F) return null;
  const x = Math.floor((lon - F.west) / (F.east - F.west) * F.w), y = Math.floor((F.north - lat) / (F.north - F.south) * F.h);
  if (!tyOff.grid || x < 0 || y < 0 || x >= F.w || y >= F.h) return null;
  return tyOff.grid[y * F.w + x] - 1;
}
function tyDecodeRle(rle, n) {
  const g = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i < rle.length; i += 2) { g.fill(rle[i], p, p + rle[i + 1]); p += rle[i + 1]; }
  return g;
}

function tyRefreshOfficialControls() {
  const box = document.getElementById("tyOfficialBox");
  const t = tyById(tyState.id);
  const list = t && window.CWA_TY_MAP_INDEX ? CWA_TY_MAP_INDEX[t.id] : null;
  tyClearOfficial();
  if (!list || !list.length) { box.style.display = "none"; return; }
  box.style.display = "";
  const sel = document.getElementById("tyOfficial");
  sel.innerHTML = `<option value="">不顯示</option>` + list.map((e, i) => {
    const w = tyOffWindow(t, e);
    return `<option value="${i}">${tyOffLabel(e)}${e[2] === "large" ? "（大雨量刻度 10–1500 mm）" : ""}${w.covered ? "" : w.overlap ? "（逐時資料僅部分涵蓋）" : "（颱風資料期間外）"}</option>`;
  }).join("");
  tyOff.defaultNote = `本颱風有 ${list.length} 張氣象署累積雨量圖，選擇後會疊在地圖上（影像為 0.01° 經緯度網格，已依海岸線與縣市界校正位置，平均誤差約 0.1–0.3 像素，即數百公尺內）。顯示官方圖時，本系統內插圖會自動改用官方圖同一套分級與配色，方便直接比對。`;
  document.getElementById("tyOfficialNote").textContent = tyOff.defaultNote;
  document.getElementById("tyOfficialSync").disabled = true;
}

function tyClearOfficial() {
  tyOff.seq++;
  if (tyOff.overlay && leafletMap) leafletMap.removeLayer(tyOff.overlay);
  if (tyOff.control && leafletMap) leafletMap.removeControl(tyOff.control);
  tyOff.overlay = tyOff.control = tyOff.entry = tyOff.grid = null;
  if (leafletMap) leafletMap.off("mousemove", tyOffHover);
  if (mapImageOverlay) mapImageOverlay.setOpacity(HEATMAP_OPACITY);
  const sel = document.getElementById("tyOfficial");
  if (sel) sel.value = "";
}

async function tySetOfficial(idx) {
  const t = tyById(tyState.id);
  if (idx === "" || !t) {
    const had = !!tyOff.overlay;
    tyClearOfficial();
    tyRefreshOfficialNote();
    document.getElementById("tyOfficialSync").disabled = true;
    if (had && tyState.scale === "auto") runTyphoonMap();
    return;
  }
  const seq = ++tyOff.seq;
  const note = document.getElementById("tyOfficialNote");
  note.textContent = "載入官方圖中…";
  try { if (!(window.CWA_TY_MAPS && CWA_TY_MAPS[t.id])) await loadScriptOnce(`typhoon_maps/maps_${t.y}.js`); }
  catch (e) { note.textContent = e.message; return; }
  if (seq !== tyOff.seq) return;
  const e = CWA_TY_MAPS[t.id][+idx];
  const F = tyOffFrame(e);
  const map = ensureMap();
  if (!map.getPane("officialPane")) {
    const pane = map.createPane("officialPane");
    pane.style.zIndex = 450;          // above the interpolated raster, below markers & popups
    pane.style.pointerEvents = "none"; // station dots underneath stay clickable
  }
  if (tyOff.overlay) map.removeLayer(tyOff.overlay);
  tyOff.entry = e;
  tyOff.grid = tyDecodeRle(e.rle, F.w * F.h);
  tyOff.overlay = L.imageOverlay(e.png, [[F.south, F.west], [F.north, F.east]], { pane: "officialPane", opacity: tyOff.opacity, interactive: false }).addTo(map);
  tyAddOfficialControl(e);
  map.off("mousemove", tyOffHover).on("mousemove", tyOffHover);
  tyApplyHideOwn();
  const w = tyOffWindow(t, [e.start, e.end]);
  document.getElementById("tyOfficialSync").disabled = !w.covered;
  if (tyState.scale === "auto") runTyphoonMap(); // switch our colours to the official classes
  await tyRefreshOfficialNote();
}

function tyAddOfficialControl(e) {
  if (tyOff.control) leafletMap.removeControl(tyOff.control);
  tyOff.control = L.control({ position: "bottomleft" });
  tyOff.control.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend ty-off-legend");
    const rows = e.colors.map((c, k) => ({ c, k })).reverse().map(({ c, k }) =>
      `<div class="map-legend-row"><span class="map-legend-swatch" style="background:rgb(${c.join(",")})"></span>${tyOffClassLabel(k, e)}</div>`).join("");
    div.innerHTML = `<div class="ty-readout" id="tyReadout">將游標移到地圖上可讀取該處數值</div>
      <div class="map-legend-title">氣象署累積雨量圖 ${e.start.slice(5)}～${e.end.slice(5)}</div><div class="map-legend-body">${rows}</div>`;
    div.classList.toggle("collapsed", !tyOff.legendOpen);
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    div.querySelector(".map-legend-title").addEventListener("click", () => {
      tyOff.legendOpen = !tyOff.legendOpen;
      div.classList.toggle("collapsed", !tyOff.legendOpen);
    });
    return div;
  };
  tyOff.control.addTo(leafletMap);
}

// value of the current interpolated map at a point (same IDW as the raster)
function tyIdwAt(lat, lon) {
  if (!lastHeatmapPoints || !lastHeatmapPoints.length) return null;
  const R = (lastHeatmapOpts && lastHeatmapOpts.maxDistKm) || 22;
  let ws = 0, vs = 0;
  for (const p of lastHeatmapPoints) {
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d > R) continue;
    if (d < 0.05) return p.value;
    const w = 1 / (d * d); ws += w; vs += w * p.value;
  }
  return ws ? vs / ws : null;
}

function tyOfficialBins() {
  const e = tyOff.entry;
  if (!e) return null;
  if (!e._bins) {
    const E = tyOffEdges(e);
    e._bins = e.colors.map((c, k) => ({ min: k === 0 ? 0.5 : E[k], max: E[k + 1] === null ? Infinity : E[k + 1], color: c }));
  }
  return e._bins;
}

function tyOffHover(ev) {
  const el = document.getElementById("tyReadout");
  if (!el || !tyOff.grid) return;
  const k = tyOffGridAt(ev.latlng.lat, ev.latlng.lng);
  if (k === null) { el.textContent = "（在官方圖範圍外）"; return; }
  const own = tyIdwAt(ev.latlng.lat, ev.latlng.lng);
  const def = tyStatDef(tyState.stat);
  const ownLabel = tyState.stat === "hourly" ? "本系統時段累積" : `本系統${def.short}`;
  el.innerHTML = `官方圖：<b>${tyOffClassLabel(k)}</b>｜${ownLabel}：<b>${own === null ? "—" : fmt(own, 1) + " mm"}</b>`;
}

function tyApplyHideOwn() {
  if (!mapImageOverlay) return;
  mapImageOverlay.setOpacity(tyOff.hideOwn && tyOff.overlay ? 0 : HEATMAP_OPACITY);
}

// how well station measurements (hourly sums over the same window) agree with the official map's classes
async function tyRefreshOfficialNote() {
  const note = document.getElementById("tyOfficialNote");
  const t = tyById(tyState.id);
  const e = tyOff.entry;
  if (!note || !t) return;
  if (!e) { note.textContent = tyOff.defaultNote || ""; return; }
  const w = tyOffWindow(t, [e.start, e.end]);
  if (!w.covered) {
    note.textContent = w.overlap
      ? `此官方圖時段（${e.start.slice(5)}～${e.end.slice(5)}）只有 ${w.overlap}/${w.len} 小時落在颱風資料庫的逐時資料期間內，無法用測站資料比對；仍可疊圖參考。`
      : `此官方圖時段在颱風資料庫逐時資料期間之外，無法用測站資料比對；仍可疊圖參考。`;
    return;
  }
  let prep;
  try { prep = await ensureTyHourly(t); } catch (err) { note.textContent = err.message; return; }
  if (tyOff.entry !== e) return;
  let n = 0, exact = 0, within = 0;
  const check = (si, v) => {
    const s = CWA_STATIONS[si];
    const k = tyOffGridAt(s[6], s[5]);
    if (k === null) return;
    const c = tyOffClassOf(v, e);
    n++;
    if (k === c) exact++;
    if (Math.abs(k - c) <= 1) within++;
  };
  for (const [si, c] of prep.cum) check(si, c[w.b + 1] - c[w.a]);
  if (tyState.zeroFill) {
    const listed = new Set(prep.cum.keys());
    CWA_STATIONS.forEach((s, si) => { if (!listed.has(si) && s[7] && s[7] <= t.y && t.y <= s[8]) check(si, 0); });
  }
  note.innerHTML = `比對：${n} 個測站在同一時段（${e.start.slice(5)}～${e.end.slice(5)}）的逐時雨量加總，落在官方圖同一分級者 <b>${pct(exact / n, 0)}</b>、相差一級以內 <b>${pct(within / n, 0)}</b>。差異多出現在海岸線（1 公里網格跨陸海）與測站稀疏的山區；官方圖為雷達與雨量站整合之網格產品，數值本就不會與單一測站完全相同。按「本系統改畫同一時段」可並排比較。`;
}

function tySyncToOfficial() {
  const t = tyById(tyState.id), e = tyOff.entry;
  if (!t || !e) return;
  const w = tyOffWindow(t, [e.start, e.end]);
  if (!w.covered) return;
  tyStopPlay(true);
  tyState.stat = "hourly";
  tyState.cmp = "";
  document.getElementById("tyStat").value = "hourly";
  document.getElementById("tyCompare").value = "";
  const winSel = document.getElementById("tyWinLen");
  if (![...winSel.options].some(o => +o.value === w.len)) winSel.insertAdjacentHTML("beforeend", `<option value="${w.len}">${w.len} 小時</option>`);
  tyState.winLen = w.len;
  winSel.value = String(w.len);
  tyState.endIdx = w.b;
  document.getElementById("tyEnd").value = w.b;
  tyShowHourlyControls();
  tyUpdateEndLabel();
  runTyphoonMap();
}

function tyOfficialAfterRender() {
  if (tyOff.overlay) { tyOff.overlay.bringToFront(); tyApplyHideOwn(); }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("tyOfficial").addEventListener("change", e => tySetOfficial(e.target.value));
  document.getElementById("tyOfficialSync").addEventListener("click", tySyncToOfficial);
  document.getElementById("tyOfficialOp").addEventListener("input", e => {
    tyOff.opacity = parseInt(e.target.value, 10) / 100;
    document.getElementById("tyOfficialOpVal").textContent = e.target.value + "%";
    if (tyOff.overlay) tyOff.overlay.setOpacity(tyOff.opacity);
  });
  document.getElementById("tyHideOwn").addEventListener("change", e => { tyOff.hideOwn = e.target.checked; tyApplyHideOwn(); });
});

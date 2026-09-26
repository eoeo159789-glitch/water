/* ---------- audit tools: warning thresholds, before/after evaluation, project-point import ---------- */

const DATA_MIN = DATA_FIRST_DATE, DATA_MAX = DATA_LAST_DATE;

function safeGet(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}
function safeSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage unavailable: keep in memory only */ } }
function addDays(d, n) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400e3); }
function clipRange(s, e) {
  const s2 = s < DATA_MIN ? DATA_MIN : s, e2 = e > DATA_MAX ? DATA_MAX : e;
  return s2 > e2 ? null : { start: s2, end: e2, clipped: s2 !== s || e2 !== e };
}
function pct(x, digits) { return x === null || x === undefined || isNaN(x) ? "—" : `${(x * 100).toFixed(digits ?? 1)}%`; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* =====================================================================
   1. Warning thresholds (user-entered, per station and data type)
   ===================================================================== */
const THR_STORE = "hy_thresholds_v1";
let THRESHOLDS = safeGet(THR_STORE, {});
// station ids renamed when the 2001-2019 yearbooks were merged: carry saved thresholds over
(() => {
  let moved = false;
  Object.keys(THRESHOLDS).forEach(k => {
    const [type, id] = k.split("|");
    const nid = HY_ID_ALIAS[id];
    if (nid && !THRESHOLDS[`${type}|${nid}`]) { THRESHOLDS[`${type}|${nid}`] = THRESHOLDS[k]; delete THRESHOLDS[k]; moved = true; }
  });
  if (moved) safeSet(THR_STORE, THRESHOLDS);
})();
const THR_COLOR_VARS = ["--warn-1", "--warn-2"];

function thrKey() { return `${state.dataType}|${state.stationId}`; }
function thrDefaults() {
  return state.dataType === "rainfall"
    ? [{ label: "大雨", value: null }, { label: "豪雨", value: null }]
    : [{ label: "一級警戒", value: null }, { label: "二級警戒", value: null }];
}
function currentThresholds() {
  return (THRESHOLDS[thrKey()] || [])
    .map((t, i) => ({ ...t, color: cssVar(THR_COLOR_VARS[i]) || "#d03b3b" }))
    .filter(t => t && t.value !== null && t.value !== "" && !isNaN(t.value));
}
function thrSummaryText() {
  const cur = currentThresholds();
  const unit = UNIT[state.dataType];
  return `警戒值設定（本站${cur.length ? "：" + cur.map(t => `${t.label} ${thrFmt(t.value)} ${unit}`).join("、") : "：尚未設定"}）`;
}

function renderThresholdEditor() {
  const el = document.getElementById("thrEditor");
  if (!el) return;
  if (!state.stationId) { el.style.display = "none"; return; }
  el.style.display = "";
  const list = THRESHOLDS[thrKey()] || thrDefaults();
  const unit = UNIT[state.dataType];
  const wasOpen = el.open;
  el.innerHTML = `
    <summary id="thrSummary">${thrSummaryText()}</summary>
    ${[0, 1].map(i => `<div class="thr-row">
      <span class="thr-swatch" style="background:var(${THR_COLOR_VARS[i]})"></span>
      <input type="text" class="thr-label" value="${escapeHtml((list[i] || thrDefaults()[i]).label)}" aria-label="警戒值 ${i + 1} 名稱">
      <input type="number" class="thr-value" step="any" value="${list[i] && list[i].value !== null ? list[i].value : ""}" placeholder="數值" aria-label="警戒值 ${i + 1} 數值">
      <span class="cs-lbl">${unit}</span>
    </div>`).join("")}
    <div class="row" style="margin-top:6px;">
      <button class="primary" type="button" id="thrApply">套用</button>
      <button class="ghost" type="button" id="thrClear">清除</button>
      ${state.dataType === "rainfall" ? `<button class="ghost" type="button" id="thrRainPreset">帶入雨量分級（日雨量 大雨 80／豪雨 200 mm）</button>` : ""}
    </div>
    <p class="empty-note thr-note">本資料不含官方警戒值，請依各河川分署公告的警戒水位（或自訂基準）填入；會畫在圖表上，並統計超過的天數。${state.dataType === "rainfall" ? "雨量以日雨量比較（氣象署分級以 24 小時累積為準，兩者略有差異）。" : "水位／流量為「日平均值」，與瞬時警戒水位比較時，超越天數可能低估。"}設定只記在這台電腦的瀏覽器。</p>`;
  el.open = wasOpen;
  el.querySelector("#thrApply").addEventListener("click", () => {
    const labels = [...el.querySelectorAll(".thr-label")].map(i => i.value.trim());
    const values = [...el.querySelectorAll(".thr-value")].map(i => i.value === "" ? null : parseFloat(i.value));
    THRESHOLDS[thrKey()] = labels.map((l, i) => ({ label: l || thrDefaults()[i].label, value: values[i] }));
    safeSet(THR_STORE, THRESHOLDS);
    el.querySelector("#thrSummary").textContent = thrSummaryText();
    rerunCurrentResult();
  });
  el.querySelector("#thrClear").addEventListener("click", () => {
    delete THRESHOLDS[thrKey()];
    safeSet(THR_STORE, THRESHOLDS);
    renderThresholdEditor();
    rerunCurrentResult();
  });
  const preset = el.querySelector("#thrRainPreset");
  if (preset) preset.addEventListener("click", () => {
    const ls = el.querySelectorAll(".thr-label"), vs = el.querySelectorAll(".thr-value");
    ls[0].value = "大雨"; vs[0].value = 80; ls[1].value = "豪雨"; vs[1].value = 200;
  });
}

function rerunCurrentResult() {
  if (state.mode === "query" && document.getElementById("queryResult").innerHTML.trim()) runQuery();
  else if (state.mode === "compare" && document.getElementById("compareResult").innerHTML.trim()) runCompare();
  else if (state.mode === "eval" && document.getElementById("evResult").innerHTML.trim()) runEval();
}

function exceedStats(series, dates, thr) {
  let count = 0, valid = 0, run = 0, maxRun = 0, runStart = null, maxRunStart = null, first = null, last = null;
  dates.forEach(d => {
    const v = series[d];
    if (v === undefined || v === null) { run = 0; return; } // a missing day breaks a run
    valid++;
    if (v >= thr) {
      count++;
      run++;
      if (run === 1) runStart = d;
      if (run > maxRun) { maxRun = run; maxRunStart = runStart; }
      if (!first) first = d;
      last = d;
    } else run = 0;
  });
  // rainfall: "-" (no-rain) days are stored as missing, so rates use calendar days as the denominator
  const base = state.dataType === "rainfall" ? (valid ? dates.length : 0) : valid; // no records at all -> unknown, not "0 days"
  return { count, valid, base, maxRun, maxRunStart, first, last, ratio: base ? count / base : null, perYear: base ? count / base * 365 : null };
}
function thrFmt(v) { return state.dataType === "rainfall" ? fmt(v, 0) : fmt(v, 2); }

function exceedTilesHtml(series, dates) {
  const thr = currentThresholds();
  if (!thr.length) return "";
  const unit = UNIT[state.dataType];
  return `<div class="stats-grid">${thr.map(t => {
    const s = exceedStats(series, dates, t.value);
    return `<div class="stat-tile thr-tile" style="border-left-color:${t.color}">
      <div class="k">≥「${escapeHtml(t.label)}」${thrFmt(t.value)} ${unit}</div>
      <div class="v">${s.base ? `${s.count} 天` : "—"}</div>
      <div class="sub">${s.base ? `占${state.dataType === "rainfall" ? "期間日數" : "有資料日"} ${pct(s.ratio)}｜最長連續 ${s.maxRun} 天${s.first ? `｜首次 ${s.first}` : ""}` : "此期間無資料"}</div>
    </div>`;
  }).join("")}</div>`;
}

/* Chart.js inline plugin: horizontal threshold lines, vertical markers, shaded bands */
function refLinesPlugin(cfg) {
  return {
    id: "refLines",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      if (!cfg.bands || !cfg.bands.length) return;
      const step = chart.data.labels.length > 1 ? Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0)) : a.width;
      ctx.save();
      cfg.bands.forEach(b => {
        const x0 = Math.max(a.left, x.getPixelForValue(b.from) - step / 2);
        const x1 = Math.min(a.right, x.getPixelForValue(b.to) + step / 2);
        ctx.fillStyle = b.color;
        ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
        if (b.label) {
          ctx.fillStyle = cssVar("--text-muted");
          ctx.font = "11px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(b.label, (x0 + x1) / 2, a.top + 12);
        }
      });
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x, y } } = chart;
      ctx.save();
      ctx.font = "11px system-ui, sans-serif";
      (cfg.vLines || []).forEach(v => {
        const px = x.getPixelForValue(v.index);
        if (px < a.left || px > a.right) return;
        ctx.strokeStyle = v.color; ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
        ctx.fillStyle = v.color; ctx.textAlign = "left";
        ctx.fillText(v.label, px + 4, a.top + 12);
      });
      // dashed threshold lines; labels sit on a backing chip and step aside when two lines are close
      const placed = [];
      (cfg.hLines || []).map(h => ({ ...h, py: y.getPixelForValue(h.value) }))
        .filter(h => h.py >= a.top && h.py <= a.bottom)
        .sort((p, q) => p.py - q.py)
        .forEach(h => {
          ctx.strokeStyle = h.color; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(a.left, h.py); ctx.lineTo(a.right, h.py); ctx.stroke();
          ctx.setLineDash([]);
          let ty = h.py - 5;
          if (placed.some(p => Math.abs(p - ty) < 14)) ty = h.py + 14;
          placed.push(ty);
          const w = ctx.measureText(h.label).width;
          ctx.fillStyle = cssVar("--surface-1") || "#fff";
          ctx.globalAlpha = 0.85;
          ctx.fillRect(a.right - w - 10, ty - 11, w + 8, 14);
          ctx.globalAlpha = 1;
          ctx.fillStyle = h.color; ctx.textAlign = "right";
          ctx.fillText(h.label, a.right - 6, ty);
        });
      ctx.restore();
    },
  };
}

// make sure threshold lines fall inside the y range
function applyThresholdRange(options) {
  const thr = currentThresholds();
  if (!thr.length) return options;
  const vals = thr.map(t => t.value);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  // "suggested" bounds only widen the axis when a threshold lies outside the data range
  if (state.dataType === "rainfall") options.scales.y.suggestedMax = hi * 1.08;
  else { options.scales.y.suggestedMax = hi; options.scales.y.suggestedMin = lo; }
  return options;
}
function thresholdHLines() {
  const unit = UNIT[state.dataType];
  return currentThresholds().map(t => ({ value: t.value, color: t.color, label: `${t.label} ${thrFmt(t.value)} ${unit}` }));
}

/* =====================================================================
   2. 治理前後評估 (before/after evaluation around a project's completion date)
   ===================================================================== */
let evChart = null;
let evLastRows = null;

function evPopulateRain() {
  const sel = document.getElementById("evRain");
  const wrap = document.getElementById("evRainWrap");
  if (!sel) return;
  if (state.dataType === "rainfall") { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const st = getStationById(state.stationId);
  const prev = sel.value;
  let opts = [`<option value="">不使用</option>`];
  let firstId = "";
  if (st && st.lat !== undefined) {
    const near = RAINFALL.filter(r => r.lat !== undefined)
      .map(r => ({ r, d: haversineKm(st.lat, st.lon, r.lat, r.lon) }))
      .sort((a, b) => a.d - b.d).slice(0, 15);
    firstId = near.length ? near[0].r.id : "";
    opts = opts.concat(near.map(({ r, d }) => `<option value="${r.id}">${r.name_zh}（${r.code}）— ${d.toFixed(1)} km</option>`));
  } else {
    const same = RAINFALL.filter(r => !st || r.region === st.region).sort((a, b) => (a.name_zh || "").localeCompare(b.name_zh || "", "zh-Hant"));
    opts = opts.concat(same.map(r => `<option value="${r.id}">${r.name_zh}（${r.code}）</option>`));
  }
  sel.innerHTML = opts.join("");
  sel.value = [...sel.options].some(o => o.value === prev) && prev ? prev : firstId;
}

function evPeriods() {
  const endC = document.getElementById("evEnd").value;
  const startS = document.getElementById("evStart").value || endC;
  const win = document.getElementById("evWindow").value;
  if (!endC) return { error: "請輸入完工日" };
  if (startS > endC) return { error: "開工日不可晚於完工日" };
  let before, after;
  if (win === "all") {
    before = clipRange(DATA_MIN, addDays(startS, -1));
    after = clipRange(addDays(endC, 1), DATA_MAX);
  } else {
    const n = parseInt(win, 10);
    before = clipRange(addDays(startS, -n), addDays(startS, -1));
    after = clipRange(addDays(endC, 1), addDays(endC, n));
  }
  if (!before) return { error: `開工日前沒有可比較的資料（系統資料範圍 ${DATA_MIN.slice(0, 4)}–${DATA_MAX.slice(0, 4)} 年）` };
  if (!after) return { error: `完工日後沒有可比較的資料（系統資料範圍 ${DATA_MIN.slice(0, 4)}–${DATA_MAX.slice(0, 4)} 年）` };
  return { startS, endC, win, before, after };
}

function percentile(vals, p) {
  if (!vals.length) return null;
  const s = vals.slice().sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function periodStats(series, dates) {
  const st = aggregate(series, dates);
  const vals = dates.map(d => series[d]).filter(v => v !== undefined && v !== null);
  st.p95 = percentile(vals, 0.95);
  st.completeness = dates.length ? st.count / dates.length : null;
  // rainfall: sum over calendar days ("-" = no rain); level/discharge: mean of recorded days
  st.annualSum = dates.length && st.sum !== null ? st.sum / dates.length * 365 : null;
  return st;
}

function rainRefStats(rs, dates) {
  const st = aggregate(rs.daily, dates);
  const vals = dates.map(d => rs.daily[d]).filter(v => v !== undefined && v !== null);
  return {
    ...st,
    annualSum: dates.length ? (st.sum || 0) / dates.length * 365 : null,
    d80: vals.filter(v => v >= 80).length,
    d200: vals.filter(v => v >= 200).length,
  };
}

function changeStr(b, a, digits, unit) {
  if (b === null || a === null || b === undefined || a === undefined) return "—";
  const d = a - b;
  const rel = b !== 0 ? ` (${d >= 0 ? "+" : ""}${(d / Math.abs(b) * 100).toFixed(0)}%)` : "";
  return `${d >= 0 ? "+" : ""}${fmt(d, digits)}${unit ? " " + unit : ""}${rel}`;
}

// every year from the start of "before" to the end of "after" (the chart also shows the construction period)
function evYearSpan(a, b) {
  const out = [];
  for (let y = +a.slice(0, 4); y <= +b.slice(0, 4); y++) out.push(y);
  return out;
}
async function runEval() {
  const resultEl = document.getElementById("evResult");
  const station = getStationById(state.stationId);
  if (!station) { resultEl.innerHTML = `<p class="empty-note">請先於上方選擇測站</p>`; return; }
  const P = evPeriods();
  if (P.error) { resultEl.innerHTML = `<p class="empty-note">${P.error}</p>`; return; }
  const series = getSeries(station);
  const unit = UNIT[state.dataType];
  const isRain = state.dataType === "rainfall";
  const digits = isRain ? 1 : 2;
  const dB = dateRangeArray(P.before.start, P.before.end);
  const dA = dateRangeArray(P.after.start, P.after.end);
  const needRain = !isRain && document.getElementById("evRain").value;
  try { await hyEnsureWithNote(resultEl, needRain ? [state.dataType, "rainfall"] : state.dataType, evYearSpan(P.before.start, P.after.end)); }
  catch (e) { resultEl.innerHTML = `<p class="empty-note">${e.message}</p>`; return; }
  const sB = periodStats(series, dB), sA = periodStats(series, dA);
  const thr = currentThresholds();
  const exB = thr.map(t => exceedStats(series, dB, t.value));
  const exA = thr.map(t => exceedStats(series, dA, t.value));
  const rsId = !isRain ? document.getElementById("evRain").value : "";
  const rs = rsId ? RAINFALL.find(r => r.id === rsId) : null;
  const rB = rs ? rainRefStats(rs, dB) : null, rA = rs ? rainRefStats(rs, dA) : null;

  /* ---- plain-language findings ---- */
  const notes = [];
  const sameLen = dB.length === dA.length;
  notes.push(`比較期間：治理前 ${P.before.start} ～ ${P.before.end}（${dB.length} 天），治理後 ${P.after.start} ～ ${P.after.end}（${dA.length} 天）${P.startS !== P.endC ? `；施工期 ${P.startS} ～ ${P.endC} 不列入比較` : ""}。${P.before.clipped || P.after.clipped ? "部分期間超出系統資料範圍，已截短。" : ""}${sameLen ? "" : "兩段期間長度不同，次數另以「每年換算」比較。"}`);
  thr.forEach((t, i) => {
    const b = exB[i], a = exA[i];
    const yb = b.perYear, ya = a.perYear;
    let trend = "";
    if (yb !== null && ya !== null) trend = ya < yb ? "，減少" : ya > yb ? "，增加" : "，持平";
    notes.push(`達「${escapeHtml(t.label)}」（${thrFmt(t.value)} ${unit}）的天數：治理前 ${b.count} 天（每年換算 ${fmt(yb, 1)} 天）→ 治理後 ${a.count} 天（每年換算 ${fmt(ya, 1)} 天）${trend}。`);
  });
  if (!thr.length) notes.push("尚未設定警戒值：請於上方「警戒值設定」填入，即可統計治理前後超過警戒值的天數。");
  if (rs && rB && rA && rB.annualSum !== null && rA.annualSum !== null) {
    const rc = rB.annualSum > 0 ? (rA.annualSum - rB.annualSum) / rB.annualSum : 0;
    notes.push(`參考雨量站「${rs.name_zh}」每年換算總雨量：治理前 ${fmt(rB.annualSum, 0)} mm → 治理後 ${fmt(rA.annualSum, 0)} mm（${rc >= 0 ? "+" : ""}${(rc * 100).toFixed(0)}%）；日雨量 ≥200 mm 天數 ${rB.d200} → ${rA.d200} 天。`);
    if (thr.length && exB[0].ratio !== null && exA[0].ratio !== null) {
      const yb = exB[0].ratio, ya = exA[0].ratio;
      if (ya < yb && rc <= -0.1) notes.push(`<b>判讀提醒：</b>治理後同期降雨明顯較少，超越天數減少可能部分反映降雨差異，而非全為工程成效；建議改以強度相近的颱風或豪雨事件比對（地圖模式 →「颱風事件雨量」可做 A－B 相減）。`);
      else if (ya < yb) notes.push(`<b>判讀：</b>治理後降雨未明顯減少，超越天數仍下降，較支持工程改善效果（仍需排除上游調度、河道變化等其他因素）。`);
      else if (ya > yb) notes.push(`<b>判讀提醒：</b>治理後超越天數未減少${rc > 0.1 ? "（同期降雨較多，可能是原因之一）" : ""}，建議檢視工程成效或其他影響因素。`);
    }
  }
  if (!isRain && ((sB.completeness ?? 0) < 0.8 || (sA.completeness ?? 0) < 0.8)) notes.push(`<b>注意：</b>資料完整度偏低（治理前 ${pct(sB.completeness, 0)}、治理後 ${pct(sA.completeness, 0)}），比較結果僅供參考。`);
  if (!isRain) notes.push("水位／流量為日平均值；警戒水位多以瞬時值判定，日平均超越天數可能低估實際超越次數。");
  if (isRain || rs) notes.push("雨量「每年換算」以期間日曆天數計算（年報中「-」為無降雨）。");

  /* ---- comparison table ---- */
  const rows = [];
  const row = (k, b, a, ch) => rows.push(`<tr><td>${k}</td><td class="num">${b}</td><td class="num">${a}</td><td class="num">${ch}</td></tr>`);
  if (isRain) row("有降雨紀錄天數", `${sB.count}／${dB.length} 天`, `${sA.count}／${dA.length} 天`, "");
  else row("有資料天數（完整度）", `${sB.count}／${dB.length}（${pct(sB.completeness, 0)}）`, `${sA.count}／${dA.length}（${pct(sA.completeness, 0)}）`, "");
  if (isRain) {
    row("總雨量", `${fmt(sB.sum)} mm`, `${fmt(sA.sum)} mm`, changeStr(sB.sum, sA.sum, 1, "mm"));
    row("每年換算總雨量", `${fmt(sB.annualSum, 0)} mm`, `${fmt(sA.annualSum, 0)} mm`, changeStr(sB.annualSum, sA.annualSum, 0, "mm"));
    row("最大日雨量", `${fmt(sB.max)} mm<div class="sub">${sB.maxDate || ""}</div>`, `${fmt(sA.max)} mm<div class="sub">${sA.maxDate || ""}</div>`, changeStr(sB.max, sA.max, 1, "mm"));
    row("降雨日數（≥0.1 mm）", `${sB.rainDays ?? "—"} 天`, `${sA.rainDays ?? "—"} 天`, "");
  } else {
    row("平均值", `${fmt(sB.avg, 2)} ${unit}`, `${fmt(sA.avg, 2)} ${unit}`, changeStr(sB.avg, sA.avg, 2, unit));
    row("最大值", `${fmt(sB.max, 2)} ${unit}<div class="sub">${sB.maxDate || ""}</div>`, `${fmt(sA.max, 2)} ${unit}<div class="sub">${sA.maxDate || ""}</div>`, changeStr(sB.max, sA.max, 2, unit));
    row("第 95 百分位", `${fmt(sB.p95, 2)} ${unit}`, `${fmt(sA.p95, 2)} ${unit}`, changeStr(sB.p95, sA.p95, 2, unit));
  }
  thr.forEach((t, i) => {
    const b = exB[i], a = exA[i];
    const yb = b.perYear, ya = a.perYear;
    row(`<span class="thr-dot" style="background:${t.color}"></span>≥「${escapeHtml(t.label)}」天數`, `${b.count} 天（${pct(b.ratio)}）`, `${a.count} 天（${pct(a.ratio)}）`, changeStr(b.count, a.count, 0, "天"));
    row(`　每年換算天數`, fmt(yb, 1), fmt(ya, 1), changeStr(yb, ya, 1, "天"));
    row(`　最長連續超過`, `${b.maxRun} 天${b.maxRunStart ? `<div class="sub">${b.maxRunStart} 起</div>` : ""}`, `${a.maxRun} 天${a.maxRunStart ? `<div class="sub">${a.maxRunStart} 起</div>` : ""}`, changeStr(b.maxRun, a.maxRun, 0, "天"));
  });
  if (rs) {
    row(`參考雨量「${rs.name_zh}」每年換算總雨量`, `${fmt(rB.annualSum, 0)} mm`, `${fmt(rA.annualSum, 0)} mm`, changeStr(rB.annualSum, rA.annualSum, 0, "mm"));
    row(`　日雨量 ≥80 mm 天數`, `${rB.d80} 天`, `${rA.d80} 天`, changeStr(rB.d80, rA.d80, 0, "天"));
    row(`　日雨量 ≥200 mm 天數`, `${rB.d200} 天`, `${rA.d200} 天`, changeStr(rB.d200, rA.d200, 0, "天"));
  }

  const colorB = cssVar("--series-a"), colorA = cssVar("--series-b");
  resultEl.innerHTML = `
    <div class="ev-findings">${notes.map(n => `<p>${n}</p>`).join("")}</div>
    <div class="table-scroll"><table class="data-table ev-table">
      <thead><tr><th>項目</th><th class="num"><span class="swatch" style="background:${colorB}"></span> 治理前</th><th class="num"><span class="swatch" style="background:${colorA}"></span> 治理後</th><th class="num">變化（後−前）</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
    <div class="legend-row" style="margin-top:12px;">
      <span><span class="swatch" style="background:${colorB}"></span>治理前</span>
      <span><span class="swatch" style="background:${colorA}"></span>治理後</span>
      ${P.startS !== P.endC ? `<span><span class="swatch" style="background:var(--baseline)"></span>施工期（不列入比較）</span>` : ""}
      ${thr.map(t => `<span><span class="thr-dash" style="border-color:${t.color}"></span>${escapeHtml(t.label)}</span>`).join("")}
    </div>
    <div class="chart-wrap"><canvas id="evCanvas"></canvas></div>`;

  /* ---- chart: continuous timeline before → construction → after ---- */
  const allDates = dateRangeArray(P.before.start, P.after.end);
  const inB = new Set(dB), inA = new Set(dA);
  const val = d => (series[d] !== undefined ? series[d] : null);
  const dataB = allDates.map(d => (inB.has(d) ? val(d) : null));
  const dataA = allDates.map(d => (inA.has(d) ? val(d) : null));
  const dataC = allDates.map(d => (!inB.has(d) && !inA.has(d) ? val(d) : null));
  const idx = d => allDates.indexOf(d);
  const bands = [];
  if (P.startS !== P.endC) bands.push({ from: Math.max(0, idx(P.startS)), to: idx(P.endC), color: "rgba(137,135,129,0.14)", label: "施工期" });
  const vLines = [{ index: idx(P.endC), color: cssVar("--text-secondary"), label: `完工 ${P.endC}` }];
  const type = isRain ? "bar" : "line";
  const ds = (label, data, color) => ({ label, data, type, borderColor: color, backgroundColor: isRain ? color : "transparent", pointRadius: 0, borderWidth: isRain ? 0 : 1.5, spanGaps: false, tension: 0.1 });
  const options = applyThresholdRange(chartOptions(allDates.length, isRain));
  options.plugins.legend = { display: false };
  if (evChart) evChart.destroy();
  evChart = new Chart(document.getElementById("evCanvas").getContext("2d"), {
    data: { labels: allDates, datasets: [ds("治理前", dataB, colorB), ds("施工期", dataC, cssVar("--baseline")), ds("治理後", dataA, colorA)] },
    options,
    plugins: [refLinesPlugin({ hLines: thresholdHLines(), vLines, bands })],
  });

  evLastRows = allDates.map(d => [d, inB.has(d) ? "治理前" : inA.has(d) ? "治理後" : "施工期", val(d) ?? "", rs ? (rs.daily[d] ?? "") : ""]);
}

function exportEvalCsv() {
  if (!evLastRows) { alert("請先執行治理前後評估"); return; }
  const st = getStationById(state.stationId);
  const rsSel = document.getElementById("evRain");
  const rsName = rsSel && rsSel.value ? rsSel.options[rsSel.selectedIndex].text.split("（")[0] : "";
  downloadCsv(`${st.name_zh}_治理前後評估_${Date.now()}.csv`,
    [["date", "period", `${state.dataType}_${UNIT[state.dataType]}`, rsName ? `參考雨量_${rsName}_mm` : "ref_rain_mm"], ...evLastRows]);
}

/* =====================================================================
   3. Project points import (CSV / GeoJSON), shown on the map, linked to evaluation
   ===================================================================== */
const PRJ_STORE = "hy_projects_v1";
let PROJECTS = safeGet(PRJ_STORE, []);
let prjLayer = null;
let prjLayerInControl = false;

const PRJ_ALIASES = {
  name: ["名稱", "工程名稱", "案名", "計畫名稱", "工程", "name", "title"],
  lon: ["經度", "lon", "lng", "long", "longitude", "wgs84_lon", "x經度"],
  lat: ["緯度", "lat", "latitude", "wgs84_lat", "y緯度"],
  x: ["x", "x坐標", "x座標", "twd97_x", "twd97x", "e", "東座標", "橫座標"],
  y: ["y", "y坐標", "y座標", "twd97_y", "twd97y", "n", "北座標", "縱座標"],
  end: ["完工日", "完工日期", "竣工日", "竣工日期", "完工", "實際完工日", "預定完工日", "end", "enddate", "completion"],
  start: ["開工日", "開工日期", "開工", "start", "startdate"],
  type: ["工程類型", "類型", "類別", "type", "category"],
};

function normHeader(h) { return String(h || "").replace(/^﻿/, "").trim().toLowerCase().replace(/[\s()（）_\-]/g, ""); }
function findCol(headers, key) {
  const aliases = PRJ_ALIASES[key].map(normHeader);
  const nh = headers.map(normHeader);
  let i = nh.findIndex(h => aliases.includes(h));
  if (i < 0 && key !== "x" && key !== "y") i = nh.findIndex(h => aliases.some(a => a.length >= 2 && h.includes(a)));
  return i;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const sep = (text.split("\n")[0].includes("\t") && !text.split("\n")[0].includes(",")) ? "\t" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}

function parseDateLoose(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^(\d{2,4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/) || s.match(/^(\d{3,4})(\d{2})(\d{2})$/);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  if (y < 1000) y += 1911; // 民國年
  const mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return dateStr(y, mo, d);
}

// TWD97 TM2 (121°E zone, GRS80) -> WGS84 lat/lon
function twd97ToWgs84(x, y) {
  const a = 6378137.0, b = 6356752.314245, lon0 = 121 * Math.PI / 180, k0 = 0.9999, dx = 250000;
  const e = Math.sqrt(1 - (b * b) / (a * a));
  x -= dx;
  const M = y / k0;
  const mu = M / (a * (1 - e * e / 4 - 3 * e ** 4 / 64 - 5 * e ** 6 / 256));
  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const fp = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const e2 = (e * a / b) ** 2;
  const C1 = e2 * Math.cos(fp) ** 2, T1 = Math.tan(fp) ** 2;
  const R1 = a * (1 - e * e) / Math.pow(1 - e * e * Math.sin(fp) ** 2, 1.5);
  const N1 = a / Math.sqrt(1 - e * e * Math.sin(fp) ** 2);
  const D = x / (N1 * k0);
  const lat = fp - (N1 * Math.tan(fp) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * e2) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(fp);
  return [lat * 180 / Math.PI, lon * 180 / Math.PI];
}

// accepts WGS84 degrees (either order) or TWD97 TM2 metres; returns [lat, lon] or null
function resolveCoords(a, b, isProjected) {
  const n1 = parseFloat(String(a).replace(/,/g, "")), n2 = parseFloat(String(b).replace(/,/g, ""));
  if (isNaN(n1) || isNaN(n2)) return null;
  // (a, b) = (lon/x, lat/y)
  if (n1 >= 116 && n1 <= 124 && n2 >= 20 && n2 <= 27) return [n2, n1];
  if (n2 >= 116 && n2 <= 124 && n1 >= 20 && n1 <= 27) return [n1, n2]; // columns swapped
  if (isProjected !== false && n1 >= 100000 && n1 <= 400000 && n2 >= 2300000 && n2 <= 2900000) return twd97ToWgs84(n1, n2);
  return null;
}

function projectsFromRows(rows) {
  const headers = rows[0];
  const ci = {};
  Object.keys(PRJ_ALIASES).forEach(k => { ci[k] = findCol(headers, k); });
  const useLonLat = ci.lon >= 0 && ci.lat >= 0;
  const useXY = ci.x >= 0 && ci.y >= 0;
  if (!useLonLat && !useXY) throw new Error("找不到座標欄位：請提供「經度、緯度」或 TWD97「X、Y」欄位");
  const out = [], bad = [];
  rows.slice(1).forEach((r, i) => {
    const c = useLonLat ? resolveCoords(r[ci.lon], r[ci.lat]) : resolveCoords(r[ci.x], r[ci.y]);
    if (!c) { bad.push(i + 2); return; }
    const attrs = {};
    headers.forEach((h, j) => { if (String(r[j] ?? "").trim() !== "") attrs[String(h).replace(/^﻿/, "").trim()] = String(r[j]).trim(); });
    out.push({
      name: ci.name >= 0 && r[ci.name] ? String(r[ci.name]).trim() : `工程點位 ${i + 1}`,
      lat: c[0], lon: c[1],
      start: ci.start >= 0 ? parseDateLoose(r[ci.start]) : null,
      end: ci.end >= 0 ? parseDateLoose(r[ci.end]) : null,
      type: ci.type >= 0 ? String(r[ci.type] || "").trim() : "",
      attrs,
    });
  });
  return { out, bad };
}

function projectsFromGeoJson(gj) {
  const feats = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [];
  const out = [], bad = [];
  feats.forEach((f, i) => {
    const g = f.geometry;
    if (!g) { bad.push(i + 1); return; }
    const pts = [];
    (function walk(c) { if (typeof c[0] === "number") pts.push(c); else c.forEach(walk); })(g.coordinates || []);
    if (!pts.length) { bad.push(i + 1); return; }
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const c = resolveCoords(mx, my);
    if (!c) { bad.push(i + 1); return; }
    const props = f.properties || {};
    const keys = Object.keys(props);
    const pick = k => { const j = findCol(keys, k); return j >= 0 ? props[keys[j]] : null; };
    out.push({
      name: String(pick("name") || `工程點位 ${i + 1}`), lat: c[0], lon: c[1],
      start: parseDateLoose(pick("start")), end: parseDateLoose(pick("end")),
      type: String(pick("type") || ""), attrs: Object.fromEntries(keys.map(k => [k, String(props[k] ?? "")])),
    });
  });
  return { out, bad };
}

async function readFileText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("big5").decode(buf); } // Excel CSV saved on Traditional Chinese Windows
}

async function importProjectFile(file) {
  const status = document.getElementById("prjStatus");
  try {
    const text = await readFileText(file);
    const isJson = /\.(geo)?json$/i.test(file.name) || /^\s*[{[]/.test(text);
    const { out, bad } = isJson ? projectsFromGeoJson(JSON.parse(text)) : projectsFromRows(parseCsv(text));
    if (!out.length) throw new Error("沒有讀到有效的工程點位");
    out.forEach(p => { p.id = `P${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; p.src = file.name; });
    PROJECTS = PROJECTS.concat(out);
    safeSet(PRJ_STORE, PROJECTS);
    status.textContent = `已匯入 ${out.length} 筆（目前共 ${PROJECTS.length} 筆）${bad.length ? `；${bad.length} 筆座標無法辨識已略過（第 ${bad.slice(0, 8).join("、")}${bad.length > 8 ? "…" : ""} 筆）` : ""}`;
    renderProjects();
    prjRefreshLayer(true);
  } catch (e) {
    status.textContent = "匯入失敗：" + e.message;
  }
}

function nearestLevelStation(p) {
  let best = null;
  RIVER.forEach(s => {
    if (s.lat === undefined || !s.ly.length) return;
    const d = haversineKm(p.lat, p.lon, s.lat, s.lon);
    if (!best || d < best.d) best = { s, d };
  });
  return best;
}

function renderProjects() {
  const el = document.getElementById("prjList");
  if (!el) return;
  document.getElementById("prjClearBtn").style.display = PROJECTS.length ? "" : "none";
  if (!PROJECTS.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="table-scroll"><table class="data-table prj-table">
    <thead><tr><th>工程名稱</th><th>類型</th><th>開工日</th><th>完工日</th><th>最近水位站（距離）</th><th>操作</th></tr></thead>
    <tbody>${PROJECTS.map(p => {
      const n = nearestLevelStation(p);
      return `<tr data-id="${p.id}">
        <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.type || "—")}</td><td>${p.start || "—"}</td><td>${p.end || "—"}</td>
        <td>${n ? `${escapeHtml(n.s.name_zh)}（${n.d.toFixed(1)} km）${n.d > 10 ? ' <span class="badge">距離偏遠</span>' : ""}` : "—"}</td>
        <td class="prj-actions"><button class="ghost" data-act="map" type="button">地圖</button><button class="ghost" data-act="eval" type="button">治理前後評估</button><button class="ghost" data-act="del" type="button" aria-label="刪除">✕</button></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

function prjPopupHtml(p) {
  const n = nearestLevelStation(p);
  const attrs = Object.entries(p.attrs || {}).slice(0, 14).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("");
  return `<div class="prj-popup"><b>${escapeHtml(p.name)}</b>
    <div>${p.start ? `開工 ${p.start}　` : ""}${p.end ? `完工 ${p.end}` : ""}</div>
    ${n ? `<div>最近水位站：${escapeHtml(n.s.name_zh)}（${n.d.toFixed(1)} km）</div>` : ""}
    <table>${attrs}</table>
    <button class="ghost" type="button" data-prj-eval="${p.id}">治理前後評估</button></div>`;
}

function prjRefreshLayer(show) {
  if (typeof leafletMap === "undefined" || !leafletMap || !layersControlRef) return; // built when the map is first opened
  if (!prjLayer) prjLayer = L.featureGroup();
  prjLayer.clearLayers();
  PROJECTS.forEach(p => {
    const icon = L.divIcon({ className: "project-icon", html: "<span></span>", iconSize: [14, 14], iconAnchor: [7, 7] });
    const m = L.marker([p.lat, p.lon], { icon, zIndexOffset: 1000 }).bindTooltip(`治理工程：${p.name}${p.end ? `（完工 ${p.end}）` : ""}`).bindPopup(prjPopupHtml(p), { maxWidth: 320 });
    m.prjId = p.id;
    prjLayer.addLayer(m);
  });
  if (!prjLayerInControl && PROJECTS.length) { layersControlRef.addOverlay(prjLayer, "治理工程點位（匯入）"); prjLayerInControl = true; }
  if (show && PROJECTS.length && !leafletMap.hasLayer(prjLayer)) prjLayer.addTo(leafletMap);
}

function prjOpenOnMap(p) {
  document.querySelector('#modeSeg button[data-mode="map"]').click();
  setTimeout(() => {
    prjRefreshLayer(true);
    leafletMap.invalidateSize();
    leafletMap.setView([p.lat, p.lon], 12, { reset: true }); // immediate: an animated zoom would be cancelled by the popup auto-pan
    prjLayer.eachLayer(m => { if (m.prjId === p.id) m.openPopup(); });
    document.getElementById("mapCanvas").scrollIntoView({ behavior: "smooth", block: "center" });
  }, 150);
}

function prjEvaluate(p) {
  const n = nearestLevelStation(p);
  if (!n) { alert("找不到有座標的水位站"); return; }
  document.querySelector('#dataTypeSeg button[data-type="level"]').click();
  document.querySelector('#regionSeg button[data-region="all"]').click();
  document.getElementById("stationSearch").value = "";
  renderStationOptions();
  state.stationId = n.s.id;
  document.getElementById("stationSelect").value = n.s.id;
  renderStationInfo();
  document.querySelector('#modeSeg button[data-mode="eval"]').click();
  if (p.end) document.getElementById("evEnd").value = p.end;
  document.getElementById("evStart").value = p.start && p.start <= (p.end || p.start) ? p.start : "";
  document.getElementById("evProjectNote").innerHTML = `評估對象：<b>${escapeHtml(p.name)}</b>，最近水位站「${escapeHtml(n.s.name_zh)}」距離 ${n.d.toFixed(1)} km${n.d > 10 ? "（距離偏遠，請確認該站是否位於工程影響範圍）" : ""}。${p.end ? "" : "此工程未提供完工日，請手動輸入。"}`;
  if (p.end) runEval(); else document.getElementById("evResult").innerHTML = "";
  document.getElementById("evalPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function downloadProjectTemplate() {
  downloadCsv("治理工程點位_範本.csv", [
    ["名稱", "經度", "緯度", "開工日", "完工日", "工程類型", "經費(千元)", "備註"],
    ["範例排水改善工程（請刪除此列）", "120.2140", "23.0010", "2021/03/01", "2022/06/30", "排水改善", "12000", "座標可改用 TWD97 X、Y 欄位"],
    ["範例護岸工程（請刪除此列）", "120.6500", "24.1500", "111/01/10", "111/12/20", "護岸", "8500", "日期可用民國年"],
  ]);
}

/* ---------- wiring ---------- */
function evOnEnter() {
  evPopulateRain();
  const e = document.getElementById("evEnd");
  if (!e.value) e.value = "2022-06-30";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("evBtn").addEventListener("click", runEval);
  document.getElementById("evCsvBtn").addEventListener("click", exportEvalCsv);
  document.getElementById("prjFile").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (f) importProjectFile(f);
    e.target.value = "";
  });
  document.getElementById("prjTemplateBtn").addEventListener("click", downloadProjectTemplate);
  document.getElementById("prjClearBtn").addEventListener("click", () => {
    if (!PROJECTS.length) return;
    PROJECTS = [];
    safeSet(PRJ_STORE, PROJECTS);
    renderProjects();
    prjRefreshLayer(false);
    document.getElementById("prjStatus").textContent = "已清除所有匯入的工程點位";
  });
  document.getElementById("prjList").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const p = PROJECTS.find(q => q.id === btn.closest("tr").dataset.id);
    if (!p) return;
    if (btn.dataset.act === "map") prjOpenOnMap(p);
    else if (btn.dataset.act === "eval") prjEvaluate(p);
    else if (btn.dataset.act === "del") {
      PROJECTS = PROJECTS.filter(q => q.id !== p.id);
      safeSet(PRJ_STORE, PROJECTS);
      renderProjects();
      prjRefreshLayer(false);
    }
  });
  // evaluate button inside map popups
  document.getElementById("mapCanvas").addEventListener("click", e => {
    const b = e.target.closest("[data-prj-eval]");
    if (!b) return;
    const p = PROJECTS.find(q => q.id === b.dataset.prjEval);
    if (p) prjEvaluate(p);
  });
  renderProjects();
  if (PROJECTS.length) document.getElementById("prjStatus").textContent = `已載入先前匯入的 ${PROJECTS.length} 筆工程點位`;
});

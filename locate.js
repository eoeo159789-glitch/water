/* ---------- 定位：座標／地址定位（地圖）與工程位置定位（治理前後評估） ----------
   Coordinates: decimal degrees (either order), degrees-minutes-seconds, or TM2 metres (TWD97 / TWD67).
   Names: yearbook / CWA station names and county names work offline; street addresses are looked up
   with the OpenStreetMap Nominatim service and need an internet connection. */

// TWD67 TM2 -> TWD97 TM2 (Taiwan main island; commonly used empirical formula, about ±2 m)
function twd67ToTwd97(x, y) {
  const A = 0.00001549, B = 0.000006521;
  return [x + 807.8 + A * x + B * y, y - 248.6 + A * y - B * x];
}

// WGS84 (≈TWD97) lat/lon -> TWD97 TM2 (121°E, k0 0.9999, false easting 250 km)
function wgs84ToTwd97(lat, lon) {
  const a = 6378137.0, f = 1 / 298.257222101, k0 = 0.9999, lon0 = 121 * Math.PI / 180, dx = 250000;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2;
  const A = (lam - lon0) * Math.cos(phi);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = dx + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [x, y];
}

const inLat = v => v >= 21.5 && v <= 26.6, inLon = v => v >= 118 && v <= 122.5;
const inTmX = v => v >= 100000 && v <= 400000, inTmY = v => v >= 2400000 && v <= 2850000;

/* text -> {lat, lon, how} | null */
function locParseCoords(text, datum) {
  const t = String(text || "").trim();
  if (!t) return null;
  // degrees-minutes-seconds: 23°26'19.6"N 120°36'21"E  /  23度26分19秒, 120度36分21秒
  if (/[°度′'’″"NSEWnsew北東]/.test(t) && /\d/.test(t)) {
    const parts = t.replace(/[NSEWnsew北南東西]/g, m => m + "|").split(/[|,，;；]+|\s{2,}/).map(x => x.trim()).filter(x => /\d/.test(x));
    const vals = parts.map(p => {
      const n = (p.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      if (!n.length) return null;
      return n[0] + (n[1] || 0) / 60 + (n[2] || 0) / 3600;
    }).filter(v => v !== null);
    if (vals.length === 2) {
      const [p, q] = vals;
      if (inLat(p) && inLon(q)) return { lat: p, lon: q, how: "經緯度（度分秒）" };
      if (inLat(q) && inLon(p)) return { lat: q, lon: p, how: "經緯度（度分秒）" };
    }
  }
  // plain numbers; "250,000.5" style thousands separators allowed for TM2 metres
  const withThousands = (t.match(/(?<![\d.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d])/g) || []).map(s => Number(s.replace(/,/g, "")));
  const plain = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  for (const nums of [withThousands, plain]) {
    if (nums.length < 2) continue;
    const [p, q] = nums;
    if (inLat(p) && inLon(q)) return { lat: p, lon: q, how: "經緯度（WGS84）" };
    if (inLat(q) && inLon(p)) return { lat: q, lon: p, how: "經緯度（WGS84）" };
    let x = null, y = null;
    if (inTmX(p) && inTmY(q)) { x = p; y = q; } else if (inTmX(q) && inTmY(p)) { x = q; y = p; }
    if (x !== null) {
      const d67 = datum === "twd67";
      if (d67) [x, y] = twd67ToTwd97(x, y);
      const [lat, lon] = twd97ToWgs84(x, y);
      return { lat, lon, how: d67 ? "TWD67 二度分帶（已轉 TWD97）" : "TWD97 二度分帶" };
    }
  }
  return null;
}

/* ---------- names that work offline ---------- */
let LOC_COUNTIES = null;
function locCounties() {
  if (!LOC_COUNTIES) {
    try { LOC_COUNTIES = topojson.feature(COUNTIES_TOPO, COUNTIES_TOPO.objects.counties).features; } catch (e) { LOC_COUNTIES = []; }
  }
  return LOC_COUNTIES;
}
function locRingContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function locCountyAt(lat, lon) {
  for (const f of locCounties()) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      if (locRingContains(poly[0], lon, lat) && !poly.slice(1).some(h => locRingContains(h, lon, lat))) return f.properties.COUNTYNAME;
    }
  }
  return null;
}
const locNorm = s => String(s || "").replace(/臺/g, "台").replace(/\s/g, "");
function locOfflineMatches(text) {
  const q = locNorm(text);
  if (!q) return [];
  const out = [];
  const add = (label, lat, lon, kind, bounds) => out.push({ label, lat, lon, kind, bounds });
  RAINFALL.forEach(s => { if (s.lat !== undefined && (locNorm(s.name_zh) === q || s.code === text.trim())) add(`雨量站 ${s.name_zh}（${s.code}）`, s.lat, s.lon, "station"); });
  RIVER.forEach(s => { if (s.lat !== undefined && (locNorm(s.name_zh) === q || locNorm(s.name_zh).replace(/[（(].*$/, "") === q)) add(`${s.dy.length ? "流量／水位站" : "水位站"} ${s.name_zh}（${s.basin_zh || ""} ${s.code}）`, s.lat, s.lon, "station"); });
  if (typeof CWA_STATIONS !== "undefined") CWA_STATIONS.forEach(s => { if (locNorm(s[1]) === q) add(`氣象署雨量站 ${s[1]}（${s[0]}）`, s[6], s[5], "station"); });
  locCounties().forEach(f => {
    const n = f.properties.COUNTYNAME;
    if (locNorm(n) === q || locNorm(n).replace(/[縣市]$/, "") === q) {
      const b = L.geoJSON(f).getBounds();
      add(n, b.getCenter().lat, b.getCenter().lng, "county", b);
    }
  });
  return out;
}
function locCountyInText(text) {
  const q = locNorm(text);
  const f = locCounties().find(f => q.includes(locNorm(f.properties.COUNTYNAME)));
  if (!f) return null;
  const b = L.geoJSON(f).getBounds();
  return { label: `${f.properties.COUNTYNAME}（只找到縣市，未能定位到門牌）`, lat: b.getCenter().lat, lon: b.getCenter().lng, kind: "county", bounds: b };
}

/* ---------- online address lookup (OpenStreetMap Nominatim) ---------- */
async function locGeocode(text) {
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=tw&accept-language=zh-TW&q=" + encodeURIComponent(text);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const js = await r.json();
    return js.map(x => ({ label: x.display_name, lat: +x.lat, lon: +x.lon, kind: "address" }));
  } finally { clearTimeout(timer); }
}

/* one entry point: coordinates -> offline names -> online address -> county in the text */
async function locResolve(text, datum) {
  const c = locParseCoords(text, datum);
  if (c) return { hits: [{ label: `${c.how}`, lat: c.lat, lon: c.lon, kind: "coord" }], src: "coord" };
  const off = locOfflineMatches(text);
  if (off.length) return { hits: off, src: "offline" };
  let online = null, err = null;
  try { online = await locGeocode(text); } catch (e) { err = e; }
  if (online && online.length) return { hits: online, src: "online" };
  const cty = locCountyInText(text);
  if (cty) return { hits: [cty], src: "county", note: err ? "地址查詢服務無法連線（離線或被瀏覽器阻擋），只依縣市名稱定位。" : "查無此地址，只依縣市名稱定位。" };
  return { hits: [], src: "none", note: err ? "地址查詢需要網路連線（目前無法連線到 OpenStreetMap 地址服務）。離線時請改輸入經緯度或 TWD97 座標，或輸入測站名稱、縣市名稱。" : "查無結果，請改用較完整的地址、地標，或直接輸入座標。" };
}

/* ---------- nearest stations ---------- */
function locNearest(lat, lon, kind, n, maxKm) {
  const list = kind === "rain" ? RAINFALL : RIVER;
  return list.filter(s => s.lat !== undefined && (kind === "rain" || (kind === "level" ? s.ly.length : s.dy.length)))
    .map(s => ({ s, d: haversineKm(lat, lon, s.lat, s.lon) }))
    .filter(x => x.d <= (maxKm || 1e9))
    .sort((a, b) => a.d - b.d).slice(0, n);
}
function locYears(s, kind) { return kind === "rain" ? s.years : kind === "level" ? s.ly : s.dy; }

/* ---------- map marker ---------- */
let locMarker = null;
function locFmtLL(lat, lon) { return `${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
function locPopupHtml(p) {
  const [x, y] = wgs84ToTwd97(p.lat, p.lon);
  const cty = locCountyAt(p.lat, p.lon);
  const rows = [["rain", "雨量站"], ["level", "水位站"], ["discharge", "流量站"]].map(([k, lbl]) => {
    const nb = locNearest(p.lat, p.lon, k, 1)[0];
    return nb ? `<tr><td>最近${lbl}</td><td>${escapeHtml(nb.s.name_zh)}${nb.s.basin_zh && k !== "rain" ? `（${escapeHtml(nb.s.basin_zh)}）` : ""}<br><span style="color:var(--text-muted)">${hyYearRanges(locYears(nb.s, k))}</span></td><td class="num">${nb.d.toFixed(1)} km</td></tr>` : "";
  }).join("");
  return `<div class="loc-pop"><b>${escapeHtml(p.label || "定位點")}</b>
    <table>
      <tr><td>經緯度</td><td colspan="2">${locFmtLL(p.lat, p.lon)}</td></tr>
      <tr><td>TWD97</td><td colspan="2">X ${x.toFixed(1)}，Y ${y.toFixed(1)}</td></tr>
      ${cty ? `<tr><td>縣市</td><td colspan="2">${cty}</td></tr>` : ""}
      ${rows}
    </table>
    <div class="loc-actions">
      <button class="primary" type="button" data-loc-act="eval">以此點做治理前後評估</button>
      <button type="button" data-loc-act="copy">複製座標</button>
    </div></div>`;
}
function locShow(p, opts) {
  const map = ensureMap();
  if (locMarker) map.removeLayer(locMarker);
  const icon = L.divIcon({ className: "", html: '<div class="loc-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  locMarker = L.marker([p.lat, p.lon], { icon, zIndexOffset: 1000, keyboard: false }).addTo(map);
  locMarker.bindPopup(locPopupHtml(p), { maxWidth: 320, autoPanPadding: [30, 30] });
  locMarker._loc = p;
  if (p.bounds) map.fitBounds(p.bounds, { animate: false, padding: [20, 20] });
  else map.setView([p.lat, p.lon], Math.max(map.getZoom(), (opts && opts.zoom) || 13), { animate: false });
  locMarker.openPopup();
}
function locClear() {
  if (locMarker && leafletMap) leafletMap.removeLayer(locMarker);
  locMarker = null;
  document.getElementById("locStatus").classList.remove("err");
}

function locSetStatus(el, html, err) { el.innerHTML = html; el.classList.toggle("err", !!err); }

async function locRun() {
  const text = document.getElementById("locQuery").value.trim();
  const st = document.getElementById("locStatus");
  if (!text) { locSetStatus(st, "請輸入座標、地址或地名。", true); return; }
  locSetStatus(st, "定位中…");
  const res = await locResolve(text, document.getElementById("locDatum").value);
  if (!res.hits.length) { locSetStatus(st, res.note, true); return; }
  if (res.hits.length === 1) {
    locShow(res.hits[0]);
    locSetStatus(st, `已定位：${escapeHtml(res.hits[0].label)}${res.src === "online" ? "（OpenStreetMap 地址服務，精度依門牌資料而定，請核對位置）" : ""}${res.note ? "｜" + res.note : ""}`);
    return;
  }
  locSetStatus(st, `找到 ${res.hits.length} 個結果，請選擇：<ul class="loc-cand">${res.hits.map((h, i) =>
    `<li><button type="button" data-loc-i="${i}">定位</button>${escapeHtml(h.label)}</li>`).join("")}</ul>`);
  st._hits = res.hits;
}

/* ---------- 治理前後評估：工程位置 ---------- */
let EV_POINT = null;          // {lat, lon, label}
let evLocHits = [];
function evNeededYears() {
  const P = evPeriods();
  if (P.error) return null;
  const span = (a, b) => { const o = []; for (let y = +a.slice(0, 4); y <= +b.slice(0, 4); y++) o.push(y); return o; };
  return { before: span(P.before.start, P.before.end), after: span(P.after.start, P.after.end), P };
}
function evCoverage(s, kind, need) {
  const ys = new Set(locYears(s, kind).map(Number));
  if (!need) return { cls: "cov-part", text: "請先輸入完工日", ok: false, score: 1 };
  const b = need.before.filter(y => ys.has(y)).length / need.before.length;
  const a = need.after.filter(y => ys.has(y)).length / need.after.length;
  if (b > 0 && a > 0) return { cls: b === 1 && a === 1 ? "cov-ok" : "cov-part", text: b === 1 && a === 1 ? "施工前後皆有資料" : "施工前後部分年份有資料", ok: true, score: 2 + (b === 1 && a === 1 ? 1 : 0) };
  if (b > 0) return { cls: "cov-no", text: "只有施工前資料", ok: false, score: 0 };
  if (a > 0) return { cls: "cov-no", text: "只有施工後資料", ok: false, score: 0 };
  return { cls: "cov-no", text: "比較期間無資料", ok: false, score: 0 };
}
function evRenderStationList(autoPick) {
  const el = document.getElementById("evLocList");
  if (!EV_POINT) { el.innerHTML = ""; return; }
  const kind = document.getElementById("evLocType").value;
  const need = evNeededYears();
  evLocHits = locNearest(EV_POINT.lat, EV_POINT.lon, kind, 12, 40).map(x => ({ ...x, cov: evCoverage(x.s, kind, need) }));
  if (!evLocHits.length) { el.innerHTML = `<p class="empty-note" style="text-align:left;padding:4px 0;">40 公里內沒有${kind === "level" ? "水位" : "流量"}站。</p>`; return null; }
  const best = evLocHits.find(x => x.cov.ok) || null;
  el.innerHTML = `<div class="table-scroll"><table class="data-table ev-st-table">
    <thead><tr><th>${kind === "level" ? "水位" : "流量"}站</th><th>流域／河川</th><th class="num">距離</th><th>資料年份</th><th>比較期間資料</th><th></th></tr></thead>
    <tbody>${evLocHits.map((x, i) => `<tr data-i="${i}"${state.stationId === x.s.id && state.dataType === kind ? ' class="sel"' : ""}>
      <td class="c-name">${escapeHtml(x.s.name_zh)}（${escapeHtml(x.s.code || "")}）</td>
      <td data-label="流域／河川">${escapeHtml(x.s.basin_zh || "—")}${x.s.tributary_zh && x.s.tributary_zh !== x.s.basin_zh ? "／" + escapeHtml(x.s.tributary_zh) : ""}</td>
      <td class="num" data-label="距離">${x.d.toFixed(1)} km</td>
      <td data-label="資料年份">${hyYearRanges(locYears(x.s, kind))}</td>
      <td class="${x.cov.cls}" data-label="比較期間">${x.cov.text}</td>
      <td class="c-act"><button class="ghost" type="button" data-ev-pick="${i}">${x === best ? "選用（建議）" : "選用"}</button></td></tr>`).join("")}</tbody></table></div>
    <p class="loc-status">「建議」為距離最近且施工前後皆有資料的測站。最近的測站不一定位於工程所在的同一條河川或其下游，請依流域／河川欄核對；流量站較水位站少，距離可能較遠。</p>`;
  if (autoPick && best) evPickStation(best);
  return best;
}
function evPickStation(x) {
  const kind = document.getElementById("evLocType").value;
  document.querySelector(`#dataTypeSeg button[data-type="${kind}"]`).click();
  document.querySelector('#regionSeg button[data-region="all"]').click();
  document.getElementById("stationSearch").value = "";
  renderStationOptions();
  state.stationId = x.s.id;
  document.getElementById("stationSelect").value = x.s.id;
  renderStationInfo();
  const far = x.d > 10 ? "（距離較遠，請確認該站是否受工程影響）" : "";
  document.getElementById("evProjectNote").innerHTML = `工程位置：${escapeHtml(EV_POINT.label)}（${locFmtLL(EV_POINT.lat, EV_POINT.lon)}）；評估測站：<b>${escapeHtml(x.s.name_zh)}</b>${TYPE_LABEL[kind]}站（${escapeHtml(x.s.basin_zh || "")}${x.s.tributary_zh && x.s.tributary_zh !== x.s.basin_zh ? "／" + escapeHtml(x.s.tributary_zh) : ""}），距工程 ${x.d.toFixed(1)} km${far}。`;
  evRenderStationList(false);
  if (document.getElementById("evEnd").value) runEval();
}
async function evLocRun(autoPick) {
  const text = document.getElementById("evLocQuery").value.trim();
  const st = document.getElementById("evLocStatus");
  if (!text) { locSetStatus(st, "請輸入工程座標或地址。", true); return; }
  locSetStatus(st, "定位中…");
  const res = await locResolve(text, document.getElementById("evLocDatum").value);
  if (!res.hits.length) { locSetStatus(st, res.note, true); return; }
  const h = res.hits[0];
  EV_POINT = { lat: h.lat, lon: h.lon, label: h.kind === "coord" ? "工程座標" : h.label };
  document.getElementById("evLocClear").style.display = "";
  const [x, y] = wgs84ToTwd97(h.lat, h.lon);
  const cty = locCountyAt(h.lat, h.lon);
  locSetStatus(st, `工程位置：${escapeHtml(h.kind === "coord" ? h.label : h.label)} → ${locFmtLL(h.lat, h.lon)}（TWD97 X ${x.toFixed(0)}，Y ${y.toFixed(0)}）${cty ? "，" + cty : ""}${res.hits.length > 1 ? `；另有 ${res.hits.length - 1} 個相近結果，若位置不對請輸入更完整的地址或改用座標` : ""}${res.note ? "｜" + res.note : ""}`);
  evPopulateRain();
  const best = evRenderStationList(autoPick);
  if (autoPick && !best && evLocHits.length) locSetStatus(st, st.innerHTML + "｜附近測站都沒有涵蓋施工前後的資料，請確認完工日或改選測站類型。", false);
}
function evLocClearAll() {
  EV_POINT = null;
  evLocHits = [];
  document.getElementById("evLocList").innerHTML = "";
  document.getElementById("evLocClear").style.display = "none";
  locSetStatus(document.getElementById("evLocStatus"), "已清除工程位置；參考雨量站改依所選測站位置排序。");
  evPopulateRain();
}
// from the map popup: evaluate at a clicked / located point
function locGoEval(p) {
  document.querySelector('#modeSeg button[data-mode="eval"]').click();
  document.getElementById("evLocQuery").value = locFmtLL(p.lat, p.lon);
  document.getElementById("evLocDatum").value = "twd97";
  evLocRun(true);
  document.getElementById("evalPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("locBtn").addEventListener("click", locRun);
  document.getElementById("locQuery").addEventListener("keydown", e => { if (e.key === "Enter") locRun(); });
  document.getElementById("locClear").addEventListener("click", () => { locClear(); document.getElementById("locQuery").value = ""; });
  document.getElementById("locStatus").addEventListener("click", e => {
    const b = e.target.closest("button[data-loc-i]");
    const hits = document.getElementById("locStatus")._hits;
    if (b && hits) { const h = hits[+b.dataset.locI]; locShow(h); locSetStatus(document.getElementById("locStatus"), `已定位：${escapeHtml(h.label)}`); }
  });
  // buttons inside the marker popup
  document.getElementById("mapCanvas").addEventListener("click", e => {
    const b = e.target.closest("button[data-loc-act]");
    if (!b || !locMarker) return;
    const p = locMarker._loc;
    if (b.dataset.locAct === "eval") locGoEval(p);
    else if (b.dataset.locAct === "copy") {
      const txt = locFmtLL(p.lat, p.lon);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { b.textContent = "已複製"; }, () => { b.textContent = txt; });
    }
  });
  document.getElementById("evLocBtn").addEventListener("click", () => evLocRun(true));
  document.getElementById("evLocQuery").addEventListener("keydown", e => { if (e.key === "Enter") evLocRun(true); });
  document.getElementById("evLocClear").addEventListener("click", evLocClearAll);
  document.getElementById("evLocType").addEventListener("change", () => { if (EV_POINT) evRenderStationList(true); });
  document.getElementById("evLocList").addEventListener("click", e => {
    const b = e.target.closest("button[data-ev-pick]");
    if (b) evPickStation(evLocHits[+b.dataset.evPick]);
  });
  // completion date / window changed: refresh the coverage column
  ["evEnd", "evStart", "evWindow"].forEach(id => document.getElementById(id).addEventListener("change", () => { if (EV_POINT) evRenderStationList(false); }));
});

// right-click (long-press on phones) on the map: coordinates of that point
function locAttachMap(map) {
  map.on("contextmenu", ev => locShow({ lat: ev.latlng.lat, lon: ev.latlng.lng, label: "地圖點選位置" }, { zoom: map.getZoom() }));
}

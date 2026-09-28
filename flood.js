/* ---------- 淹水潛勢圖（經濟部水利署，定量降雨情境）----------
   Data: flood/index.js (FLOOD_INDEX: which scenarios are bundled) + flood/flood_<h>h_<mm>.js,
   each calling FLOOD_DATA(key, {cities, towns, f:[[class, cityIdx, townIdx, areaHa, polys]], ...}).
   Rings are delta-encoded integers at 1e-5 degree (lon, lat interleaved). Loaded on demand via
   <script> injection so the page still works when opened from file:// without a server.

   Rendering: the largest scenario has ~3 million vertices, far too many for Leaflet vector
   objects. The data are decoded once into typed arrays of Web-Mercator coordinates (zoom-0 pixel
   units) and drawn by a single custom canvas layer: only polygons inside the view are drawn,
   vertices closer than ~0.6 px are merged, and polygons smaller than ~2 px are drawn as a dot. */

// all 10 official 定量降雨 scenarios; only those listed in FLOOD_INDEX are selectable
const FLOOD_SCENARIOS = [
  [6, 150], [6, 250], [6, 350],
  [12, 200], [12, 300], [12, 400],
  [24, 200], [24, 350], [24, 500], [24, 650],
];
const FLOOD_CLASSES = [
  { c: 1, label: "0.3–0.5 m", color: "#b4d8f0" },
  { c: 2, label: "0.5–1.0 m", color: "#6baed6" },
  { c: 3, label: "1.0–2.0 m", color: "#2b7bba" },
  { c: 4, label: "2.0–3.0 m", color: "#0b4a8f" },
  { c: 5, label: "3.0 m 以上", color: "#4a1486" },
];
const FLOOD_CLASS_BY = Object.fromEntries(FLOOD_CLASSES.map(k => [k.c, k]));
const FLOOD_OUTLINE = "#0a2a5c"; // dark navy outline keeps polygons readable on the CWA-coloured rain raster

window.FLOOD_STORE = window.FLOOD_STORE || {};   // raw data as delivered by the data file (freed after decoding)
function FLOOD_DATA(key, d) { window.FLOOD_STORE[key] = d; }
const floodDecoded = new Map();                    // key -> decoded scenario (at most 2 kept, LRU)

let FLOOD_OPACITY = 0.7;
let floodLayer = null;          // FloodCanvasLayer instance (one, reused across scenarios)
let floodLayerKey = null;       // scenario currently shown
let floodClassMask = [false, true, true, true, true, true]; // index = depth class 1..5
let floodLegendControl = null;
let floodInControl = false;
let floodBusy = false;
let floodPopup = null;

function floodKey(h, mm) { return `${h}h_${mm}`; }
function floodIndex() { return (typeof FLOOD_INDEX !== "undefined" && FLOOD_INDEX) || {}; }
// not loadScriptOnce: a decoded scenario can be evicted, and then its file must run again
function floodLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { s.remove(); resolve(); };
    s.onerror = () => { s.remove(); reject(new Error("無法載入資料檔 " + src)); };
    document.head.appendChild(s);
  });
}
function floodSetStatus(msg) {
  const el = document.getElementById("floodStatus");
  if (el) el.textContent = msg || "";
}
function escapeHtmlFlood(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- decoding into typed arrays ---------- */
// Web Mercator at zoom 0 (256 px world), same as Leaflet's EPSG:3857 pixel space / 2^zoom
const FLOOD_R = 6378137, FLOOD_MAXLAT = 85.0511287798;
function floodMercX(lon) { return (lon + 180) / 360 * 256; }
function floodMercY(lat) {
  const s = Math.sin(Math.max(-FLOOD_MAXLAT, Math.min(FLOOD_MAXLAT, lat)) * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256;
}

function floodDecode(raw) {
  // count
  let nPoly = 0, nRing = 0, nPt = 0;
  raw.f.forEach(f => f[4].forEach(poly => { nPoly++; poly.forEach(r => { nRing++; nPt += r.length / 2; }); }));
  const xy = new Float64Array(nPt * 2);
  const ringStart = new Uint32Array(nRing + 1);   // vertex index where each ring starts
  const polyRing = new Uint32Array(nPoly + 1);    // ring index where each polygon starts
  const polyFeat = new Uint32Array(nPoly);
  const polyClass = new Uint8Array(nPoly);
  const bbox = new Float64Array(nPoly * 4);       // minX, minY, maxX, maxY (zoom-0 px)
  const feats = [];
  let pi = 0, ri = 0, vi = 0;
  raw.f.forEach((f, fi) => {
    feats.push({ c: f[0], city: raw.cities[f[1]] || "", town: raw.towns[f[2]] || "", ha: f[3] });
    f[4].forEach(poly => {
      polyRing[pi] = ri; polyFeat[pi] = fi; polyClass[pi] = f[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      poly.forEach(r => {
        ringStart[ri++] = vi;
        let X = 0, Y = 0;
        for (let i = 0; i < r.length; i += 2) {
          X += r[i]; Y += r[i + 1];
          const mx = floodMercX(X / 1e5), my = floodMercY(Y / 1e5);
          xy[vi * 2] = mx; xy[vi * 2 + 1] = my; vi++;
          if (mx < x0) x0 = mx; if (mx > x1) x1 = mx;
          if (my < y0) y0 = my; if (my > y1) y1 = my;
        }
      });
      bbox[pi * 4] = x0; bbox[pi * 4 + 1] = y0; bbox[pi * 4 + 2] = x1; bbox[pi * 4 + 3] = y1;
      pi++;
    });
  });
  ringStart[nRing] = vi; polyRing[nPoly] = ri;
  // draw order: shallow classes first so deeper ones stay on top where they touch
  const order = Uint32Array.from({ length: nPoly }, (_, i) => i).sort((a, b) => polyClass[a] - polyClass[b]);
  const pv = Array.isArray(raw.pv) && raw.pv.length === nPoly ? raw.pv : null; // village per part (see build_flood.py)
  return { key: raw.key, hours: raw.hours, mm: raw.mm, areaKm2: raw.areaKm2 || {}, feats, pv,
           xy, ringStart, polyRing, polyFeat, polyClass, bbox, order, nPoly, nPt };
}

async function floodGetScenario(key) {
  if (floodDecoded.has(key)) {               // refresh LRU position
    const d = floodDecoded.get(key); floodDecoded.delete(key); floodDecoded.set(key, d); return d;
  }
  const meta = floodIndex()[key];
  if (!meta) throw new Error("此情境的資料檔未內建");
  if (!FLOOD_STORE[key]) await floodLoadScript("flood/" + meta.file);
  const raw = FLOOD_STORE[key];
  if (!raw) throw new Error("資料檔格式不正確：" + meta.file);
  const d = floodDecode(raw);
  delete FLOOD_STORE[key];                   // the nested arrays are several times larger than the typed arrays
  floodDecoded.set(key, d);
  while (floodDecoded.size > 2) floodDecoded.delete(floodDecoded.keys().next().value);
  return d;
}

/* ---------- canvas layer ---------- */
// class colours as 32-bit RGBA words for direct pixel writes; slots 1-5 fill, 7-11 outline (mixed with navy)
function floodPalette32() {
  const le = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
  const word = (r, g, b) => le ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const o = hex(FLOOD_OUTLINE), pal = new Uint32Array(16);
  FLOOD_CLASSES.forEach(k => {
    const c = hex(k.color);
    pal[k.c] = word(c[0], c[1], c[2]);
    const m = c.map((v, i) => Math.round(v * 0.35 + o[i] * 0.65));
    pal[k.c + 6] = word(m[0], m[1], m[2]);
  });
  return pal;
}

const FloodCanvasLayer = L.Layer.extend({
  initialize(opts) { L.setOptions(this, opts); this._data = null; this._mask = floodClassMask; },
  setData(d, mask) { this._data = d; this._mask = mask.slice(); if (this._map) this._redraw(); },
  setOpacity(v) { if (this._canvas) this._canvas.style.opacity = v; },
  onAdd(map) {
    const pane = map.getPane(this.options.pane) || map.getPane("overlayPane");
    this._canvas = L.DomUtil.create("canvas", "flood-canvas leaflet-zoom-animated", pane);
    this._canvas.style.pointerEvents = "none";
    this._canvas.style.opacity = FLOOD_OPACITY;
    map.on("moveend viewreset resize", this._reset, this);
    if (map._zoomAnimated) map.on("zoomanim", this._animateZoom, this);
    map.on("click", this._onClick, this);
    this._reset();
  },
  onRemove(map) {
    L.DomUtil.remove(this._canvas); this._canvas = null;
    map.off("moveend viewreset resize", this._reset, this);
    map.off("zoomanim", this._animateZoom, this);
    map.off("click", this._onClick, this);
    if (floodPopup && map.hasLayer(floodPopup)) map.closePopup(floodPopup);
  },
  _reset() {
    const map = this._map; if (!map) return;
    const size = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    // draw a margin around the view so short drags don't reveal undrawn edges before moveend
    const pad = size.multiplyBy(0.15).round(), full = size.add(pad.multiplyBy(2));
    const tl = map.containerPointToLayerPoint(pad.multiplyBy(-1));
    this._pad = pad; this._full = full;
    this._bounds = L.latLngBounds(map.containerPointToLatLng(pad.multiplyBy(-1)), map.containerPointToLatLng(size.add(pad)));
    L.DomUtil.setPosition(this._canvas, tl);
    this._canvas.width = Math.round(full.x * dpr); this._canvas.height = Math.round(full.y * dpr);
    this._canvas.style.width = full.x + "px"; this._canvas.style.height = full.y + "px";
    this._redraw();
  },
  _animateZoom(e) {
    const scale = this._map.getZoomScale(e.zoom);
    const offset = this._map._latLngBoundsToNewLayerBounds(this._bounds, e.zoom, e.center).min;
    L.DomUtil.setTransform(this._canvas, offset, scale);
  },
  _redraw() {
    const map = this._map, cv = this._canvas, d = this._data;
    if (!map || !cv) return;
    const ctx = cv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!d) return;
    const t0 = performance.now();
    // Everything is rasterised here in JS into one pixel buffer (scanline fill, even-odd per polygon)
    // and composited with a single drawImage: canvas vector fills of 10^5 small polygons are far slower.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const GW = cv.width, GH = cv.height;                               // canvas backing store = device px
    const k = GW / (this._full ? this._full.x : GW);                   // CSS px -> buffer px
    const scale = Math.pow(2, map.getZoom()) * k;                      // zoom-0 px -> buffer px
    const org = map.getPixelBounds().min.subtract(this._pad || L.point(0, 0)).multiplyBy(k);
    const vx0 = (org.x - 2) / scale, vy0 = (org.y - 2) / scale;
    const vx1 = (org.x + GW + 2) / scale, vy1 = (org.y + GH + 2) / scale;
    const minPx = 0.5 / scale;                                         // merge vertices closer than this
    const dot = 2 / scale;                                             // polygons smaller than this -> dot
    const outline = map.getZoom() >= 12;
    const { xy, ringStart, polyRing, polyClass, bbox, order } = d;

    if (!this._cls || this._cls.length !== GW * GH) {
      this._cls = new Uint8Array(GW * GH);
      this._img = ctx.createImageData(GW, GH);
      this._offCanvas = document.createElement("canvas"); this._offCanvas.width = GW; this._offCanvas.height = GH;
    }
    const cls = this._cls; cls.fill(0);
    // scratch edge arrays (grown on demand)
    let ex = this._ex || (this._ex = new Float64Array(4096)), ey0 = this._ey0 || (this._ey0 = new Float64Array(4096));
    let ey1 = this._ey1 || (this._ey1 = new Float64Array(4096)), eslope = this._es || (this._es = new Float64Array(4096));
    const xs = this._xs || (this._xs = new Float64Array(65536));
    let drawn = 0, verts = 0, nDots = 0;

    for (let oi = 0; oi < order.length; oi++) {
      const p = order[oi], c = polyClass[p];
      if (!this._mask[c]) continue;
      const b = p * 4;
      if (bbox[b] > vx1 || bbox[b + 2] < vx0 || bbox[b + 1] > vy1 || bbox[b + 3] < vy0) continue;
      drawn++;
      if (bbox[b + 2] - bbox[b] < dot && bbox[b + 3] - bbox[b + 1] < dot) {
        // sub-pixel polygon: 2x2 dot (scaled with dpr) so it stays visible
        const s2 = dpr > 1.5 ? 3 : 2;
        const gx = (((bbox[b] + bbox[b + 2]) / 2 * scale - org.x) | 0) - (s2 >> 1);
        const gy = (((bbox[b + 1] + bbox[b + 3]) / 2 * scale - org.y) | 0) - (s2 >> 1);
        for (let yy = gy; yy < gy + s2; yy++) {
          if (yy < 0 || yy >= GH) continue;
          const row = yy * GW;
          for (let xx = gx; xx < gx + s2; xx++) if (xx >= 0 && xx < GW) cls[row + xx] = c;
        }
        nDots++;
        continue;
      }
      // build the edge list in buffer pixels
      let ne = 0, pymin = Infinity, pymax = -Infinity;
      for (let r = polyRing[p]; r < polyRing[p + 1]; r++) {
        const s = ringStart[r], e = ringStart[r + 1];
        let fx = xy[s * 2] * scale - org.x, fy = xy[s * 2 + 1] * scale - org.y;
        let lx = fx, ly = fy, lwx = xy[s * 2], lwy = xy[s * 2 + 1];
        for (let v = s + 1; v <= e; v++) {
          let x, y;
          if (v === e) { x = fx; y = fy; }
          else {
            const wx = xy[v * 2], wy = xy[v * 2 + 1];
            if (v < e - 1 && Math.abs(wx - lwx) < minPx && Math.abs(wy - lwy) < minPx) continue;
            lwx = wx; lwy = wy; x = wx * scale - org.x; y = wy * scale - org.y;
          }
          verts++;
          if (y !== ly) {
            if (ne >= ex.length) {
              const g = n => { const t = new Float64Array(n.length * 2); t.set(n); return t; };
              ex = this._ex = g(ex); ey0 = this._ey0 = g(ey0); ey1 = this._ey1 = g(ey1); eslope = this._es = g(eslope);
            }
            const up = y > ly;
            ey0[ne] = up ? ly : y; ey1[ne] = up ? y : ly;
            eslope[ne] = (x - lx) / (y - ly);
            ex[ne] = up ? lx : x;
            if (ey0[ne] < pymin) pymin = ey0[ne]; if (ey1[ne] > pymax) pymax = ey1[ne];
            ne++;
          }
          lx = x; ly = y;
        }
      }
      if (!ne) continue;
      // scanline fill at pixel centres, even-odd rule
      const r0 = Math.max(0, Math.ceil(pymin - 0.5)), r1 = Math.min(GH - 1, Math.floor(pymax - 0.5));
      let filledAny = false;
      for (let yy = r0; yy <= r1; yy++) {
        const sy = yy + 0.5;
        let n = 0;
        for (let i = 0; i < ne; i++) {
          if (sy >= ey0[i] && sy < ey1[i] && n < xs.length) xs[n++] = ex[i] + (sy - ey0[i]) * eslope[i];
        }
        if (n < 2) continue;
        const arr = xs.subarray(0, n); arr.sort();
        const row = yy * GW;
        for (let i = 0; i + 1 < n; i += 2) {
          let xa = Math.ceil(arr[i] - 0.5), xb = Math.floor(arr[i + 1] - 0.5);
          if (xa < 0) xa = 0; if (xb >= GW) xb = GW - 1;
          if (xb >= xa) { cls.fill(c, row + xa, row + xb + 1); filledAny = true; }
        }
      }
      if (!filledAny) {                     // thin sliver: keep it visible as a single pixel
        const gx = ((bbox[b] + bbox[b + 2]) / 2 * scale - org.x) | 0, gy = ((bbox[b + 1] + bbox[b + 3]) / 2 * scale - org.y) | 0;
        if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) cls[gy * GW + gx] = c;
      }
    }

    // colourise (+ outline where the class changes) into the image buffer
    const pal = this._pal || (this._pal = floodPalette32());
    const px = new Uint32Array(this._img.data.buffer);
    const OUT = 6; // palette slot base for outline colours (class + OUT)
    for (let yy = 0, i = 0; yy < GH; yy++) {
      for (let xx = 0; xx < GW; xx++, i++) {
        const c = cls[i];
        if (!c) { px[i] = 0; continue; }
        if (outline && (xx === 0 || cls[i - 1] < c || xx === GW - 1 || cls[i + 1] < c ||
                        yy === 0 || cls[i - GW] < c || yy === GH - 1 || cls[i + GW] < c)) px[i] = pal[c + OUT];
        else px[i] = pal[c];
      }
    }
    this._offCanvas.getContext("2d").putImageData(this._img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._offCanvas, 0, 0);
    this._lastStats = { drawn, verts, nDots, ms: Math.round(performance.now() - t0) };
  },
  // click -> which polygon (deepest class first) contains the point
  hitTest(latlng) {
    const d = this._data; if (!d) return null;
    const px = floodMercX(latlng.lng), py = floodMercY(latlng.lat);
    const { xy, ringStart, polyRing, polyClass, bbox, order } = d;
    for (let oi = order.length - 1; oi >= 0; oi--) {
      const p = order[oi];
      if (!this._mask[polyClass[p]]) continue;
      const b = p * 4;
      if (px < bbox[b] || px > bbox[b + 2] || py < bbox[b + 1] || py > bbox[b + 3]) continue;
      let wind = 0;                                                   // nonzero winding, same rule as drawing
      for (let r = polyRing[p]; r < polyRing[p + 1]; r++) {
        const s = ringStart[r], e = ringStart[r + 1];
        for (let v = s, w = e - 1; v < e; w = v++) {
          const x1 = xy[w * 2], y1 = xy[w * 2 + 1], x2 = xy[v * 2], y2 = xy[v * 2 + 1];
          if (y1 <= py) { if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) wind++; }
          else if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) wind--;
        }
      }
      if (wind !== 0) return p;
    }
    return null;
  },
  _onClick(e) {
    const p = this.hitTest(e.latlng);
    if (p === null) return;
    const d = this._data, f = d.feats[d.polyFeat[p]], k = FLOOD_CLASS_BY[f.c];
    const pieces = floodPartVillages(d, p);
    const vTxt = pieces.length
      ? pieces.map(x => x.v ? `${escapeHtmlFlood(x.v.county + x.v.town + x.v.name)}` : "（村里界外）").slice(0, 4).join("、")
        + (pieces.length > 4 ? ` 等 ${pieces.length} 個村里` : "")
      : `${escapeHtmlFlood(f.city)}${escapeHtmlFlood(f.town)}`;
    const ll = floodRepPoint(d, p);
    const html = `<div class="flood-popup"><b>淹水潛勢：${k ? k.label : "—"}</b>
      <div>情境：定量降雨 ${d.hours} 小時 ${d.mm} mm</div>
      <div>${vTxt}${pieces.length > 1 ? `<span class="flood-popup-sub">（此塊跨 ${pieces.length} 個村里）</span>` : ""}</div>
      <div>此塊面積：${floodFmtHa(floodPartAreaM2(d, p) / 1e4)}</div>
      <div class="flood-popup-sub">代表點：${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}</div>
      <div class="flood-popup-note">資料：經濟部水利署淹水潛勢圖（模擬成果，實際淹水受排水設施、堤防與降雨分布影響，僅供參考）</div></div>`;
    floodPopup = L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(html).openOn(this._map);
  },
});

/* ---------- legend / show / hide ---------- */
function floodAddLegend(d) {
  if (floodLegendControl) { leafletMap.removeControl(floodLegendControl); floodLegendControl = null; }
  floodLegendControl = L.control({ position: "bottomleft" });
  floodLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend flood-legend");
    const area = d.areaKm2 || {};
    let rows = "";
    FLOOD_CLASSES.slice().reverse().forEach(k => {
      if (!floodClassMask[k.c]) return;
      const a = area[String(k.c)];
      rows += `<div class="map-legend-row"><span class="map-legend-swatch" style="background:${k.color}"></span>${k.label}${a !== undefined ? `<span class="flood-legend-area">${a.toFixed(1)} km²</span>` : ""}</div>`;
    });
    div.innerHTML = `<div class="map-legend-title">淹水潛勢 ${d.hours}h／${d.mm}mm</div><div class="map-legend-body">${rows}<div class="flood-legend-src">經濟部水利署</div></div>`;
    if (typeof wireLegendToggle === "function") wireLegendToggle(div);
    return div;
  };
  floodLegendControl.addTo(leafletMap);
}

function floodEnsureLayer() {
  if (floodLayer) return floodLayer;
  if (!leafletMap.getPane("floodPane")) {
    const p = leafletMap.createPane("floodPane");
    p.style.zIndex = 410; // above the rain raster (overlayPane 400), below markers (600) and popups
    p.style.pointerEvents = "none";
  }
  floodLayer = new FloodCanvasLayer({ pane: "floodPane" });
  return floodLayer;
}

async function floodShow() {
  if (floodBusy) return;
  if (typeof ensureMap === "function") ensureMap();
  const sel = document.getElementById("floodScenario");
  const key = sel ? sel.value : "";
  floodReadClassMask();
  if (!key) { floodSetStatus("尚未內建任何淹水潛勢資料檔。"); return; }
  floodBusy = true;
  try {
    const meta = floodIndex()[key];
    if (!floodDecoded.has(key)) {
      floodSetStatus(`載入中…（約 ${meta ? meta.sizeMB : "?"} MB，較大的情境需數秒）`);
      await new Promise(r => setTimeout(r, 30)); // let the status paint
    }
    const d = await floodGetScenario(key);
    const layer = floodEnsureLayer();
    floodLayerKey = key;
    if (floodPopup && leafletMap.hasLayer(floodPopup)) leafletMap.closePopup(floodPopup);
    if (!floodInControl && layersControlRef) { layersControlRef.addOverlay(layer, "淹水潛勢圖（水利署）"); floodInControl = true; }
    layer.setData(d, floodClassMask);
    if (!leafletMap.hasLayer(layer)) layer.addTo(leafletMap);
    floodAddLegend(d);
    floodWireLayerControlSync();
    const nShown = d.order.reduce((n, p) => n + (floodClassMask[d.polyClass[p]] ? 1 : 0), 0);
    floodSetStatus(nShown
      ? `已顯示 ${nShown.toLocaleString()} 塊淹水範圍（全臺合計 ${Object.entries(d.areaKm2).filter(([c]) => floodClassMask[+c]).reduce((s, [, a]) => s + a, 0).toFixed(1)} km²）；點選色塊可看淹水深度與所在村里。`
      : "目前沒有勾選任何淹水深度。");
  } catch (e) {
    console.error(e);
    floodSetStatus("載入失敗：" + e.message + "（請確認 flood 資料夾與網頁放在同一層）");
    const cb = document.getElementById("floodShow");
    if (cb) cb.checked = false;
  } finally {
    floodBusy = false;
  }
}

function floodHide() {
  if (floodLayer && leafletMap && leafletMap.hasLayer(floodLayer)) leafletMap.removeLayer(floodLayer);
  if (floodLegendControl) { leafletMap.removeControl(floodLegendControl); floodLegendControl = null; }
}

function applyFloodOpacity(v) {
  FLOOD_OPACITY = v;
  if (floodLayer) floodLayer.setOpacity(v);
  if (typeof pctLabel === "function") pctLabel("opFloodVal", v);
}

// keep the side-panel checkbox in sync when the layer is toggled from the map's layer control
function floodWireLayerControlSync() {
  if (typeof leafletMap === "undefined" || !leafletMap || floodWireLayerControlSync.done) return;
  floodWireLayerControlSync.done = true;
  leafletMap.on("overlayadd overlayremove", e => {
    if (e.layer !== floodLayer) return;
    const cb = document.getElementById("floodShow");
    if (cb) cb.checked = e.type === "overlayadd";
    if (e.type === "overlayadd" && floodLayerKey && floodDecoded.has(floodLayerKey)) floodAddLegend(floodDecoded.get(floodLayerKey));
    if (e.type === "overlayremove" && floodLegendControl) { leafletMap.removeControl(floodLegendControl); floodLegendControl = null; }
  });
}

function initFloodUI() {
  const sel = document.getElementById("floodScenario");
  if (!sel) return;
  const idx = floodIndex();
  let firstAvail = "";
  const groups = {};
  FLOOD_SCENARIOS.forEach(([h, mm]) => {
    const key = floodKey(h, mm);
    const has = !!idx[key];
    if (has && !firstAvail) firstAvail = key;
    const size = has ? `（${idx[key].sizeMB >= 10 ? Math.round(idx[key].sizeMB) : idx[key].sizeMB} MB）` : "（未內建）";
    (groups[h] = groups[h] || []).push(`<option value="${key}"${has ? "" : " disabled"}>${h} 小時 ${mm} mm${size}</option>`);
  });
  sel.innerHTML = Object.entries(groups).map(([h, opts]) => `<optgroup label="延時 ${h} 小時">${opts.join("")}</optgroup>`).join("");
  const pref = ["24h_350", "24h_500", "12h_300", "24h_200"].find(k => idx[k]) || firstAvail;
  if (pref) sel.value = pref;
  const nAvail = Object.keys(idx).length;
  const note = document.getElementById("floodAvail");
  if (note) note.textContent = nAvail ? `已內建 ${nAvail}／${FLOOD_SCENARIOS.length} 種情境。` : "尚未內建任何情境資料檔。";

  const cb = document.getElementById("floodShow");
  cb.addEventListener("change", () => { cb.checked ? floodShow() : (floodHide(), floodSetStatus("")); });
  sel.addEventListener("change", () => { if (cb.checked) floodShow(); });
  // depth-class checkboxes (multi-select) + all / none shortcuts
  const clsBox = document.getElementById("floodClassBox");
  if (clsBox) {
    clsBox.innerHTML = FLOOD_CLASSES.map(k => `<label class="flood-cls"><input type="checkbox" value="${k.c}" checked><span class="map-legend-swatch" style="background:${k.color}"></span>${k.label}</label>`).join("")
      + `<span class="flood-cls-btns"><button type="button" class="linkish" data-flood-cls="all">全選</button><button type="button" class="linkish" data-flood-cls="none">全不選</button><button type="button" class="linkish" data-flood-cls="deep">1 m 以上</button></span>`;
    const onCls = () => { floodReadClassMask(); if (cb.checked) floodShow(); };
    clsBox.addEventListener("change", onCls);
    clsBox.addEventListener("click", e => {
      const b = e.target.closest("button[data-flood-cls]"); if (!b) return;
      clsBox.querySelectorAll("input[type=checkbox]").forEach(i => { i.checked = b.dataset.floodCls === "all" || (b.dataset.floodCls === "deep" && +i.value >= 3); });
      onCls();
    });
  }
  floodInitExport();

  const op = document.getElementById("opFlood");
  if (op) {
    op.value = Math.round(FLOOD_OPACITY * 100);
    op.addEventListener("input", e => applyFloodOpacity(parseInt(e.target.value, 10) / 100));
    if (typeof pctLabel === "function") pctLabel("opFloodVal", FLOOD_OPACITY);
  }
  const reset = document.getElementById("opResetBtn");
  if (reset) reset.addEventListener("click", () => { if (op) op.value = 70; applyFloodOpacity(0.7); });
}

/* ---------- per-part helpers: area, representative point, villages ---------- */
function floodReadClassMask() {
  const box = document.getElementById("floodClassBox");
  if (!box) return floodClassMask;
  const m = [false, false, false, false, false, false];
  box.querySelectorAll("input[type=checkbox]").forEach(i => { if (i.checked) m[+i.value] = true; });
  floodClassMask = m;
  return m;
}
function floodMercToLatLng(x, y) {
  const lon = x / 256 * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 256))) * 180 / Math.PI;
  return [lat, lon];
}
function floodFmtHa(ha) { return ha >= 100 ? (ha / 100).toFixed(2) + " km²" : ha.toFixed(2) + " 公頃"; }
const FLOOD_M_PER_PX0 = 40075016.686 / 256;   // metres per zoom-0 px at the equator
// polygon area in m² (shoelace in Web Mercator, scaled by cos² of the latitude)
function floodPartAreaM2(d, p) {
  const { xy, ringStart, polyRing, bbox } = d;
  let a = 0;
  for (let r = polyRing[p]; r < polyRing[p + 1]; r++) {
    const s = ringStart[r], e = ringStart[r + 1];
    for (let v = s, w = e - 1; v < e; w = v++) a += xy[w * 2] * xy[v * 2 + 1] - xy[v * 2] * xy[w * 2 + 1];
  }
  const lat = floodMercToLatLng(0, (bbox[p * 4 + 1] + bbox[p * 4 + 3]) / 2)[0] * Math.PI / 180;
  // Web Mercator applies spherical formulas to GRS80 latitudes: ground area = merc area * cos²φ (1-e²) / (1-e² sin²φ)²
  const e2 = 0.00669438002290, w = 1 - e2 * Math.sin(lat) ** 2;
  return Math.abs(a) / 2 * FLOOD_M_PER_PX0 * FLOOD_M_PER_PX0 * Math.cos(lat) ** 2 * (1 - e2) / (w * w);
}
// a point guaranteed inside the polygon: midpoint of the widest interior span on the bbox's middle row
function floodRepPoint(d, p) {
  const { xy, ringStart, polyRing, bbox } = d;
  const b = p * 4;
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = bbox[b + 1] + (bbox[b + 3] - bbox[b + 1]) * f;
    const xs = [];
    for (let r = polyRing[p]; r < polyRing[p + 1]; r++) {
      const s = ringStart[r], e = ringStart[r + 1];
      for (let v = s, w = e - 1; v < e; w = v++) {
        const y1 = xy[w * 2 + 1], y2 = xy[v * 2 + 1];
        if ((y1 <= y) !== (y2 <= y)) xs.push(xy[w * 2] + (y - y1) / (y2 - y1) * (xy[v * 2] - xy[w * 2]));
      }
    }
    xs.sort((a, c) => a - c);
    let best = -1, bx = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > best) { best = xs[i + 1] - xs[i]; bx = (xs[i] + xs[i + 1]) / 2; }
    if (best > 0) return floodMercToLatLng(bx, y);
  }
  return floodMercToLatLng(xy[ringStart[polyRing[p]] * 2], xy[ringStart[polyRing[p]] * 2 + 1]);
}
function floodVillage(vi) {
  const V = typeof FLOOD_VILLAGES !== "undefined" ? FLOOD_VILLAGES : null;
  if (!V || vi < 0 || !V.v[vi]) return null;
  const r = V.v[vi];
  return { code: r[0], county: V.counties[r[1]], town: V.towns[r[2]], name: r[3] };
}
// [{vi, v, m2}] for one part, largest share first; [] if the part has no village information
function floodPartVillages(d, p) {
  if (!d.pv) return [];
  const x = d.pv[p];
  if (x === -1 || x === undefined) return [];
  if (typeof x === "number") return [{ vi: x, v: floodVillage(x), m2: null }];
  const out = [];
  for (let i = 0; i + 1 < x.length; i += 2) out.push({ vi: x[i], v: floodVillage(x[i]), m2: x[i + 1] });
  return out.sort((a, b) => b.m2 - a.m2);
}
const floodNormName = s => String(s || "").replace(/台/g, "臺");

/* ---------- export: flood-prone locations with depth ---------- */
function floodInitExport() {
  const scope = document.getElementById("floodExpScope");
  if (!scope) return;
  const cSel = document.getElementById("floodExpCounty"), tSel = document.getElementById("floodExpTown");
  const V = typeof FLOOD_VILLAGES !== "undefined" ? FLOOD_VILLAGES : null;
  if (V) {
    // county order follows village codes (north to south as in the MOI code list)
    const order = [];
    V.v.forEach(r => { if (!order.includes(r[1])) order.push(r[1]); });
    cSel.innerHTML = order.map(ci => `<option value="${escapeHtmlFlood(V.counties[ci])}">${escapeHtmlFlood(V.counties[ci])}</option>`).join("");
  } else {
    scope.querySelector('option[value="county"]').disabled = true;
  }
  const fillTowns = () => {
    if (!V) return;
    const towns = [];
    V.v.forEach(r => { if (V.counties[r[1]] === cSel.value && !towns.includes(V.towns[r[2]])) towns.push(V.towns[r[2]]); });
    tSel.innerHTML = `<option value="">全部鄉鎮市區</option>` + towns.map(t => `<option value="${escapeHtmlFlood(t)}">${escapeHtmlFlood(t)}</option>`).join("");
  };
  const sync = () => {
    const isC = scope.value === "county";
    document.getElementById("floodExpCountyWrap").style.display = isC ? "" : "none";
    document.getElementById("floodExpTownWrap").style.display = isC ? "" : "none";
    document.getElementById("floodExpMinWrap").style.display = document.getElementById("floodExpKind").value === "patch" ? "" : "none";
  };
  scope.addEventListener("change", sync);
  document.getElementById("floodExpKind").addEventListener("change", sync);
  cSel.addEventListener("change", fillTowns);
  fillTowns(); sync();
  document.getElementById("floodExpBtn").addEventListener("click", floodExport);
}

function floodExpMsg(t) { const el = document.getElementById("floodExpMsg"); if (el) el.textContent = t || ""; }

async function floodExport() {
  const key = document.getElementById("floodScenario").value;
  if (!key) { floodExpMsg("尚未內建任何情境"); return; }
  const mask = floodReadClassMask();
  const classes = FLOOD_CLASSES.filter(k => mask[k.c]);
  if (!classes.length) { floodExpMsg("請至少勾選一種淹水深度"); return; }
  const scope = document.getElementById("floodExpScope").value;
  const kind = document.getElementById("floodExpKind").value;
  const cName = document.getElementById("floodExpCounty").value, tName = document.getElementById("floodExpTown").value;
  const minHa = Math.max(0, parseFloat(document.getElementById("floodExpMin").value) || 0);
  const btn = document.getElementById("floodExpBtn");
  btn.disabled = true;
  try {
    if (!floodDecoded.has(key)) { floodExpMsg("載入情境資料中…"); await new Promise(r => setTimeout(r, 30)); }
    const d = await floodGetScenario(key);
    floodExpMsg("整理中…"); await new Promise(r => setTimeout(r, 30));
    const scen = `定量降雨${d.hours}小時${d.mm}mm`;
    // view filter (zoom-0 px)
    let vb = null;
    if (scope === "view") {
      if (typeof ensureMap === "function") ensureMap();
      const b = leafletMap.getBounds();
      vb = [floodMercX(b.getWest()), floodMercY(b.getNorth()), floodMercX(b.getEast()), floodMercY(b.getSouth())];
    }
    const inPlace = (county, town) => scope !== "county" || (floodNormName(county) === cName && (!tName || floodNormName(town) === tName));
    const { bbox, polyClass, polyFeat, nPoly } = d;
    const locOf = (p) => {                       // representative point + TWD97 + map link
      const ll = floodRepPoint(d, p);
      const xy97 = typeof wgs84ToTwd97 === "function" ? wgs84ToTwd97(ll[0], ll[1]) : ["", ""];
      return [ll[0].toFixed(6), ll[1].toFixed(6), Math.round(xy97[0]), Math.round(xy97[1]), `https://www.google.com/maps?q=${ll[0].toFixed(6)},${ll[1].toFixed(6)}`];
    };
    const unassigned = (f) => ({ county: floodNormName(f.city), town: floodNormName(f.town), name: "（村里界外）", code: "" });
    let rows, header, fname;
    if (kind === "village") {
      const acc = new Map();
      for (let p = 0; p < nPoly; p++) {
        const c = polyClass[p]; if (!mask[c]) continue;
        const b = p * 4;
        if (vb && (bbox[b] > vb[2] || bbox[b + 2] < vb[0] || bbox[b + 1] > vb[3] || bbox[b + 3] < vb[1])) continue;
        const f = d.feats[polyFeat[p]];
        let pieces = floodPartVillages(d, p);
        const total = floodPartAreaM2(d, p);
        if (!pieces.length) pieces = [{ vi: -1, v: null, m2: total }];
        else if (pieces.length === 1) pieces[0].m2 = total;
        else { const s = pieces.reduce((t, x) => t + x.m2, 0) || 1; pieces.forEach(x => { x.m2 = x.m2 / s * total; }); }
        pieces.forEach(x => {
          const v = x.v || unassigned(f);
          if (!inPlace(v.county, v.town)) return;
          const k = x.vi >= 0 ? "v" + x.vi : "u" + v.county + v.town;
          let a = acc.get(k);
          if (!a) { a = { v, area: [0, 0, 0, 0, 0, 0], n: 0, maxC: 0, best: -1, bestM2: -1 }; acc.set(k, a); }
          a.area[c] += x.m2; a.n++;
          if (c > a.maxC || (c === a.maxC && x.m2 > a.bestM2)) { a.maxC = c; a.best = p; a.bestM2 = x.m2; }
        });
      }
      const list = [...acc.values()].sort((a, b) => (a.v.code || "~" + a.v.county + a.v.town).localeCompare(b.v.code || "~" + b.v.county + b.v.town));
      header = ["情境", "縣市", "鄉鎮市區", "村里", "村里代碼", "最大淹水深度",
        ...classes.map(k => `${k.label} 面積(公頃)`), "合計淹水面積(公頃)", "淹水塊數",
        "最深處代表點_緯度", "最深處代表點_經度", "最深處代表點_TWD97_X", "最深處代表點_TWD97_Y", "Google地圖"];
      rows = list.map(a => {
        const tot = classes.reduce((t, k) => t + a.area[k.c], 0);
        return [scen, a.v.county, a.v.town, a.v.name, a.v.code, FLOOD_CLASS_BY[a.maxC].label,
          ...classes.map(k => a.area[k.c] ? (a.area[k.c] / 1e4).toFixed(2) : ""), (tot / 1e4).toFixed(2), a.n, ...locOf(a.best)];
      });
      fname = "村里彙總";
    } else {
      const items = [];
      for (let p = 0; p < nPoly; p++) {
        const c = polyClass[p]; if (!mask[c]) continue;
        const b = p * 4;
        if (vb && (bbox[b] > vb[2] || bbox[b + 2] < vb[0] || bbox[b + 1] > vb[3] || bbox[b + 3] < vb[1])) continue;
        const m2 = floodPartAreaM2(d, p);
        if (m2 / 1e4 < minHa) continue;
        const f = d.feats[polyFeat[p]];
        const pieces = floodPartVillages(d, p);
        const v = (pieces[0] && pieces[0].v) || unassigned(f);
        if (!inPlace(v.county, v.town)) continue;
        items.push({ p, c, m2, v, f, pieces });
      }
      items.sort((a, b) => (a.v.code || "~").localeCompare(b.v.code || "~") || b.c - a.c || b.m2 - a.m2);
      header = ["情境", "縣市", "鄉鎮市區", "村里（面積最大者）", "村里代碼", "淹水深度", "面積(公頃)", "跨村里（各村里面積，公頃）",
        "代表點_緯度", "代表點_經度", "代表點_TWD97_X", "代表點_TWD97_Y", "Google地圖", "水利署圖資標示縣市", "水利署圖資標示鄉鎮"];
      rows = items.map(it => {
        const tot = it.pieces.reduce((t, x) => t + (x.m2 || 0), 0) || 1;
        const cross = it.pieces.length > 1 ? it.pieces.map(x => `${x.v ? x.v.town + x.v.name : "村里界外"} ${(x.m2 / tot * it.m2 / 1e4).toFixed(2)}`).join("；") : "";
        return [scen, it.v.county, it.v.town, it.v.name, it.v.code, FLOOD_CLASS_BY[it.c].label, (it.m2 / 1e4).toFixed(2), cross,
          ...locOf(it.p), floodNormName(it.f.city), floodNormName(it.f.town)];
      });
      fname = `逐塊明細${minHa ? "_" + minHa + "公頃以上" : ""}`;
    }
    if (!rows.length) { floodExpMsg("此範圍沒有符合條件的淹水區域"); return; }
    const where = scope === "view" ? "目前畫面" : scope === "county" ? cName + (tName || "") : "全臺";
    const depthTag = classes.length === FLOOD_CLASSES.length ? "全部深度" : classes.map(k => k.label.replace(/ /g, "")).join("+");
    downloadCsv(`淹水潛勢_${d.hours}h${d.mm}mm_${fname}_${where}_${depthTag}.csv`, [header, ...rows]);
    floodExpMsg(`已匯出 ${rows.length.toLocaleString()} 列`);
  } catch (e) {
    console.error(e);
    floodExpMsg("匯出失敗：" + e.message);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", initFloodUI);

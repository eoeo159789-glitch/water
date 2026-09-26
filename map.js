/* ---------- map mode: interpolated rainfall map + river station map ---------- */

let leafletMap = null;
let mapImageOverlay = null;
let mapMarkersLayer = null;
let mapLegendControl = null;
let taiwanGeoLayer = null;
let riversLayer = null;
let countiesLayer = null;
let osmLayer = null;
let photoLayer = null;
let blankBaseLayer = null;
let rainStationsLayer = null;    // static reference layer: all rainfall station locations
let levelStationsLayer = null;   // static reference layer: all water-level station locations
let dischargeStationsLayer = null; // static reference layer: all discharge station locations
let lastHeatmapPoints = null;   // for zoom-triggered re-render (single rainfall mode)
let lastHeatmapDiverging = null; // {maxAbs} when the last heatmap was a diverging diff map
let lastHeatmapOpts = null;      // {maxDistKm} used by the last heatmap (typhoon mode uses adaptive radius)
let layersControlRef = null;     // Leaflet layer control, so later-loaded layers (typhoon stations) can be added
// white station dots on rainfall maps: user can hide them (remembered in this browser)
let SHOW_STATION_DOTS = (() => { try { return localStorage.getItem("hy_show_dots") !== "0"; } catch (e) { return true; } })();
function addDotsLayer(layer) {
  layer._isDots = true;
  if (SHOW_STATION_DOTS) layer.addTo(leafletMap);
}
function applyShowDots(v) {
  SHOW_STATION_DOTS = v;
  try { localStorage.setItem("hy_show_dots", v ? "1" : "0"); } catch (e) { /* ignore */ }
  if (mapMarkersLayer && mapMarkersLayer._isDots && leafletMap) {
    if (v) mapMarkersLayer.addTo(leafletMap); else leafletMap.removeLayer(mapMarkersLayer);
  }
}
let lastMapRows = null;         // for CSV export
let zoomRenderTimer = null;

// live-adjustable layer opacities (0-1), changed via the opacity editor panel
let HEATMAP_OPACITY = 0.85;
let RIVERS_OPACITY = 0.7;
let COUNTIES_OPACITY = 1;
let STATION_OPACITY = 0.9;

// CWA-style quantitative precipitation forecast color bins (mm), sampled from the
// official 定量降水預報 legend the user supplied. This is the fixed reset target;
// the live scale used for rendering is `activeRainBins()` (custom if the user set one).
const CWA_RAIN_BINS = [
  { min: 0.5, max: 1,        color: [189, 189, 189] },
  { min: 1,   max: 2,        color: [161, 255, 255] },
  { min: 2,   max: 5,        color: [3,   199, 254] },
  { min: 5,   max: 10,       color: [5,   142, 234] },
  { min: 10,  max: 15,       color: [3,   100, 255] },
  { min: 15,  max: 20,       color: [5,   145, 1]   },
  { min: 20,  max: 30,       color: [58,  255, 3]   },
  { min: 30,  max: 40,       color: [250, 245, 3]   },
  { min: 40,  max: 50,       color: [255, 203, 0]   },
  { min: 50,  max: 70,       color: [255, 149, 0]   },
  { min: 70,  max: 90,       color: [236, 0,   0]   },
  { min: 90,  max: 110,      color: [209, 0,   0]   },
  { min: 110, max: 130,      color: [146, 0,   0]   },
  { min: 130, max: 150,      color: [153, 0,   156] },
  { min: 150, max: 200,      color: [207, 0,   210] },
  { min: 200, max: 300,      color: [255, 0,   255] },
  { min: 300, max: Infinity, color: [255, 206, 255] },
];
let CUSTOM_RAIN_BINS = null;      // set via the color-scale editor; null = use CWA default
let RAIN_MIN_THRESHOLD = 0.5;     // mm; below this, no color is drawn
let DIVERGING_POS_COLOR = [200, 0, 0];   // period-diff "increase" color
let DIVERGING_NEG_COLOR = [0, 80, 210];  // period-diff "decrease" color

let WRA_BINS_OVERRIDE = null;   // extended bins while playing a cumulative daily animation
function activeRainBins() {
  return CUSTOM_RAIN_BINS || (state.mapmode !== "typhoon" ? WRA_BINS_OVERRIDE : null) ||
    (typeof tyActiveBins === "function" ? tyActiveBins() : null) || CWA_RAIN_BINS;
}

function rainColorFor(v) {
  if (v === null || v === undefined || v < RAIN_MIN_THRESHOLD) return null;
  const bins = activeRainBins();
  for (const bin of bins) {
    if (v < bin.max) return bin.color;
  }
  return bins[bins.length - 1].color;
}

// diverging (blue = decrease, white = ~0, red = increase) for rainfall diff heatmap
function divergingColorArr(v, maxAbs) {
  if (maxAbs <= 0) return [230, 230, 230];
  const t = Math.max(-1, Math.min(1, v / maxAbs));
  const c1 = [255, 255, 255];
  const c2 = t >= 0 ? DIVERGING_POS_COLOR : DIVERGING_NEG_COLOR;
  const tt = Math.abs(t);
  return c1.map((c, i) => Math.round(c + (c2[i] - c) * tt));
}

function round3(v) { return v === null || v === undefined ? v : Math.round(v * 1000) / 1000; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ensureMap() {
  if (leafletMap) return leafletMap;
  leafletMap = L.map("mapCanvas", { attributionControl: false, zoomControl: true, zoomSnap: 0.25 });
  L.control.attribution({ prefix: false, position: "bottomright" }).addTo(leafletMap);
  leafletMap.setView([23.6, 120.95], 8);

  taiwanGeoLayer = L.geoJSON(TAIWAN_GEO, {
    style: { color: "#898781", weight: 1, fillColor: "#cfcfc7", fillOpacity: 0.25 }
  }).addTo(leafletMap);

  // -- optional online basemaps (need internet; offline default is "no basemap") --
  blankBaseLayer = L.layerGroup(); // placeholder representing "no tile basemap"
  osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, subdomains: "abc",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors（需連線）'
  });
  photoLayer = L.tileLayer("https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}.png", {
    maxZoom: 19,
    attribution: '正射影像 &copy; <a href="https://www.nlsc.gov.tw/" target="_blank">國土測繪中心</a>（需連線）'
  });
  blankBaseLayer.addTo(leafletMap);

  try {
    const riversGeo = topojson.feature(RIVERS_TOPO, RIVERS_TOPO.objects[Object.keys(RIVERS_TOPO.objects)[0]]);
    riversLayer = L.geoJSON(riversGeo, {
      style: () => riverStyle(),
      onEachFeature: (feature, layer) => {
        const name = feature.properties && feature.properties.RIVER_NAME;
        if (name) layer.bindTooltip(name, { sticky: true });
      }
    }).addTo(leafletMap);
  } catch (e) {
    console.error("river layer failed to load", e);
  }

  try {
    const countiesGeo = topojson.feature(COUNTIES_TOPO, COUNTIES_TOPO.objects.counties);
    countiesLayer = L.geoJSON(countiesGeo, {
      style: () => countyStyle(),
      onEachFeature: (feature, layer) => {
        const name = feature.properties && feature.properties.COUNTYNAME;
        if (name) layer.bindTooltip(name, { sticky: true });
      }
    }); // off by default, toggled via layer control
  } catch (e) {
    console.error("county layer failed to load", e);
  }

  // -- static station-location reference layers (independent of any query; always the
  // full 雨量站/水位站/流量站 lists with coordinates) --
  rainStationsLayer = buildStationRefLayer(RAINFALL, "rain", s => true);
  levelStationsLayer = buildStationRefLayer(RIVER, "level", s => s.ly.length > 0);
  dischargeStationsLayer = buildStationRefLayer(RIVER, "discharge", s => s.dy.length > 0);

  const baseLayers = {
    "無底圖（離線可用）": blankBaseLayer,
    "OpenStreetMap 電子地圖（需連線）": osmLayer,
    "正射影像（需連線）": photoLayer,
  };
  const overlays = {};
  if (riversLayer) overlays["河川水系"] = riversLayer;
  if (countiesLayer) overlays["縣市界"] = countiesLayer;
  overlays["雨量站位置"] = rainStationsLayer;
  overlays["水位站位置"] = levelStationsLayer;
  overlays["流量站位置"] = dischargeStationsLayer;
  layersControlRef = L.control.layers(baseLayers, overlays, { position: "topright", collapsed: true }).addTo(leafletMap);
  addFullscreenControl(leafletMap);
  if (typeof tyAddStationRefLayer === "function") tyAddStationRefLayer(); // no-op until typhoon data is loaded
  if (typeof prjRefreshLayer === "function") prjRefreshLayer(true);     // imported project points, if any
  if (typeof locAttachMap === "function") locAttachMap(leafletMap);    // right-click / long-press: coordinates

  leafletMap.on("baselayerchange", (e) => {
    const isBlank = e.layer === blankBaseLayer;
    taiwanGeoLayer.setStyle({ fillOpacity: isBlank ? 0.25 : 0, opacity: isBlank ? 1 : 0 });
  });

  leafletMap.fitBounds(taiwanGeoLayer.getBounds(), { padding: [10, 10], animate: false });

  leafletMap.on("zoomend", () => {
    if (!lastHeatmapPoints) return;
    clearTimeout(zoomRenderTimer);
    zoomRenderTimer = setTimeout(() => {
      const { dataUrl, bounds } = renderRainfallHeatmap(lastHeatmapPoints, lastHeatmapDiverging, lastHeatmapOpts);
      if (mapImageOverlay) leafletMap.removeLayer(mapImageOverlay);
      mapImageOverlay = L.imageOverlay(dataUrl, bounds, { opacity: HEATMAP_OPACITY }).addTo(leafletMap);
      if (mapMarkersLayer) mapMarkersLayer.bringToFront();
    }, 200);
  });

  return leafletMap;
}

/* ---------- style helpers driven by the opacity editor ---------- */
function riverStyle() {
  return { color: "#2f6fb0", weight: 0.6, fillColor: "#4a90d9", fillOpacity: RIVERS_OPACITY * 0.643, opacity: RIVERS_OPACITY };
}
function countyStyle() {
  return { color: "#5a4632", weight: 1.2, fillOpacity: 0, dashArray: "4,3", opacity: COUNTIES_OPACITY };
}

const STATION_REF_STYLE = {
  rain:      { cls: "rain",      label: "雨量站" },
  level:     { cls: "level",     label: "水位站" },
  discharge: { cls: "discharge", label: "流量站" },
};

function buildStationRefLayer(stations, kind, filterFn) {
  const group = L.featureGroup();
  const meta = STATION_REF_STYLE[kind];
  stations.forEach(s => {
    if (s.lat === undefined || !filterFn(s)) return;
    const icon = L.divIcon({
      className: `station-icon ${meta.cls}`,
      html: meta.cls === "discharge" ? '<span class="tri-shape"></span>' : "",
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    const yrs = kind === "level" ? s.ly : kind === "discharge" ? s.dy : s.years;
    const m = L.marker([s.lat, s.lon], { icon, opacity: STATION_OPACITY })
      .bindTooltip(`${meta.label}：${s.name_zh}（${s.code}）<br>資料年份：${hyYearRanges(yrs)}`);
    group.addLayer(m);
  });
  return group;
}

/* ---------- fullscreen control (hand-rolled; no external plugin needed) ---------- */
function addFullscreenControl(map) {
  const FullscreenControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control leaflet-control-fullscreen");
      const link = L.DomUtil.create("a", "leaflet-control-fullscreen-btn", container);
      link.href = "#";
      link.title = "全螢幕顯示地圖";
      link.setAttribute("role", "button");
      link.innerHTML = "⛶";
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(link, "click", (e) => {
        L.DomEvent.preventDefault(e);
        toggleMapFullscreen();
      });
      return container;
    }
  });
  map.addControl(new FullscreenControl());
}

function toggleMapFullscreen() {
  const el = document.getElementById("mapCanvas");
  const isFull = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFull) {
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) req.call(el);
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) exit.call(document);
  }
}
["fullscreenchange", "webkitfullscreenchange"].forEach(evt => {
  document.addEventListener(evt, () => {
    if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 120);
  });
});

function buildMaskCanvas(width, height, minLon, maxLon, minLat, maxLat) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  const ring = TAIWAN_GEO.geometry.coordinates[0];
  ctx.beginPath();
  ring.forEach(([lon, lat], i) => {
    const x = (lon - minLon) / (maxLon - minLon) * width;
    const y = (maxLat - lat) / (maxLat - minLat) * height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  return canvas;
}

// resolution scales with current zoom level so the raster looks crisper as you zoom in
function resolutionForZoom() {
  const z = leafletMap ? leafletMap.getZoom() : 8;
  const w = Math.round(420 * Math.pow(1.35, Math.max(0, z - 8)));
  return Math.max(420, Math.min(w, 1600));
}

function renderRainfallHeatmap(points, diverging, opts) {
  // points: [{lat, lon, value}]; diverging: {maxAbs} to use a blue/red diff scale, or falsy for the CWA scale
  // opts: { maxDistKm (IDW search radius, default 22), width (raster width px, default by zoom) }
  opts = opts || {};
  const geoB = taiwanGeoLayer.getBounds();
  const minLat = geoB.getSouth() - 0.05, maxLat = geoB.getNorth() + 0.05;
  const minLon = geoB.getWest() - 0.05, maxLon = geoB.getEast() + 0.05;
  const width = opts.width || resolutionForZoom(), height = Math.round(width * (maxLat - minLat) / (maxLon - minLon));

  const raster = document.createElement("canvas");
  raster.width = width; raster.height = height;
  const rctx = raster.getContext("2d");
  const imgData = rctx.createImageData(width, height);

  const maxDistKm = opts.maxDistKm || 22;
  const power = 2;
  // cheap equirectangular approximation (Taiwan is small enough this is accurate to <0.1%)
  const latRad = (minLat + maxLat) / 2 * Math.PI / 180;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos(latRad);
  const maxDegLat = maxDistKm / kmPerDegLat;
  const maxDegLon = maxDistKm / kmPerDegLon;

  // spatial grid index: cell size = search radius, so each pixel only needs the 3x3 neighbouring
  // cells (keeps ~1,000-station typhoon maps and hourly animation fast; results identical to a full scan)
  const nx = Math.max(1, Math.ceil((maxLon - minLon) / maxDegLon));
  const ny = Math.max(1, Math.ceil((maxLat - minLat) / maxDegLat));
  const cells = Array.from({ length: nx * ny }, () => []);
  for (const p of points) {
    const gx = Math.floor((p.lon - minLon) / maxDegLon), gy = Math.floor((p.lat - minLat) / maxDegLat);
    if (gx < -1 || gy < -1 || gx > nx || gy > ny) continue; // too far outside the raster to reach any pixel
    cells[Math.min(ny - 1, Math.max(0, gy)) * nx + Math.min(nx - 1, Math.max(0, gx))].push(p);
  }

  for (let py = 0; py < height; py++) {
    const lat = maxLat - (py / height) * (maxLat - minLat);
    const gy = Math.min(ny - 1, Math.floor((lat - minLat) / maxDegLat));
    for (let px = 0; px < width; px++) {
      const lon = minLon + (px / width) * (maxLon - minLon);
      const gx = Math.min(nx - 1, Math.floor((lon - minLon) / maxDegLon));
      let wSum = 0, vSum = 0, minD = Infinity, hit = false;
      search:
      for (let cy = Math.max(0, gy - 1); cy <= Math.min(ny - 1, gy + 1); cy++) {
        for (let cx = Math.max(0, gx - 1); cx <= Math.min(nx - 1, gx + 1); cx++) {
          for (const p of cells[cy * nx + cx]) {
            const dLat = Math.abs(p.lat - lat), dLon = Math.abs(p.lon - lon);
            if (dLat > maxDegLat || dLon > maxDegLon) continue;
            const dx = dLon * kmPerDegLon, dy = dLat * kmPerDegLat;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < minD) minD = d;
            if (d < 0.05) { wSum = 1; vSum = p.value; hit = true; break search; }
            if (d <= maxDistKm) {
              const w = 1 / Math.pow(d, power);
              wSum += w; vSum += w * p.value;
            }
          }
        }
      }
      const idx = (py * width + px) * 4;
      if ((!hit && minD > maxDistKm) || wSum === 0) {
        imgData.data[idx + 3] = 0;
        continue;
      }
      const val = vSum / wSum;
      const color = diverging ? divergingColorArr(val, diverging.maxAbs) : rainColorFor(val);
      if (!color) {
        imgData.data[idx + 3] = 0;
      } else {
        imgData.data[idx] = color[0];
        imgData.data[idx + 1] = color[1];
        imgData.data[idx + 2] = color[2];
        imgData.data[idx + 3] = diverging ? 190 : 210;
      }
    }
  }
  rctx.putImageData(imgData, 0, 0);

  // clip to Taiwan polygon shape
  const mask = buildMaskCanvas(width, height, minLon, maxLon, minLat, maxLat);
  rctx.globalCompositeOperation = "destination-in";
  rctx.drawImage(mask, 0, 0);
  rctx.globalCompositeOperation = "source-over";

  return { dataUrl: raster.toDataURL(), bounds: [[minLat, minLon], [maxLat, maxLon]] };
}

function clearMapLayers() {
  if (mapImageOverlay) { leafletMap.removeLayer(mapImageOverlay); mapImageOverlay = null; }
  if (mapMarkersLayer) { leafletMap.removeLayer(mapMarkersLayer); mapMarkersLayer = null; }
  if (mapLegendControl) { leafletMap.removeControl(mapLegendControl); mapLegendControl = null; }
  lastHeatmapPoints = null;
  lastHeatmapDiverging = null;
  lastHeatmapOpts = null;
  if (typeof tyMarkers !== "undefined") tyMarkers.clear();
}

function rgbStr(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }

// legends collapse to their title on tap (default collapsed on phones so the map stays visible);
// the choice is remembered across re-renders
let legendCollapsed = typeof window !== "undefined" && window.innerWidth < 640;
function wireLegendToggle(div) {
  div.classList.toggle("collapsed", legendCollapsed);
  const title = div.querySelector(".map-legend-title");
  title.setAttribute("role", "button");
  title.setAttribute("title", "點選展開／收合圖例");
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  title.addEventListener("click", () => {
    legendCollapsed = !legendCollapsed;
    div.classList.toggle("collapsed", legendCollapsed);
  });
}

function addRainLegend(unitLabel) {
  mapLegendControl = L.control({ position: "bottomright" });
  mapLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend");
    let rows = "";
    activeRainBins().slice().reverse().forEach(bin => {
      const label = bin.max === Infinity ? `≥${bin.min}` : `${bin.min}–${bin.max}`;
      rows += `<div class="map-legend-row"><span class="map-legend-swatch" style="background:${rgbStr(bin.color)}"></span>${label}</div>`;
    });
    div.innerHTML = `<div class="map-legend-title">${unitLabel}</div><div class="map-legend-body">${rows}</div>`;
    wireLegendToggle(div);
    return div;
  };
  mapLegendControl.addTo(leafletMap);
}

function addDivergingRainLegend(title, maxAbs) {
  mapLegendControl = L.control({ position: "bottomright" });
  mapLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend");
    const steps = [1, 0.6, 0.3, 0.1, 0, -0.1, -0.3, -0.6, -1];
    let rows = "";
    steps.forEach(t => {
      const v = t * maxAbs;
      rows += `<div class="map-legend-row"><span class="map-legend-swatch" style="background:${rgbStr(divergingColorArr(v, maxAbs))}"></span>${v > 0 ? "+" : ""}${fmt(v, 1)}</div>`;
    });
    div.innerHTML = `<div class="map-legend-title">${title}</div><div class="map-legend-body">${rows}</div>`;
    wireLegendToggle(div);
    return div;
  };
  mapLegendControl.addTo(leafletMap);
}

function addValueLegend(title, colorFn, minV, maxV, unit) {
  mapLegendControl = L.control({ position: "bottomright" });
  mapLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "map-legend");
    const steps = 5;
    let rows = "";
    for (let i = steps; i >= 0; i--) {
      const v = minV + (maxV - minV) * (i / steps);
      rows += `<div class="map-legend-row"><span class="map-legend-swatch" style="background:${colorFn(v)}"></span>${fmt(v, 1)} ${unit}</div>`;
    }
    div.innerHTML = `<div class="map-legend-title">${title}</div><div class="map-legend-body">${rows}</div>`;
    wireLegendToggle(div);
    return div;
  };
  mapLegendControl.addTo(leafletMap);
}

function sequentialColor(t, hue) {
  // t in [0,1], hue: "blue" or "orange"
  t = Math.max(0, Math.min(1, t));
  if (hue === "orange") {
    const c1 = [255, 235, 205], c2 = [200, 80, 20];
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    return `rgb(${r},${g},${b})`;
  }
  const c1 = [205, 226, 251], c2 = [13, 54, 107];
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `rgb(${r},${g},${b})`;
}

function divergingColorStr(v, maxAbs) {
  return rgbStr(divergingColorArr(v, maxAbs));
}

/* ---------- per-year data files: load what a map needs first ---------- */
let mapEnsureSeq = 0;
async function mapEnsure(statusEl, kind, years) {
  const seq = ++mapEnsureSeq;
  const k = HY_KIND[kind] || kind;
  const need = years.filter(y => HY_YEARS[k].includes(y) && !HY_LOADED.has(`${k}_${y}`)).length;
  if (need) statusEl.textContent = `載入 ${need} 個年度資料檔中…`;
  try { await hyEnsure(kind, years); }
  catch (e) { statusEl.textContent = e.message; return false; }
  if (need) statusEl.textContent = "";
  return seq === mapEnsureSeq;     // a newer request started meanwhile: let that one draw
}

/* ---------- single-period map ---------- */
async function runMapQuery() {
  const map = ensureMap();
  clearMapLayers();
  const dates = currentMapDates();
  const statusEl = document.getElementById("mapStatus");
  if (dates.length === 0) { statusEl.textContent = "請輸入有效的日期範圍"; return; }
  if (!(await mapEnsure(statusEl, state.dataType, hyYearsOfDates(dates)))) return;

  if (state.dataType === "rainfall") {
    wraStopPlay(true);
    WRA_BINS_OVERRIDE = null;
    renderWraRainMap(dates, { title: "總雨量 (mm)", label: "期間總雨量" });
  } else {
    const key = state.dataType; // level | discharge
    const points = [];
    RIVER.forEach(s => {
      if (s.lat === undefined) return;
      const series = s[key];
      if (!series || Object.keys(series).length === 0) return;
      const st = aggregateForMap(series, dates);
      if (st.avg !== null) points.push({ lat: s.lat, lon: s.lon, value: st.avg, name: s.name_zh, code: s.code });
    });
    statusEl.textContent = `${points.length} 個${TYPE_LABEL[key]}測站顯示於地圖（不做空間內插，僅標示測站位置與數值；已疊加河川水系範圍供對照）`;
    if (points.length === 0) { return; }
    const vals = points.map(p => p.value);
    const minV = Math.min(...vals), maxV = Math.max(...vals);
    const hue = key === "discharge" ? "orange" : "blue";
    mapMarkersLayer = L.featureGroup();
    points.forEach(p => {
      const t = maxV > minV ? (p.value - minV) / (maxV - minV) : 0.5;
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 5 + t * 7, color: "#333", weight: 1,
        fillColor: sequentialColor(t, hue), fillOpacity: STATION_OPACITY
      }).bindTooltip(`${p.name}：${fmt(p.value, 2)} ${UNIT[key]}`);
      mapMarkersLayer.addLayer(m);
    });
    mapMarkersLayer.addTo(map);
    addValueLegend(`${TYPE_LABEL[key]} (${UNIT[key]})`, v => sequentialColor(maxV > minV ? (v - minV) / (maxV - minV) : 0.5, hue), minV, maxV, UNIT[key]);
    lastMapRows = points.map(p => [p.code || "", p.name || "", round3(p.value)]);
  }
}

/* ---------- period-subtraction (A - B) map ---------- */
async function runMapDiffQuery() {
  const map = ensureMap();
  clearMapLayers();
  const statusEl = document.getElementById("mapStatus");
  const aS = document.getElementById("mAStart").value, aE = document.getElementById("mAEnd").value;
  const bS = document.getElementById("mBStart").value, bE = document.getElementById("mBEnd").value;
  if (!aS || !aE || aS > aE || !bS || !bE || bS > bE) {
    statusEl.textContent = "請確認期間 A、B 的日期範圍正確";
    return;
  }
  const datesA = dateRangeArray(aS, aE);
  const datesB = dateRangeArray(bS, bE);
  if (!(await mapEnsure(statusEl, state.dataType, hyYearsOfDates(datesA, datesB)))) return;

  if (state.dataType === "rainfall") {
    const points = [];
    RAINFALL.forEach(s => {
      if (s.lat === undefined) return;
      const a = wraRainSum(s, datesA), b = wraRainSum(s, datesB);
      if (a !== null && b !== null) {
        points.push({ lat: s.lat, lon: s.lon, value: a - b, valueA: a, valueB: b, name: s.name_zh, code: s.code });
      }
    });
    if (points.length === 0) { statusEl.textContent = "兩期間皆有資料的雨量站數為 0，無法比較"; return; }
    const maxAbs = Math.max(1, ...points.map(p => Math.abs(p.value)));
    statusEl.textContent = `${points.length} 個雨量站參與內插（總雨量差 A－B，反距離加權 IDW）`;
    lastHeatmapPoints = points;
    lastHeatmapDiverging = { maxAbs };
    const { dataUrl, bounds } = renderRainfallHeatmap(points, { maxAbs });
    mapImageOverlay = L.imageOverlay(dataUrl, bounds, { opacity: HEATMAP_OPACITY }).addTo(map);

    mapMarkersLayer = L.featureGroup();
    points.forEach(p => {
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 3, color: "#333", weight: 1, fillColor: "#fff", fillOpacity: STATION_OPACITY
      }).bindTooltip(`${p.name}：${p.value > 0 ? "+" : ""}${fmt(p.value, 1)} mm（A: ${fmt(p.valueA, 1)}，B: ${fmt(p.valueB, 1)}）`);
      mapMarkersLayer.addLayer(m);
    });
    addDotsLayer(mapMarkersLayer); // white station dots (can be hidden)
    addDivergingRainLegend("總雨量差 A－B (mm)", maxAbs);
    lastMapRows = points.map(p => [p.code || "", p.name || "", round3(p.valueA), round3(p.valueB), round3(p.value)]);
  } else {
    const key = state.dataType;
    const points = [];
    RIVER.forEach(s => {
      if (s.lat === undefined) return;
      const series = s[key];
      if (!series || Object.keys(series).length === 0) return;
      const stA = aggregateForMap(series, datesA);
      const stB = aggregateForMap(series, datesB);
      if (stA.avg !== null && stB.avg !== null) {
        points.push({ lat: s.lat, lon: s.lon, value: stA.avg - stB.avg, valueA: stA.avg, valueB: stB.avg, name: s.name_zh, code: s.code });
      }
    });
    if (points.length === 0) { statusEl.textContent = "兩期間皆有資料的測站數為 0，無法比較"; return; }
    const maxAbs = Math.max(0.01, ...points.map(p => Math.abs(p.value)));
    statusEl.textContent = `${points.length} 個${TYPE_LABEL[key]}測站顯示於地圖（平均值差 A－B，不內插）`;
    mapMarkersLayer = L.featureGroup();
    points.forEach(p => {
      const t = Math.abs(p.value) / maxAbs;
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 5 + t * 7, color: "#333", weight: 1,
        fillColor: divergingColorStr(p.value, maxAbs), fillOpacity: STATION_OPACITY
      }).bindTooltip(`${p.name}：${p.value > 0 ? "+" : ""}${fmt(p.value, 2)} ${UNIT[key]}（A: ${fmt(p.valueA, 2)}，B: ${fmt(p.valueB, 2)}）`);
      mapMarkersLayer.addLayer(m);
    });
    mapMarkersLayer.addTo(map);
    addDivergingRainLegend(`${TYPE_LABEL[key]}差 A－B (${UNIT[key]})`, maxAbs);
    lastMapRows = points.map(p => [p.code || "", p.name || "", round3(p.valueA), round3(p.valueB), round3(p.value)]);
  }
}

/* ---------- yearbook rainfall: "-" (no rain) days are stored as missing ----------
   A station that has any record in a month was operating that month, so its missing days there are
   dry days (0 mm). Without this, dry stations drop out and nearby rain is interpolated into dry areas. */
let WRA_ZERO_FILL = (() => { try { return localStorage.getItem("hy_wra_zero") !== "0"; } catch (e) { return true; } })();
function stationMonths(s) {
  if (!s._months) s._months = new Set(Object.keys(s.daily).map(d => d.slice(0, 7)));
  return s._months;
}
function wraRainSum(s, dates) {
  let sum = 0, n = 0;
  for (const d of dates) { const v = s.daily[d]; if (v !== undefined && v !== null) { sum += v; n++; } }
  if (n) return sum;
  if (!WRA_ZERO_FILL) return null;
  const months = stationMonths(s);
  return dates.some(d => months.has(d.slice(0, 7))) ? 0 : null;
}

// yearbook (WRA) station points for a set of dates
function wraPoints(dates) {
  const points = [];
  let zeros = 0;
  RAINFALL.forEach(s => {
    if (s.lat === undefined) return;
    const v = wraRainSum(s, dates);
    if (v === null) return;
    if (v === 0 && !dates.some(d => s.daily[d] !== undefined && s.daily[d] !== null)) zeros++;
    points.push({ lat: s.lat, lon: s.lon, value: v, name: s.name_zh, code: s.code });
  });
  return { points, zeros, ipoints: points, radius: 22 };
}

// CWA typhoon-database hourly points: rainfall of hours [a, b] (indices of hour-ending times) of typhoon t
function cwaHourPoints(t, a, b) {
  const prep = tyPrepared(t);
  const points = [];
  const listed = new Set();
  for (const [si, c] of prep.cum) {
    listed.add(si);
    const s = CWA_STATIONS[si];
    points.push({ lat: s[6], lon: s[5], value: c[b + 1] - c[a], name: s[1], code: s[0], outer: s[3] === "外島" });
  }
  let zeros = 0;
  CWA_STATIONS.forEach((s, si) => {   // operating stations with no rain at all this typhoon = 0 mm
    if (listed.has(si) || !s[7] || s[7] > t.y || t.y > s[8]) return;
    points.push({ lat: s[6], lon: s[5], value: 0, name: s[1], code: s[0], outer: s[3] === "外島" });
    zeros++;
  });
  const ipoints = points.filter(p => !p.outer);
  return { points, zeros, ipoints, radius: tyRadiusKm(ipoints.length) };
}

// draw an interpolated rainfall map from a point set (query result or a playback frame)
function renderRainPointsMap(P, opts) {
  opts = opts || {};
  const map = ensureMap();
  const statusEl = document.getElementById("mapStatus");
  const { dataUrl, bounds } = renderRainfallHeatmap(P.ipoints, null, { maxDistKm: P.radius, width: opts.light ? 360 : undefined });
  if (opts.light && mapImageOverlay && mapMarkersLayer && mapMarkersLayer._wra && mapMarkersLayer._src === opts.src) {
    mapImageOverlay.setUrl(dataUrl);   // playback frame: swap the raster, keep legend
    mapMarkersLayer.clearLayers();
  } else {
    clearMapLayers();
    mapImageOverlay = L.imageOverlay(dataUrl, bounds, { opacity: HEATMAP_OPACITY }).addTo(map);
    mapMarkersLayer = L.featureGroup();
    mapMarkersLayer._wra = true;
    mapMarkersLayer._src = opts.src;
    addDotsLayer(mapMarkersLayer); // white station dots (can be hidden)
    addRainLegend(opts.title || "總雨量 (mm)");
  }
  P.points.forEach(p => {
    mapMarkersLayer.addLayer(L.circleMarker([p.lat, p.lon], {
      radius: opts.src === "day" ? 3 : 2.3, color: "#333", weight: opts.src === "day" ? 1 : 0.8, opacity: STATION_OPACITY, fillColor: "#fff", fillOpacity: STATION_OPACITY
    }).bindTooltip(`${p.name}：${fmt(p.value, 1)} mm${opts.tip ? "（" + opts.tip + "）" : ""}`));
  });
  lastHeatmapPoints = P.ipoints;
  lastHeatmapDiverging = null;
  lastHeatmapOpts = { maxDistKm: P.radius };
  statusEl.textContent = opts.src === "hour" || opts.src === "cday"
    ? `${P.ipoints.length} 個氣象署測站參與內插（${opts.label}，${opts.src === "cday" ? "逐時資料加總" : "逐時資料"}；內插半徑 ${P.radius} km）` + (P.zeros ? `；含推定 0 mm ${P.zeros} 站` : "")
    : `${P.points.length} 個雨量站參與內插（${opts.label || "期間總雨量"}，反距離加權 IDW）` + (P.zeros ? `；其中 ${P.zeros} 站當期無降雨紀錄、以 0 mm 計` : "");
  lastMapRows = P.points.map(p => [p.code || "", p.name || "", round3(p.value)]);
}

// interpolated yearbook rainfall map for a set of dates (used by the query and by daily playback)
function renderWraRainMap(dates, opts) {
  renderRainPointsMap(wraPoints(dates), { ...opts, src: "day" });
}

/* ---------- playback of the rainfall map: daily (yearbook) or hourly (CWA typhoon database) ---------- */
let wraPlayTimer = null;
let wraHourOpts = [];   // typhoons whose hourly records overlap the selected dates: [{t, a, b}]
function wraSelDates() {
  if (!document.querySelector("#mapGranInputs input, #mapGranInputs select")) return [];
  try { return currentMapDates(); } catch (e) { return []; }
}
function wraStep() {
  const v = document.getElementById("wraPlayStep").value || "day";
  if (v === "day") return { kind: "day" };
  const [kind, id] = v.split(":");
  const o = wraHourOpts.find(o => o.t.id === id);
  if (!o) return { kind: "day" };
  return kind === "cday" ? { kind: "cday", ...o, days: wraCwaDays(o) } : { kind: "hour", ...o };
}
// calendar days (00:00-24:00, as on the official CWA daily maps) covered by a typhoon's hourly records
function wraCwaDays(o) {
  const days = [];
  for (let h = o.a; h <= o.b; h++) {
    const begin = new Date(tyHourDate(o.t, h).getTime() - 3600e3);   // hour h ends at tyHourDate(h)
    const d = begin.toISOString().slice(0, 10);
    if (!days.length || days[days.length - 1].d !== d) days.push({ d, a: h, b: h });
    else days[days.length - 1].b = h;
  }
  days.forEach(x => { x.hours = x.b - x.a + 1; });
  return days;
}
function wraFrames() {
  const st = wraStep();
  if (st.kind === "hour") return Array.from({ length: st.b - st.a + 1 }, (_, i) => st.a + i);
  if (st.kind === "cday") return st.days;
  return state.mapgran === "day" ? [] : wraSelDates();
}
// typhoons in the CWA database whose hourly window overlaps the selected dates
function wraFindTyphoons(dates) {
  if (!dates.length || typeof CWA_TYPHOONS === "undefined") return [];
  const s = dates[0] + " 00:00";
  const endD = new Date(dates[dates.length - 1] + "T00:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 1);
  const e = endD.toISOString().slice(0, 10) + " 00:00";
  const out = [];
  for (const t of CWA_TYPHOONS) {
    if (Math.abs(t.y - +dates[0].slice(0, 4)) > 1) continue;
    const a = Math.max(0, tyHourIndex(t, s) + 1), b = Math.min(t.n - 1, tyHourIndex(t, e));  // hours ending in (s, e]
    if (a <= b) out.push({ t, a, b });
  }
  return out;
}
async function wraRefreshStepOptions() {
  const sel = document.getElementById("wraPlayStep");
  if (!sel) return;
  const prev = sel.value;
  if (state.dataType === "rainfall" && state.mapmode === "single") {
    try { await ensureTyphoonMeta(); } catch (e) { /* typhoon data unavailable: daily only */ }
  }
  wraHourOpts = wraFindTyphoons(wraSelDates());
  const opts = [];
  if (state.mapgran !== "day") opts.push(`<option value="day">逐日（水利署年報日雨量）</option>`);
  wraHourOpts.forEach(o => {
    const nd = wraCwaDays(o).length;
    if (nd >= 1 && state.mapgran !== "day") opts.push(`<option value="cday:${o.t.id}">逐日（${o.t.y} ${o.t.zh} 颱風，氣象署測站，由逐時資料加總 ${nd} 天）</option>`);
    opts.push(`<option value="hour:${o.t.id}">逐時（${o.t.y} ${o.t.zh} 颱風，氣象署逐時資料 ${o.b - o.a + 1} 小時）</option>`);
  });
  sel.innerHTML = opts.join("") || `<option value="">（此期間無可播放資料）</option>`;
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  wraUpdatePlayUi(true);
}
function wraUpdatePlayUi(fromRefresh) {
  const row = document.getElementById("wraPlayRow");
  if (!row) return;
  document.getElementById("wraZeroRow").style.display =
    state.dataType === "rainfall" && state.mapmode !== "typhoon" ? "" : "none";
  // only while the map view with its date inputs is on screen
  const inputsReady = !!document.querySelector("#mapGranInputs input, #mapGranInputs select");
  const show = state.mode === "map" && inputsReady && state.dataType === "rainfall" && state.mapmode === "single";
  row.style.display = show ? "" : "none";
  if (!show) { wraStopPlay(true); return; }
  if (!fromRefresh) { wraRefreshStepOptions(); return; }
  const all = wraFrames();
  const sl = document.getElementById("wraPlayIdx");
  sl.max = Math.max(0, all.length - 1);
  if (+sl.value > all.length - 1) sl.value = Math.max(0, all.length - 1);
  document.getElementById("wraPlayBtn").disabled = all.length < 2;
  const st = wraStep();
  document.getElementById("wraPlayModeStep").textContent = st.kind === "hour" ? "當時雨量（1 小時）" : "當日雨量";
  const partial = st.kind === "cday" ? st.days.filter(x => x.hours < 24) : [];
  document.getElementById("wraPlayNote").textContent = st.kind === "cday"
    ? `氣象署逐日：以中央氣象署颱風資料庫約 ${st.t.ns} 個測站的逐時雨量，依 00:00～24:00 加總成日雨量（與氣象署官方日累積雨量圖同一日界），測站比水利署年報密。` +
      (partial.length ? `其中 ${partial.map(x => `${x.d.slice(5)} 僅 ${x.hours} 小時`).join("、")}（颱風資料期間外的小時沒有資料），該日數值會偏低。` : "")
    : st.kind === "hour"
    ? `逐時播放使用中央氣象署颱風資料庫的測站與逐時雨量（與水利署年報測站不同）；只涵蓋該颱風的逐時資料期間（${tyFmtHour(st.t, 0, true)} 起 ${st.t.n} 小時）。`
    : (wraHourOpts.length ? "年報為日雨量，逐日播放用水利署測站；此期間另有颱風逐時資料，可在「時間步」改選逐時播放。"
                          : "年報為日雨量，逐日播放用水利署測站；逐時播放僅在所選期間與颱風事件重疊時提供（氣象署颱風逐時資料）。");
  wraPlayLabel();
}
function wraPlayLabel() {
  const all = wraFrames();
  const i = +document.getElementById("wraPlayIdx").value;
  const mode = document.getElementById("wraPlayMode").value;
  const el = document.getElementById("wraPlayLabelEl");
  if (!all.length) { el.textContent = state.mapgran === "day" ? "單日僅能逐時播放（需與颱風逐時資料重疊）" : "請先選擇有效的月份或區間"; return; }
  const st = wraStep();
  if (st.kind === "cday") {
    const x = all[i], note = x.hours < 24 ? `，僅 ${x.hours} 小時資料` : "";
    el.textContent = mode === "cum" ? `${all[0].d} ～ ${x.d}（第 ${i + 1}/${all.length} 天累積${note}）` : `${x.d}（第 ${i + 1}/${all.length} 天${note}）`;
    return;
  }
  if (st.kind === "hour") {
    const t = st.t, h = all[i], h0 = all[0];
    const begin = new Date(tyHourDate(t, h0).getTime() - 3600e3);
    const b = `${pad2(begin.getUTCMonth() + 1)}-${pad2(begin.getUTCDate())} ${pad2(begin.getUTCHours())}:00`;
    el.textContent = mode === "cum" ? `${b} ～ ${tyFmtHour(t, h)}（第 ${i + 1}/${all.length} 小時累積）` : `${tyFmtHour(t, h)} 止的 1 小時（第 ${i + 1}/${all.length} 小時）`;
    return;
  }
  el.textContent = mode === "cum" ? `${all[0]} ～ ${all[i]}（第 ${i + 1}/${all.length} 天累積）` : `${all[i]}（第 ${i + 1}/${all.length} 天）`;
}
async function wraRenderFrame(light) {
  const all = wraFrames();
  if (!all.length) return;
  const i = +document.getElementById("wraPlayIdx").value;
  const mode = document.getElementById("wraPlayMode").value;
  const st = wraStep();
  if (st.kind === "cday") {
    await ensureTyHourly(st.t);
    const x = all[i], a = mode === "cum" ? all[0].a : x.a;
    renderRainPointsMap(cwaHourPoints(st.t, a, x.b), {
      light, src: "cday",
      title: mode === "cum" ? "自起始日累積 (mm)" : "當日雨量 (mm)",
      label: mode === "cum" ? `${all[0].d}～${x.d} 累積，氣象署測站` : `${x.d} 當日雨量，氣象署測站`,
      tip: mode === "cum" ? `至 ${x.d} 累積` : x.d,
    });
    return;
  }
  if (st.kind === "hour") {
    await ensureTyHourly(st.t);
    const a = mode === "cum" ? all[0] : all[i], b = all[i];
    renderRainPointsMap(cwaHourPoints(st.t, a, b), {
      light, src: "hour",
      title: mode === "cum" ? "自起始時累積 (mm)" : "時雨量 (mm)",
      label: mode === "cum" ? `至 ${tyFmtHour(st.t, b)} 累積` : `${tyFmtHour(st.t, b)} 止 1 小時雨量`,
      tip: mode === "cum" ? `至 ${tyFmtHour(st.t, b)} 累積` : `${tyFmtHour(st.t, b)} 止 1 小時`,
    });
    return;
  }
  const ds = mode === "cum" ? all.slice(0, i + 1) : [all[i]];
  await hyEnsure("rain", hyYearsOfDates(ds));
  renderWraRainMap(ds, {
    light,
    title: mode === "cum" ? "自起始日累積 (mm)" : "當日雨量 (mm)",
    label: mode === "cum" ? `${all[0]}～${all[i]} 累積` : `${all[i]} 當日雨量`,
    tip: mode === "cum" ? `至 ${all[i]} 累積` : all[i],
  });
}
async function wraTogglePlay() {
  if (wraPlayTimer) { wraStopPlay(); return; }
  const all = wraFrames();
  if (all.length < 2) return;
  const sl = document.getElementById("wraPlayIdx");
  const mode = document.getElementById("wraPlayMode").value;
  const st = wraStep();
  if (st.kind === "hour" || st.kind === "cday") await ensureTyHourly(st.t);
  else {
    try { await hyEnsure("rain", hyYearsOfDates(all)); }
    catch (e) { document.getElementById("mapStatus").textContent = e.message; return; }
  }
  // one colour scale for the whole animation: any frame past 350 mm switches to the extended bins
  WRA_BINS_OVERRIDE = null;
  if (typeof TY_EXT_BINS !== "undefined") {
    let maxV = 0;
    const pmax = P => Math.max(0, ...P.points.map(p => p.value));
    if (st.kind === "hour") {
      maxV = mode === "cum" ? pmax(cwaHourPoints(st.t, all[0], all[all.length - 1])) : 0;
    } else if (st.kind === "cday") {
      maxV = mode === "cum" ? pmax(cwaHourPoints(st.t, all[0].a, all[all.length - 1].b))
                            : Math.max(...all.map(x => pmax(cwaHourPoints(st.t, x.a, x.b))));
    } else if (mode === "cum") {
      maxV = Math.max(0, ...RAINFALL.map(s => wraRainSum(s, all) || 0));
    } else {
      maxV = Math.max(0, ...RAINFALL.map(s => Math.max(0, ...all.map(d => s.daily[d] || 0))));
    }
    if (maxV > 350) WRA_BINS_OVERRIDE = TY_EXT_BINS;
  }
  if (+sl.value >= all.length - 1) sl.value = 0;
  document.getElementById("wraPlayBtn").textContent = "❚❚ 暫停";
  clearMapLayers(); // start from a fresh layer set (legend matches the chosen scale)
  const delay = +document.getElementById("wraPlaySpeed").value || 600;
  wraPlayTimer = -1;
  const step = async () => {
    if (!wraPlayTimer) return;
    wraPlayLabel();
    await wraRenderFrame(true);
    if (!wraPlayTimer) return;
    if (+sl.value >= all.length - 1) { wraStopPlay(); return; }
    sl.value = +sl.value + 1;
    wraPlayTimer = setTimeout(step, delay);
  };
  wraPlayTimer = setTimeout(step, 0);
}
function wraStopPlay(silent) {
  if (!wraPlayTimer) return;
  if (wraPlayTimer !== -1) clearTimeout(wraPlayTimer);
  wraPlayTimer = null;
  const b = document.getElementById("wraPlayBtn");
  if (b) b.textContent = "▶ 播放";
  if (!silent) { clearMapLayers(); wraRenderFrame(false); } // last frame at full resolution
}
document.addEventListener("DOMContentLoaded", () => {
  if (!document.getElementById("wraPlayRow")) return;
  const zf = document.getElementById("wraZeroFill");
  zf.checked = WRA_ZERO_FILL;
  zf.addEventListener("change", e => {
    WRA_ZERO_FILL = e.target.checked;
    try { localStorage.setItem("hy_wra_zero", WRA_ZERO_FILL ? "1" : "0"); } catch (err) { /* ignore */ }
  });
  document.getElementById("wraPlayBtn").addEventListener("click", wraTogglePlay);
  let t = null;
  document.getElementById("wraPlayIdx").addEventListener("input", () => {
    wraPlayLabel();
    if (wraPlayTimer) return;
    clearTimeout(t);
    t = setTimeout(() => wraRenderFrame(true), 60);
  });
  document.getElementById("wraPlayIdx").addEventListener("change", () => { if (!wraPlayTimer) { clearMapLayers(); wraRenderFrame(false); } });
  document.getElementById("wraPlayMode").addEventListener("change", () => { wraStopPlay(true); wraPlayLabel(); });
  document.getElementById("wraPlayStep").addEventListener("change", () => {
    wraStopPlay(true);
    document.getElementById("wraPlayIdx").value = 0;
    wraUpdatePlayUi(true);
  });
  // deferred: the typhoon quick-pick fills the date inputs in a document-level handler that runs after this one
  document.getElementById("mapGranInputs").addEventListener("change", () => { wraStopPlay(true); setTimeout(() => wraUpdatePlayUi(), 0); });
});

function aggregateForMap(series, dates) {
  return aggregate(series, dates);
}

function exportMapCsv() {
  if (state.mapmode === "typhoon") {
    if (!tyLastExport) { alert("請先產生颱風雨量圖"); return; }
    downloadCsv(tyLastExport.filename, [tyLastExport.header, ...tyLastExport.rows]);
    return;
  }
  if (!lastMapRows || !lastMapRows.length) { alert("請先產生地圖"); return; }
  const isDiff = state.mapmode === "diff";
  const unit = UNIT[state.dataType];
  const header = isDiff
    ? ["code", "name", `A_${unit}`, `B_${unit}`, `diff_A_minus_B_${unit}`]
    : ["code", "name", `value_${unit}`];
  downloadCsv(`地圖資料_${state.dataType}_${state.mapmode}_${Date.now()}.csv`, [header, ...lastMapRows]);
}

function renderMapGranInputs() {
  const el = document.getElementById("mapGranInputs");
  if (state.mapgran === "day") {
    el.innerHTML = `<label class="field">選擇日期<input type="date" id="mDate" min="${DATA_FIRST_DATE}" max="${DATA_LAST_DATE}" value="2024-01-01"></label>`;
  } else if (state.mapgran === "month") {
    el.innerHTML = `<label class="field">選擇年份
      <select id="mYear">${hyYearOptions()}</select>
    </label>
    <label class="field">選擇月份
      <select id="mMonth">${MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select>
    </label>`;
  } else {
    el.innerHTML = `<label class="field">開始日期<input type="date" id="mStart" min="${DATA_FIRST_DATE}" max="${DATA_LAST_DATE}" value="2024-01-01"></label>
    <label class="field">結束日期<input type="date" id="mEnd" min="${DATA_FIRST_DATE}" max="${DATA_LAST_DATE}" value="2024-01-31"></label>
    <label class="field">颱風快選<select class="typhoon-pick" data-start="mStart" data-end="mEnd"><option value="">不套用</option></select></label>`;
  }
  populateTyphoonSelects();
  wraUpdatePlayUi();
}

function currentMapDates() {
  if (state.mapgran === "day") {
    const d = document.getElementById("mDate").value;
    return d ? [d] : [];
  }
  if (state.mapgran === "month") {
    const y = parseInt(document.getElementById("mYear").value, 10);
    const m = parseInt(document.getElementById("mMonth").value, 10);
    const n = daysInMonth(y, m);
    return Array.from({ length: n }, (_, i) => dateStr(y, m, i + 1));
  }
  const s = document.getElementById("mStart").value;
  const e = document.getElementById("mEnd").value;
  if (!s || !e || s > e) return [];
  return dateRangeArray(s, e);
}

/* ---------- custom color-scale editor ---------- */
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(rgb) {
  return "#" + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
}

function renderColorScaleRows(bins) {
  const el = document.getElementById("csRows");
  el.innerHTML = bins.map((bin, i) => {
    const isLast = i === bins.length - 1;
    const maxField = isLast
      ? `<span class="cs-lbl" style="width:80px;">（最高級距）</span>`
      : `<input type="number" class="cs-max" value="${bin.max}" step="0.1">`;
    const removable = !isLast && bins.length > 2;
    return `<div class="cs-row">
      <span class="cs-lbl">上限</span>${maxField}<span class="cs-lbl">mm</span>
      <input type="color" class="cs-color" value="${rgbToHex(bin.color)}">
      ${removable ? `<button class="cs-remove" type="button" title="移除此級距">✕</button>` : `<span style="width:22px;display:inline-block;"></span>`}
    </div>`;
  }).join("");
}

function readRowsRaw() {
  const rows = [...document.querySelectorAll("#csRows .cs-row")];
  return rows.map((row, i) => {
    const isLast = i === rows.length - 1;
    const maxInput = row.querySelector(".cs-max");
    const max = isLast ? Infinity : parseFloat(maxInput.value);
    const color = hexToRgb(row.querySelector(".cs-color").value);
    return { max, color };
  });
}

function readColorScaleFromUI() {
  const raw = readRowsRaw();
  let prevMax = parseFloat(document.getElementById("csMinThreshold").value);
  if (isNaN(prevMax)) prevMax = 0;
  return raw.map(r => {
    if (isNaN(r.max)) throw new Error("有級距上限未填寫數字");
    const bin = { min: prevMax, max: r.max, color: r.color };
    prevMax = r.max;
    return bin;
  });
}

function initColorScaleEditor() {
  const rowsEl = document.getElementById("csRows");
  if (!rowsEl) return; // editor not present on this page
  renderColorScaleRows(CWA_RAIN_BINS);

  document.getElementById("csAddRowBtn").addEventListener("click", () => {
    const raw = readRowsRaw();
    const insertAt = raw.length - 1; // just before the open-ended last row
    const prevMax = insertAt > 0 ? raw[insertAt - 1].max : (parseFloat(document.getElementById("csMinThreshold").value) || 0);
    const nextMax = raw[insertAt].max === Infinity ? prevMax + 50 : raw[insertAt].max;
    const newMax = Math.round(((prevMax + nextMax) / 2) * 10) / 10;
    raw.splice(insertAt, 0, { max: newMax, color: [150, 150, 150] });
    renderColorScaleRows(raw.map(r => ({ max: r.max, color: r.color })));
  });

  rowsEl.addEventListener("click", (e) => {
    if (!e.target.matches(".cs-remove")) return;
    const rows = [...rowsEl.querySelectorAll(".cs-row")];
    const idx = rows.indexOf(e.target.closest(".cs-row"));
    const raw = readRowsRaw();
    raw.splice(idx, 1);
    renderColorScaleRows(raw.map(r => ({ max: r.max, color: r.color })));
  });

  document.getElementById("csResetBtn").addEventListener("click", () => {
    CUSTOM_RAIN_BINS = null;
    RAIN_MIN_THRESHOLD = 0.5;
    DIVERGING_POS_COLOR = [200, 0, 0];
    DIVERGING_NEG_COLOR = [0, 80, 210];
    document.getElementById("csMinThreshold").value = 0.5;
    document.getElementById("csDivPos").value = rgbToHex(DIVERGING_POS_COLOR);
    document.getElementById("csDivNeg").value = rgbToHex(DIVERGING_NEG_COLOR);
    renderColorScaleRows(CWA_RAIN_BINS);
    const statusEl = document.getElementById("mapStatus");
    if (statusEl) statusEl.textContent = "已重設為中央氣象署配色，請重新按「產生地圖」";
  });

  document.getElementById("csApplyBtn").addEventListener("click", () => {
    const statusEl = document.getElementById("mapStatus");
    try {
      const bins = readColorScaleFromUI();
      if (!(bins[0].min < bins[0].max)) throw new Error("「最低顯示雨量」必須小於第一個級距的上限");
      for (let i = 1; i < bins.length; i++) {
        if (!(bins[i].max > bins[i - 1].max)) throw new Error("級距上限必須由小到大遞增排列");
      }
      CUSTOM_RAIN_BINS = bins;
      const th = parseFloat(document.getElementById("csMinThreshold").value);
      RAIN_MIN_THRESHOLD = isNaN(th) ? 0 : th;
      DIVERGING_POS_COLOR = hexToRgb(document.getElementById("csDivPos").value);
      DIVERGING_NEG_COLOR = hexToRgb(document.getElementById("csDivNeg").value);
      if (statusEl) statusEl.textContent = "已套用自訂色階，請重新按「產生地圖」更新畫面";
    } catch (err) {
      alert("色階設定有誤：" + err.message);
    }
  });
}

document.addEventListener("DOMContentLoaded", initColorScaleEditor);

/* ---------- layer opacity editor ---------- */
function pctLabel(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = Math.round(v * 100) + "%";
}

function applyHeatmapOpacity(v) {
  HEATMAP_OPACITY = v;
  if (mapImageOverlay) mapImageOverlay.setOpacity(v);
  pctLabel("opRainVal", v);
}
function applyRiversOpacity(v) {
  RIVERS_OPACITY = v;
  if (riversLayer) riversLayer.setStyle(riverStyle());
  pctLabel("opRiversVal", v);
}
function applyCountiesOpacity(v) {
  COUNTIES_OPACITY = v;
  if (countiesLayer) countiesLayer.setStyle(countyStyle());
  pctLabel("opCountiesVal", v);
}
function applyStationOpacity(v) {
  STATION_OPACITY = v;
  if (mapMarkersLayer) mapMarkersLayer.eachLayer(m => { if (m.setStyle) m.setStyle({ fillOpacity: v, opacity: v }); });
  [rainStationsLayer, levelStationsLayer, dischargeStationsLayer, tyStationRefLayer].forEach(layer => {
    if (layer) layer.eachLayer(m => { if (m.setOpacity) m.setOpacity(v); });
  });
  pctLabel("opStationsVal", v);
}

function initOpacityEditor() {
  const opRain = document.getElementById("opRain");
  if (!opRain) return; // editor not present on this page
  opRain.addEventListener("input", (e) => applyHeatmapOpacity(parseInt(e.target.value, 10) / 100));
  document.getElementById("opRivers").addEventListener("input", (e) => applyRiversOpacity(parseInt(e.target.value, 10) / 100));
  document.getElementById("opCounties").addEventListener("input", (e) => applyCountiesOpacity(parseInt(e.target.value, 10) / 100));
  document.getElementById("opStations").addEventListener("input", (e) => applyStationOpacity(parseInt(e.target.value, 10) / 100));
  pctLabel("opRainVal", HEATMAP_OPACITY);
  pctLabel("opRiversVal", RIVERS_OPACITY);
  pctLabel("opCountiesVal", COUNTIES_OPACITY);
  pctLabel("opStationsVal", STATION_OPACITY);

  document.getElementById("opResetBtn").addEventListener("click", () => {
    const defaults = { opRain: 85, opRivers: 70, opCounties: 100, opStations: 90 };
    Object.entries(defaults).forEach(([id, v]) => { document.getElementById(id).value = v; });
    applyHeatmapOpacity(0.85);
    applyRiversOpacity(0.7);
    applyCountiesOpacity(1);
    applyStationOpacity(0.9);
  });
}

document.addEventListener("DOMContentLoaded", initOpacityEditor);
document.addEventListener("DOMContentLoaded", () => {
  const cb = document.getElementById("showDots");
  if (!cb) return;
  cb.checked = SHOW_STATION_DOTS;
  cb.addEventListener("change", e => applyShowDots(e.target.checked));
});

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

function activeRainBins() {
  return CUSTOM_RAIN_BINS || (typeof tyActiveBins === "function" ? tyActiveBins() : null) || CWA_RAIN_BINS;
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
  levelStationsLayer = buildStationRefLayer(RIVER, "level", s => s.level && Object.keys(s.level).length > 0);
  dischargeStationsLayer = buildStationRefLayer(RIVER, "discharge", s => s.discharge && Object.keys(s.discharge).length > 0);

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
    const m = L.marker([s.lat, s.lon], { icon, opacity: STATION_OPACITY })
      .bindTooltip(`${meta.label}：${s.name_zh}（${s.code}）`);
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

/* ---------- single-period map ---------- */
function runMapQuery() {
  const map = ensureMap();
  clearMapLayers();
  const dates = currentMapDates();
  const statusEl = document.getElementById("mapStatus");
  if (dates.length === 0) { statusEl.textContent = "請輸入有效的日期範圍"; return; }

  if (state.dataType === "rainfall") {
    const points = [];
    RAINFALL.forEach(s => {
      if (s.lat === undefined) return;
      const st = aggregateForMap(s.daily, dates);
      if (st.sum !== null) points.push({ lat: s.lat, lon: s.lon, value: st.sum, name: s.name_zh, code: s.code });
    });
    statusEl.textContent = `${points.length} 個雨量站參與內插（期間總雨量，反距離加權 IDW）`;
    lastHeatmapPoints = points;
    lastHeatmapDiverging = null;
    const { dataUrl, bounds } = renderRainfallHeatmap(points, null);
    mapImageOverlay = L.imageOverlay(dataUrl, bounds, { opacity: HEATMAP_OPACITY }).addTo(map);

    mapMarkersLayer = L.featureGroup();
    points.forEach(p => {
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 3, color: "#333", weight: 1, fillColor: "#fff", fillOpacity: STATION_OPACITY
      }).bindTooltip(`${p.name}：${fmt(p.value, 1)} mm`);
      mapMarkersLayer.addLayer(m);
    });
    mapMarkersLayer.addTo(map);
    addRainLegend("總雨量 (mm)");
    lastMapRows = points.map(p => [p.code || "", p.name || "", round3(p.value)]);
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
function runMapDiffQuery() {
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

  if (state.dataType === "rainfall") {
    const points = [];
    RAINFALL.forEach(s => {
      if (s.lat === undefined) return;
      const stA = aggregateForMap(s.daily, datesA);
      const stB = aggregateForMap(s.daily, datesB);
      if (stA.sum !== null && stB.sum !== null) {
        points.push({ lat: s.lat, lon: s.lon, value: stA.sum - stB.sum, valueA: stA.sum, valueB: stB.sum, name: s.name_zh, code: s.code });
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
    mapMarkersLayer.addTo(map);
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
    el.innerHTML = `<label class="field">選擇日期<input type="date" id="mDate" min="2020-01-01" max="2024-12-31" value="2024-01-01"></label>`;
  } else if (state.mapgran === "month") {
    el.innerHTML = `<label class="field">選擇年份
      <select id="mYear"><option value="2024">2024</option><option value="2023">2023</option><option value="2022">2022</option><option value="2021">2021</option><option value="2020">2020</option></select>
    </label>
    <label class="field">選擇月份
      <select id="mMonth">${MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select>
    </label>`;
  } else {
    el.innerHTML = `<label class="field">開始日期<input type="date" id="mStart" min="2020-01-01" max="2024-12-31" value="2024-01-01"></label>
    <label class="field">結束日期<input type="date" id="mEnd" min="2020-01-01" max="2024-12-31" value="2024-01-31"></label>
    <label class="field">颱風快選<select class="typhoon-pick" data-start="mStart" data-end="mEnd"><option value="">不套用</option></select></label>`;
  }
  populateTyphoonSelects();
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

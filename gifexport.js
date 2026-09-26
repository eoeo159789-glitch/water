/* ---------- 動畫 GIF 下載（離線可用，不需外部程式庫） ----------
   Frames are rendered off-screen from the same IDW grid as the map (not a screenshot of the Leaflet map,
   whose online basemap tiles would block reading the canvas), with coastline / county lines, title,
   time label, legend and source line, then encoded to an animated GIF in the browser. */

/* ===== GIF89a encoder: one local palette per frame, LZW, infinite loop ===== */
class GifWriter {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.parts = [];
    const b = [];
    const str = s => { for (const c of s) b.push(c.charCodeAt(0)); };
    const u16 = v => b.push(v & 255, (v >> 8) & 255);
    str("GIF89a"); u16(w); u16(h);
    b.push(0x00, 0, 0);                                   // no global colour table
    b.push(0x21, 0xff, 0x0b); str("NETSCAPE2.0"); b.push(0x03, 0x01, 0, 0, 0x00);   // loop forever
    this.parts.push(new Uint8Array(b));
  }
  // rgba: Uint8ClampedArray (w*h*4); delay in ms
  addFrame(rgba, delayMs) {
    const { palette, indices } = gifQuantize(rgba);
    const b = [];
    const u16 = v => b.push(v & 255, (v >> 8) & 255);
    b.push(0x21, 0xf9, 0x04, 0x00); u16(Math.round(delayMs / 10)); b.push(0, 0x00);   // graphic control
    b.push(0x2c); u16(0); u16(0); u16(this.w); u16(this.h); b.push(0x80 | 7);         // local table, 256 colours
    this.parts.push(new Uint8Array(b));
    this.parts.push(palette);
    this.parts.push(gifLzw(indices, 8));
  }
  finish() {
    this.parts.push(new Uint8Array([0x3b]));
    return new Blob(this.parts, { type: "image/gif" });
  }
}

// up to 256 colours: the most frequent exact colours, everything else mapped to the nearest of them
function gifQuantize(rgba) {
  const n = rgba.length / 4;
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const k = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(e => e[0]);
  const palette = new Uint8Array(768);
  const lut = new Map();
  top.forEach((k, i) => { palette[i * 3] = k >> 16; palette[i * 3 + 1] = (k >> 8) & 255; palette[i * 3 + 2] = k & 255; lut.set(k, i); });
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    let idx = lut.get(k);
    if (idx === undefined) {
      const r = k >> 16, g = (k >> 8) & 255, bl = k & 255;
      let best = 0, bd = Infinity;
      for (let j = 0; j < top.length; j++) {
        const dr = palette[j * 3] - r, dg = palette[j * 3 + 1] - g, db = palette[j * 3 + 2] - bl;
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bd) { bd = d; best = j; }
      }
      idx = best;
      lut.set(k, idx);
    }
    indices[i] = idx;
  }
  return { palette, indices };
}

// LZW compression as used by GIF (variable code width 9..12 bits), output split into ≤255-byte sub-blocks
function gifLzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  let nBits = minCode + 1, maxCode = (1 << nBits) - 1, free = clear + 2, clearFlag = false;
  const out = [];
  let cur = 0, curBits = 0;
  const dict = new Map();
  const emit = code => {
    cur |= code << curBits; curBits += nBits;
    while (curBits >= 8) { out.push(cur & 255); cur >>= 8; curBits -= 8; }
    if (free > maxCode || clearFlag) {
      if (clearFlag) { nBits = minCode + 1; maxCode = (1 << nBits) - 1; clearFlag = false; }
      else { nBits++; maxCode = nBits === 12 ? 4096 : (1 << nBits) - 1; }
    }
  };
  emit(clear);
  let ent = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (ent << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) { ent = hit; continue; }
    emit(ent);
    ent = c;
    if (free < 4096) dict.set(key, free++);
    else { dict.clear(); free = clear + 2; clearFlag = true; emit(clear); }
  }
  emit(ent);
  emit(eoi);
  if (curBits > 0) out.push(cur & 255);
  const blocks = [minCode];
  for (let i = 0; i < out.length; i += 255) {
    const len = Math.min(255, out.length - i);
    blocks.push(len);
    for (let j = 0; j < len; j++) blocks.push(out[i + j]);
  }
  blocks.push(0);
  return new Uint8Array(blocks);
}

/* ===== frame composition ===== */
const GIF_FONT = '"Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif';
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

function gifLayout(mapW, bounds) {
  const [[minLat, minLon], [maxLat, maxLon]] = bounds;
  const mapH = Math.round(mapW * (mercY(maxLat) - mercY(minLat)) / ((maxLon - minLon) * Math.PI / 180));
  const legendW = Math.max(118, Math.round(mapW * 0.24)), headH = 62, footH = 24;
  const W = mapW + legendW, H = headH + mapH + footH;
  const px = lon => (lon - minLon) / (maxLon - minLon) * mapW;
  const py = lat => headH + (mercY(maxLat) - mercY(lat)) / (mercY(maxLat) - mercY(minLat)) * mapH;
  // outlines as paths, built once per animation
  const path = new Path2D(), coast = new Path2D();
  const addRings = (target, geom) => {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    polys.forEach(poly => poly.forEach(ring => ring.forEach(([lo, la], i) => i ? target.lineTo(px(lo), py(la)) : target.moveTo(px(lo), py(la)))));
  };
  try { locCounties().forEach(f => addRings(path, f.geometry)); } catch (e) { /* no counties */ }
  addRings(coast, TAIWAN_GEO.geometry);
  return { mapW, mapH, legendW, headH, footH, W, H, px, py, counties: path, coast, minLat, maxLat, minLon, maxLon };
}

function gifDrawFrame(ctx, Lo, raster, f) {
  const { W, H, mapW, mapH, headH, footH, legendW } = Lo;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#f3f6f9"; ctx.fillRect(0, headH, mapW, mapH);          // sea
  ctx.fillStyle = "#e9e8e3"; ctx.fill(Lo.coast);                          // land without data
  // rainfall grid: opaque, no smoothing, so the classes stay exact colours
  const tmp = document.createElement("canvas");
  tmp.width = raster.width; tmp.height = raster.height;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(raster, 0, 0);
  const id = tctx.getImageData(0, 0, tmp.width, tmp.height);
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] >= 100 ? 255 : 0;
  tctx.putImageData(id, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, headH, mapW, mapH);
  ctx.imageSmoothingEnabled = true;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(60,60,60,0.55)"; ctx.lineWidth = 0.7; ctx.stroke(Lo.counties);
  ctx.strokeStyle = "#555"; ctx.lineWidth = 1; ctx.stroke(Lo.coast);
  if (f.dots) {
    ctx.fillStyle = "#333";
    f.dots.forEach(p => { const x = Lo.px(p.lon), y = Lo.py(p.lat); if (x >= 0 && x <= mapW && y >= headH && y <= headH + mapH) ctx.fillRect(x - 1, y - 1, 2, 2); });
  }
  // header
  ctx.fillStyle = "#111"; ctx.textBaseline = "top";
  ctx.font = `bold 16px ${GIF_FONT}`; gifFitText(ctx, f.title, 10, 8, W - 20);
  ctx.fillStyle = "#b3261e"; ctx.font = `bold 15px ${GIF_FONT}`; gifFitText(ctx, f.time, 10, 34, W - 20);
  // legend
  const bins = f.bins.slice().reverse();
  const lx = mapW + 10;
  ctx.fillStyle = "#111"; ctx.font = `bold 12px ${GIF_FONT}`; gifFitText(ctx, f.unit, lx, headH + 4, legendW - 14);
  const rowH = Math.max(11, Math.min(18, Math.floor((mapH - 30) / bins.length)));
  ctx.font = `${Math.min(12, rowH - 1)}px ${GIF_FONT}`;
  bins.forEach((b, i) => {
    const y = headH + 24 + i * rowH;
    ctx.fillStyle = `rgb(${b.color.join(",")})`; ctx.fillRect(lx, y + 1, 16, rowH - 3);
    ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 1; ctx.strokeRect(lx + 0.5, y + 1.5, 15, rowH - 4);
    ctx.fillStyle = "#222";
    ctx.fillText(b.max === Infinity ? `≥${b.min}` : `${b.min}–${b.max}`, lx + 22, y + 1);
  });
  // footer
  ctx.fillStyle = "#666"; ctx.font = `11px ${GIF_FONT}`;
  gifFitText(ctx, f.source, 10, headH + mapH + 6, W - 20);
}
function gifFitText(ctx, text, x, y, maxW) {
  let t = String(text || "");
  while (t.length > 4 && ctx.measureText(t).width > maxW) t = t.slice(0, -2);
  if (t !== String(text || "")) t = t.slice(0, -1) + "…";
  ctx.fillText(t, x, y);
}

/* ===== export driver ===== */
let gifJob = null;           // { cancel: bool }
async function gifExport(spec, ui) {
  // spec: { frames: n, frame(i) -> {points, radius, time}, title, unit, source, delay, filename, width, bins() }
  if (gifJob) { gifJob.cancel = true; return; }
  const job = gifJob = { cancel: false };
  const btn = ui.btn, prog = ui.progress;
  const label0 = btn.textContent;
  btn.textContent = "✕ 取消產生";
  try {
    let Lo = null, gw = null, ctx = null;
    const bins = spec.bins();
    for (let i = 0; i < spec.frames; i++) {
      if (job.cancel) { prog.textContent = "已取消"; return; }
      prog.textContent = `產生 GIF：第 ${i + 1}/${spec.frames} 格…`;
      await new Promise(r => setTimeout(r, 0));           // keep the page responsive
      const fr = spec.frame(i);
      const { canvas, bounds } = renderRainfallHeatmap(fr.points, null, { maxDistKm: fr.radius, width: spec.width, noUrl: true });
      if (!Lo) {
        Lo = gifLayout(spec.width, bounds);
        const cv = document.createElement("canvas");
        cv.width = Lo.W; cv.height = Lo.H;
        ctx = cv.getContext("2d", { willReadFrequently: true });
        gw = new GifWriter(Lo.W, Lo.H);
      }
      gifDrawFrame(ctx, Lo, canvas, { title: spec.title, time: fr.time, unit: spec.unit, source: spec.source, bins, dots: SHOW_STATION_DOTS ? fr.points : null });
      const rgba = ctx.getImageData(0, 0, Lo.W, Lo.H).data;
      // hold the last frame a little longer so the loop is readable
      gw.addFrame(rgba, i === spec.frames - 1 ? Math.max(spec.delay * 3, 1500) : spec.delay);
    }
    const blob = gw.finish();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = spec.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    prog.textContent = `已下載 ${spec.filename}（${spec.frames} 格，${(blob.size / 1048576).toFixed(1)} MB）`;
  } catch (e) {
    prog.textContent = "GIF 產生失敗：" + e.message;
  } finally {
    btn.textContent = label0;
    gifJob = null;
  }
}
const gifSafe = s => String(s).replace(/[\\/:*?"<>|\s]+/g, "_");

/* rainfall map playback (yearbook daily / CWA hourly for a selected period) */
async function gifExportWra() {
  const ui = { btn: document.getElementById("wraGifBtn"), progress: document.getElementById("wraGifMsg") };
  if (gifJob) { gifJob.cancel = true; return; }
  wraStopPlay(true);
  const all = wraFrames(), st = wraStep(), mode = document.getElementById("wraPlayMode").value;
  if (all.length < 2) { ui.progress.textContent = "目前的期間只有一格，無法做成動畫；請選較長的期間或改用逐時。"; return; }
  ui.progress.textContent = "載入資料中…";
  try { await wraEnsureAnimData(all, st); } catch (e) { ui.progress.textContent = e.message; return; }
  wraSetAnimScale(all, st, mode);
  const kindTxt = st.kind === "hour" ? "逐時，氣象署測站" : st.kind === "cday" ? "逐日，氣象署測站" : "逐日，水利署年報";
  const what = st.kind !== "day" ? `${st.t.y} ${st.t.zh}颱風　` : "";
  const unit = mode === "cum" ? "累積雨量 (mm)" : st.kind === "hour" ? "時雨量 (mm)" : "日雨量 (mm)";
  await gifExport({
    frames: all.length,
    frame: i => { const f = wraFramePoints(i, all, st, mode); return { points: f.P.ipoints, radius: f.P.radius, time: wraLabelAt(i, all, st, mode) }; },
    title: `${what}${mode === "cum" ? "累積雨量" : st.kind === "hour" ? "時雨量" : "日雨量"}（${kindTxt}）`,
    unit,
    source: st.kind === "day" ? "資料：經濟部水利署臺灣水文年報日雨量｜反距離加權內插（IDW）" : "資料：中央氣象署颱風資料庫逐時雨量｜反距離加權內插（IDW）",
    delay: +document.getElementById("wraPlaySpeed").value || 600,
    width: +document.getElementById("wraGifSize").value || 480,
    bins: () => activeRainBins(),
    filename: gifSafe(`雨量動畫_${what}${st.kind === "hour" ? "逐時" : "逐日"}${mode === "cum" ? "累積" : ""}_${st.kind === "day" ? all[0] + "_" + all[all.length - 1] : st.kind === "cday" ? "氣象署測站" : ""}.gif`).replace(/_+\.gif$/, ".gif"),
  }, ui);
}

/* typhoon-event mode: hourly playback of the selected typhoon */
async function gifExportTyphoon() {
  const ui = { btn: document.getElementById("tyGifBtn"), progress: document.getElementById("tyGifMsg") };
  if (gifJob) { gifJob.cancel = true; return; }
  tyStopPlay(true);
  const t = tyById(tyState.id);
  if (!t) return;
  if (tyEnsureHourly()) await runTyphoonMap();
  ui.progress.textContent = "載入逐時資料中…";
  try { await ensureTyHourly(t); } catch (e) { ui.progress.textContent = e.message; return; }
  // same frame sequence as the ▶ button
  const idx = [];
  let k = tyState.step === "day" ? tyNextMidnight(t, -1) : 0;
  idx.push(k);
  while (k < t.n - 1) { k = tyNextStep(t, k); idx.push(k); }
  const keep = tyState.endIdx;
  tyUseExt = tyRefMax(t) > 350;
  const win = tyState.winLen === 0 ? "事件開始起累積雨量" : `${tyState.winLen} 小時累積雨量`;
  const stepTxt = tyState.step === "day" ? "逐日" : tyState.step === "1" ? "逐時" : `每 ${tyState.step} 小時`;
  try {
    await gifExport({
      frames: idx.length,
      frame: i => {
        tyState.endIdx = idx[i];
        const A = tyValues(t, "hourly");
        const pts = [];
        for (const [si, a] of A.vals) { const s = CWA_STATIONS[si]; if (s[3] !== "外島") pts.push({ lat: s[6], lon: s[5], value: a.v }); }
        return { points: pts, radius: tyRadiusKm(pts.length), time: tyWindowLabel(t) };
      },
      title: `${t.y} ${t.zh}（${t.en}）颱風　${win}（${stepTxt}）`,
      unit: `${tyState.winLen === 0 ? "累積" : tyState.winLen + " 小時"}雨量 (mm)`,
      source: "資料：中央氣象署颱風資料庫逐時雨量（時間為該小時結束時間）｜反距離加權內插（IDW）",
      delay: tyState.step === "day" ? 900 : 350,
      width: +document.getElementById("tyGifSize").value || 480,
      bins: () => activeRainBins(),
      filename: gifSafe(`颱風雨量動畫_${t.y}${t.zh}_${win}_${stepTxt}.gif`),
    }, ui);
  } finally {
    tyState.endIdx = keep;
    tyUpdateEndLabel();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("wraGifBtn").addEventListener("click", gifExportWra);
  document.getElementById("tyGifBtn").addEventListener("click", gifExportTyphoon);
});

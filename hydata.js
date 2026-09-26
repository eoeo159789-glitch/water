/* ---------- yearbook daily data, loaded per year on demand ----------
   data.js holds the station lists only; the daily values live in data/<kind>_<year>.js
   (kind = rain | level | discharge), each calling HY_DATA(kind, year, {stationId: "v,v,,v,..."})
   with one comma-separated value per day of the year (empty = no value).
   Loaded values are merged into the station objects (s.daily / s.level / s.discharge keyed by
   "YYYY-MM-DD"), so the query, map and evaluation code reads them the same way as before. */

const HY_KIND = { rainfall: "rain", level: "level", discharge: "discharge" };
const HY_FIELD = { rain: "daily", level: "level", discharge: "discharge" };
const HY_INDEX = {};
RAINFALL.forEach(s => { s.daily = {}; HY_INDEX[s.id] = s; });
RIVER.forEach(s => { s.level = {}; s.discharge = {}; s.ly = s.ly || []; s.dy = s.dy || []; HY_INDEX[s.id] = s; });
const HY_LOADED = new Set();
const DATA_FIRST_YEAR = Math.min(...HY_YEARS.rain, ...HY_YEARS.level);
const DATA_LAST_YEAR = Math.max(...HY_YEARS.rain, ...HY_YEARS.level);
const DATA_FIRST_DATE = `${DATA_FIRST_YEAR}-01-01`, DATA_LAST_DATE = `${DATA_LAST_YEAR}-12-31`;

// station by id; ids renamed when 2001-2019 data was merged still resolve (saved thresholds, links)
function hyStation(id) { return HY_INDEX[id] || HY_INDEX[HY_ID_ALIAS[id]] || null; }

function hyYearDates(year) {
  const out = [];
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function HY_DATA(kind, year, map) {
  const field = HY_FIELD[kind];
  const ds = hyYearDates(year);
  for (const id in map) {
    const s = HY_INDEX[id];
    if (!s) continue;
    const arr = map[id].split(","), tgt = s[field];
    for (let i = 0; i < arr.length; i++) if (arr[i] !== "") tgt[ds[i]] = +arr[i];
    if (kind === "rain") delete s._months;   // cached "months with records" (rain zero-fill)
  }
  HY_LOADED.add(`${kind}_${year}`);
}

function hyLoadScript(src) {
  hyLoadScript.cache = hyLoadScript.cache || {};
  if (!hyLoadScript.cache[src]) {
    hyLoadScript.cache[src] = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => { delete hyLoadScript.cache[src]; reject(new Error(`無法載入資料檔 ${src}（請確認 data 資料夾與網頁放在同一個資料夾內）`)); };
      document.head.appendChild(el);
    });
  }
  return hyLoadScript.cache[src];
}

// years (numbers) covered by a list of "YYYY-MM-DD" dates
function hyYearsOfDates(...lists) {
  const ys = new Set();
  lists.forEach(l => (l || []).forEach(d => ys.add(+d.slice(0, 4))));
  return [...ys];
}

/* make sure the yearly files for these data types and years are loaded.
   kinds: "rainfall" | "level" | "discharge" (or rain/level/discharge); years: numbers */
async function hyEnsure(kinds, years) {
  kinds = [].concat(kinds).map(k => HY_KIND[k] || k);
  const jobs = [];
  kinds.forEach(k => years.forEach(y => {
    if (HY_YEARS[k].includes(y) && !HY_LOADED.has(`${k}_${y}`)) jobs.push(hyLoadScript(`data/${k}_${y}.js`));
  }));
  if (jobs.length) await Promise.all(jobs);
  return jobs.length;
}
// shows "載入 N 年資料中…" in el while loading (only when something actually has to be loaded)
async function hyEnsureWithNote(el, kinds, years) {
  kinds = [].concat(kinds).map(k => HY_KIND[k] || k);
  const need = kinds.reduce((n, k) => n + years.filter(y => HY_YEARS[k].includes(y) && !HY_LOADED.has(`${k}_${y}`)).length, 0);
  if (need && el) el.innerHTML = `<p class="empty-note">載入 ${need} 個年度資料檔中…</p>`;
  await hyEnsure(kinds, years);
}

// "2001–2005、2008、2010–2024"
function hyYearRanges(years) {
  const ys = [...new Set((years || []).map(Number))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    out.push(i === j ? `${ys[i]}` : `${ys[i]}–${ys[j]}`);
    i = j;
  }
  return out.join("、");
}
// year <option>s, newest first
function hyYearOptions() {
  let h = "";
  for (let y = DATA_LAST_YEAR; y >= DATA_FIRST_YEAR; y--) h += `<option value="${y}">${y}</option>`;
  return h;
}

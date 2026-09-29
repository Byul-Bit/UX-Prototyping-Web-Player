/* UX Prototype Player (web) — plays projects exported by "UX Prototyping for iPAD" (.uxplay.zip).
 * Projects are stored only in this browser (IndexedDB). No server is contacted after the page is cached.
 */
(() => {
'use strict';

const VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function formatBytes(n) {
  if (!n) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i < 2 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

function formatDate(ms) {
  try {
    return new Date(ms).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) { return ''; }
}

let toastTimer = null;
function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(text) {
  $('busy-text').textContent = text || '처리 중…';
  $('busy').hidden = !text;
}

function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', heic: 'image/heic',
    heif: 'image/heif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff',
    caf: 'audio/x-caf', json: 'application/json'
  })[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Storage (IndexedDB): projects + asset blobs
// ---------------------------------------------------------------------------
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('ux-prototype-player', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('저장이 취소되었습니다.'));
    });
  }
  function reqp(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return {
    async listProjects() {
      const db = await open();
      const list = await reqp(db.transaction('projects').objectStore('projects').getAll());
      return list.sort((a, b) => b.importedAt - a.importedAt);
    },
    async getProject(id) {
      const db = await open();
      return reqp(db.transaction('projects').objectStore('projects').get(id));
    },
    async putFile(key, blob) {
      const db = await open();
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(blob, key);
      return done(tx);
    },
    async getFile(key) {
      const db = await open();
      return reqp(db.transaction('files').objectStore('files').get(key));
    },
    async putProject(rec) {
      const db = await open();
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(rec);
      return done(tx);
    },
    /** Deletes the project and its files. With keepKeys, only removes files not listed (old versions). */
    async deleteProject(id, keepKeys = null) {
      const db = await open();
      const keep = new Set(keepKeys || []);
      const tx = db.transaction(['projects', 'files'], 'readwrite');
      if (!keepKeys) tx.objectStore('projects').delete(id);
      const files = tx.objectStore('files');
      const range = IDBKeyRange.bound(id + '/', id + '/\uffff');
      // Callback style keeps the transaction active (no promise hop).
      files.getAllKeys(range).onsuccess = (ev) => {
        for (const k of ev.target.result) if (!keep.has(k)) files.delete(k);
      };
      return done(tx);
    }
  };
})();

// ---------------------------------------------------------------------------
// ZIP reader (stored + deflate), reads entries lazily with File.slice
// ---------------------------------------------------------------------------
const Zip = {
  async open(file) {
    const size = file.size;
    const tailLen = Math.min(size, 65557);
    const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 파일이 아닙니다.');
    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      // ZIP64 end of central directory
      const locAt = eocd - 20;
      if (locAt < 0 || tail.getUint32(locAt, true) !== 0x07064b50) throw new Error('지원하지 않는 ZIP 형식입니다.');
      const z64Offset = Number(tail.getBigUint64(locAt + 8, true));
      const z64 = new DataView(await file.slice(z64Offset, z64Offset + 56).arrayBuffer());
      count = Number(z64.getBigUint64(32, true));
      cdSize = Number(z64.getBigUint64(40, true));
      cdOffset = Number(z64.getBigUint64(48, true));
    }
    const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder('utf-8');
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const method = cd.getUint16(p + 10, true);
      let compSize = cd.getUint32(p + 20, true);
      let uncompSize = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let localOffset = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      // ZIP64 extra field
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.getUint16(e, true);
        const len = cd.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.getBigUint64(q, true)); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, compSize, uncompSize, localOffset });
      p = eEnd + commentLen;
    }
    return {
      entries,
      async blob(entry, type) {
        const lh = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP 파일이 손상되었습니다.');
        const start = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + entry.compSize);
        if (entry.method === 0) return new Blob([raw], { type });
        if (entry.method === 8) {
          if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축된 ZIP을 풀 수 없습니다. Mac 앱에서 내보낸 파일을 그대로 사용하세요.');
          const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
          const out = await new Response(stream).blob();
          return new Blob([out], { type });
        }
        throw new Error('지원하지 않는 압축 방식입니다.');
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Project model helpers (same rules as the Mac / iPad app)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Real-size calibration
//   CSS px on this iPad -> physical pixels. Normally 2, but iPadOS Display Zoom
//   ("더 많은 공간") makes the logical screen larger, so everything drawn at 2 px/pt
//   comes out smaller (e.g. 159 mm shown as ~137 mm on iPad Pro 13").
//   We detect the iPad from the screen's aspect ratio and compare its native
//   pixel count with the logical screen size. A manual correction is kept per device.
// ---------------------------------------------------------------------------
const IPADS = [
  { name: 'iPad Air 11"', w: 2360, h: 1640, ppi: 264, scale: 2 },
  { name: 'iPad Pro 11"', w: 2420, h: 1668, ppi: 264, scale: 2 },
  { name: 'iPad Air 13"', w: 2732, h: 2048, ppi: 264, scale: 2 },
  { name: 'iPad Pro 13"', w: 2752, h: 2064, ppi: 264, scale: 2 }
];

const Calib = {
  manual() {
    try {
      const v = parseFloat(localStorage.getItem('sizeCalibration'));
      return v > 0.3 && v < 3 ? v : 1;
    } catch (_) { return 1; }
  },
  setManual(v) {
    try {
      if (Math.abs(v - 1) < 0.0005) localStorage.removeItem('sizeCalibration');
      else localStorage.setItem('sizeCalibration', String(v));
    } catch (_) { /* ignore */ }
  },
  /** { physPerCss, ppi, name, detected, zoom } for the current screen. zoom < 1 = Display Zoom '더 많은 공간'. */
  detect(project, sw = window.screen.width, sh = window.screen.height) {
    const dev = (project && project.device) || {};
    const fallback = { physPerCss: dev.scale || 2, ppi: dev.ppi || 264, name: null, detected: false, zoom: 1 };
    const sl = Math.max(sw, sh), ss = Math.min(sw, sh);
    if (!(sl > 0 && ss > 0)) return fallback;
    const aspect = sl / ss;
    const cands = [];
    if (dev.nativeWidth && dev.nativeHeight) {
      cands.push({ name: dev.name, long: Math.max(dev.nativeWidth, dev.nativeHeight), short: Math.min(dev.nativeWidth, dev.nativeHeight), ppi: dev.ppi, scale: dev.scale || 2 });
    }
    for (const t of IPADS) cands.push({ name: t.name, long: Math.max(t.w, t.h), short: Math.min(t.w, t.h), ppi: t.ppi, scale: t.scale });
    let best = null;
    for (const c of cands) {
      const a = c.long / c.short;
      const err = Math.abs(aspect - a) / a;
      if (err < 0.02 && (!best || err < best.err - 0.002)) best = { ...c, err };   // project device wins near-ties (13" Air/Pro)
    }
    if (!best) return fallback;
    const physPerCss = best.long / sl;
    return { physPerCss, ppi: best.ppi, name: best.name, detected: true, zoom: physPerCss / best.scale };
  },
  /** CSS px per project-native pixel (physical size preserved), including the manual correction. */
  factor(project) {
    const c = Calib.detect(project);
    const devPPI = (project.device && project.device.ppi) || c.ppi;
    return (c.ppi / devPPI) / c.physPerCss * Calib.manual();
  },
  /** CSS px for a length in millimetres on this iPad. */
  mmToCss(project, mm) {
    const c = Calib.detect(project);
    return mm / 25.4 * c.ppi / c.physPerCss * Calib.manual();
  },
  describe(project) {
    const c = Calib.detect(project);
    const m = Calib.manual();
    let text;
    if (!c.detected) text = '이 화면의 iPad 모델을 알아내지 못해 기본 배율(1pt = 2px)을 씁니다.';
    else if (Math.abs(c.zoom - 1) < 0.01) text = `${c.name} 화면 · 화면 확대/축소 ‘기본’ — 자동 보정 없음`;
    else text = `${c.name} 화면 · 화면 확대/축소 설정 감지 (${c.zoom < 1 ? '더 많은 공간' : '큰 텍스트'}) — 자동으로 ${Math.round(100 / c.zoom)}% 크기로 보정`;
    if (Math.abs(m - 1) >= 0.0005) text += ` · 수동 보정 ${(m * 100).toFixed(1)}%`;
    return text;
  }
};

// Full screen (hides Safari UI and the status bar with time/date/battery where iPadOS allows it).
const FS = {
  el() { return document.documentElement; },
  supported() { const e = FS.el(); return !!(e.requestFullscreen || e.webkitRequestFullscreen); },
  active() { return !!(document.fullscreenElement || document.webkitFullscreenElement); },
  wanted() { try { return localStorage.getItem('autoFullscreen') !== '0'; } catch (_) { return true; } },
  setWanted(v) { try { localStorage.setItem('autoFullscreen', v ? '1' : '0'); } catch (_) { /* ignore */ } },
  enter() {
    if (!FS.supported() || FS.active()) return;
    const e = FS.el();
    try {
      const p = e.requestFullscreen ? e.requestFullscreen({ navigationUI: 'hide' }) : e.webkitRequestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* refused */ }
  },
  exit() {
    if (!FS.active()) return;
    try {
      const p = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* ignore */ }
  }
};

const Model = {
  displayPoints(project) {
    const d = project.display, dev = project.device;
    const toPx = (v) => (d.unit === 'px' ? v : v / 25.4 * dev.ppi);
    const f = Calib.factor(project);
    return {
      w: toPx(d.width) * f,
      h: toPx(d.height) * f,
      ox: toPx(d.offsetX || 0) * f,
      oy: toPx(d.offsetY || 0) * f
    };
  },
  /** Scrolling (long image) flow: content size as a multiple of the display, or null. */
  scrollInfo(project, flow) {
    const m = flow && flow.media;
    if (!m || m.kind !== 'image' || !m.scroll) return null;
    const a = Model.asset(project, m.assetID);
    if (!a || !(a.pixelWidth > 0) || !(a.pixelHeight > 0)) return null;
    const d = project.display;
    if (!(d.width > 0 && d.height > 0)) return null;
    const displayAspect = d.width / d.height;
    const imageAspect = a.pixelWidth / a.pixelHeight;
    if (m.scroll === 'vertical') {
      const kh = Math.max(1, displayAspect / imageAspect);
      return kh > 1.001 ? { axis: 'vertical', kw: 1, kh, max: kh - 1 } : null;
    }
    if (m.scroll === 'horizontal') {
      const kw = Math.max(1, imageAspect / displayAspect);
      return kw > 1.001 ? { axis: 'horizontal', kw, kh: 1, max: kw - 1 } : null;
    }
    return null;
  },
  sizeText(project) {
    const d = project.display;
    const f = (v) => (d.unit === 'px' ? Math.round(v) : v.toFixed(1));
    return `${f(d.width)} × ${f(d.height)} ${d.unit}`;
  },
  flow(project, id) {
    return id ? project.flows.find((f) => f.id === id) : undefined;
  },
  asset(project, id) {
    return id ? project.assets.find((a) => a.id === id) : undefined;
  },
  startFlow(project) {
    return Model.flow(project, project.startFlowID) || project.flows[0];
  },
  key(trigger) {
    switch (trigger.type) {
      case 'touchArea': return 'touchArea:' + (trigger.areaID || '');
      case 'swipe': return 'swipe:' + (trigger.direction || '');
      default: return trigger.type;
    }
  },
  connection(flow, triggerKey) {
    return flow.connections.find((c) => Model.key(c.trigger) === triggerKey);
  },
  contains(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function importZipFile(file) {
  const zip = await Zip.open(file);
  const candidates = zip.entries
    .filter((e) => !e.name.startsWith('__MACOSX/') && /(^|\/)project\.json$/.test(e.name))
    .sort((a, b) => a.name.length - b.name.length);
  if (!candidates.length) {
    if (/\.protopack$/i.test(file.name)) throw new Error('.protopack은 Mac 앱 전용 파일입니다. Mac 앱에서 ‘iPad 웹 플레이어용 내보내기’로 만든 .uxplay.zip을 선택하세요.');
    throw new Error('프로젝트 파일(project.json)이 없습니다. Mac 앱에서 ‘iPad 웹 플레이어용 내보내기’로 만든 파일인지 확인하세요.');
  }
  const pj = candidates[0];
  const root = pj.name.slice(0, pj.name.length - 'project.json'.length);
  const project = JSON.parse(await (await zip.blob(pj, 'application/json')).text());
  if (!project || !project.id || !Array.isArray(project.flows) || !project.display || !project.device) {
    throw new Error('프로젝트 형식을 읽을 수 없습니다.');
  }
  project.assets = project.assets || [];
  const byName = new Map(zip.entries.map((e) => [e.name, e]));

  const keys = [];
  let bytes = 0;
  let i = 0;
  const needed = project.assets.length;
  for (const a of project.assets) {
    i++;
    busy(`‘${project.name}’ 가져오는 중… (${i}/${needed})`);
    const entry = byName.get(root + 'assets/' + a.fileName);
    if (!entry) continue; // missing file: the flow shows black
    const blob = await zip.blob(entry, mimeFor(a.fileName));
    const key = `${project.id}/a/${a.id}`;
    await DB.putFile(key, blob);
    keys.push(key);
    bytes += blob.size;
  }
  // Thumbnail of the start flow (image or video frame made by the Mac app)
  let thumbKey = null;
  const start = Model.startFlow(project);
  if (start && start.media && start.media.assetID) {
    const te = byName.get(root + 'thumbnails/' + start.media.assetID + '.jpg');
    if (te) {
      thumbKey = `${project.id}/t/${start.media.assetID}`;
      await DB.putFile(thumbKey, await zip.blob(te, 'image/jpeg'));
      keys.push(thumbKey);
    } else if (start.media.kind === 'image') {
      thumbKey = `${project.id}/a/${start.media.assetID}`;
    }
  }
  // Remove files of an older version of the same project
  const existed = !!(await DB.getProject(project.id));
  await DB.deleteProject(project.id, keys);
  await DB.putProject({
    id: project.id,
    name: project.name,
    project,
    importedAt: Date.now(),
    bytes,
    thumbKey
  });
  return { name: project.name, updated: existed };
}

async function importFiles(files) {
  if (!files || !files.length) return;
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (_) { /* ignore */ }
  }
  const results = [];
  for (const f of files) {
    try {
      busy(`‘${f.name}’ 여는 중…`);
      results.push(await importZipFile(f));
    } catch (err) {
      busy(null);
      const msg = (err && err.name === 'QuotaExceededError')
        ? '저장 공간이 부족합니다. 사용하지 않는 프로젝트를 삭제하세요.'
        : (err && err.message) || String(err);
      alertBox(`‘${f.name}’을(를) 가져오지 못했습니다.\n${msg}`);
    }
  }
  busy(null);
  if (results.length) {
    toast(results.length === 1
      ? `‘${results[0].name}’ ${results[0].updated ? '새 버전으로 바꿨습니다' : '가져왔습니다'}`
      : `${results.length}개 프로젝트를 가져왔습니다`);
  }
  await renderLibrary();
}

function alertBox(text) {
  // window.alert is fine here: it is only used for import errors.
  window.alert(text);
}

// ---------------------------------------------------------------------------
// Library screen
// ---------------------------------------------------------------------------
const thumbURLs = new Map();

async function renderLibrary() {
  const grid = $('grid');
  const list = await DB.listProjects();
  for (const u of thumbURLs.values()) URL.revokeObjectURL(u);
  thumbURLs.clear();
  grid.textContent = '';
  $('empty').hidden = list.length > 0;
  for (const rec of list) {
    const p = rec.project;
    const thumb = h('div', { class: 'thumb' }, '▶︎');
    if (rec.thumbKey) {
      DB.getFile(rec.thumbKey).then((blob) => {
        if (!blob) return;
        const u = URL.createObjectURL(blob);
        thumbURLs.set(rec.id, u);
        thumb.textContent = '';
        thumb.append(h('img', { src: u, alt: '' }));
      });
    }
    const card = h('div', { class: 'card', role: 'button', tabindex: '0' },
      thumb,
      h('div', { class: 'card-body' },
        h('b', {}, p.name),
        h('span', {}, `${p.device.name} · ${p.display.orientation === 'landscape' ? '가로' : '세로'} · ${Model.sizeText(p)}`),
        h('span', {}, `Flow ${p.flows.length}개 · ${formatBytes(rec.bytes)} · ${formatDate(rec.importedAt)}`)
      ),
      h('button', {
        class: 'more', type: 'button', 'aria-label': '삭제',
        onclick: (ev) => {
          ev.stopPropagation();
          if (window.confirm(`‘${p.name}’을(를) 이 iPad에서 삭제할까요?\nMac의 원본은 그대로입니다.`)) {
            DB.deleteProject(rec.id).then(renderLibrary);
          }
        }
      }, '🗑')
    );
    card.addEventListener('click', () => Player.open(rec.id));
    grid.append(card);
  }
  updateStorageInfo(list.length);
}

async function updateStorageInfo(count) {
  let text = `프로젝트 ${count}개`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e.usage !== undefined) text += ` · 사용 ${formatBytes(e.usage)}`;
    }
  } catch (_) { /* ignore */ }
  $('storage-info').textContent = text;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
const TAP_MAX_DISTANCE = 10;
const TAP_MAX_DURATION = 500;
const SWIPE_MIN_DISTANCE = 30;
const FLICK_MIN_DISTANCE = 15;
const FLICK_MIN_SPEED = 300; // pt/s
const AXIS_DOMINANCE = 1.5;

const Player = {
  rec: null,
  project: null,
  urls: new Map(),        // assetID -> object URL
  blobs: new Map(),       // assetID -> Blob
  audioBuffers: new Map(),
  audioCtx: null,
  videoPool: [],
  // engine state
  currentFlowID: null,
  token: 0,
  phase: 'waiting',
  autoTimer: null,
  transitionTimer: null,
  entryAudio: null,        // { src, stopOnExit }
  lingering: [],
  currentLayer: null,
  showAreas: false,
  showMarks: false,
  size: { w: 0, h: 0, k: 1 },
  wakeLock: null,
  effects: [],             // playing sound-effect sources
  scroll: null,            // scrollInfo of the current flow
  scrollOff: 0,            // display lengths along the scroll axis
  momentum: null,
  areaContent: null,

  async open(id) {
    const rec = await DB.getProject(id);
    if (!rec) return;
    if (!rec.project.flows.length) { toast('Flow가 없는 프로젝트입니다.'); return; }
    this.rec = rec;
    this.project = rec.project;
    busy('준비 중…');
    try {
      for (const a of this.project.assets) {
        const blob = await DB.getFile(`${this.project.id}/a/${a.id}`);
        if (!blob) continue;
        this.blobs.set(a.id, blob);
        this.urls.set(a.id, URL.createObjectURL(blob));
      }
    } finally {
      busy(null);
    }
    $('library').hidden = true;
    $('player').hidden = false;
    $('start-title').textContent = this.project.name;
    $('start-sub').textContent = `${this.project.device.name} · ${Model.sizeText(this.project)} · Flow ${this.project.flows.length}개`;
    $('start-overlay').hidden = false;
    $('menu').hidden = true;
    this.layout();
    this.renderStill(Model.startFlow(this.project));
  },

  /** Called from the "탭해서 시작" button: unlocks sound and video for the whole session. */
  start() {
    if (FS.wanted()) FS.enter();   // must run first, inside the tap
    $('start-overlay').hidden = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        if (!this.audioCtx) this.audioCtx = new AC();
        this.audioCtx.resume();
        const b = this.audioCtx.createBuffer(1, 1, 22050);
        const s = this.audioCtx.createBufferSource();
        s.buffer = b;
        s.connect(this.audioCtx.destination);
        s.start(0);
      } catch (_) { this.audioCtx = null; }
    }
    // Two video elements, unlocked inside this user gesture and reused for every video flow.
    const firstVideo = this.project.assets.find((a) => a.type === 'video' && this.urls.has(a.id));
    if (!this.videoPool.length) {
      for (let i = 0; i < 2; i++) {
        const v = document.createElement('video');
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.preload = 'auto';
        v.disablePictureInPicture = true;
        v._busy = false;
        this.videoPool.push(v);
      }
    }
    if (firstVideo) {
      for (const v of this.videoPool) {
        v.src = this.urls.get(firstVideo.id);
        v.muted = false;
        const p = v.play();
        // Pause again only if the engine has not taken this element in the meantime.
        if (p && p.then) p.then(() => { if (!v._busy) v.pause(); }).catch(() => {});
        else if (!v._busy) v.pause();
      }
    }
    this.decodeAudio();
    this.requestWakeLock();
    this.run();
  },

  async decodeAudio() {
    if (!this.audioCtx) return;
    const sounds = this.project.assets.filter((a) => a.type === 'sfx' || a.type === 'audio');
    sounds.sort((a, b) => (a.type === 'sfx' ? 0 : 1) - (b.type === 'sfx' ? 0 : 1));   // short effects first
    for (const a of sounds) {
      if (this.audioBuffers.has(a.id)) continue;
      const blob = this.blobs.get(a.id);
      if (!blob) continue;
      try {
        const buf = await blob.arrayBuffer();
        const decoded = await new Promise((resolve, reject) => {
          const r = this.audioCtx.decodeAudioData(buf, resolve, reject);
          if (r && r.then) r.then(resolve, reject);
        });
        this.audioBuffers.set(a.id, decoded);
      } catch (_) { /* unsupported audio: skipped */ }
    }
  },

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) { /* ignore */ }
  },

  close() {
    this.stopEngine();
    for (const v of this.videoPool) { v.pause(); v.removeAttribute('src'); v.load(); v._busy = false; v.remove(); }
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.blobs.clear();
    this.audioBuffers.clear();
    $('layers').textContent = '';
    $('areas').textContent = '';
    $('marks').textContent = '';
    this.currentLayer = null;
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
    $('player').hidden = true;
    $('menu').hidden = true;
    $('start-overlay').hidden = true;
    $('calib').hidden = true;
    $('library').hidden = false;
    FS.exit();
    this.rec = null;
    this.project = null;
    this.scroll = null;
    this.scrollOff = 0;
    this.stopMomentum();
    renderLibrary();
  },

  // ---------------- Layout ----------------
  layout() {
    if (!this.project) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const d = Model.displayPoints(this.project);
    let k = 1;
    if (d.w > vw + 0.5 || d.h > vh + 0.5) k = Math.min(vw / d.w, vh / d.h);
    const w = d.w * k, hgt = d.h * k;
    const left = (vw - w) / 2 + d.ox * k;
    const top = (vh - hgt) / 2 + d.oy * k;
    const st = $('stage');
    Object.assign(st.style, { width: w + 'px', height: hgt + 'px', left: left + 'px', top: top + 'px' });
    this.size = { w, h: hgt, k, left, top };
    this.renderCorners(vw, vh);
    this.renderAreas();
    // Orientation hint
    const wantsLandscape = this.project.display.orientation === 'landscape';
    const isLandscape = vw >= vh;
    const hint = $('rotate-hint');
    hint.textContent = wantsLandscape ? 'iPad를 가로 방향으로 돌려주세요' : 'iPad를 세로 방향으로 돌려주세요';
    hint.hidden = wantsLandscape === isLandscape;
  },

  renderCorners(vw, vh) {
    const box = $('corners');
    box.textContent = '';
    const zone = 70;
    const s = this.size;
    const disp = { x: s.left, y: s.top, w: s.w, h: s.h };
    const spots = [[0, 0], [vw - zone, 0], [0, vh - zone], [vw - zone, vh - zone]];
    for (const [x, y] of spots) {
      const overlaps = x < disp.x + disp.w && x + zone > disp.x && y < disp.y + disp.h && y + zone > disp.y;
      if (overlaps) continue;
      const c = h('div', { class: 'corner', style: { left: x + 'px', top: y + 'px' } });
      let timer = null;
      const cancel = () => { clearTimeout(timer); timer = null; };
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        cancel();
        timer = setTimeout(() => { timer = null; this.openMenu(); }, 2000);
      });
      c.addEventListener('pointerup', cancel);
      c.addEventListener('pointercancel', cancel);
      c.addEventListener('pointerleave', cancel);
      box.append(c);
    }
  },

  renderAreas() {
    const box = $('areas');
    box.textContent = '';
    if (!this.showAreas || !this.project) return;
    this.areaContent = null;
    const flow = Model.flow(this.project, this.currentFlowID);
    if (!flow) return;
    const sc = this.scroll;
    const content = h('div', { class: 'area-content' });
    if (sc) Object.assign(content.style, { width: sc.kw * 100 + '%', height: sc.kh * 100 + '%' });
    box.append(content);
    for (const a of flow.touchAreas || []) {
      const r = a.rect;
      const code = 'TA-' + String(a.number).padStart(2, '0');
      const pinned = !!(sc && a.pinned);
      (sc && !pinned ? content : box).append(h('div', {
        class: 'area' + (pinned ? ' pinned' : ''),
        style: { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' }
      }, (pinned ? '📌 ' : '') + (a.name ? `${code} ${a.name}` : code)));
    }
    this.areaContent = content;
    this.applyScroll();
  },

  // ---------------- Scrolling (long images) ----------------
  scrollTransform(len) {
    const sc = this.scroll;
    if (!sc) return '';
    const pct = -this.scrollOff / len * 100;
    return sc.axis === 'vertical' ? `translate3d(0, ${pct}%, 0)` : `translate3d(${pct}%, 0, 0)`;
  },
  applyScroll() {
    const sc = this.scroll;
    if (!sc) return;
    const len = sc.axis === 'vertical' ? sc.kh : sc.kw;
    const t = this.scrollTransform(len);
    if (this.currentLayer && this.currentLayer._scrollImg) this.currentLayer._scrollImg.style.transform = t;
    if (this.areaContent) this.areaContent.style.transform = t;
  },
  setScroll(v) {
    if (!this.scroll) return;
    this.scrollOff = clamp(v, 0, this.scroll.max);
    this.applyScroll();
  },
  stopMomentum() {
    if (this.momentum) cancelAnimationFrame(this.momentum);
    this.momentum = null;
  },
  /** Momentum after the finger lifts. vel = display lengths per second. */
  fling(vel) {
    this.stopMomentum();
    if (!this.scroll || Math.abs(vel) < 0.15) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      vel *= Math.exp(-dt / 0.33);
      const before = this.scrollOff;
      this.setScroll(this.scrollOff + vel * dt);
      if (Math.abs(vel) < 0.03 || (dt > 0 && this.scrollOff === before)) { this.momentum = null; return; }
      this.momentum = requestAnimationFrame(step);
    };
    this.momentum = requestAnimationFrame(step);
  },
  /** Point on the whole long image (normalized) for a point on the display. */
  contentPoint(x, y) {
    const sc = this.scroll;
    if (!sc) return { x, y };
    return sc.axis === 'vertical' ? { x, y: (y + this.scrollOff) / sc.kh } : { x: (x + this.scrollOff) / sc.kw, y };
  },

  // ---------------- Rendering ----------------
  fitCSS(fit) {
    return fit === 'fill' ? 'cover' : fit === 'stretch' ? 'fill' : 'contain';
  },

  /** Still first frame under the start overlay (no playback yet). */
  renderStill(flow) {
    const layers = $('layers');
    layers.textContent = '';
    const layer = h('div', { class: 'layer' });
    if (flow && flow.media.kind === 'image' && this.urls.get(flow.media.assetID)) {
      this.appendImage(layer, flow, this.urls.get(flow.media.assetID));
    }
    layers.append(layer);
    this.currentLayer = layer;
  },

  appendImage(layer, flow, url) {
    const sc = Model.scrollInfo(this.project, flow);
    if (sc) {
      const img = h('img', { src: url, alt: '', decoding: 'async', class: 'scroll',
        style: { width: sc.kw * 100 + '%', height: sc.kh * 100 + '%' } });
      layer._scrollImg = img;
      layer.append(img);
    } else {
      layer.append(h('img', { src: url, alt: '', decoding: 'async', style: { objectFit: this.fitCSS(flow.media.fit) } }));
    }
  },

  /** Makes `flow` the current one for scrolling and resets the scroll position. */
  setCurrent(flow) {
    this.stopMomentum();
    this.currentFlowID = flow.id;
    this.scroll = Model.scrollInfo(this.project, flow);
    this.scrollOff = 0;
  },

  makeLayer(flow, token) {
    const layer = h('div', { class: 'layer' });
    const m = flow.media;
    const url = m.assetID ? this.urls.get(m.assetID) : null;
    if (m.kind === 'image' && url) {
      this.appendImage(layer, flow, url);
    } else if (m.kind === 'video' && url) {
      const v = this.videoPool.find((x) => !x._busy) || this.videoPool[0];
      if (v) {
        v._busy = true;
        v.onended = null;
        v.pause();
        if (v.getAttribute('src') !== url) v.src = url;
        v.loop = m.videoMode === 'loop';
        v.muted = !!m.muted;
        v.style.objectFit = this.fitCSS(m.fit);
        try { v.currentTime = 0; } catch (_) { /* not loaded yet */ }
        v.onended = () => this.videoDidEnd(token);
        layer.append(v);
        layer._video = v;
        const p = v.play();
        if (p && p.catch) {
          p.catch(() => {
            // Autoplay with sound refused: play muted rather than showing nothing.
            v.muted = true;
            v.play().catch(() => {});
          });
        }
      }
    }
    return layer;
  },

  releaseLayer(layer) {
    if (!layer) return;
    if (layer._video) {
      const v = layer._video;
      v.onended = null;
      v.pause();
      v._busy = false;
      v.remove();
    }
    layer.remove();
  },

  preloadNext(flow) {
    for (const c of flow.connections) {
      const next = Model.flow(this.project, c.targetFlowID);
      if (next && next.media.kind === 'image' && this.urls.get(next.media.assetID)) {
        const img = new Image();
        img.src = this.urls.get(next.media.assetID);
        if (img.decode) img.decode().catch(() => {});
      }
    }
  },

  // ---------------- Engine ----------------
  run(fromFlowID) {
    this.stopEngine();
    const first = Model.flow(this.project, fromFlowID) || Model.startFlow(this.project);
    if (!first) return;
    this.token++;
    this.setCurrent(first);
    for (const old of Array.from($('layers').children)) this.releaseLayer(old);
    const layer = this.makeLayer(first, this.token);
    $('layers').append(layer);
    this.currentLayer = layer;
    this.renderAreas();
    this.enter(first);
  },

  stopEngine() {
    clearTimeout(this.autoTimer);
    clearTimeout(this.transitionTimer);
    this.autoTimer = null;
    this.transitionTimer = null;
    this.stopAllAudio();
    this.phase = 'waiting';
  },

  enter(flow) {
    this.playEntryAudio(flow);
    this.settle(flow);
  },

  settle(flow) {
    const isVideo = flow.media.kind === 'video' && this.urls.has(flow.media.assetID);
    this.phase = isVideo ? 'playing' : 'waiting';
    this.scheduleAuto(flow);
    this.preloadNext(flow);
  },

  scheduleAuto(flow) {
    clearTimeout(this.autoTimer);
    const c = flow.connections.find((x) => x.trigger.type === 'autoDelay');
    if (!c) return;
    const token = this.token;
    const delay = Math.max(c.trigger.delay || 0, 0);
    this.autoTimer = setTimeout(() => {
      if (this.token === token && this.phase !== 'transitioning') this.go(c);
    }, delay * 1000);
  },

  videoDidEnd(token) {
    const flow = Model.flow(this.project, this.currentFlowID);
    if (token !== this.token || this.phase === 'transitioning' || !flow || flow.media.kind !== 'video') return;
    switch (flow.media.videoMode) {
      case 'loop': break;
      case 'hold': this.phase = 'waiting'; break;
      case 'autoNext': {
        const c = Model.connection(flow, 'videoEnd');
        if (c) this.go(c); else this.phase = 'waiting';
        break;
      }
      default: this.phase = 'waiting';
    }
  },

  handle(input) {
    if (this.phase === 'transitioning') return;
    const flow = Model.flow(this.project, this.currentFlowID);
    if (!flow) return;
    if (input.type === 'tap') {
      const sc = this.scroll;
      let areas = (flow.touchAreas || []).slice().reverse();
      // Scrolling flow: areas pinned to the screen come first, the rest are placed on the whole image.
      if (sc) areas = areas.filter((a) => a.pinned).concat(areas.filter((a) => !a.pinned));
      const cp = this.contentPoint(input.x, input.y);
      for (const a of areas) {
        const p = sc && !a.pinned ? cp : input;
        if (Model.contains(a.rect, p.x, p.y)) {
          const c = Model.connection(flow, 'touchArea:' + a.id);
          if (c) { this.go(c); return; }
        }
      }
      const c = Model.connection(flow, 'tapAnywhere');
      if (c) this.go(c);
    } else if (input.type === 'swipe') {
      const c = Model.connection(flow, 'swipe:' + input.direction);
      if (c) this.go(c);
    }
  },

  go(c) {
    const target = Model.flow(this.project, c.targetFlowID);
    if (!target) return;
    clearTimeout(this.autoTimer);
    clearTimeout(this.transitionTimer);
    this.phase = 'transitioning';
    this.playEffect(c);
    if (this.entryAudio && this.entryAudio.stopOnExit) this.stopSource(this.entryAudio.src);
    const style = (c.transition && c.transition.style) || 'none';
    const duration = style === 'none' ? 0 : Math.max((c.transition && c.transition.duration) || 0, 0.05);
    this.token++;
    const token = this.token;
    const oldLayer = this.currentLayer;
    const newLayer = this.makeLayer(target, token);
    this.setCurrent(target);
    this.currentLayer = newLayer;
    $('layers').append(newLayer);
    this.renderAreas();
    this.playEntryAudio(target);

    if (style === 'none' || !newLayer.animate) {
      this.releaseLayer(oldLayer);
      this.settle(target);
      return;
    }
    const ms = duration * 1000;
    const easing = 'ease-in-out';
    if (style === 'fade') {
      newLayer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing, fill: 'both' });
      if (oldLayer) oldLayer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing, fill: 'both' });
    } else {
      const d = c.trigger.type === 'swipe' ? (c.trigger.direction || 'left') : 'left';
      const move = {
        left: ['translateX(100%)', 'translateX(-100%)'],
        right: ['translateX(-100%)', 'translateX(100%)'],
        up: ['translateY(100%)', 'translateY(-100%)'],
        down: ['translateY(-100%)', 'translateY(100%)']
      }[d];
      newLayer.animate([{ transform: move[0] }, { transform: 'none' }], { duration: ms, easing, fill: 'both' });
      if (oldLayer) oldLayer.animate([{ transform: 'none' }, { transform: move[1] }], { duration: ms, easing, fill: 'both' });
    }
    this.transitionTimer = setTimeout(() => {
      this.releaseLayer(oldLayer);
      if (this.token === token) this.settle(target);
    }, ms);
  },

  // ---------------- Audio ----------------
  playEntryAudio(flow) {
    this.lingering = this.lingering.filter((x) => x.playing);
    if (this.entryAudio && this.entryAudio.playing && !this.entryAudio.stopOnExit) this.lingering.push(this.entryAudio);
    this.entryAudio = null;
    const ea = flow.entryAudio;
    if (!ea || !this.audioCtx) return;
    const buffer = this.audioBuffers.get(ea.assetID);
    if (!buffer) {
      // Not decoded yet (large file): try again shortly while still in this flow.
      const token = this.token;
      setTimeout(() => {
        if (this.token === token && this.audioBuffers.get(ea.assetID) && !this.entryAudio) this.playEntryAudio(flow);
      }, 400);
      return;
    }
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.audioCtx.destination);
    const item = { src, stopOnExit: !!ea.stopOnExit, playing: true };
    src.onended = () => { item.playing = false; };
    src.start(0);
    this.entryAudio = item;
  },

  /** Interaction sound effect: right away or after its delay, at its volume. Keeps playing across flows. */
  playEffect(c) {
    const s = c.sound;
    if (!s || !s.assetID || !this.audioCtx) return;
    const buffer = this.audioBuffers.get(s.assetID);
    if (!buffer) return;
    try {
      const ctx = this.audioCtx;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = clamp(typeof s.volume === 'number' ? s.volume : 1, 0, 1);
      src.connect(gain);
      gain.connect(ctx.destination);
      src.onended = () => { this.effects = this.effects.filter((x) => x !== src); };
      src.start(ctx.currentTime + Math.max(s.delay || 0, 0));
      this.effects.push(src);
    } catch (_) { /* ignore */ }
  },

  stopSource(src) {
    try { src.stop(); } catch (_) { /* already stopped */ }
  },

  stopAllAudio() {
    if (this.entryAudio) this.stopSource(this.entryAudio.src);
    for (const x of this.lingering) this.stopSource(x.src);
    this.entryAudio = null;
    this.lingering = [];
    for (const src of this.effects) this.stopSource(src);
    this.effects = [];
  },

  // ---------------- Menu ----------------
  openMenu() {
    if (!this.project) return;
    const flow = Model.flow(this.project, this.currentFlowID);
    $('menu-title').textContent = flow ? (flow.name ? `Flow ${String(flow.number).padStart(2, '0')} · ${flow.name}` : `Flow ${String(flow.number).padStart(2, '0')}`) : '';
    $('m-areas').textContent = this.showAreas ? 'Touch Area 숨기기' : 'Touch Area 보기';
    $('m-marks').textContent = this.showMarks ? '터치 표시 끄기' : '터치 표시 켜기';
    $('m-full').hidden = !FS.supported();
    $('m-full').textContent = FS.active() ? '전체 화면 끄기' : '전체 화면으로';
    $('menu').hidden = false;
  },

  addMark(x, y, swipe) {
    if (!this.showMarks) return;
    const m = h('div', { class: 'mark' + (swipe ? ' swipe' : ''), style: { left: x + 'px', top: y + 'px' } });
    $('marks').append(m);
    setTimeout(() => m.remove(), 500);
  }
};

// ---------------------------------------------------------------------------
// Input: taps and swipes on the prototype display
// ---------------------------------------------------------------------------
function setupStageInput() {
  const hit = $('hit');
  let track = null;
  const activePointers = new Set();

  hit.addEventListener('pointerdown', (e) => {
    activePointers.add(e.pointerId);
    if (activePointers.size > 1) { track = null; return; }
    const r = hit.getBoundingClientRect();
    Player.stopMomentum();
    track = {
      id: e.pointerId,
      x0: e.clientX - r.left,
      y0: e.clientY - r.top,
      cx0: e.clientX,
      cy0: e.clientY,
      s0: Player.scrollOff,
      t0: performance.now(),
      samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }]
    };
    try { hit.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
  });
  hit.addEventListener('pointermove', (e) => {
    if (!track || e.pointerId !== track.id) return;
    track.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (track.samples.length > 12) track.samples.shift();
    // Long image: the content follows the finger along the scroll axis.
    const sc = Player.scroll;
    if (sc && Player.phase !== 'transitioning' && $('start-overlay').hidden && $('menu').hidden) {
      const r = hit.getBoundingClientRect();
      const dx = e.clientX - track.cx0, dy = e.clientY - track.cy0;
      const along = sc.axis === 'vertical' ? dy : dx;
      const cross = sc.axis === 'vertical' ? dx : dy;
      const len = sc.axis === 'vertical' ? r.height : r.width;
      if (Math.abs(cross) > Math.abs(along) * 1.2) Player.setScroll(track.s0);
      else if (len > 0) Player.setScroll(track.s0 - along / len);
    }
  });
  const finish = (e, cancelled) => {
    activePointers.delete(e.pointerId);
    if (!track || e.pointerId !== track.id) return;
    const t = track;
    track = null;
    if (cancelled || !Player.project || !$('start-overlay').hidden || !$('menu').hidden) return;
    const r = hit.getBoundingClientRect();
    const x1 = e.clientX - r.left, y1 = e.clientY - r.top;
    const dx = x1 - t.x0, dy = y1 - t.y0;
    const dist = Math.hypot(dx, dy);
    const dur = performance.now() - t.t0;
    // Velocity over the last ~80 ms
    const now = performance.now();
    let ref = t.samples[0];
    for (const s of t.samples) { if (now - s.t <= 80) { ref = s; break; } }
    const dt = Math.max((now - ref.t) / 1000, 0.001);
    const speed = Math.hypot(e.clientX - ref.x, e.clientY - ref.y) / dt;
    const sc = Player.scroll;
    const flingNow = () => {
      if (!sc) return;
      const v = sc.axis === 'vertical' ? (e.clientY - ref.y) / dt : (e.clientX - ref.x) / dt;
      const len = sc.axis === 'vertical' ? r.height : r.width;
      if (len > 0 && now - ref.t < 200) Player.fling(-v / len);
    };

    if (dist < TAP_MAX_DISTANCE && dur < TAP_MAX_DURATION) {
      if (r.width > 0 && r.height > 0) {
        Player.addMark(t.x0, t.y0, false);
        Player.handle({ type: 'tap', x: t.x0 / r.width, y: t.y0 / r.height });
      }
      return;
    }
    if (!(dist >= SWIPE_MIN_DISTANCE || (speed >= FLICK_MIN_SPEED && dist >= FLICK_MIN_DISTANCE))) { flingNow(); return; }
    let direction = null;
    if (Math.abs(dx) >= Math.abs(dy) * AXIS_DOMINANCE) direction = dx < 0 ? 'left' : 'right';
    else if (Math.abs(dy) >= Math.abs(dx) * AXIS_DOMINANCE) direction = dy < 0 ? 'up' : 'down';
    if (!direction) { flingNow(); return; }
    if (sc) {
      const along = sc.axis === 'vertical' ? (direction === 'up' || direction === 'down') : (direction === 'left' || direction === 'right');
      if (along) {
        // Along the scroll axis a drag scrolls; it works as a Swipe only when the image was already at its end.
        const towardEnd = direction === 'up' || direction === 'left';
        const atEdge = towardEnd ? t.s0 >= sc.max - 0.001 : t.s0 <= 0.001;
        if (!atEdge) { flingNow(); return; }
      }
    }
    Player.addMark(x1, y1, true);
    Player.handle({ type: 'swipe', direction });
  };
  hit.addEventListener('pointerup', (e) => finish(e, false));
  hit.addEventListener('pointercancel', (e) => finish(e, true));

  // Four-finger hold (1 s) anywhere opens the menu.
  let holdTimer = null;
  const player = $('player');
  player.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 4 && !holdTimer) {
      holdTimer = setTimeout(() => { holdTimer = null; Player.openMenu(); }, 1000);
    }
  }, { passive: true });
  const cancelHold = (e) => {
    if (e.touches.length < 4) { clearTimeout(holdTimer); holdTimer = null; }
  };
  player.addEventListener('touchend', cancelHold, { passive: true });
  player.addEventListener('touchcancel', cancelHold, { passive: true });
  // No page scroll / zoom while playing.
  player.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  player.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if ($('player').hidden) return;
    if (!$('start-overlay').hidden) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Player.start(); }
      if (e.key === 'Escape') Player.close();
      return;
    }
    const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (map[e.key]) {
      e.preventDefault();
      const d = map[e.key], sc = Player.scroll;
      if (sc && Player.phase !== 'transitioning') {
        const along = sc.axis === 'vertical' ? (d === 'up' || d === 'down') : (d === 'left' || d === 'right');
        const forward = d === 'down' || d === 'right';   // arrow keys move the view like a page
        if (along && (forward ? Player.scrollOff < sc.max - 0.001 : Player.scrollOff > 0.001)) {
          Player.setScroll(Player.scrollOff + (forward ? 0.4 : -0.4));
          return;
        }
      }
      Player.handle({ type: 'swipe', direction: d });
      return;
    }
    if (e.key === 'Escape') { Player.close(); return; }
    if (e.key === 'r' || e.key === 'R') { Player.run(); return; }
    if (e.key === 't' || e.key === 'T') { Player.showAreas = !Player.showAreas; Player.renderAreas(); }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Real-size calibration sheet: a 100 mm bar to check with a ruler
// ---------------------------------------------------------------------------
function calibProject() {
  return Player.project || { device: { name: '', nativeWidth: 0, nativeHeight: 0, ppi: 264, scale: 2 } };
}
function renderCalibration() {
  const p = calibProject();
  $('c-status').textContent = Calib.describe(p);
  $('c-bar').style.width = Calib.mmToCss(p, 100) + 'px';
  $('c-value').textContent = `수동 보정 ${(Calib.manual() * 100).toFixed(1)}%`;
}
function nudgeCalibration(d) {
  Calib.setManual(clamp(Math.round((Calib.manual() + d) * 1000) / 1000, 0.5, 1.5));
  renderCalibration();
}
function openCalibration() {
  renderCalibration();
  $('calib').hidden = false;
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function setup() {
  $('version').textContent = `UX Prototype Player (웹) ${VERSION}`;
  const input = $('file-input');
  const pick = () => { input.value = ''; input.click(); };
  $('btn-import').addEventListener('click', pick);
  $('btn-import-empty').addEventListener('click', pick);
  input.addEventListener('change', () => importFiles(Array.from(input.files || [])));

  $('btn-help').addEventListener('click', () => { $('help').hidden = false; });
  $('btn-help-close').addEventListener('click', () => { $('help').hidden = true; });

  let hintHidden = false;
  try { hintHidden = localStorage.getItem('hideInstallHint') === '1'; } catch (_) { /* ignore */ }
  $('install-hint').hidden = isStandalone() || hintHidden;
  $('btn-hide-hint').addEventListener('click', () => {
    $('install-hint').hidden = true;
    try { localStorage.setItem('hideInstallHint', '1'); } catch (_) { /* ignore */ }
  });

  $('btn-start').addEventListener('click', () => Player.start());
  $('btn-start-cancel').addEventListener('click', () => Player.close());
  $('m-restart').addEventListener('click', () => { $('menu').hidden = true; Player.run(); });
  $('m-areas').addEventListener('click', () => { Player.showAreas = !Player.showAreas; Player.renderAreas(); $('menu').hidden = true; });
  $('m-marks').addEventListener('click', () => { Player.showMarks = !Player.showMarks; $('menu').hidden = true; });
  $('m-exit').addEventListener('click', () => Player.close());
  $('m-close').addEventListener('click', () => {
    $('menu').hidden = true;
    if (FS.wanted()) FS.enter();   // back to full screen if the user left it
  });
  $('m-full').addEventListener('click', () => {
    $('menu').hidden = true;
    if (FS.active()) { FS.setWanted(false); FS.exit(); } else { FS.setWanted(true); FS.enter(); }
  });
  $('m-calib').addEventListener('click', () => { $('menu').hidden = true; openCalibration(); });
  $('btn-calib').addEventListener('click', () => openCalibration());
  $('c-minus').addEventListener('click', () => nudgeCalibration(-0.01));
  $('c-minus-s').addEventListener('click', () => nudgeCalibration(-0.002));
  $('c-plus-s').addEventListener('click', () => nudgeCalibration(0.002));
  $('c-plus').addEventListener('click', () => nudgeCalibration(0.01));
  $('c-reset').addEventListener('click', () => { Calib.setManual(1); renderCalibration(); });
  $('c-close').addEventListener('click', () => { $('calib').hidden = true; Player.layout(); });
  const onFS = () => setTimeout(() => Player.layout(), 60);
  document.addEventListener('fullscreenchange', onFS);
  document.addEventListener('webkitfullscreenchange', onFS);

  window.addEventListener('resize', () => Player.layout());
  window.addEventListener('orientationchange', () => setTimeout(() => Player.layout(), 200));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Player.project && !$('player').hidden) {
      Player.requestWakeLock();
      if (Player.audioCtx) Player.audioCtx.resume().catch(() => {});
    }
  });

  setupStageInput();
  setupKeyboard();
  renderLibrary();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (!window.indexedDB) {
  document.body.textContent = '이 브라우저는 저장소(IndexedDB)를 지원하지 않습니다.';
} else {
  setup();
}

// Exposed for automated tests.
window.__uxplayer = { Player, DB, Zip, Model, Calib, FS, importFiles, VERSION };
})();

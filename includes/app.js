let EVENTS = [];
const WIKI_FILE = "https://vdd-aktuell.de/mediawiki/index.php?title=Special:Redirect/file/";
const VAPID_PUBLIC_KEY = 'BB56Mes7d34d0yJ0xzH1krHSWVj1Fly91I6rAfkwMU-qoXvbkfXkMts2pDrOaq_21TqwBNNcjla49FdB2H2P22Q';
const PUSH_SERVER_URL  = 'https://vdd-rittatlas-server.fly.dev';

function safeUrl(url) {
  return url && /^https?:\/\//i.test(url) ? url : '';
}
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const imgCache = {};
function preloadImg(ev) {
  if (ev.ritt_bild && !imgCache[ev.id]) {
    const img = new Image();
    img.src = WIKI_FILE + encodeURIComponent(ev.ritt_bild);
    imgCache[ev.id] = img;
  }
}

// ── favourites ────────────────────────────────────────────────────────────────
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem('vdd_favs') || '[]')); } catch(_) {}

function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  try { localStorage.setItem('vdd_favs', JSON.stringify([...favs])); } catch(_) {}
  const starred = favs.has(id);
  const ev = EVENTS.find(e => e.id === id);
  if (ev) ev._fav = starred ? 1 : 0;
  document.querySelectorAll('.fav-star').forEach(s => {
    if (s.dataset.id === id) {
      s.classList.toggle('starred', starred);
      s.title = starred ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
    }
  });
  document.querySelectorAll(`[data-fav-id="${CSS.escape(id)}"]`).forEach(el => {
    el.classList.toggle('starred', starred);
    el.title = starred ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
  });
  applyFilters();
  schedulePrefSync();
}

// ── push notifications ────────────────────────────────────────────────────────
let _prefSyncTimer = null;
let _savedTimer = null;

function _setSyncStatus(s, msg = '') {
  clearTimeout(_savedTimer);
  const loading = s === 'pending';
  document.getElementById('sn-pill-changes')?.classList.toggle('sn-pill-loading', loading);
  document.getElementById('sn-toggle-new-events')?.classList.toggle('sn-toggle-loading', loading);
  const el = document.getElementById('sn-sync-status');
  if (el) {
    if (s === 'saved') { el.className = 'sn-sync-saved'; el.textContent = 'Gespeichert'; }
    else if (s === 'error') { el.className = 'sn-error'; el.textContent = msg || 'Fehler beim Speichern'; }
    else { el.className = ''; el.textContent = ''; }
  }
  if (s === 'saved' || s === 'error') _savedTimer = setTimeout(() => _setSyncStatus('idle'), 4000);
}

function schedulePrefSync() {
  clearTimeout(_prefSyncTimer);
  _setSyncStatus('pending');
  _prefSyncTimer = setTimeout(syncPrefsToServer, 1500);
}

async function syncPrefsToServer() {
  const subJson = localStorage.getItem('vdd_push_sub');
  if (!subJson) return;
  let sub;
  try { sub = JSON.parse(subJson); } catch(_) { return; }
  const prefs = JSON.parse(localStorage.getItem('vdd_push_prefs') || '{"notify_new_events":true,"notify_all_changes":false}');
  const body = { endpoint: sub.endpoint, notify_new_events: prefs.notify_new_events, notify_all_changes: prefs.notify_all_changes, favorites: prefs.notify_changes === 'none' ? [] : [...favs] };
  const bodyJson = JSON.stringify(body);
  if (!navigator.onLine) {
    try { localStorage.setItem('vdd_pending_prefs', bodyJson); } catch(_) {}
    _setSyncStatus('idle');
    return;
  }
  try {
    const r = await fetchWithWakeup(PUSH_SERVER_URL + '/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyJson });
    if (r.ok) {
      try { localStorage.removeItem('vdd_pending_prefs'); } catch(_) {}
      _setSyncStatus('saved');
    } else if (r.status === 404) {
      try { localStorage.removeItem('vdd_push_sub'); localStorage.removeItem('vdd_pending_prefs'); } catch(_) {}
      _setSyncStatus('idle');
    } else {
      try { localStorage.setItem('vdd_pending_prefs', bodyJson); } catch(_) {}
      _setSyncStatus('error', 'Server-Fehler: ' + r.status);
    }
  } catch(e) {
    try { localStorage.setItem('vdd_pending_prefs', bodyJson); } catch(_) {}
    _setSyncStatus('error', e.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// Retries on network errors to survive fly.io cold-starts (can take 10-15 s).
async function fetchWithWakeup(url, options, { retries = 4, delayMs = 4000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, delayMs));
    try { return await fetch(url, options); }
    catch (e) {
      if (!(e instanceof TypeError)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

async function subscribePush(prefs) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('Push-Benachrichtigungen werden von diesem Browser nicht unterstützt.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Berechtigung verweigert.');
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  const subJson = sub.toJSON();
  const body = { endpoint: subJson.endpoint, keys: subJson.keys, notify_new_events: prefs.notify_new_events ?? true, notify_all_changes: prefs.notify_all_changes ?? false, favorites: prefs.notify_changes === 'none' ? [] : [...favs] };
  const r = await fetchWithWakeup(PUSH_SERVER_URL + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Server-Fehler: ' + r.status);
  try {
    localStorage.setItem('vdd_push_sub', JSON.stringify({ endpoint: subJson.endpoint, keys: subJson.keys }));
    localStorage.setItem('vdd_push_prefs', JSON.stringify({ notify_new_events: prefs.notify_new_events ?? true, notify_all_changes: prefs.notify_all_changes ?? false }));
  } catch(_) {}
}

async function unsubscribePush() {
  const subJson = localStorage.getItem('vdd_push_sub');
  if (subJson) {
    try {
      const sub = JSON.parse(subJson);
      await fetchWithWakeup(PUSH_SERVER_URL + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    } catch(_) {}
  }
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration('sw.js');
      if (reg) { const ps = await reg.pushManager.getSubscription(); if (ps) await ps.unsubscribe(); }
    } catch(_) {}
  }
  try { localStorage.removeItem('vdd_push_sub'); localStorage.removeItem('vdd_push_prefs'); localStorage.removeItem('vdd_pending_prefs'); } catch(_) {}
}

function buildNotificationsHtml() {
  const isSubscribed = !!localStorage.getItem('vdd_push_sub');
  const prefs = JSON.parse(localStorage.getItem('vdd_push_prefs') || '{"notify_new_events":true,"notify_all_changes":false}');
  // normalize legacy prefs that predate the three-way changes option
  if (!prefs.notify_changes) prefs.notify_changes = prefs.notify_all_changes ? 'all' : 'favorites';
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!pushSupported) return '<p>Push-Benachrichtigungen werden von diesem Browser nicht unterstützt.</p>';

  const dis = isSubscribed ? '' : ' disabled';
  const dim = isSubscribed ? '' : ' sn-disabled';
  const nc = prefs.notify_changes;

  function pill(val, label) {
    return `<label class="sn-pill"><input type="radio" name="sn-changes" value="${val}"${nc === val ? ' checked' : ''}${dis}><span>${label}</span></label>`;
  }

  return `
<div class="sn-row">
  <div class="sn-row-text">
    <span class="sn-label">Benachrichtigungen aktivieren</span>
    <span class="sn-desc">Browser-Benachrichtigungen für Ritte erhalten</span>
  </div>
  <label class="sn-toggle">
    <input type="checkbox" id="sn-enable"${isSubscribed ? ' checked' : ''}>
    <span class="sn-toggle-track"></span>
  </label>
</div>
<div class="sn-divider"></div>
<div class="sn-row${dim}">
  <div class="sn-row-text">
    <span class="sn-label">Neue Ritte</span>
    <span class="sn-desc">Bei neuen Ritten benachrichtigen</span>
  </div>
  <label id="sn-toggle-new-events" class="sn-toggle">
    <input type="checkbox" id="pref-new-events"${prefs.notify_new_events ? ' checked' : ''}${dis}>
    <span class="sn-toggle-track"></span>
  </label>
</div>
<div class="sn-divider"></div>
<div class="sn-row-stack${dim}">
  <div class="sn-row-text">
    <span class="sn-label">Änderungen an Ritten</span>
    <span class="sn-desc">Bei Zeit-, Ort- oder Detailänderungen</span>
  </div>
  <div id="sn-pill-changes" class="sn-pill-group">
    ${pill('none', 'Keine')}
    ${pill('favorites', 'Favoriten')}
    ${pill('all', 'Alle Ritte')}
  </div>
</div>
<span id="sn-sync-status"></span>`;
}

function wireNotificationsModal() {
  const body = document.getElementById('notifications-modal-body');
  function refresh() { body.innerHTML = buildNotificationsHtml(); wireNotificationsModal(); }

  function savePref(key, value) {
    const p = JSON.parse(localStorage.getItem('vdd_push_prefs') || '{}');
    p[key] = value;
    if (key === 'notify_changes') p.notify_all_changes = (value === 'all');
    try { localStorage.setItem('vdd_push_prefs', JSON.stringify(p)); } catch(_) {}
    schedulePrefSync();
  }

  const enableToggle = document.getElementById('sn-enable');
  if (enableToggle) {
    enableToggle.addEventListener('change', async () => {
      const enabling = enableToggle.checked;
      enableToggle.checked = !enabling; // revert until server confirms
      enableToggle.disabled = true;
      const toggleLabel = enableToggle.closest('.sn-toggle');
      if (toggleLabel) toggleLabel.classList.add('sn-toggle-loading');
      try {
        if (enabling) {
          const prefs = JSON.parse(localStorage.getItem('vdd_push_prefs') || '{"notify_new_events":true,"notify_all_changes":false}');
          await subscribePush(prefs);
        } else {
          await unsubscribePush();
        }
      } catch(err) {
        enableToggle.disabled = false;
        if (toggleLabel) toggleLabel.classList.remove('sn-toggle-loading');
        _setSyncStatus('error', err.message);
        return;
      }
      refresh();
      _setSyncStatus('saved');
    });
  }

  const newEvChk = document.getElementById('pref-new-events');
  if (newEvChk) newEvChk.addEventListener('change', () => savePref('notify_new_events', newEvChk.checked));

  body.querySelectorAll('input[name="sn-changes"]').forEach(r => {
    r.addEventListener('change', () => { if (r.checked) savePref('notify_changes', r.value); });
  });
}

// ── state ─────────────────────────────────────────────────────────────────────
let showVorrat = document.getElementById('show-vorrat').checked;
const TODAY = new Date().toISOString().slice(0, 10);

// ── status filter ─────────────────────────────────────────────────────────────
const ALL_STATUSES = ['steht fest', 'vorläufig', 'abgesagt', 'vergangen'];
let selectedStatuses = new Set();

function getEventStatus(ev) {
  const s = (ev.status || '').toLowerCase();
  if (ev.rittvorrat || s.includes('abgesagt')) return 'abgesagt';
  const isPast = (ev.end_date || ev.start_date) < TODAY;
  if (isPast) return 'vergangen';
  if (s.includes('vorl')) return 'vorläufig';
  return 'steht fest';
}

// ── map ────────────────────────────────────────────────────────────────────────
const BASEMAP_STYLE = 'https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/styles/bm_web_top.json';
const BLANK_STYLE = { version: 8, glyphs: 'https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/fonts/v2/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f8f8f8' } }] };

const map = new maplibregl.Map({
  container: 'map',
  style: navigator.onLine ? BASEMAP_STYLE : BLANK_STYLE,
  bounds: [[6.0259, 47.5733], [14.5152, 54.4286]],
  fitBoundsOptions: { padding: 25 },
  maxBounds: [[3.5, 44], [17, 57]],
  attributionControl: { compact: true },
  pitchWithRotate: false,
  maxPitch: 0,
  dragRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
// Fullscreen the whole right pane (map + legend + mobile popup modal), not just the canvas
map.addControl(new maplibregl.FullscreenControl({ container: document.getElementById('right-pane') }), 'top-right');
map.on('click', e => { if (map.getLayer('events-unclustered') && !map.queryRenderedFeatures(e.point, { layers: ['events-unclustered'] }).length && openPopup) openPopup.remove(); });
let _moveRAF = null;
map.on('move', () => {
  if (_programmaticMapMove || _moveRAF) return;
  _moveRAF = requestAnimationFrame(() => {
    _moveRAF = null;
    mapBounds = map.getBounds();
    _filterFromMapMove = true;
    applyFilters();
    _filterFromMapMove = false;
  });
});
map.on('moveend', () => {
  if (_moveRAF) { cancelAnimationFrame(_moveRAF); _moveRAF = null; }
  if (_programmaticMapMove) { _programmaticMapMove = false; return; }
  mapBounds = map.getBounds();
  _filterFromMapMove = true;
  applyFilters();
  _filterFromMapMove = false;
});
window.addEventListener('offline', () => { map.setStyle(BLANK_STYLE); setOfflineBanner(true); });
window.addEventListener('online',  () => { map.setStyle(BASEMAP_STYLE); setOfflineBanner(false); });

function setOfflineBanner(offline) {
  document.getElementById('offline-banner').classList.toggle('show', offline);
}
setOfflineBanner(!navigator.onLine);

function markerPinName(ev) {
  if (ev.rittvorrat) return 'pin-red';
  const s = (ev.status || '').toLowerCase();
  if (s.includes('abgesagt')) return 'pin-red';
  const isPast = (ev.end_date || ev.start_date) < TODAY;
  if (isPast) return 'pin-grey';
  if (s.includes('vorl'))    return 'pin-yellow';
  return 'pin-green';
}

function kmOffsets(lat, km) {
  const dLat = km / 111.32;
  return { dLat, dLon: km / (111.32 * Math.cos(lat * Math.PI / 180)) };
}

function circlePolygon(lat, lon, km, n = 64) {
  const { dLat, dLon } = kmOffsets(lat, km);
  const coords = Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)];
  });
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
}

const INIT_BOUNDS = [[6.0259, 47.5733], [14.5152, 54.4286]];

function radiusBounds(lat, lon, km) {
  const { dLat, dLon } = kmOffsets(lat, km);
  return [
    [Math.max(lon - dLon, INIT_BOUNDS[0][0]), Math.max(lat - dLat, INIT_BOUNDS[0][1])],
    [Math.min(lon + dLon, INIT_BOUNDS[1][0]), Math.min(lat + dLat, INIT_BOUNDS[1][1])],
  ];
}

function showRadiusCircle(lat, lon, km) {
  const data = circlePolygon(lat, lon, km);
  const src = map.getSource('radius-circle');
  if (src) {
    src.setData(data);
  } else {
    map.addSource('radius-circle', { type: 'geojson', data });
    map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius-circle',
      paint: { 'fill-color': '#2ea3f2', 'fill-opacity': 0.07 } });
    map.addLayer({ id: 'radius-stroke', type: 'line', source: 'radius-circle',
      paint: { 'line-color': '#2ea3f2', 'line-width': 2 } });
  }
}

function removeRadiusCircle() {
  if (map.getSource('radius-circle')) {
    map.removeLayer('radius-fill');
    map.removeLayer('radius-stroke');
    map.removeSource('radius-circle');
  }
}

let openPopup = null;
let _currentGeoJSON = null;
let _styleReady = false;

function eventsToGeoJSON(events) {
  const groups = {};
  events.filter(ev => ev.lat && ev.lon).forEach(ev => {
    const key = `${ev.lat},${ev.lon}`;
    (groups[key] = groups[key] || []).push(ev);
  });
  const features = [];
  for (const group of Object.values(groups)) {
    group.forEach((ev, i) => {
      const lonOffset = group.length > 1 ? (i - (group.length - 1) / 2) * 0.0008 : 0;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ev.lon + lonOffset, ev.lat] },
        properties: { id: ev.id, pinName: markerPinName(ev), name: ev.name }
      });
    });
  }
  return { type: 'FeatureCollection', features };
}

const PIN_COLORS = { 'pin-grey': '#9e9e9e', 'pin-red': '#c62828', 'pin-yellow': '#f9a825', 'pin-green': '#2e7d32' };

function _makePinImageData(color) {
  const svg = `<svg width="22" height="33" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0z"
          fill="${color}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="4.5" fill="#fff" opacity=".85"/>
  </svg>`;
  return new Promise((resolve, reject) => {
    const img = new Image(22, 33);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 22; c.height = 33;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 22, 33);
      resolve(ctx.getImageData(0, 0, 22, 33));
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  });
}

const _pinImagesReady = Promise.all(
  Object.entries(PIN_COLORS).map(([name, color]) =>
    _makePinImageData(color).then(data => [name, data])
  )
).then(entries => Object.fromEntries(entries));

async function _addEventLayersToMap(geojson) {
  if (map.getSource('events-source')) {
    map.getSource('events-source').setData(geojson);
    return;
  }

  const pinImages = await _pinImagesReady;
  for (const [name, data] of Object.entries(pinImages)) {
    if (!map.hasImage(name)) map.addImage(name, data);
  }
  map.addSource('events-source', {
    type: 'geojson', data: geojson
  });
  map.addLayer({
    id: 'events-unclustered', type: 'symbol', source: 'events-source',
    layout: {
      'icon-image': ['get', 'pinName'],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    }
  });

  map.on('click', 'events-unclustered', e => {
    const ev = EVENTS.find(ev => ev.id === e.features[0].properties.id);
    if (!ev) return;
    if (ev.id === activeId && openPopup) {
      openPopup.remove();
      return;
    }
    focusEvent(ev);
  });

  map.on('mouseenter', 'events-unclustered', e => {
    map.getCanvas().style.cursor = 'pointer';
    const ev = EVENTS.find(ev => ev.id === e.features[0].properties.id);
    if (ev) preloadImg(ev);
  });
  map.on('mouseleave', 'events-unclustered', () => { map.getCanvas().style.cursor = ''; });
}

map.on('style.load', () => {
  _styleReady = true;
  if (_currentGeoJSON) _addEventLayersToMap(_currentGeoJSON).catch(() => {});
});

function showEventPopup(ev) {
  const prev = openPopup;
  openPopup = null;
  if (prev) prev.remove();
  openPopup = new maplibregl.Popup({ maxWidth: '340px', closeButton: false, anchor: 'bottom', offset: [0, -38], focusAfterOpen: false })
    .setLngLat([ev.lon, ev.lat])
    .setHTML(popupHtml(ev))
    .addTo(map);
  const _pc = openPopup.getElement()?.querySelector('.maplibregl-popup-content');
  if (_pc) _pc.scrollTop = 0;
  openPopup.on('close', () => {
    if (!openPopup) return;
    if (window.location.hash.slice(1) === encodeURIComponent(ev.id)) clearUrlHash();
    openPopup = null;
    if (activeId === ev.id) {
      activeId = null;
      const r = tbl.getRow(ev.id);
      if (r) r.reformat();
    }
  });
}

function fmtDateDe(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y.slice(2)}`;
}

function timeAgo(date) {
  const mins = Math.round((Date.now() - new Date(date)) / 60000);
  if (mins < 2)         return 'gerade eben';
  if (mins < 60)        return `vor ${mins} Min.`;
  if (mins < 1440)      return `vor ${Math.round(mins / 60)} Std.`;
  const days = Math.round(mins / 1440);
  return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
}

function dateRange(ev) {
  if (!ev.start_date) return '–';
  if (!ev.end_date || ev.start_date === ev.end_date) return fmtDateDe(ev.start_date);
  const [sy, sm, sd] = ev.start_date.split('-');
  const [ey, em, ed] = ev.end_date.split('-');
  if (sy === ey) return `${sd}.${sm} – ${ed}.${em}.${ey.slice(2)}`;
  return `${fmtDateDe(ev.start_date)} – ${fmtDateDe(ev.end_date)}`;
}

function pdfLink(filename, label, updated) {
  if (!filename) return '';
  const url = WIKI_FILE + encodeURIComponent(filename);
  return `<a class="popup-doc${updated ? ' updated' : ''}" href="${url}" target="_blank">${label}</a>`;
}

function icsDownload(ev) {
  if (!ev.start_date) return;
  const pad = s => String(s).padStart(2, '0');
  const toDate = str => str.replace(/-/g, '');
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  const locEsc = s => String(s).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, ', ').replace(/;/g, '\\;');
  const fold = line => {
    const enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    const parts = [];
    let i = 0;
    while (i < line.length) {
      const budget = i === 0 ? 75 : 74;
      let j = i + budget;
      if (j > line.length) j = line.length;
      while (j > i && enc.encode(line.slice(i, j)).length > budget) j--;
      parts.push((i === 0 ? '' : ' ') + line.slice(i, j));
      i = j;
    }
    return parts.join('\r\n');
  };
  const umlaut = s => s.replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue')
    .replace(/Ä/g,'Ae').replace(/Ö/g,'Oe').replace(/Ü/g,'Ue').replace(/ß/g,'ss');
  const asciiId = umlaut(ev.id || ev.wiki_title).replace(/[^a-zA-Z0-9_-]/g, '-');
  const endExcl = d => {
    const [y, m, day] = d.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day + 1));
    return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth()+1)}${pad(dt.getUTCDate())}`;
  };
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const end = ev.end_date && ev.end_date !== ev.start_date ? ev.end_date : ev.start_date;
  const distParts = ['efr','kdr','mdr','ldr','mtr','cei'].map(k => ev[k] && `${k.toUpperCase()} ${ev[k]}`).filter(Boolean).join(', ');
  const descParts = [
    distParts      && `Distanzen: ${distParts}`,
    ev.organizer   && `Veranstalter: ${ev.organizer}`,
    ev.event_types && `Art: ${ev.event_types}`,
    ev.vdd_url,
  ].filter(Boolean).map(esc).join('\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VDD Viewer//DE',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:vdd-${asciiId}@vdd-aktuell.de`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${toDate(ev.start_date)}`,
    `DTEND;VALUE=DATE:${endExcl(end)}`,
    `SUMMARY:${esc(ev.name || ev.wiki_title)}`,
    ev.venue    ? `LOCATION:${locEsc(ev.venue)}` : '',
    descParts   ? `DESCRIPTION:${descParts}` : '',
    ev.vdd_url  ? `URL:${ev.vdd_url}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(l => l !== '').map(fold).join('\r\n') + '\r\n';
  const blob = new Blob([lines], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${umlaut(ev.name || ev.wiki_title).replace(/[^a-zA-Z0-9_-]/g, '_')}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function popupBodyHtml(ev) {
  const distParts = [
    ev.efr && `EFR ${ev.efr}`, ev.kdr && `KDR ${ev.kdr}`,
    ev.mdr && `MDR ${ev.mdr}`, ev.ldr && `LDR ${ev.ldr}`,
    ev.mtr && `MTR ${ev.mtr}`, ev.cei && `CEI ${ev.cei}`,
  ].filter(Boolean).join(' | ');

  let h = '';
  if (ev.ritt_bild) h += `<div class="popup-img" style="background-image:url(${WIKI_FILE}${encodeURIComponent(ev.ritt_bild)})"></div>`;

  const status = ev.status && ev.status !== 'steht fest' ? ev.status : null;
  for (const [label, val] of [
    ['Datum', dateRange(ev)], ['Status', status], ['Distanzen', distParts],
    ['Region', ev.region], ['Ort', ev.venue],
    ['Veranstalter', ev.organizer], ['Art', ev.event_types], ['Seit', ev.first_edition_year],
  ]) {
    if (val) h += `<div class="popup-row"><span class="popup-label">${label}: </span>${val}</div>`;
  }

  const siteUrl = safeUrl(ev.website);
  if (siteUrl) {
    const siteLabel = siteUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    h += `<div class="popup-row"><span class="popup-label">Website: </span><a href="${siteUrl}" target="_blank" rel="noopener noreferrer">${escHtml(siteLabel)}</a></div>`;
  }
  const link = ev.vdd_url || ev.wiki_url;
  if (link) {
    h += `<div style="margin-top:8px"><a class="popup-link" style="margin:0" href="${link}" target="_blank">VDD-Seite &rarr;</a></div>`;
  }
  if (ev.bemerkung) h += `<div class="popup-note"><span class="popup-label">Bemerkung: </span>${escHtml(ev.bemerkung)}</div>`;
  return h;
}

function popupDocsHtml(ev) {
  return [
    pdfLink(ev.announcement_pdf, 'Ausschreibung', ev.announcement_updated),
    pdfLink(ev.results_pdf,      'Ergebnisse',    false),
    pdfLink(ev.registration_pdf, 'Nennung',        false),
    ev.start_date ? `<button type="button" class="popup-doc popup-doc-ics" data-ics-id="${escHtml(ev.id)}">Kalender</button>` : '',
  ].filter(Boolean).join('');
}

const SHARE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>`;
const POPUP_STAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path class="popup-star-path" d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21Z"/></svg>`;
document.getElementById('popup-modal-share').innerHTML = SHARE_ICON;
document.getElementById('popup-modal-star').innerHTML = POPUP_STAR_SVG;

function popupHtml(ev) {
  const name = escHtml(ev.name || ev.wiki_title);
  const title = ev.subtitle ? `${name} <small style="font-weight:400;opacity:.85">${escHtml(ev.subtitle)}</small>` : name;
  const docs = popupDocsHtml(ev);
  const footer = docs ? `<div class="popup-footer">${docs}</div>` : '';
  const starred = favs.has(ev.id);
  const safeId = escHtml(ev.id);
  const starBtn = `<button class="popup-header-close popup-star${starred ? ' starred' : ''}" data-fav-id="${safeId}" title="${starred ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}">${POPUP_STAR_SVG}</button>`;
  return `<div class="popup-header"><span class="popup-header-title">${title}</span>${starBtn}<button class="popup-header-close" onclick="shareCurrentUrl(this)" title="Link teilen" data-copied="✓">${SHARE_ICON}</button><button class="popup-header-close" onclick="if(openPopup)openPopup.remove()" title="Schließen">✕</button></div><div class="popup-body">${popupBodyHtml(ev)}</div>${footer}`;
}

// ── filter logic ───────────────────────────────────────────────────────────────
let filterText = '';
let selectedFavStates = new Set();
let userLat = null, userLon = null, radiusKm = 250;
let userMarker = null;
let selectedRegion = '';
let selectedEventTypes = new Set();
let selectedDistances = new Set();
let mapBounds = null;
let _programmaticMapMove = false;
let _filterFromMapMove = false;
let _tableReady = false;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function eventVisible(ev) {
  if (ev.rittvorrat && !showVorrat) return false;
  if (selectedFavStates.size > 0) {
    const isFav = favs.has(ev.id);
    if (!((selectedFavStates.has('fav') && isFav) || (selectedFavStates.has('unfav') && !isFav))) return false;
  }
  if (selectedStatuses.size > 0 && !selectedStatuses.has(getEventStatus(ev))) return false;
  if (selectedRegion && ev.region !== selectedRegion) return false;
  if (selectedEventTypes.size > 0) {
    if (!ev.event_types_arr.some(t => selectedEventTypes.has(t))) return false;
  }
  if (selectedDistances.size > 0) {
    let distMatch = false;
    for (const d of selectedDistances) { if (ev[d]) { distMatch = true; break; } }
    if (!distMatch) return false;
  }
  if (filterText) {
    const q = filterText.toLowerCase();
    if (![ev.wiki_title, ev.name, ev.subtitle, ev.region, ev.venue,
          ev.event_types, ev.organizer, ev.status]
        .some(v => v && v.toLowerCase().includes(q))) return false;
  } else if (userLat !== null) {
    if (!ev.lat || !ev.lon) return false;
    if (haversineKm(userLat, userLon, ev.lat, ev.lon) > radiusKm) return false;
  }
  if (mapBounds && ev.lat && ev.lon) {
    if (!mapBounds.contains([ev.lon, ev.lat])) return false;
  }
  return true;
}

function applyFilters() {
  updateLegend();
  tbl.setFilter(eventVisible);
}

function statusClass(s) {
  if (!s) return '';
  const l = s.toLowerCase();
  if (l.includes('abgesagt')) return 'status-abges';
  if (l.includes('vorl'))    return 'status-vorl';
  return 'status-fest';
}

function updateLegend() {
  const bar = document.getElementById('legend-bar');
  if (!bar) return;
  const cats = new Set();
  EVENTS.filter(eventVisible).forEach(d => {
    if (d.rittvorrat || (d.status || '').toLowerCase().includes('abgesagt')) { cats.add('abgesagt'); return; }
    const isPast = (d.end_date || d.start_date) < TODAY;
    if (isPast) { cats.add('past'); return; }
    if ((d.status || '').toLowerCase().includes('vorl')) { cats.add('vorl'); return; }
    cats.add('fest');
  });
  const defs = [
    { key: 'fest',     color: '#2e7d32', label: 'Steht fest' },
    { key: 'vorl',     color: '#f9a825', label: 'Vorläufig' },
    { key: 'abgesagt', color: '#c62828', label: 'Abgesagt' },
    { key: 'past',     color: '#9e9e9e', label: 'Vergangen' },
  ];
  const visible = defs.filter(i => cats.has(i.key));
  if (visible.length <= 1) { bar.innerHTML = ''; return; }
  bar.innerHTML = visible.map(i =>
    `<span class="legend-item"><span class="legend-dot" style="background:${i.color}"></span>${i.label}</span>`
  ).join('');
}

// ── column formatters ──────────────────────────────────────────────────────────
function fmtName(cell) {
  const ev = cell.getRow().getData();
  const name = ev.name || ev.wiki_title;
  let html = escHtml(name);
  if (!ev.lat) html += '<span class="no-map-badge">kein GPS</span>';
  return html;
}

const STAR_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path class="star-path" d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21Z"/></svg>`;

function fmtFav(cell) {
  const ev = cell.getRow().getData();
  const starred = favs.has(ev.id);
  return `<span class="fav-star${starred ? ' starred' : ''}" data-id="${escHtml(ev.id)}" title="${starred ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}">${STAR_SVG}</span>`;
}

function fmtDate(cell) { return dateRange(cell.getRow().getData()); }

function fmtStatus(cell) {
  const s = cell.getValue() || '–';
  return `<span class="${statusClass(s)}">${s}</span>`;
}

function fmtPdf(pdfField, updatedField) {
  return function(cell) {
    const ev = cell.getRow().getData();
    const pdf = ev[pdfField];
    if (!pdf) return '';
    const updated = updatedField ? ev[updatedField] : false;
    return `<a class="tbl-doc${updated ? ' updated' : ''}" href="${WIKI_FILE}${encodeURIComponent(pdf)}" target="_blank" onclick="event.stopPropagation()">PDF</a>`;
  };
}

function fmtIcs(cell) {
  const ev = cell.getRow().getData();
  if (!ev.start_date) return '';
  return `<button type="button" class="tbl-doc tbl-doc-ics" onclick="event.stopPropagation();icsDownload(EVENTS.find(e=>e.id==='${ev.id}'))">ICS</button>`;
}

function fmtLink(cell) {
  const url = safeUrl(cell.getValue());
  if (!url) return '';
  const label = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escHtml(label)}</a>`;
}

// ── MiniTable — lightweight table ──────────────────────────────────────────────
class MiniTable {
  #data; #idx; #cols; #rowFmt; #filterFn = null;
  #sortField; #sortDir; #container;
  #tbody; #headerCells = [];
  #rowMap = new Map();
  #listeners = {};
  #priorityFn = null;

  constructor(selector, { data, index, columns, rowFormatter, initialSort }) {
    this.#data     = data;
    this.#idx      = index;
    this.#cols     = columns;
    this.#rowFmt   = rowFormatter;
    this.#sortField = initialSort?.[0]?.column ?? null;
    this.#sortDir   = initialSort?.[0]?.dir     ?? 'asc';
    this.#container = document.querySelector(selector);
    this.#build();
  }

  #build() {
    const wrap = document.createElement('div');
    wrap.className = 'mtbl-wrap';
    this.#container.appendChild(wrap);

    const table = document.createElement('table');
    table.className = 'mtbl';

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    let frozenPx = 0;
    this.#cols.forEach(col => {
      const th = document.createElement('th');
      if (col.width)         th.style.cssText += `width:${col.width}px;max-width:${col.width}px;`;
      if (col.frozen)       { th.classList.add('fr'); th.style.left = frozenPx + 'px'; frozenPx += col.width || 160; }
      if (col.headerTooltip) th.title = col.headerTooltip;
      const canSort = col.headerSort !== false && col.sorter !== false;
      th.innerHTML = escHtml(col.title) + (canSort ? '<span class="sa"></span>' : '');
      if (!canSort) th.classList.add('ns');
      else th.addEventListener('click', () => this.#toggleSort(col.field));
      this.#headerCells.push({ th, col });
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    this.#tbody = document.createElement('tbody');
    table.appendChild(this.#tbody);
    wrap.appendChild(table);

    const frag = document.createDocumentFragment();
    this.#getSorted(this.#data).forEach(d => this.#appendRow(d, frag));
    this.#tbody.appendChild(frag);
    this.#updateArrows();
    setTimeout(() => this.#emit('tableBuilt'), 0);
  }

  #getSorted(arr) {
    if (!this.#sortField && !this.#priorityFn) return arr;
    const col = this.#cols.find(c => c.field === this.#sortField);
    const num = col?.sorter === 'number';
    return [...arr].sort((a, b) => {
      if (this.#priorityFn) {
        const pc = this.#priorityFn(a, b);
        if (pc !== 0) return pc;
      }
      if (!this.#sortField) return 0;
      let av = a[this.#sortField], bv = b[this.#sortField];
      if (num) { av = +av || 0; bv = +bv || 0; }
      else     { av = av ?? ''; bv = bv ?? ''; }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return this.#sortDir === 'asc' ? cmp : -cmp;
    });
  }

  #toggleSort(field) {
    if (this.#sortField === field) {
      this.#sortDir = this.#sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      const col = this.#cols.find(c => c.field === field);
      this.#sortDir = col?.initialSortDir ?? 'asc';
    }
    this.#sortField = field;
    this.#updateArrows();
    this.#reapply();
  }

  #updateArrows() {
    this.#headerCells.forEach(({ th, col }) => {
      th.classList.toggle('asc',  col.field === this.#sortField && this.#sortDir === 'asc');
      th.classList.toggle('desc', col.field === this.#sortField && this.#sortDir === 'desc');
    });
  }

  #rowProxy(tr, d) {
    return {
      getData:    () => d,
      getElement: () => tr,
      reformat:   () => { if (this.#rowFmt) this.#rowFmt(this.#rowProxy(tr, d)); },
    };
  }

  #appendRow(d, container = this.#tbody) {
    const tr = document.createElement('tr');
    let frozenPx = 0;
    this.#cols.forEach(col => {
      const td = document.createElement('td');
      if (col.width)  td.style.cssText = `width:${col.width}px;max-width:${col.width}px;`;
      if (col.frozen) { td.classList.add('fr'); td.style.left = frozenPx + 'px'; frozenPx += col.width || 160; }
      const rp = this.#rowProxy(tr, d);
      const cp = { getRow: () => rp, getValue: () => d[col.field], getData: () => d };
      td.innerHTML = col.formatter ? (col.formatter(cp) ?? '') : escHtml(String(d[col.field] ?? ''));
      if (col.tooltip === true)               td.title = String(d[col.field] ?? '');
      else if (typeof col.tooltip === 'function') td.title = col.tooltip(null, cp) || '';
      tr.appendChild(td);
    });
    tr.addEventListener('click',      e => this.#emit('rowClick',      e, this.#rowProxy(tr, d)));
    tr.addEventListener('mouseenter', e => this.#emit('rowMouseEnter', e, this.#rowProxy(tr, d)));
    this.#rowMap.set(d[this.#idx], { tr, data: d });
    if (this.#rowFmt) this.#rowFmt(this.#rowProxy(tr, d));
    container.appendChild(tr);
  }

  #reapply() {
    const filtered = this.#filterFn ? this.#data.filter(this.#filterFn) : this.#data;
    const sorted   = this.#getSorted(filtered);
    this.#rowMap.forEach(({ tr }) => { tr.style.display = 'none'; });
    sorted.forEach(d => {
      const e = this.#rowMap.get(d[this.#idx]);
      if (e) { e.tr.style.display = ''; this.#tbody.appendChild(e.tr); }
    });
    this.#emit('dataFiltered', [],
      sorted.map(d => { const e = this.#rowMap.get(d[this.#idx]); return e ? this.#rowProxy(e.tr, e.data) : null; }).filter(Boolean));
  }

  setFilter(fn)      { this.#filterFn = fn; this.#reapply(); }
  setPriorityFn(fn)  { this.#priorityFn = fn; this.#reapply(); }
  getRow(id)      { const e = this.#rowMap.get(id); return e ? this.#rowProxy(e.tr, e.data) : null; }
  scrollToRow(id) { this.#rowMap.get(id)?.tr.scrollIntoView({ block: 'nearest', behavior: 'instant' }); return Promise.resolve(); }
  on(ev, fn)      { (this.#listeners[ev] ??= []).push(fn); return this; }
  #emit(ev, ...a) { (this.#listeners[ev] || []).forEach(fn => fn(...a)); }
}

let tbl;
let activeId = null;

function initTable(data) {
  tbl = new MiniTable("#grid", {
    data,
    index: "id",
    initialSort: [{ column: "start_date", dir: "asc" }],
    columns: [
      { title: "★",                 field: "_fav",               formatter: fmtFav,   sorter: "number", frozen: true, width: 26, headerTooltip: "Favorit", initialSortDir: "desc" },
      { title: "Name",              field: "name",               formatter: fmtName,                                          frozen: true, width: window.innerWidth <= 768 ? 115 : 160, tooltip: (e, cell) => cell.getData().name },
      { title: "Datum",             field: "start_date",         formatter: fmtDate,          width: 95 },
      { title: "EFR",               field: "efr",                width: 37, headerSort: false, headerTooltip: "Einführungsritt (25–40 km)",          tooltip: true },
      { title: "KDR",               field: "kdr",                width: 37, headerSort: false, headerTooltip: "Kurzdistanzritt (41–60 km)",           tooltip: true },
      { title: "MDR",               field: "mdr",                width: 37, headerSort: false, headerTooltip: "Mitteldistanzritt (61–80 km)",          tooltip: true },
      { title: "LDR",               field: "ldr",                width: 40, headerSort: false, headerTooltip: "Langdistanzritt (81–160 km)",           tooltip: true },
      { title: "MTR",               field: "mtr",                width: 40, headerSort: false, headerTooltip: "Mehrtagesritt",                         tooltip: true },
      { title: "CEI",               field: "cei",                width: 25, headerSort: false, headerTooltip: "Concours d'Endurance International",    tooltip: true },
      { title: "Ausschreibung",     field: "announcement_pdf",   formatter: fmtPdf("announcement_pdf", "announcement_updated"), sorter: false, width: 40, headerTooltip: "Ausschreibung (PDF)" },
      { title: "Ergebnisse",        field: "results_pdf",        formatter: fmtPdf("results_pdf", null),                      sorter: false, width: 40, headerTooltip: "Ergebnisliste (PDF)" },
      { title: "Nennformular",      field: "registration_pdf",   formatter: fmtPdf("registration_pdf", null),                 sorter: false, width: 40, headerTooltip: "Nennformular (PDF)" },
      { title: "Kalender",          field: "start_date",         formatter: fmtIcs,                                           sorter: false, width: 40, headerTooltip: "Termin als ICS-Datei herunterladen", headerSort: false },
      { title: "Geändert",          field: "wiki_touched",       formatter: cell => fmtDateDe(cell.getValue()),               width: 55,     headerTooltip: "Letzte Änderung auf der VDD-Wiki-Seite" },
      { title: "Seit",              field: "first_edition_year", sorter: "number",            width: 40 },
      { title: "Website",           field: "website",            formatter: fmtLink,                                          sorter: false, width: 100 },
      { title: "Art",               field: "event_types",        width: 100, tooltip: true },
      { title: "Status",            field: "status",             formatter: fmtStatus,                                        width: 60, tooltip: true },
      { title: "Region",            field: "region",             width: 100, tooltip: true },
      { title: "Veranstaltungsort", field: "venue",              width: 150, tooltip: true },
      { title: "Veranstalter",      field: "organizer",          width: 150, tooltip: true },
    ],
    rowFormatter(row) {
      const d = row.getData();
      const el = row.getElement();
      const isPast = (d.end_date || d.start_date) < TODAY;
      const isAbgesagt = !!d.rittvorrat || (d.status || '').toLowerCase().includes('abgesagt');
      const isVorl = !isAbgesagt && !isPast && (d.status || '').toLowerCase().includes('vorl');
      el.classList.toggle('vorrat',       !!d.rittvorrat);
      el.classList.toggle('no-coords',    !d.lat);
      el.classList.toggle('row-active',   d.id === activeId);
      el.classList.toggle('row-abgesagt', isAbgesagt);
      el.classList.toggle('row-vorl',     isVorl);
      el.classList.toggle('row-past',     isPast && !isAbgesagt);
    },
  });

  tbl.on("tableBuilt", () => {
    applyFilters();
    _tableReady = true;
    requestAnimationFrame(() => { map.resize(); fitVisibleMarkers(); });
    const hash = window.location.hash.slice(1);
    if (hash) {
      const ev = EVENTS.find(e => e.id === decodeURIComponent(hash));
      if (ev) focusEvent(ev);
    }
  });

  tbl.on("rowClick", (e, row) => {
    if (e.target.closest('.fav-star')) return;
    focusEvent(row.getData());
  });
  tbl.on("rowMouseEnter", (_e, row) => { preloadImg(row.getData()); });

  tbl.on("dataFiltered", (_filters, rows) => {
    const visibleIds = new Set(rows.map(r => r.getData().id));
    if (activeId && !visibleIds.has(activeId) && openPopup) openPopup.remove();
    _currentGeoJSON = eventsToGeoJSON(EVENTS.filter(ev => visibleIds.has(ev.id)));
    const src = map.getSource('events-source');
    if (src) src.setData(_currentGeoJSON);
    document.getElementById('count').textContent = `${rows.length} / ${EVENTS.length}`;

    if (_tableReady && !_filterFromMapMove && !_programmaticMapMove) {
      const evs = rows.map(r => r.getData()).filter(ev => ev.lat && ev.lon);
      if (evs.length > 0) {
        const lons = evs.map(ev => ev.lon), lats = evs.map(ev => ev.lat);
        _programmaticMapMove = true;
        map.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 60, duration: 1000, maxZoom: 14 }
        );
      }
    }
  });
}

// ── star clicks (table + desktop popup) ───────────────────────────────────────
document.getElementById('grid').addEventListener('click', e => {
  const star = e.target.closest('.fav-star') ||
               (e.target.tagName === 'TD' ? e.target.querySelector('.fav-star') : null);
  if (!star) return;
  e.stopPropagation();
  toggleFav(star.dataset.id);
}, true);

document.addEventListener('click', e => {
  const btn = e.target.closest('.popup-star[data-fav-id]');
  if (!btn) return;
  toggleFav(btn.dataset.favId);
});

// ── interaction ────────────────────────────────────────────────────────────────
function isMobileViewport() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function showModalPopup(ev) {
  const modal = document.getElementById('popup-modal');
  const title = document.getElementById('popup-modal-title');
  const body  = document.getElementById('popup-modal-body');
  title.textContent = ev.name || ev.wiki_title;
  body.innerHTML = popupBodyHtml(ev);
  const docs = popupDocsHtml(ev);
  const footer = document.getElementById('popup-modal-footer');
  footer.innerHTML = docs;
  footer.style.display = docs ? '' : 'none';
  // Update star
  const star = document.getElementById('popup-modal-star');
  star.dataset.favId = ev.id;
  const _s = favs.has(ev.id);
  star.classList.toggle('starred', _s);
  star.title = _s ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen';
  modal.classList.add('show');
}

function clearUrlHash() {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

function hideModalPopup() {
  document.getElementById('popup-modal').classList.remove('show');
  clearUrlHash();
}

document.getElementById('popup-modal-close').addEventListener('click', hideModalPopup);

function resetModalStar() {
  const star = document.getElementById('popup-modal-star');
  if (star) { star.dataset.favId = ''; star.innerHTML = POPUP_STAR_SVG; star.classList.remove('starred'); }
}

document.getElementById('popup-modal-star').addEventListener('click', () => {
  const star = document.getElementById('popup-modal-star');
  const id = star.dataset.favId;
  if (!id) return;
  toggleFav(id);
  // toggleFav already updates the star DOM, nothing extra needed here
});

function shareCurrentUrl(feedbackEl) {
  const url = window.location.origin + window.location.pathname + window.location.hash;
  if (navigator.share) {
    navigator.share({ url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {
      if (feedbackEl) {
        const orig = feedbackEl.dataset.label || feedbackEl.innerHTML;
        feedbackEl.innerHTML = feedbackEl.dataset.copied || '✓ Link kopiert';
        setTimeout(() => { feedbackEl.innerHTML = orig; }, 1500);
      }
    });
  }
}

document.getElementById('popup-modal-share').addEventListener('click', e => {
  shareCurrentUrl(e.currentTarget);
});

document.getElementById('popup-modal').addEventListener('click', e => {
  if (e.target.id === 'popup-modal') hideModalPopup();
});

document.addEventListener('click', e => {
  const link = e.target.closest('a.popup-doc:not(.popup-doc-ics), a.tbl-doc:not(.tbl-doc-ics)');
  if (!link || navigator.onLine) return;
  e.preventDefault();
  e.stopPropagation();
  resetModalStar();
  document.getElementById('popup-modal-title').textContent = 'Offline – PDF nicht verfügbar';
  document.getElementById('popup-modal-body').innerHTML =
    '<p style="margin:0;line-height:1.5">PDFs können nur online geöffnet werden. ' +
    'Bitte prüfe deine Internetverbindung und versuche es erneut.</p>';
  const footer = document.getElementById('popup-modal-footer');
  footer.innerHTML = '';
  footer.style.display = 'none';
  document.getElementById('popup-modal').classList.add('show');
}, true);

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-ics-id]');
  if (btn) icsDownload(EVENTS.find(ev => ev.id === btn.dataset.icsId));
});

function highlightRow(id) {
  const prevId = activeId;
  activeId = id;
  if (prevId) { const r = tbl.getRow(prevId); if (r) r.reformat(); }
  const row = tbl.getRow(id);
  if (row) { row.reformat(); tbl.scrollToRow(id); }
}

function focusEvent(ev) {
  history.replaceState(null, '', '#' + encodeURIComponent(ev.id));
  highlightRow(ev.id);
  if (ev.lat && ev.lon) {
    if (isMobileViewport()) {
      showModalPopup(ev);
    } else {
      requestAnimationFrame(() => {
        showEventPopup(ev);
        requestAnimationFrame(() => {
          const _mapH    = map.getContainer().clientHeight;
          const _popupEl = openPopup?.getElement();
          const _popupH  = _popupEl ? _popupEl.getBoundingClientRect().height : 250;
          const _needed  = 15 + _popupH + 38;
          const _topPad  = Math.max(15, Math.min(2 * _needed - _mapH, _mapH - 50));
          _programmaticMapMove = true;
          map.flyTo({ center: [ev.lon, ev.lat], zoom: map.getZoom(), padding: { top: _topPad } });
        });
      });
    }
  }
}

// ── filter bar ─────────────────────────────────────────────────────────────────
function updateClearFiltersBtn() {
  const active = selectedFavStates.size || selectedRegion || selectedEventTypes.size || selectedDistances.size || selectedStatuses.size;
  document.getElementById('btn-clear-filters').style.display = active ? '' : 'none';
}

document.getElementById('region-select').addEventListener('change', e => {
  selectedRegion = e.target.value;
  updateClearFiltersBtn();
  applyFilters();
});

document.querySelectorAll('[data-dist]').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = btn.dataset.dist;
    btn.classList.toggle('active');
    btn.classList.contains('active') ? selectedDistances.add(d) : selectedDistances.delete(d);
    updateClearFiltersBtn();
    applyFilters();
  });
});

document.querySelectorAll('[data-status]').forEach(btn => {
  btn.addEventListener('click', () => {
    const s = btn.dataset.status;
    btn.classList.toggle('active');
    btn.classList.contains('active') ? selectedStatuses.add(s) : selectedStatuses.delete(s);
    updateClearFiltersBtn();
    applyFilters();
  });
});

document.querySelectorAll('[data-fav]').forEach(btn => {
  btn.addEventListener('click', () => {
    const f = btn.dataset.fav;
    btn.classList.toggle('active');
    btn.classList.contains('active') ? selectedFavStates.add(f) : selectedFavStates.delete(f);
    updateClearFiltersBtn();
    applyFilters();
  });
});

document.getElementById('btn-clear-filters').addEventListener('click', () => {
  selectedFavStates.clear();
  selectedRegion = '';
  selectedEventTypes.clear();
  selectedDistances.clear();
  selectedStatuses.clear();
  mapBounds = null;
  document.querySelectorAll('.tog.active').forEach(b => b.classList.remove('active'));
  document.getElementById('region-select').value = '';
  updateClearFiltersBtn();
  applyFilters();
});

// ── controls ───────────────────────────────────────────────────────────────────
document.getElementById('show-vorrat').addEventListener('change', e => {
  showVorrat = e.target.checked;
  applyFilters();
  if (showVorrat) {
    document.getElementById('rittvorrat-modal').classList.add('show');
  }
});

const searchEl      = document.getElementById('search');
const searchClearBtn = document.getElementById('search-clear');

function syncSearchToUrl(q) {
  const url = new URL(window.location.href);
  if (q) url.searchParams.set('q', q);
  else   url.searchParams.delete('q');
  history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
}

searchEl.addEventListener('input', e => {
  filterText = e.target.value;
  searchClearBtn.style.display = filterText ? 'block' : 'none';
  if (filterText) clearRadius();
  syncSearchToUrl(filterText);
  applyFilters();
});

searchClearBtn.addEventListener('click', () => {
  searchEl.value = '';
  filterText = '';
  searchClearBtn.style.display = 'none';
  syncSearchToUrl('');
  applyFilters();
  searchEl.focus();
});

function fitVisibleMarkers() {
  const evs = EVENTS.filter(e => e.lat && e.lon);
  if (!evs.length) return;
  const lons = evs.map(e => e.lon), lats = evs.map(e => e.lat);
  mapBounds = null;
  _programmaticMapMove = true;
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 25 });
}

function clearRadius() {
  userLat = null; userLon = null;
  if (userMarker) { userMarker.remove(); userMarker = null; }
  removeRadiusCircle();
  const btn = document.getElementById('btn-locate');
  btn.classList.remove('active');
  btn.textContent = '📍 Standort';
  fitVisibleMarkers();
}

document.getElementById('btn-locate').addEventListener('click', () => {
  if (userLat !== null) { clearRadius(); applyFilters(); return; }
  if (!navigator.geolocation) { alert('Geolocation nicht verfügbar'); return; }
  const btn = document.getElementById('btn-locate');
  btn.textContent = '⏳ …';
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    userLat = latitude;
    userLon = longitude;
    filterText = '';
    document.getElementById('search').value = '';
    document.getElementById('search-clear').style.display = 'none';
    if (userMarker) { userMarker.remove(); userMarker = null; }
    removeRadiusCircle();

    const userEl = document.createElement('div');
    userEl.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#2ea3f2;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.5);cursor:default';
    const userPopup = new maplibregl.Popup({ offset: 7 })
      .setHTML(`Mein Standort<br><small>Genauigkeit: ±${Math.round(accuracy)} m</small>`);
    userMarker = new maplibregl.Marker({ element: userEl })
      .setLngLat([userLon, userLat])
      .setPopup(userPopup)
      .addTo(map);

    radiusKm = +document.getElementById('radius-slider').value || 250;
    showRadiusCircle(userLat, userLon, radiusKm);
    map.resize();
    mapBounds = null;
    _programmaticMapMove = true;
    map.fitBounds(radiusBounds(userLat, userLon, radiusKm), { padding: 25 });
    btn.textContent = '✕ Löschen';
    btn.disabled = false;
    btn.classList.add('active');
    applyFilters();
  }, err => {
    btn.textContent = '📍 Standort';
    btn.disabled = false;
    alert('Standort konnte nicht ermittelt werden: ' + err.message);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
});

{
  const slider = document.getElementById('radius-slider');
  const stored = +localStorage.getItem('vdd_radius_km');
  radiusKm = stored || +slider.value || 250;
  slider.value = radiusKm;
  document.getElementById('radius-label').textContent = radiusKm + ' km';
}

document.getElementById('radius-slider').addEventListener('input', e => {
  radiusKm = +e.target.value;
  document.getElementById('radius-label').textContent = radiusKm + ' km';
  try { localStorage.setItem('vdd_radius_km', String(radiusKm)); } catch(_) {}
  if (userLat !== null) {
    showRadiusCircle(userLat, userLon, radiusKm);
    mapBounds = null;
    _programmaticMapMove = true;
    map.fitBounds(radiusBounds(userLat, userLon, radiusKm), { padding: 25 });
    applyFilters();
  }
});

// ── mobile filter toggle: hide the filter bar, give the freed space to the map ─
(function () {
  const btn = document.getElementById('btn-filter-toggle');
  btn.addEventListener('click', () => {
    const hide = !document.body.classList.contains('filters-hidden');
    if (hide) {
      const h = document.getElementById('filter-bar').offsetHeight;
      document.documentElement.style.setProperty('--fbar-h', h + 'px');
    }
    document.body.classList.toggle('filters-hidden', hide);
    btn.classList.toggle('active', hide);
    const label = hide ? 'Filter einblenden' : 'Filter ausblenden';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    map.resize();
  });
})();

// ── service worker registration (required for PWA installability) ─────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── PWA install prompt ────────────────────────────────────────────────────────
(function () {
  const installBtn = document.getElementById('install-app-btn');
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn.hidden = true;
  });
})();

// ── burger menu ────────────────────────────────────────────────────────────────
(function () {
  const burgerBtn = document.getElementById('burger-btn');
  const drawer    = document.getElementById('burger-drawer');
  const backdrop  = document.getElementById('burger-backdrop');

  function openDrawer() {
    drawer.classList.add('open');
    backdrop.classList.add('show');
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    backdrop.classList.remove('show');
  }

  burgerBtn.addEventListener('click', () => {
    drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  });
  backdrop.addEventListener('click', closeDrawer);

  // Open modal on burger item click
  drawer.querySelectorAll('.burger-item[data-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.modal;
      closeDrawer();
      if (modalId === 'notifications-modal') {
        document.getElementById('notifications-modal-body').innerHTML = buildNotificationsHtml();
        wireNotificationsModal();
      }
      document.getElementById(modalId).classList.add('show');
    });
  });
})();

// ── generic modal close (std-modal) ───────────────────────────────────────────
document.querySelectorAll('.std-modal-close').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.modal).classList.remove('show');
  });
});
document.querySelectorAll('.std-modal').forEach(modal => {
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('show');
  });
});

// ── info modal ─────────────────────────────────────────────────────────────────
document.getElementById('info-modal-close').addEventListener('click', () =>
  document.getElementById('info-modal').classList.remove('show')
);
document.getElementById('info-modal').addEventListener('click', e => {
  if (e.target.id === 'info-modal') document.getElementById('info-modal').classList.remove('show');
});

// ── data caching ───────────────────────────────────────────────────────────────
async function loadVddData() {
  const KEY = 'vdd_d', TS = 'vdd_t';
  const MAX_AGE = 60 * 60 * 1000;
  const now = Date.now();
  const forceRefresh = !!window.location.hash;
  let cached = null;
  try {
    cached = localStorage.getItem(KEY);
    const ts = parseInt(localStorage.getItem(TS) || '0', 10);
    const offline = !navigator.onLine;
    if (cached && (offline || (!forceRefresh && (now - ts) < MAX_AGE))) {
      return JSON.parse(cached);
    }
  } catch(e) {
    try { localStorage.removeItem(KEY); localStorage.removeItem(TS); } catch(_) {}
    cached = null;
  }
  try {
    const data = await fetch('data.min.json').then(r => r.json());
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      localStorage.setItem(TS, String(now));
    } catch(_) {}
    return data;
  } catch(fetchErr) {
    if (cached) return JSON.parse(cached);
    throw fetchErr;
  }
}

// ── load data ──────────────────────────────────────────────────────────────────
(async function () {
  // Sync pending preference changes if back online
  if (navigator.onLine && localStorage.getItem('vdd_pending_prefs')) {
    syncPrefsToServer().catch(() => {});
  }

  const initialQ = new URL(window.location.href).searchParams.get('q');
  if (initialQ) {
    filterText = initialQ;
    searchEl.value = initialQ;
    document.getElementById('search-clear').style.display = 'block';
  }

  let _vd;
  try {
    _vd = await loadVddData();
  } catch(e) {
    document.getElementById('grid').innerHTML =
      `<p style="padding:1.5rem;color:#c00">Daten konnten nicht geladen werden.<br>${e.message}</p>`;
    console.error(e);
    return;
  }
  const { events, scraped_at } = _vd;
  EVENTS = events.map((ev, i) => {
    const strip = f => ev[f] ? String(ev[f]).replace(/\s+/g, '') : ev[f];
    const id = ev.id ?? ev.wiki_title ?? String(i);
    return { ...ev, id, event_types_arr: (ev.event_types || '').split(',').map(s => s.trim()).filter(Boolean), _fav: favs.has(id) ? 1 : 0, efr: strip('efr'), kdr: strip('kdr'), mdr: strip('mdr'), ldr: strip('ldr'), mtr: strip('mtr'), cei: strip('cei') };
  });

  const lastChanged = EVENTS.filter(e => e.wiki_touched).sort((a, b) => b.wiki_touched.localeCompare(a.wiki_touched))[0];
  if (lastChanged) {
    const a = document.createElement('a');
    a.href = '#' + encodeURIComponent(lastChanged.id);
    a.textContent = lastChanged.name || lastChanged.wiki_title;
    a.addEventListener('click', e => {
      e.preventDefault();
      window.location.hash = encodeURIComponent(lastChanged.id);
      document.getElementById('info-modal').classList.remove('show');
      focusEvent(lastChanged);
    });
    const cell = document.getElementById('info-last-changed');
    cell.textContent = '';
    cell.appendChild(a);
    cell.appendChild(document.createTextNode(` (${fmtDateDe(lastChanged.wiki_touched)})`));
  }

  const APP_SHA_KEY = 'vdd_app_sha';
  let pendingNewSha = null;

  // ── GitHub status info (last checked / app version), throttled to once per hour ──
  function renderGhInfo(info) {
    if (info.runUpdatedAt) document.getElementById('info-geprueft').textContent = timeAgo(info.runUpdatedAt);
    if (info.commitSha) {
      document.getElementById('info-version').textContent = `${info.commitSha} (${timeAgo(info.commitDate)})`;
      const knownSha = localStorage.getItem(APP_SHA_KEY);
      if (knownSha && knownSha !== info.commitSha) {
        // Reload only while hidden, so an open tab never flashes/loses state while in use.
        if (document.visibilityState === 'hidden') {
          localStorage.setItem(APP_SHA_KEY, info.commitSha);
          location.reload();
          return;
        }
        pendingNewSha = info.commitSha;
        return;
      }
      localStorage.setItem(APP_SHA_KEY, info.commitSha);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingNewSha) {
      localStorage.setItem(APP_SHA_KEY, pendingNewSha);
      location.reload();
    }
  });

  const GH_TTL = 60 * 60 * 1000;
  let ghInfo = null;
  try { ghInfo = JSON.parse(localStorage.getItem('vdd_gh_info')); } catch(_) {}

  if (ghInfo && (Date.now() - ghInfo.checkedAt) < GH_TTL) {
    renderGhInfo(ghInfo);
  } else {
    Promise.all([
      fetch('https://api.github.com/repos/techtimo/vdd-rittatlas/actions/workflows/update.yml/runs?per_page=1').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('https://api.github.com/repos/techtimo/vdd-rittatlas/commits?per_page=30').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([runsData, commitsData]) => {
      const run = runsData?.workflow_runs?.[0];
      // Hourly data-only commits are authored by the scraper bot; skip those to find the latest actual code change.
      const codeCommit = commitsData?.find(c => c.commit?.author?.name !== 'github-actions[bot]');
      if (!run && !codeCommit) {
        if (ghInfo) renderGhInfo(ghInfo);
        return;
      }
      const info = {
        checkedAt: Date.now(),
        runUpdatedAt: run?.updated_at || ghInfo?.runUpdatedAt || null,
        commitSha: codeCommit?.sha ? codeCommit.sha.slice(0, 7) : ghInfo?.commitSha || null,
        commitDate: codeCommit?.commit?.committer?.date || ghInfo?.commitDate || null,
      };
      try { localStorage.setItem('vdd_gh_info', JSON.stringify(info)); } catch(_) {}
      renderGhInfo(info);
    });
  }

  // populate region dropdown
  const regionSel = document.getElementById('region-select');
  [...new Set(EVENTS.map(e => e.region).filter(Boolean))].sort().forEach(r => {
    const o = document.createElement('option'); o.value = r; o.textContent = r;
    regionSel.appendChild(o);
  });

  // populate event-type toggles
  const allTypes = new Set();
  EVENTS.forEach(e => e.event_types_arr.forEach(t => allTypes.add(t)));
  const typeRow = document.getElementById('type-toggles');
  [...allTypes].sort().forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'tog'; btn.textContent = type; btn.dataset.type = type;
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      btn.classList.contains('active') ? selectedEventTypes.add(type) : selectedEventTypes.delete(type);
      updateClearFiltersBtn();
      applyFilters();
    });
    typeRow.appendChild(btn);
  });

  // Render the table immediately; don't gate it on the basemap tiles, which
  // can be slow to fetch on a first-ever visit. Markers are added via the
  // 'style.load' listener once the map style is ready, or immediately below
  // if it already fired before the event data arrived (isStyleLoaded() is
  // unreliable here: it reflects whether tiles are *currently* loaded, which
  // can be false even after 'style.load' already fired once).
  _currentGeoJSON = eventsToGeoJSON(EVENTS);
  if (_styleReady) {
    _addEventLayersToMap(_currentGeoJSON).catch(err => console.error('addEventLayers failed:', err));
  }

  await new Promise(r => setTimeout(r, 0));
  initTable(EVENTS);
})();

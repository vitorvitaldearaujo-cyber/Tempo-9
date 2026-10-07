/* DiaClaro — service worker
   - abre o app mesmo sem rede
   - confere nova versão em segundo plano e avisa
   - (Chrome/Android, app instalado) atualiza clima, confere lembretes e alertas de tempestade com o app fechado */
const BUILD = '2026-10-07.1';
const CACHE = 'diaclaro-' + BUILD;
const SHELL = ['./DiaClaro.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

/* ---- banco compartilhado com a página (IndexedDB) ---- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('diaclaro', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  try {
    const d = await idbOpen();
    return await new Promise(res => { const q = d.transaction('kv', 'readonly').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
  } catch (e) { return undefined; }
}
async function idbSet(k, v) {
  try {
    const d = await idbOpen();
    return await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = t.onabort = () => res(false); });
  } catch (e) { return false; }
}

/* ---- ciclo de vida ---- */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'BG_NOW') e.waitUntil(bgRefresh());
});

/* ---- cache: HTML sempre revalidado (pega versão nova), resto "stale-while-revalidate" ---- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;
  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('.html');
  if (isDoc) {
    e.respondWith(
      fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
        .then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {}); } return res; })
        .catch(() => caches.match(req).then(r => r || caches.match('./DiaClaro.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {}); } return res; }).catch(() => hit);
      return hit || net;
    })
  );
});

/* ---- avisos ---- */
function show(title, body, tag, view, sticky) {
  return self.registration.showNotification(title, {
    body, tag, icon: 'icon-192.png', badge: 'icon-192.png', renotify: true,
    vibrate: [200, 100, 200, 100, 300], requireInteraction: !!sticky, data: { view: view || 'home' }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.postMessage({ type: 'notif-click', data }); return c.focus(); }
      }
      return self.clients.openWindow('./DiaClaro.html');
    })
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(show(d.title || 'DiaClaro', d.body || '', d.tag || 'dc-push', d.view));
});

/* ---- atualização em segundo plano ---- */
const OFFS = { '5 minutos antes': 5, '15 minutos antes': 15, '30 minutos antes': 30, '1 hora antes': 60, '1 dia antes': 1440 };
const FURL = (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,weather_code,is_day,visibility,uv_index,dew_point_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,daylight_duration&timezone=auto&forecast_days=10&wind_speed_unit=kmh`;
const SURL = (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code&hourly=weather_code,precipitation,wind_gusts_10m&forecast_days=2&timezone=auto&wind_speed_unit=kmh`;

function sendWpp(al, text) {
  if (!al || !al.waPhone || !al.waKey) return Promise.resolve();
  return fetch('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent('+' + al.waPhone) + '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(al.waKey), { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
}

/* mesma regra de severidade da página */
function severe(j) {
  const H = j.hourly, cur = ((j.current && j.current.time) || H.time[0]).slice(0, 13);
  let s = H.time.findIndex(t => t.slice(0, 13) === cur); if (s < 0) s = 0;
  let best = null, maxG = 0, maxP = 0;
  for (let i = 0; i < 12 && s + i < H.time.length; i++) {
    const k = s + i, code = H.weather_code[k], g = H.wind_gusts_10m[k] || 0, p = H.precipitation[k] || 0;
    maxG = Math.max(maxG, g); maxP = Math.max(maxP, p);
    let lvl = 0, type = '';
    if (code === 96 || code === 99) { lvl = 4; type = 'tempestade com granizo'; }
    else if (code === 95) { lvl = 3; type = 'tempestade com raios'; }
    if (g >= 90 && lvl < 4) { lvl = 4; type = 'vendaval'; }
    else if (g >= 65 && lvl < 3) { lvl = 3; type = 'rajadas fortes de vento'; }
    if (p >= 20 && lvl < 4) { lvl = 4; type = 'chuva torrencial'; }
    else if ((p >= 10 || code === 82) && lvl < 3) { lvl = 3; type = 'chuva muito forte'; }
    if (lvl && (!best || lvl > best.lvl)) best = { lvl, type, time: H.time[k], i };
  }
  return best ? Object.assign(best, { maxG, maxP }) : null;
}

let bgRunning = null;
function bgRefresh() {
  if (bgRunning) return bgRunning;
  bgRunning = (async () => {
    const st = (await idbGet('state')) || {};
    const fired = new Set((await idbGet('fired')) || []);
    const now = Date.now();
    let ch = false;

    /* 1) nova versão do app */
    try {
      await self.registration.update().catch(() => {});
      const r = await fetch('./DiaClaro.html', { cache: 'no-store' });
      if (r.ok) {
        const t = await r.text(), m = t.match(/const APP_BUILD='([^']+)'/), cur = await idbGet('build');
        const c = await caches.open(CACHE);
        await c.put('./DiaClaro.html', new Response(t, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
        if (m && cur && m[1] !== cur && !fired.has('upd|' + m[1])) {
          fired.add('upd|' + m[1]); ch = true;
          await show('DiaClaro atualizado', 'Uma nova versão está pronta. Abra o app para usá-la.', 'dc-upd', 'home');
        }
      }
    } catch (e) {}

    /* 2) lembretes que venceram com o app fechado */
    for (const e of (st.events || [])) {
      const mins = OFFS[e.reminder];
      if (mins == null || fired.has(e.id)) continue;
      const at = new Date(e.date + 'T' + (e.time || '09:00') + ':00').getTime(), fireAt = at - mins * 60000;
      if (now >= fireAt && now <= at + 60 * 60000) {
        fired.add(e.id); ch = true;
        const when = e.reminder === '1 dia antes' ? 'amanhã às ' + (e.time || '09:00') : 'às ' + (e.time || '09:00');
        await show(e.title, 'Compromisso ' + when + (e.location ? ' · ' + e.location : ''), 'ev-' + e.id, 'calendar');
        if (st.al && st.al.wa && st.al.waReminders) await sendWpp(st.al, '🔔 DiaClaro: ' + e.title + ' — ' + when);
      }
    }

    /* 3) clima do local principal (a página usa isso ao abrir) */
    try {
      if (st.wxLoc) {
        const r = await fetch(FURL(st.wxLoc.lat, st.wxLoc.lon));
        if (r.ok) await idbSet('wxbg', { key: st.wxLoc.lat + ',' + st.wxLoc.lon, w: await r.json(), t: Date.now() });
      }
    } catch (e) {}

    /* 3b) notícias do dia (uma vez por dia): guarda manchetes para a página mostrar ao abrir */
    try {
      const lastN = (await idbGet('newsbgT')) || 0;
      if (now - lastN > 20 * 3600e3) {
        const G = t => `https://news.google.com/rss/headlines/section/topic/${t}?hl=pt-BR&gl=BR&ceid=BR:pt-419`;
        const NF = { top: 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419', br: G('NATION'), mundo: G('WORLD'), pol: 'https://news.google.com/rss/search?q=pol%C3%ADtica+Brasil+when:2d&hl=pt-BR&gl=BR&ceid=BR:pt-419', esp: G('SPORTS'), eco: G('BUSINESS') };
        const cats = {};
        for (const id in NF) {
          try {
            const r = await fetch('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(NF[id]));
            const j = r.ok ? await r.json() : null;
            if (!j || j.status !== 'ok') continue;
            cats[id] = (j.items || []).slice(0, 30).map(i => {
              let t = String(i.title || ''), s = 'Google Notícias';
              const m = t.match(/^(.*) - ([^-]{2,40})$/); if (m) { t = m[1]; s = m[2]; }
              const l = /^https?:\/\//i.test(i.link || '') ? i.link : '';
              const img = String(i.thumbnail || (i.enclosure && i.enclosure.link) || '').replace(/^http:/i, 'https:');
              return t && l ? { t, l, s, d: Date.parse(String(i.pubDate || '').replace(' ', 'T') + 'Z') || 0, i: /^https:/i.test(img) ? img : '', x: '' } : null;
            }).filter(Boolean);
          } catch (e) {}
        }
        if (Object.keys(cats).length) { await idbSet('newsbg', { t: Date.now(), cats }); await idbSet('newsbgT', Date.now()); }
      }
    } catch (e) {}

    /* 4) alertas de tempestade severa */
    try {
      if (st.loc && st.al && st.al.storm) {
        const r = await fetch(SURL(st.loc.lat, st.loc.lon));
        if (r.ok) {
          const best = severe(await r.json());
          if (best) {
            const key = best.type + '|' + best.time.slice(0, 10) + '|' + Math.floor(+best.time.slice(11, 13) / 3);
            if (!fired.has('sev|' + key)) {
              fired.add('sev|' + key); ch = true;
              const cap = best.type.charAt(0).toUpperCase() + best.type.slice(1), name = st.loc.name || 'sua região';
              const title = '⚠️ ' + cap + ' — ' + name;
              const text = (best.i === 0 ? 'Agora' : 'Previsto para ' + best.time.slice(11, 16)) + ': ' + best.type + '. Rajadas de até ' + Math.round(best.maxG) + ' km/h e chuva de até ' + Math.round(best.maxP) + ' mm/h. Procure abrigo e fique longe de árvores, fios e áreas abertas. Defesa Civil: 199.';
              await show(title, text, 'dc-sev', 'weather', true);
              if (st.al.wa) await sendWpp(st.al, '⚠️ *DiaClaro — ALERTA*\n' + title + '\n' + text);
            }
          }
        }
      }
    } catch (e) {}

    if (ch) await idbSet('fired', [...fired].slice(-400));
    await idbSet('bgLast', Date.now());
  })().finally(() => { bgRunning = null; });
  return bgRunning;
}

self.addEventListener('periodicsync', e => { if (e.tag === 'diaclaro-bg') e.waitUntil(bgRefresh()); });
self.addEventListener('sync', e => { if (e.tag === 'diaclaro-sync') e.waitUntil(bgRefresh()); });

// Harbour UI: console tabs on top, one big picture (art, then video), a cover row along the bottom.
// Rules: nothing animates unless you are using it, and everything stops while Harbour is in the
// background or a game is running.
'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const S = {
  config: null, games: [], tabs: [], tab: 'all', list: [], sel: 0, recomp: {}, running: false,
  focused: document.hasFocus(), ambient: false, lastInput: Date.now(), menuOpen: false, artBusy: false,
};

// ---------- toast ----------
let toastTimer;
// Activity chips (top right): set() while a download/update runs, done() shows a tick, fail() a cross, then they fade away.
const Activity = {
  els: {},
  el(id) {
    let e = this.els[id];
    if (!e) { e = this.els[id] = document.createElement('div'); e.className = 'act in'; e.innerHTML = '<span class="ico"></span><span class="txt"></span><span class="bar"></span>'; $('#activity').append(e); }
    clearTimeout(e._t); e.classList.remove('out'); return e;
  },
  set(id, text, pct) {
    const e = this.el(id); e.classList.add('busy'); e.classList.remove('ok', 'bad');
    e.querySelector('.ico').textContent = ''; e.querySelector('.txt').textContent = text;
    e.querySelector('.bar').style.width = pct > 0 && pct < 1 ? `${Math.round(pct * 100)}%` : '0';
  },
  end(id, text, cls, mark, ms) {
    const e = this.el(id); e.classList.remove('busy', 'ok', 'bad'); e.classList.add(cls);
    e.querySelector('.ico').textContent = mark; e.querySelector('.txt').textContent = text; e.querySelector('.bar').style.width = '0';
    e._t = setTimeout(() => { e.classList.add('out'); e._t = setTimeout(() => { e.remove(); delete this.els[id]; }, 450); }, ms);
  },
  done(id, text) { this.end(id, text, 'ok', '✓', 2600); },
  clear(id) { const e = this.els[id]; if (e) { clearTimeout(e._t); e.remove(); delete this.els[id]; } },
  fail(id, text) { this.end(id, text, 'bad', '!', Math.max(8000, 60 * text.length)); },  // long enough to read
};
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms); }

// ---------- library ----------
const sysOf = id => S.config.systems.find(s => s.id === id) || { id, name: id, color: '#2a4a6a' };
const visible = g => !g.hidden;
const emulated = g => !g.recomp && g.system !== 'recomp' && g.system !== 'pc';
// Tabs holding games of more than one console.
const mixedTab = id => id === 'all' || id === 'favorites' || id === 'recent' || id === 'emulated' || id === 'ports';
// Recent: the games you've played lately, newest first (the 20 most recent), whatever the game order is set to.
const RECENT = 20;
const recentGames = () => S.games.filter(g => visible(g) && g.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, RECENT);
function buildTabs() {
  const counts = {};
  for (const g of S.games.filter(visible)) counts[g.system] = (counts[g.system] || 0) + 1;
  const fav = S.games.filter(g => g.favorite && visible(g)).length, emu = S.games.filter(g => visible(g) && emulated(g)).length,
    ports = S.games.filter(g => visible(g) && g.recomp).length;
  const recent = recentGames().length;
  // Favourites and Recent first, the consoles, then every port and every emulated game (ports also sit on their
  // console's tab), All last.
  S.tabs = [...(fav ? [{ id: 'favorites', name: '★ Favourites', n: fav }] : []),
    ...(recent ? [{ id: 'recent', name: 'Recent', n: recent }] : []),
    ...S.config.systems.filter(s => counts[s.id]).sort(tabOrder(counts)).map(s => ({ id: s.id, name: shortName(s.name), n: counts[s.id] })),
    ...(ports ? [{ id: 'ports', name: 'Ports', n: ports }] : []),
    ...(emu && ports ? [{ id: 'emulated', name: 'Emulated', n: emu }] : []),
    { id: 'all', name: 'All', n: S.games.filter(visible).length }];
  if (!S.tabs.some(t => t.id === S.tab)) S.tab = 'all';
  const nav = $('#tabs'); nav.replaceChildren();
  for (const t of S.tabs) {
    const b = el('button', 'tab' + (t.id === S.tab ? ' on' : ''), t.name);
    b.append(el('span', 'n', String(t.n)));
    b.onclick = () => { setTab(t.id); };
    nav.append(b);
  }
}
// Consoles in the order they came out (first release anywhere, by month), oldest on the left.
// Consoles you add yourself go after these; the Recomp and PC shelves go last.
const RELEASE = ['a2600', 'arcade', 'nes', 'genesis', 'gb', 'snes', 'ps1', 'n64', 'gbc', 'dreamcast', 'ps2', 'gba', 'gc', 'xbox',
  'nds', 'psp', 'x360', 'ps3', 'wii', '3ds', 'wiiu', 'ps4', 'switch', 'switch2'];
const releaseRank = id => { const i = RELEASE.indexOf(id); return i >= 0 ? i : id === 'recomp' ? 900 : id === 'pc' ? 901 : 800; };
const byRelease = (a, b) => releaseRank(a.id) - releaseRank(b.id);
// Settings → Console order / Game order. Ports and PC always come after the consoles.
const SORTS = { tabs: ['release', 'newest', 'name', 'most'], games: ['name', 'recent', 'played', 'year'] };
const sortSetting = kind => SORTS[kind].includes(S.config?.[kind === 'tabs' ? 'harbourTabSort' : 'harbourGameSort']) ? S.config[kind === 'tabs' ? 'harbourTabSort' : 'harbourGameSort'] : SORTS[kind][0];
const tabOrder = counts => (a, b) => {
  const late = x => (x.id === 'recomp' || x.id === 'pc' ? 1 : 0);
  if (late(a) !== late(b)) return late(a) - late(b);
  if (late(a)) return byRelease(a, b);
  const by = sortSetting('tabs');
  return by === 'newest' ? byRelease(b, a) : by === 'name' ? shortName(a.name).localeCompare(shortName(b.name))
    : by === 'most' ? (counts[b.id] - counts[a.id]) || byRelease(a, b) : byRelease(a, b);
};
const gameYear = g => parseInt(g.info?.year, 10) || 9999;
function gameOrder(a, b) {
  const by = sortSetting('games'), name = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  return by === 'recent' ? ((b.lastPlayed || 0) - (a.lastPlayed || 0)) || name
    : by === 'played' ? ((b.playMs || 0) - (a.playMs || 0)) || name
    : by === 'year' ? (gameYear(a) - gameYear(b)) || name : name;
}
const shortName = n => n.replace(/^Nintendo 64$/, 'N64').replace(/^Nintendo (?=Switch|DS|3DS)/, '').replace(/^PlayStation /, 'PS').replace(/^Sony /, '').replace(/^Microsoft /, '').replace(/^Super Nintendo$/, 'SNES').replace(/^Nintendo$/, 'NES').replace(/^Recomp$/, 'Ports');
// On a console's tab the wordmark reads just that console (N64, 360) and the accent takes its colour (a brighter take
// on the console's own, so it reads on the dark background). All and Favourites read ONEDECK, teal.
const THEMES = {
  a2600: ['ATARI 2600', '#e07a3a'], arcade: ['ARCADE', '#f0b429'], nes: ['NES', '#c9605f'], genesis: ['GENESIS', '#4d8fe8'],
  gb: ['GAME BOY', '#b4bc7a'], snes: ['SNES', '#9d8fe0'], ps1: ['PS1', '#b8c2cc'], n64: ['N64', '#3ec95a'], gbc: ['GBC', '#a46be0'],
  dreamcast: ['DREAMCAST', '#f28c28'], ps2: ['PS2', '#5b8ae6'], gba: ['GBA', '#8a78e6'], gc: ['GAMECUBE', '#8f7fe0'],
  xbox: ['XBOX', '#3fbf4c'], nds: ['DS', '#eef1f4'], psp: ['PSP', '#8e98a3'], x360: ['360', '#8fd400'], ps3: ['PS3', '#6f7882'],
  wii: ['WII', '#ffffff'], '3ds': ['3DS', '#cfd6de'], wiiu: ['WII U', '#d4ecfb'], ps4: ['PS4', '#3b82f6'],
  switch: ['SWITCH', '#ff4554'], switch2: ['SWITCH 2', '#dc2a40'], recomp: ['PORTS', '#a685ff'], ports: ['PORTS', '#a685ff'], pc: ['PC', '#5b9bf8'], emulated: ['EMULATED', '#5fd6cc'],
};
function applyTheme(id) {
  const [word, accent] = THEMES[id] || ['DECK', '#5fd6cc'];
  $('#brandLead').textContent = THEMES[id] ? '' : 'ONE';
  $('#brandWord').textContent = word;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent2', `color-mix(in srgb, ${accent} 55%, #fff)`);
}
function setTab(id, keepSel = false) {
  applyTheme(id);
  const prevId = S.list[S.sel]?.id;
  if (id !== S.tab && S.list.length) UISound.play('tab');
  S.tab = id;
  S.list = id === 'recent' ? recentGames()
    : S.games.filter(visible).filter(g => id === 'all' || (id === 'favorites' ? g.favorite : id === 'emulated' ? emulated(g) : id === 'ports' ? g.recomp : g.system === id)).sort(gameOrder);
  [...$('#tabs').children].forEach((b, i) => b.classList.toggle('on', S.tabs[i]?.id === id));
  centerTab();
  const remembered = S.uiState?.perSystem?.[id];
  const i = S.list.findIndex(g => g.id === (keepSel ? prevId : remembered));
  renderRow();
  select(i >= 0 ? i : 0, true);
  api.saveLibraryUi({ system: id }).catch(() => {});
}

// Slide the tab strip so the selected console sits in the middle of the screen.
function centerTab(instant = false) {
  const on = $('#tabs .on'); if (!on) return;
  const view = $('#tabsView').getBoundingClientRect();
  const x = innerWidth / 2 - view.left - (on.offsetLeft + on.offsetWidth / 2);
  $('#tabs').style.transition = instant ? 'none' : '';
  $('#tabs').style.setProperty('--tx', `${x}px`);
}
addEventListener('resize', () => { centerTab(true); select(S.sel, true); });

// ---------- emulator badge ----------
// On every game that runs through an emulator: grey = you don't have the emulator (or none is set),
// yellow = the emulator has an update, Harbour teal = it's there and up to date.
const EMU_ICON = 'M7 6h10a5 5 0 0 1 4.9 6l-.9 4.6a2.8 2.8 0 0 1-4.9 1.3L14.3 16H9.7l-1.8 1.9A2.8 2.8 0 0 1 3 16.6L2.1 12A5 5 0 0 1 7 6Zm.5 3v2h-2v1.6h2v2h1.6v-2h2V11h-2V9H7.5Zm8.8.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm-2.2 2.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z';
function emuInfo(g) {
  if (!g || g.recomp) return null;
  const sys = S.config.systems.find(s => s.id === g.system);
  if (!sys || sys.direct) return null;
  const emu = (S.emus || []).find(e => e.id === sys.emulator);
  if (!emu) return { state: 'missing', text: 'No emulator yet' };
  if (!emu.exe) return { state: 'missing', text: `${emu.name} not found (Settings → Emulators)` };
  const st = S.emuStatus?.[emu.id];
  if (st?.updateAvailable) return { state: 'update', text: `${emu.name}: ${st.latest.tag} available` };
  return { state: 'ok', text: `via ${emu.name}` };
}
// A game whose console has no emulator set: the well-known one Harbour can install for it (else null).
function emuOffer(g) {
  if (!g || g.recomp) return null;
  const sys = S.config.systems.find(s => s.id === g.system);
  if (!sys || sys.direct || (S.emus || []).some(e => e.id === sys.emulator)) return null;
  return (S.catalog || []).find(c => c.consoles.includes(g.system)) || null;
}
function emuBadge(info, cls, text) {
  const b = el('span', `${cls} ${info.state}`); b.title = info.text;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', EMU_ICON); p.setAttribute('fill', 'currentColor');
  svg.append(p); b.append(svg); if (text) b.append(text);
  return b;
}
async function loadEmulators(force = false) {
  S.emus = await api.emuList().catch(() => []);
  S.catalog = await api.emulatorCatalog().catch(() => S.catalog || []);
  S.emuStatus = await api.checkEmulators(force).catch(() => S.emuStatus || {});
}

// A picture's address, reloaded from disk after "Change artwork" (same file name, new picture).
const pic = u => !u || !S.artBust ? u : `${u}${u.includes('?') ? '&' : '?'}a=${S.artBust}`;
// ---------- cover row ----------
// List view: Settings → Interface. The same games, as a column of names on the right.
const VIEWS = ['shelf', 'tiles', 'list'];
const VIEW_ICONS = {  // little pictures of each view for the top-bar button
  shelf: '<rect x="2" y="13" width="5" height="8" rx="1"/><rect x="9.5" y="10" width="5" height="11" rx="1"/><rect x="17" y="13" width="5" height="8" rx="1"/>',
  tiles: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  list: '<rect x="3" y="4" width="3" height="3" rx=".8"/><rect x="8.5" y="4.5" width="12.5" height="2" rx="1"/><rect x="3" y="10.5" width="3" height="3" rx=".8"/><rect x="8.5" y="11" width="12.5" height="2" rx="1"/><rect x="3" y="17" width="3" height="3" rx=".8"/><rect x="8.5" y="17.5" width="12.5" height="2" rx="1"/>',
};
const view = () => VIEWS.includes(S.config?.harbourView) ? S.config.harbourView : 'shelf';
const listView = () => view() === 'list', tilesView = () => view() === 'tiles';
function applyView() {
  document.body.classList.toggle('listview', listView());
  document.body.classList.toggle('tilesview', tilesView());
  $('#listWrap').hidden = !listView(); $('#tilesWrap').hidden = !tilesView();
  $('#setView').value = view();
  $('#setTabSort').value = sortSetting('tabs'); $('#setGameSort').value = sortSetting('games');
  const name = view()[0].toUpperCase() + view().slice(1);
  $('#btnView').innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${VIEW_ICONS[view()]}</svg>`;
  $('#btnView').title = `View: ${name} (V)`;
}
async function setView(v) {
  await saveSetting({ harbourView: v }); applyView(); renderRow(); select(S.sel, true); renderHints();
  startVideoSoon(S.list[S.sel]);
  setHero(S.list[S.sel]);
}
const cycleView = () => { UISound.play('tab'); return setView(VIEWS[(VIEWS.indexOf(view()) + 1) % VIEWS.length]); };
$('#btnView').onclick = () => cycleView();
for (const [sel, key] of [['#setTabSort', 'harbourTabSort'], ['#setGameSort', 'harbourGameSort']]) $(sel).onchange = async e => {
  await saveSetting({ [key]: e.target.value }); buildTabs(); setTab(S.tab);
};
// Tiles: a grid of covers; arrows move through it, right-click is the ••• menu.
function renderTiles() {
  const grid = $('#tiles');
  if (!S.list.length) { grid.replaceChildren(el('p', 'note', 'No games here yet.')); return; }
  grid.replaceChildren(...S.list.map((g, i) => {
    const t = el('div', 'tile'); t.dataset.i = i;
    const front = pic(boxArt(g));
    // The whole cover: wide boxes (N64, SNES) get bars above and below instead of being cut off.
    if (front) { t.classList.add('art'); t.style.setProperty('--img', `url("${front}")`); }
    else { const card = el('div', 'card', g.title); card.append(el('small', '', sysOf(g.system).name)); t.style.setProperty('--c', sysOf(g.system).color || '#2a4a6a'); t.append(card); }
    if (front) t.append(el('div', 'name', g.title));
    if (g.favorite) t.append(el('span', 'fav', '★'));
    const emu = emuInfo(g);
    if (emu) t.append(emuBadge(emu, 'emu-badge'));
    t.onclick = () => select(i);
    t.ondblclick = () => play();
    t.oncontextmenu = e => { e.preventDefault(); select(i); openMenu(t); };
    return t;
  }));
}
// How many tiles fit across, for up and down.
const tileCols = () => { const ts = $('#tiles').children; let n = 0; while (n < ts.length && ts[n].offsetTop === ts[0].offsetTop) n++; return Math.max(1, n); };
function renderList() {
  const list = $('#gameList'), all = mixedTab(S.tab);
  if (!S.list.length) { list.replaceChildren(el('p', 'note', 'No games here yet.')); return; }
  list.replaceChildren(...S.list.map((g, i) => {
    const it = el('div', 'gi'); it.dataset.i = i;
    const front = pic(boxArt(g));
    if (front) { const img = el('img', 'thumb'); img.loading = 'lazy'; img.alt = ''; img.src = front; it.append(img); } else it.append(el('span', 'thumb'));
    it.append(el('span', 't', g.title));
    if (g.favorite) it.append(el('span', 'fav', '★'));
    if (S.recomp[g.id]?.updateAvailable) { const u = el('span', 'upd'); u.title = 'Update available'; it.append(u); }
    if (all) it.append(el('span', 's', shortName(sysOf(g.system).name)));
    it.onclick = () => select(i);
    it.ondblclick = () => play();
    return it;
  }));
}
function renderRow() {
  const row = $('#row'); row.replaceChildren();
  $('#empty').hidden = S.list.length > 0;
  if (listView()) { renderList(); refreshBadges(); return; }
  if (tilesView()) { renderTiles(); refreshBadges(); return; }
  S.list.forEach((g, i) => {
    const it = el('div', 'item'); it.dataset.i = i;
    const front = pic(boxArt(g));
    // Each cover keeps its own shape, from .5 (PSP boxes are tall, ~.57) to 1.45 wide.
    if (front) {
      it.style.backgroundImage = `url("${front}")`;
      const probe = new Image(); probe.onload = () => { it.style.setProperty('--ar', Math.max(.5, Math.min(1.45, probe.naturalWidth / probe.naturalHeight))); recenterSoon(); }; probe.src = front;
    } else {
      const card = el('div', 'card', g.title); card.append(el('small', '', sysOf(g.system).name));
      it.style.setProperty('--c', sysOf(g.system).color || '#2a4a6a'); it.append(card);
    }
    if (g.favorite) it.append(el('span', 'fav', '★'));
    const emu = emuInfo(g);
    if (emu) it.append(emuBadge(emu, 'emu-badge'));
    it.onclick = () => select(i);
    it.ondblclick = () => play();
    row.append(it);
  });
  refreshBadges();
}
// ---------- updates: recomps and emulators in one list ----------
function pendingUpdates() {
  const games = Object.entries(S.recomp).filter(([, s]) => s.updateAvailable).map(([id, s]) => ({ kind: 'game', id, s, g: S.games.find(g => g.id === id) }))
    .filter(u => u.g && !u.g.hidden).map(u => ({ ...u, name: u.g.title, from: u.s.installed?.tag, to: u.s.latest?.tag, auto: !!u.s.auto, launcher: !!u.s.launcher }));
  const emus = Object.entries(S.emuStatus || {}).filter(([, s]) => s.updateAvailable)
    .map(([id, s]) => ({ kind: 'emu', id, s, name: (S.emus || []).find(e => e.id === id)?.name || id, from: s.installed, to: s.latest?.tag, auto: !!s.canInstall }));
  // Ones OneDeck can install first, in the order you set (↑ in Updates), then "update in app" ones as they come.
  const self = S.self?.updateAvailable ? [{ kind: 'harbour', id: 'harbour', name: 'OneDeck', from: S.self.current, to: S.self.latest?.tag, auto: true }] : [];
  return [...self, ...games, ...emus].sort((a, b) => Number(b.auto) - Number(a.auto) || (a.auto && b.auto ? updateRank(a) - updateRank(b) : 0));
}
// The order updates install in: your order first (config.updateOrder, "kind:id" keys), new ones after. OneDeck's own on top.
const updKey = u => `${u.kind}:${u.id}`;
function updateRank(u) {
  if (u.kind === 'harbour') return -1;
  const i = (S.config?.updateOrder || []).indexOf(updKey(u));
  return i < 0 ? 1e6 : i;
}
// Move an update up or down. Ones already waiting in the download queue swap places there too.
function moveUpdate(u) {
  // ↑ on one in the queue: one place sooner (never past the one downloading). On one that isn't queued: into the
  // queue, at the end. Either way the selection rides with it, so pressing again keeps it going.
  const key = 'update:' + updKey(u), job = findJob(key), st = jobState(key);
  if (st === 'queued') {
    const i = Q.list.indexOf(job);
    if (i <= 0) return;
    [Q.list[i - 1], Q.list[i]] = [Q.list[i], Q.list[i - 1]];
  } else if (st === 'held') { Q.held = Q.held.filter(j => j !== job); Q.list.push(job); }
  else if (!st) updateOne(u);
  else return;
  // Remembered for next time (the order automatic updates queue in).
  const order = [Q.cur, ...Q.list].filter(j => j?.key.startsWith('update:')).map(j => j.key.slice(7));
  saveSetting({ updateOrder: [...order, ...(S.config.updateOrder || []).filter(k => !order.includes(k))] });
  UISound.play('tab'); queueChanged(); pumpQueue(); renderUpdates();
  $('#updList').querySelector(`[data-upd="${CSS.escape(updKey(u))}"] .upd-up`)?.focus();
}function openUpdates() { UISound.play('open'); renderUpdates(); if (!$('#updatesDlg').open) $('#updatesDlg').showModal(); }
function renderUpdates() {
  // Like Steam: OneDeck's own update, then the queue (the one downloading first, then up next), then Not queued, then
  // the ones to update in their own app.
  const list = pendingUpdates(), key = u => 'update:' + updKey(u);
  const auto = list.filter(u => u.auto && u.kind !== 'harbour');
  const at = u => { const k = key(u); return Q.cur?.key === k ? -1 : Q.list.findIndex(j => j.key === k); };
  const queued = auto.filter(u => Q.cur?.key === key(u) || at(u) >= 0).sort((a, b) => at(a) - at(b));
  const rest = auto.filter(u => !queued.includes(u));
  const row = u => {
    const r = el('div', 'upd-row');
    const name = el('div', 'upd-name'); name.append(el('b', '', u.name), el('small', '', `${u.kind === 'emu' ? 'Emulator' : u.kind === 'harbour' ? 'OneDeck' : 'Game'} · ${u.from || '?'} → ${u.to || '?'}`));
    const btns = el('div', 'emu-btns');
    const b = (text, fn, cls = '') => { const x = el('button', cls, text); x.type = 'button'; x.onclick = fn; btns.append(x); return x; };
    if (!u.auto && u.launcher) {
      name.append(el('small', 'upd-how', 'Updates with its own launcher'));
      b('Update', () => runLauncher(u.g), 'primary');
    } else if (!u.auto) {
      // OneDeck can't install this one: say where to update it. It notices by itself once it's done.
      name.append(el('small', 'upd-how', 'Update in app'));
      b('Release page', () => (u.kind === 'emu' ? api.openEmulatorPage(u.id) : api.recompOpenPage(u.id)).catch(e => toast(e.message)));
    } else if (u.kind === 'harbour') {
      const x = b('Update & restart', () => updateOne(u), 'primary'); x.dataset.key = key(u);
      if (jobState(key(u))) spinnerButton(x, 'Updating', findJob(key(u))?.pct || 0);
    } else {
      const k = key(u), st = jobState(k), job = findJob(k), pct = job?.pct || 0, how = pct > 0 && pct < 1 ? ` ${Math.round(pct * 100)}%` : '';
      // ↑: sooner in the queue, or into it. The first one waiting (right under the one downloading) stays selectable
      // but does nothing, so spamming A to ride one up never runs into something else.
      if (st !== 'running') {
        const up = b('↑', () => moveUpdate(u), 'upd-up');
        up.setAttribute('aria-label', st === 'queued' ? `Move ${u.name} up` : `Queue ${u.name}`); up.title = st === 'queued' ? 'Install this one sooner' : 'Add to the queue';
        if (st === 'queued' && Q.list.indexOf(job) === 0) { up.classList.add('at-top'); up.setAttribute('aria-disabled', 'true'); }
      }
      if (st === 'running' && job.downloading && job.pid) {
        const x = b(`${S.dlPaused ? 'Resume' : 'Pause'}${how}`, () => setDownloadsPaused(!S.dlPaused), 'primary'); x.dataset.key = k; x.dataset.pause = '1';
      } else if (st === 'running') {
        const x = b('Update', () => {}, 'primary'); x.dataset.key = k; spinnerButton(x, 'Updating', pct);
      } else {
        if (st === 'queued') name.append(el('small', 'upd-how', `Up next${how}`));
        if (st === 'held' && how) name.append(el('small', 'upd-how', `Downloaded${how}`));
        const x = b('Update', () => st ? startNow(job) : updateNow(u), 'primary'); x.dataset.key = k;
      }
      // ✕: out of the queue (not while it unpacks, which is quick and can't stop halfway).
      if (st === 'queued' || (st === 'running' && job.downloading && job.pid)) {
        const x = b('✕', () => unqueue(job), 'upd-x'); x.setAttribute('aria-label', `Take ${u.name} out of the queue`); x.title = 'Take it out of the queue';
      }
    }
    r.dataset.upd = updKey(u);
    r.append(name, btns); return r;
  };
  const rows = [...list.filter(u => u.kind === 'harbour').map(row), ...queued.map(row)];
  if (rest.length) { if (rows.length) rows.push(el('h4', 'emu-group', 'Not queued')); rows.push(...rest.map(row)); }
  const inApp = list.filter(u => !u.auto);
  if (inApp.length) { if (rows.length) rows.push(el('h4', 'emu-group', 'Update in app')); rows.push(...inApp.map(row)); }
  $('#updList').replaceChildren(...(rows.length ? rows : [el('p', 'note', 'Everything is up to date.')]));
}function afterUpdates() { refreshBadges(); renderRow(); select(S.sel, true); if ($('#updatesDlg').open) renderUpdates(); }
function updateOne(u, { auto = false } = {}) {
  const pid = u.kind === 'emu' ? 'emu:' + u.id : u.kind === 'game' ? u.id : null;
  return enqueue(`update:${u.kind}:${u.id}`, `Updating ${u.name}`, async () => {
    if (auto && S.running) return { quiet: true };  // a game started while it waited: it goes in after you stop playing
    try {
      if (u.kind === 'harbour') { await api.selfUpdate(); jobProgress('OneDeck updated: restarting…', 1); return { done: 'OneDeck updated: restarting…' }; }  // restarts itself
      if (u.kind === 'emu') S.emuStatus[u.id] = await api.emuUpdate(u.id);
      else S.recomp[u.id] = await api.recompUpdate(u.id);
      UISound.play('select');
      return { done: `${u.name} updated to ${u.to}` };
    } finally { afterUpdates(); }
  }, { pid });
}
// Settings → Updates → Install automatically (on unless switched off): every update OneDeck can install itself, for
// ports and emulators, goes in by itself after a check, never while a game is running (then it waits until the game
// closes). OneDeck's own updates stay a button press. "Update in app" ones still only show their badge.
function autoInstall() {
  if (S.config?.autoUpdates === false || S.dlPaused || S.running) return;
  const due = pendingUpdates().filter(u => u.auto && u.kind !== 'harbour' && !jobState(`update:${u.kind}:${u.id}`));
  for (const u of due) updateOne(u, { auto: true });
}
// Update on one that isn't in the queue yet: like Steam, it goes to the top and starts now (OneDeck's own update just
// runs: it restarts the app).
function updateNow(u) {
  if (u.kind === 'harbour') return updateOne(u);
  updateOne(u);
  const job = findJob(`update:${u.kind}:${u.id}`);
  if (job && job !== Q.cur) startNow(job);
}
// While OneDeck stays open: look again every few hours (the main process asks GitHub at most that often anyway).
setInterval(async () => { if (S.running) return; await checkUpdates(false); await loadEmulators(); afterUpdates(); autoInstall(); }, 3 * 3600 * 1000);
// Each one downloads, checks and backs up on its own, in turn.
$('#updClose').onclick = () => { UISound.play('back'); $('#updatesDlg').close(); };
$('#updatePill').onclick = openUpdates;

function refreshBadges() {
  // UPDATE on the covers (shelf) or tiles, whichever is showing.
  [...(tilesView() ? $('#tiles').querySelectorAll('.tile') : $('#row').children)].forEach((it, i) => {
    const g = S.list[i]; it.querySelector('.badge')?.remove();
    if (S.recomp[g?.id]?.updateAvailable) it.append(el('span', 'badge', 'UPDATE'));
  });
  showUpdatePill();
}
// Offline: the system says there's no network, or the update checks all failed to reach anything. The updates pill goes
// grey and says so; when the network's back it checks again by itself.
const NET_ERROR = /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out/i;
const isOffline = () => !navigator.onLine || !!S.netDown;
addEventListener('offline', () => showUpdatePill());
addEventListener('online', () => { S.netDown = false; showUpdatePill(); checkUpdates(false).then(() => loadEmulators()).then(() => { afterUpdates(); autoInstall(); }).catch(() => {}); });
// The updates pill (top right) is also the updates' status, like the activity chips: "N updates" when there's nothing
// going; while one downloads its name, how far and how many are up next, with a spinner and a progress line (a pause
// sign while paused); a tick for a moment when one's done. Clicking it opens Updates.
const isUpdateJob = j => !!j?.key?.startsWith('update:');
function showUpdatePill() {
  const pill = $('#updatePill'), j = isUpdateJob(Q.cur) ? Q.cur : null, next = Q.list.filter(isUpdateJob).length;
  pill.title = j ? `${j.label}: click to see updates` : 'See and install updates';
  const flash = S.pillFlash && S.pillFlash.until > Date.now() ? S.pillFlash.text : '';
  const n = pendingUpdates().length;
  // Nothing to update: a teal "✓ Up to date" (only once a check has really run, so it never says so too early).
  const mode = j || (S.dlPaused && next) ? 'busy' : flash ? 'ok' : isOffline() ? 'offline' : n ? 'idle' : 'current';
  pill.className = `pill ${mode === 'idle' ? 'new' : mode === 'current' || mode === 'offline' ? mode : 'status ' + mode}${S.dlPaused ? ' paused' : ''}`;
  pill.hidden = mode === 'current' && !S.updatesChecked;
  const pct = j?.pct > 0 && j.pct < 1 ? ` ${Math.round(j.pct * 100)}%` : '';
  const text = mode === 'offline' ? 'Offline' : mode === 'current' ? 'Up to date' : mode === 'idle' ? `${n} update${n === 1 ? '' : 's'}`
    : mode === 'ok' ? flash
    : (S.dlPaused ? 'Paused · ' : '') + (j ? `${j.label.replace(/^Updating /, '')}${pct}` : `${next} up next`) + (j && next ? ` · ${next} up next` : '');
  pill.querySelector('.txt').textContent = text;
  pill.querySelector('.ico').textContent = mode === 'ok' || mode === 'current' ? '✓' : S.dlPaused && mode === 'busy' ? '❚❚' : '';
  pill.querySelector('.bar').style.width = mode === 'busy' && pct ? `${Math.round(j.pct * 100)}%` : '0';
}
let videoTimer = null, saveTimer = null;
// The selected cover sits in the middle of the screen; the row slides under it. Positions are worked
// out from the covers' final sizes, so the slide doesn't wobble while the old and new selection resize.
function centerRow(instant = false) {
  const row = $('#row'), items = [...row.children];
  if (!items.length) return;
  const cs = getComputedStyle(row), rowH = parseFloat(cs.height), gap = parseFloat(cs.columnGap) || 0;
  let x = 0;
  items.forEach((it, k) => {
    const w = (k === S.sel ? 1 : .78) * rowH * (parseFloat(it.style.getPropertyValue('--ar')) || .7);
    if (k < S.sel) x += w + gap; else if (k === S.sel) x += w / 2;
  });
  row.style.transition = instant ? 'none' : '';
  row.style.transform = `translateX(${innerWidth / 2 - row.offsetLeft - x}px)`;
}
let recenterTimer = null;
const recenterSoon = () => { clearTimeout(recenterTimer); recenterTimer = setTimeout(() => centerRow(), 60); };
function select(i, instant = false) {
  if (!S.list.length) { showGame(null); return; }
  const prev = S.sel;
  S.sel = Math.max(0, Math.min(S.list.length - 1, i));
  if (tilesView()) {
    const ts = $('#tiles').children;
    ts[prev]?.classList.remove('sel'); ts[S.sel]?.classList.add('sel');
    ts[S.sel]?.scrollIntoView({ block: 'nearest', behavior: instant ? 'instant' : 'smooth' });
  } else if (listView()) {
    const rows = $('#gameList').children;
    rows[prev]?.classList.remove('sel'); rows[S.sel]?.classList.add('sel');
    rows[S.sel]?.scrollIntoView({ block: 'nearest', behavior: instant ? 'instant' : 'smooth' });
  } else {
    const items = [...$('#row').children];
    items.forEach((it, k) => it.classList.toggle('sel', k === S.sel));
    if (items[S.sel]) centerRow(instant);
  }
  if (!instant && prev !== S.sel) UISound.play('move');
  showGame(S.list[S.sel]);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveLibraryUi({ perSystem: { ...(S.uiState?.perSystem || {}), [S.tab]: S.list[S.sel]?.id } }).then(() => {
    S.uiState = { ...(S.uiState || {}), perSystem: { ...(S.uiState?.perSystem || {}), [S.tab]: S.list[S.sel]?.id } };
  }).catch(() => {}), 600);
}

// ---------- big picture ----------
let heroFlip = false, heroUrl = '';
function setHero(g) {
  // The calm background: the console's colour, Harbour teal on All and Favourites.
  $('#heroCalm').style.setProperty('--sysc', g && !mixedTab(S.tab) ? sysOf(g.system).color || '#5fd6cc' : '#5fd6cc');
  const ti = Math.max(0, S.tabs.findIndex(t => t.id === S.tab)), tn = S.tabs.length;  // across the tabs: 30% to 70%
  $('#heroCalm').style.setProperty('--cx', `${tn > 1 ? 30 + 40 * ti / (tn - 1) : 50}%`);
  // No background art: the calm background shows instead. (Tile view shows it dimmed behind the grid.)
  const big = bgArt(g);
  const url = pic(big || '');
  if (url === heroUrl) return;
  heroUrl = url;
  heroFlip = !heroFlip;
  const on = heroFlip ? $('#heroA') : $('#heroB'), off = heroFlip ? $('#heroB') : $('#heroA');
  on.style.backgroundImage = url ? `url("${url}")` : 'none';
  on.classList.toggle('soft', !big);
  // Nothing to show (art switched off, or none): neither layer shows, so no empty frame in list and tile views.
  on.classList.toggle('on', !!url); off.classList.remove('on');
}
function stopVideo() {
  clearTimeout(videoTimer);
  const v = $('#heroVideo'); v.classList.remove('on'); v.pause();
  if (v.getAttribute('src')) { v.removeAttribute('src'); v.load(); } // frees the decoder
}
// Game videos can be switched off (Settings): then only the cover art shows, and no clips are downloaded.
const videosOn = () => S.config?.harbourVideos !== false;
// The pictures shown for a game: none where that kind is switched off (Settings → Media, or for the game).
const boxArt = g => g && S.config?.harbourBoxArt !== false && !g.noBox ? g.media?.frontHQ || g.media?.front : null;
const bgArt = g => g && S.config?.harbourBackgrounds !== false && !g.noBackground ? g.media?.fanart || g.media?.screenshot : null;
function startVideoSoon(g) {
  stopVideo();
  if (!videosOn()) return;
  // While clips are being fetched for a game, its old clip isn't played (it's about to be replaced).
  if (!g?.media?.video || g.noVideo || S.running || !S.focused || S.videoJob === 'library' || S.videoJob === g.id) return;
  videoTimer = setTimeout(() => {
    const v = $('#heroVideo');
    v.src = `${g.media.video}?v=${S.videoBust || 0}`; v.muted = !S.config.harbourVideoSound; // ?v= so a rerolled clip isn't served from cache
    v.volume = (S.config.harbourVideoVolume ?? 50) / 100;
    v.play().then(() => v.classList.add('on')).catch(() => {});
  }, 1600);
}
function showGame(g) {
  setHero(g);
  startVideoSoon(g);
  $('#gActions').style.visibility = g ? '' : 'hidden';
  if (!g) { $('#gTitle').textContent = ''; $('#gLogo').hidden = true; $('#gMeta').replaceChildren(); $('#gDesc').textContent = ''; return; }
  const logo = $('#gLogo');
  if (g.media?.logo) { logo.src = pic(g.media.logo); logo.alt = g.title; logo.hidden = false; $('#gTitle').textContent = ''; }
  else { logo.hidden = true; logo.removeAttribute('src'); $('#gTitle').textContent = g.title; }
  const meta = $('#gMeta'); meta.replaceChildren(el('span', 'sys', sysOf(g.system).name));
  const st = S.recomp[g.id];
  for (const x of [g.info?.year, g.info?.developer, g.info?.genre, playTime(g),
    st?.installed?.tag && `Installed ${st.installed.tag}`]) if (x) meta.append(el('span', '', x));
  if (st?.updateAvailable) meta.append(el('span', 'upd', `${st.latest.tag} available`));
  // Cloud saves: where this game's saves are at, like Steam's (synced, syncing, not synced yet…)
  const sync = syncState(g);
  if (sync) { const t = SYNC_TEXT[sync.state]; const s = el('span', `sv-on sv-${sync.state}`, t[0]); s.title = t[1] + (sync.state === 'synced' && sync.at ? ` Last synced ${ago(sync.at)}.` : ''); meta.append(s); }
  else if (savesSync(g)) meta.append(el('span', 'sv-on', '☁ Saves sync'));
  // Games that run through an emulator say which one, coloured by how it's doing.
  const emu = emuInfo(g);
  if (emu) meta.append(emuBadge(emu, 'emu-chip', emu.text));
  $('#gDesc').textContent = g.info?.description || '';
  // No emulator for this console yet: the Play button installs one instead.
  const offer = emuOffer(g), playBtn = $('#btnPlay');
  if (!S.installingFor) playBtn.replaceChildren(...(offer ? [`Install ${offer.name}`] : [el('span', 'tri'), 'Play']));
  renderHints();
  // A PC port of this game exists (the catalogue, same game and console): say so, next to Play. Otherwise nothing.
  // It says how well the best of them runs, so "Experimental" tells you not to bother yet.
  const ports = portsFor(g), best = ports.map(x => x.status).sort((a, b) => (TIER[a] ?? 3) - (TIER[b] ?? 3))[0];
  // Next to the button: small, in brackets, in the catalogue's colour for it.
  $('#btnPort').hidden = $('#portTier').hidden = !ports.length;
  if (ports.length) { $('#portTier').className = `tier ${best}`; $('#portTier').textContent = `(${STATUS[best] || best})`; if (ports.some(x => x.harbour)) { $('#portTier').classList.add('harbour'); $('#portTier').prepend(harbourMark()); } }
  const up = $('#btnUpdate');
  up.hidden = !st?.updateAvailable; up.className = 'new';
  up.textContent = st?.updateAvailable ? (st.auto || st.launcher ? `⬆ Update to ${st.latest.tag}` : `${st.latest.tag}: update in app`) : '';
}
function playTime(g) {
  if (!g.playMs) return '';
  const h = g.playMs / 3600000;
  return h >= 1 ? `${h.toFixed(h < 10 ? 1 : 0)} h played` : `${Math.max(1, Math.round(g.playMs / 60000))} min played`;
}

// ---------- actions ----------
async function play(g = S.list[S.sel]) {
  if (!g || S.running) return;
  // No emulator for this console yet: the button says Install, and installs it.
  if (emuOffer(g)) {
    const btn = $('#btnPlay');
    S.installingFor = true; btn.disabled = true; btn.replaceChildren('Installing…');
    try { await installFor([g.system]); } finally { S.installingFor = false; btn.disabled = false; showGame(S.list[S.sel]); }
    return;
  }
  UISound.play('launch');
  try { await api.launch(g.id); toast(`Starting ${g.title}…`, 2500); }
  catch (e) { UISound.play('error'); toast(e.message, 6000); }
}
function update(g = S.list[S.sel]) {
  const st = g && S.recomp[g.id];
  if (!st?.updateAvailable) return;
  if (!st.auto && st.launcher) { runLauncher(g); return; }
  if (!st.auto) { api.recompOpenPage(g.id).then(() => toast('Update in app.', 4000)).catch(e => toast(e.message)); return; }
  updateOne({ kind: 'game', id: g.id, name: g.title, to: st.latest.tag });
}
// A port updated through its own launcher (DKB-Launcher and the like): OneDeck gets it ready and opens it, and checks
// the version again when it closes.
function runLauncher(g) {
  UISound.play('select');
  Activity.set('launcher-' + g.id, `Opening ${g.title}'s updater…`);
  api.runPortLauncher(g.id).then(() => Activity.done('launcher-' + g.id, `${g.title} is updating in its own window`))
    .catch(e => { UISound.play('error'); Activity.fail('launcher-' + g.id, e.message); });
}
api.onRecheck(async id => { const r = await api.recompCheck?.(id, true).catch(() => null); if (r) { S.recomp[id] = r; afterUpdates(); } else checkUpdates(true); });
async function checkUpdates(force = false) {
  if (force) Activity.set('check', 'Checking for updates…');
  let results;
  try { results = await api.recompCheckAll(force); Object.assign(S.recomp, results); }
  catch (e) { S.netDown = NET_ERROR.test(e.message); showUpdatePill(); if (force) Activity.fail('check', `Update check failed: ${e.message}`); return; }
  S.self = await api.selfStatus(force).catch(() => S.self);  // Harbour itself (only in a release)
  if (force) await loadEmulators(true);
  // Offline: the checks couldn't reach anything (the network is there but the internet isn't).
  // Only checks that went to the network count (one with no update source never asks anything).
  const answers = [...Object.values(results || {}), ...Object.values(S.emuStatus || {})].filter(a => a && (a.error || a.latest));
  S.netDown = answers.length > 0 && answers.every(a => NET_ERROR.test(a.error || ''));
  S.updatesChecked = true;
  refreshBadges(); showGame(S.list[S.sel]);
  autoInstall();
  if (force) {
    // Harbour's own state always comes first, so it's never lost among game and emulator updates.
    const others = pendingUpdates().filter(u => u.kind !== 'harbour').length;
    const msg = (S.self?.updateAvailable ? `OneDeck ${S.self.latest?.tag || ''} is out` : 'OneDeck is up to date')
      + (others ? ` · ${others} other update${others === 1 ? '' : 's'}` : ' · so is everything else');
    Activity.done('check', msg); toast(msg, 5000);
  }
}

// ---------- ••• menu ----------
function openMenu(anchor) {
  const g = S.list[S.sel]; if (!g) return;
  const m = $('#menu'); m.replaceChildren();
  const add = (label, fn) => { const b = el('button', '', label); b.onclick = () => { closeMenu(); fn(); }; m.append(b); };
  add(g.favorite ? '★ Remove from Favourites' : '☆ Add to Favourites', async () => { await api.setFavorite({ gameId: g.id, favorite: !g.favorite }); g.favorite = !g.favorite; buildTabs(); setTab(S.tab, true); });
  if (g.recomp) {
    add('Platform & updates…', () => openRecompDialog(g));
    add('Check for update', async () => { S.recomp[g.id] = await api.recompCheck(g.id, true).catch(e => ({ error: e.message })); refreshBadges(); showGame(g); const s = S.recomp[g.id]; toast(s.error || (s.updateAvailable ? `${s.latest.tag} is out.` : s.updateAvailable === false ? 'Up to date.' : `Newest is ${s.latest?.tag || '?'}. Set your version in Platform & updates.`)); });
    if (S.recomp[g.id]?.repo) add('Open release page', () => api.recompOpenPage(g.id).catch(e => toast(e.message)));
    add(api.platform === 'linux' ? 'Choose game program…' : 'Choose game .exe…', () => api.chooseGameExecutable(g.id).then(r => r && toast('Saved.')).catch(e => toast(e.message)));
  }
  if (!g.recomp) add('Install PC port…', () => portsForGame(g));
  add('Rename…', () => openRename(g));
  add('Sync saves…', () => openSaves({ addFor: g }));
  add('Open game folder', () => api.openGameFolder(g.id).catch(e => toast(e.message)));
  // 🎲: background art = the next of the database's backgrounds (the big picture behind the game); box art = the
  // next cover; clip = another part of the same video; video = a different video.
  if (bgArt(g) || (S.config.harbourBackgrounds !== false && !g.noBackground)) add('🎲 Change background art', () => downloadArt('game', g.id, [g.media?.fanart || !g.media?.screenshot ? 'fanart' : 'screenshot']));
  if (S.config.harbourBoxArt !== false && !g.noBox) add('🎲 Change box art', () => downloadArt('game', g.id, ['front']));
  if (videosOn() && g.noVideo) add('Videos back on for this game', () => setGameVideo(g, true));
  else if (videosOn() && g.media?.video) {
    add('🎲 Different clip', () => downloadVideos('game', g.id, 'reroll'));
    add('🎲 Change video', () => downloadVideos('game', g.id, 'new'));
    add('No video for this game', () => setGameVideo(g, false));
  } else if (videosOn()) add('Get a video for this game', () => downloadVideos('game', g.id, 'missing'));
  // Undock: off the shelves, everything kept (Settings → Undocked games redocks it). A port Harbour installed itself
  // can also be deleted, folder and all.
  add('Undock from OneDeck', async () => { await api.setHidden({ gameId: g.id, hidden: true }); g.hidden = true; buildTabs(); setTab(S.tab); afterUpdates(); toast(`${g.title} undocked. Settings can redock it.`, 4000); });
  if (g.deletable) add('Undock and delete', async () => {
    if (!confirm(`Delete ${g.title}? Only what was installed goes: your saves and mods stay in its folder, ready if you install it again.`)) return;
    try { const r = await api.gameDelete(g.id); await reload(); afterUpdates(); toast(`${g.title} deleted.` + (r?.kept ? ' Your saves stayed.' : ''), 5000); } catch (e) { UISound.play('error'); toast(e.message, 6000); }
  });
  const r = anchor.getBoundingClientRect();
  m.hidden = false; S.menuOpen = true; renderHints();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 16) + 'px';
  m.style.top = Math.max(16, r.top - m.offsetHeight - 10) + 'px';
  menuFocus(0);
}
function closeMenu() { $('#menu').hidden = true; S.menuOpen = false; renderHints(); }
function menuFocus(i) { const bs = [...$('#menu').children]; bs.forEach((b, k) => b.classList.toggle('focus', k === i)); S.menuIdx = i; }
document.addEventListener('pointerdown', e => { if (S.menuOpen && !e.target.closest('#menu') && !e.target.closest('#btnMore')) closeMenu(); });

// ---------- recomp dialog ----------
let editing = null;
async function openRecompDialog(g) {
  const cur = await api.recompGet(g.id).catch(e => { toast(e.message); return null; }); if (!cur) return;
  editing = g; const f = $('#rdForm');
  f.platform.replaceChildren(...[{ id: '', name: 'Recomp shelf' }, ...consoles()].map(s => { const o = el('option', '', s.name); o.value = s.id; return o; }));
  f.platform.value = cur.platform || ''; f.repo.value = cur.source?.repo || ''; f.prerelease.checked = !!cur.source?.prerelease;
  f.auto.checked = !cur.source || cur.source.auto !== false; f.asset.value = cur.source?.asset || ''; f.installedTag.value = cur.installed?.tag || '';
  $('#rdGame').textContent = g.title; const st = S.recomp[g.id];
  $('#rdStatus').textContent = st?.latest ? `Newest release: ${st.latest.tag}` : '';
  $('#recompDlg').showModal();
}
$('#rdCancel').onclick = () => $('#recompDlg').close();
$('#rdForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = $('#rdForm'), g = editing;
  try { await api.recompSet({ gameId: g.id, platform: f.platform.value, repo: f.repo.value, prerelease: f.prerelease.checked, auto: f.auto.checked, asset: f.asset.value, installedTag: f.installedTag.value }); }
  catch (err) { $('#rdStatus').textContent = err.message; return; }
  $('#recompDlg').close();
  await reload(); const again = S.games.find(x => x.added === g.added);
  if (again) { S.recomp[again.id] = await api.recompCheck(again.id, true).catch(() => S.recomp[again.id]); setTab(again.system); select(S.list.findIndex(x => x.id === again.id)); }
  toast('Saved.');
});

// ---------- add a game / emulator ----------
const consoles = () => S.config.systems.filter(s => s.id !== 'recomp' && s.id !== 'pc' && !s.hidden).sort(byRelease);
const option = (value, text) => { const o = el('option', '', text); o.value = value; return o; };
async function emulatorsFor(sysId) {
  const list = await api.emuList().catch(() => []);
  // Emulators set up for this console first, then any other one you have.
  const fits = e => (e.systems || []).includes(sysId);
  return [...list.filter(e => fits(e) && (e.exe || e.custom)), ...list.filter(e => !fits(e) && e.exe)];
}
function showAddStep(step) {
  for (const id of ['addPick', 'addRoms', 'addCatalog', 'addGit', 'addPort', 'addEmuPick', 'addEmu']) $('#' + id).hidden = id !== step;
  $('#' + step).querySelector('select, input, button')?.focus();
}
async function openAdd() {
  UISound.play('open');
  $('#addPort').platform.replaceChildren(option('', 'No console (Ports tab only)'), ...consoles().map(s => option(s.id, s.name)));
  $('#romsConsole').replaceChildren(...consoles().map(s => option(s.id, s.name)));
  if (consoles().some(s => s.id === S.tab)) $('#romsConsole').value = S.tab;  // the console you're looking at
  $('#emuSystems').replaceChildren(...consoles().map(s => { const l = el('label', 'check'); const c = el('input'); c.type = 'checkbox'; c.value = s.id; l.append(c, s.name); return l; }));
  for (const f of [$('#addGit'), $('#addPort'), $('#addEmu')]) f.querySelectorAll('input[type=text], input:not([type])').forEach(i => { if (i.name !== 'args') i.value = ''; });
  S.gitRom = null; S.gitPick = null; S.portGame = null; $('#gitRomName').textContent = "The ROM or disc it's made from";
  $('#gitTitle').textContent = 'Add a PC port / recomp'; $('#gitNeeds').hidden = true; $('#catSearch').value = '';
  showAddStep('addPick');
  $('#addDlg').showModal();
}
// PC port: pick its folder; Harbour finds the program, its GitHub project and version, its name and console.
async function pickPort() {
  $('#addDlg').close();
  let found;
  try {
    Activity.set('addport', 'Looking up the game…');
    found = await api.pickPort();
    if (!found) { Activity.end('addport', 'Cancelled', 'ok', '', 1); return; }
    Activity.done('addport', 'Found it');
  } catch (e) { UISound.play('error'); Activity.fail('addport', e.message); return; }
  S.portFound = found;
  const f = $('#addPort');
  f.title.value = found.title || '';
  f.platform.value = found.platform || '';
  f.repo.value = found.repo || '';
  showPortFound();
  showAddStep('addPort');
  $('#addDlg').showModal();
  f.title.focus();  // not Change, the first thing in the card
}
// What Harbour picked to start the game, and its setup if it has one: shown so a wrong guess is easy to fix.
const fileName = p => String(p || '').split(/[\\/]/).pop();
function showPortFound() {
  const found = S.portFound;
  const change = el('button', 'link', 'Change'); change.type = 'button';
  change.onclick = async () => {
    const exe = await api.pickPortExe(found.folder);
    if (!exe) return;
    found.executable = exe; found.exeName = fileName(exe);
    if (found.setup === exe) found.setup = null;
    UISound.play('select'); showPortFound();
  };
  const line = el('span', '', 'Starts with '); line.append(el('b', '', found.exeName), ' ', change);
  const parts = [line];
  if (found.setup) parts.push(el('span', '', `First-time setup: ${fileName(found.setup)}`));
  if (found.repo) parts.push(el('span', '', found.installed ? `You have ${found.installed.tag}` : 'Version unknown'));
  $('#portFound').replaceChildren(...parts.flatMap((p, i) => i ? [el('br'), p] : [p]));
}
$('#btnAdd').onclick = openAdd;
for (const b of document.querySelectorAll('#addDlg .choice')) b.onclick = () => { UISound.play('select'); if (b.dataset.kind === 'roms') showAddStep('addRoms'); else if (b.dataset.kind === 'port') showPortCatalog(); else showEmuCatalog(); };
$('#romsRoot').onclick = () => { S.pickingFolder = true; $('#addDlg').close(); addGameFolder('').finally(() => { S.pickingFolder = false; backToWelcome(); }); };
$('#romsOne').onclick = () => { const id = $('#romsConsole').value; S.pickingFolder = true; $('#addDlg').close(); addGameFolder(id).finally(() => { S.pickingFolder = false; backToWelcome(); }); };
// The catalogue: search, pick one, and the install form fills in (with what that port needs from you).
// Ports of an emulator game in the catalogue: the same console, and the same name once punctuation, "the" and
// "and"/"&" are set aside ("Legend of Zelda, The - Ocarina of Time" = "The Legend of Zelda: Ocarina of Time").
const nameKey = s => looseText(String(s || '').replace(/&/g, ' and ')).replace(/\b(the|and)\b/g, '').replace(/ /g, '');
function portsFor(g) {
  if (!g || g.recomp || !S.portList) return [];
  const key = nameKey(g.title);
  return S.portList.filter(x => x.released && !x.installed && x.platform === g.system && nameKey(x.name) === key);
}
// "Install PC port": the catalogue searched to this game on its console, with your copy of it ready as the game file.
async function portsForGame(g) {
  S.portGame = g;
  await openAdd();
  S.portGame = g;  // (openAdd clears what was picked before)
  showPortCatalog({ q: g.title, console: g.system });
}
$('#btnPort').onclick = () => { const g = S.list[S.sel]; if (g) { UISound.play('select'); portsForGame(g); } };
async function showPortCatalog(prefill = null) {
  showAddStep('addCatalog');
  $('#portCatalog').replaceChildren(el('p', 'note', 'Loading the catalogue…'));
  try { S.portList = await api.portCatalog(); } catch (e) { $('#portCatalog').replaceChildren(el('p', 'note', `Couldn't load the catalogue: ${e.message}`)); return; }
  // Consoles to filter by, the busiest first.
  const counts = {};
  for (const x of S.portList) counts[x.consoleName] = (counts[x.consoleName] || 0) + 1;
  $('#catConsole').replaceChildren(option('', `All consoles (${S.portList.length})`), ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => option(n, `${n} (${c})`)));
  if (prefill) {
    $('#catSearch').value = prefill.q;
    const name = S.portList.find(x => x.platform === prefill.console)?.consoleName;
    if (name) $('#catConsole').value = name;
  }
  renderPortCatalog();
  (prefill ? $('#portCatalog button:not([disabled])') : $('#catSearch'))?.focus();
}
// Recompendium's ratings, then Harbour's own tiers (anydock.json in each port's repository)
const STATUS = { fully: 'Fully playable', playable: 'Playable', experimental: 'Experimental', complete: 'Complete', beta: 'Beta', alpha: 'Alpha' };
// Harbour's own ports: its mark, in white.
function harbourMark() {
  const m = el('img', 'hb-mark'); m.src = 'assets/brand/onedeck-mark.svg'; m.alt = ''; m.title = "OneDeck's own port"; return m;
}
const TIER = { fully: 0, complete: 0, playable: 1, beta: 1, experimental: 2, alpha: 2 };
function renderPortCatalog() {
  const q = looseText($('#catSearch').value), only = $('#catConsole').value;
  const owned = new Set(S.games.map(g => g.system));
  // The whole catalogue. Games for consoles you play first, then ones with a download, then the most popular.
  // Every word of the search must appear ("ratchet clank" finds "Ratchet & Clank").
  const words = q.split(' ').filter(w => w && w !== 'and' && w !== 'the');
  const list = (S.portList || []).filter(x => (!only || x.consoleName === only) && (!words.length || (t => words.every(w => t.includes(w)))(looseText(`${x.name} ${x.project} ${x.repo} ${x.consoleName}`))))
    .sort((a, b) => Number(owned.has(b.platform)) - Number(owned.has(a.platform)) || Number(b.released) - Number(a.released) || (TIER[a.status] ?? 3) - (TIER[b.status] ?? 3) || b.stars - a.stars);
  $('#portCatalog').replaceChildren(...(list.length ? list.map(x => {
    const card = el('div', 'emu-cat'), info = el('div', 'emu-cat-info');
    // Console · which port it is (two ports of one game look alike otherwise); how well it runs sits on the right.
    // (a project named after the game, "Ocarina of Time (N64)", shows its own short name instead)
    info.append(el('b', '', x.name), el('small', '', `${x.consoleName} · ${x.project.includes(x.name) ? x.repo.split('/')[1] : x.project}`));
    const tier = el('span', `tier ${x.status}${x.harbour ? ' harbour' : ''}`, STATUS[x.status] || x.status);
    if (x.harbour) tier.prepend(harbourMark());  // Harbour's own: its mark over the rating
    // No release to download yet: its page instead (source code only, or still being made).
    const btn = el('button', x.installed || !x.released ? '' : 'primary', x.installed ? 'Installed' : x.released ? 'Install' : 'Page'); btn.type = 'button';
    btn.disabled = x.installed; btn.title = x.released ? '' : 'No download yet: opens its GitHub page';
    btn.onclick = () => x.released ? pickFromCatalog(x) : window.open(`https://github.com/${x.repo}`);
    card.append(info, tier, btn); return card;
  }) : [el('p', 'note', 'Nothing found. Paste its GitHub page instead.')]));
}
const looseText = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
$('#catSearch').oninput = () => renderPortCatalog();
$('#catConsole').onchange = () => renderPortCatalog();
function pickFromCatalog(x) {
  UISound.play('select');
  S.gitPick = x; S.gitRom = null;
  const f = $('#addGit'); f.repo.value = `https://github.com/${x.repo}`;
  $('#gitTitle').textContent = x.name;
  $('#gitNeeds').textContent = x.needs ? `Needs: ${x.needs}` : ''; $('#gitNeeds').hidden = !x.needs;
  $('#gitRomName').textContent = "The ROM or disc it's made from";
  // Came from a game on your shelf: your copy of it is the game file.
  // (only for a port of that same game: searching for another one from there doesn't hand it this game's file)
  const own = S.portGame && S.portGame.system === x.platform && nameKey(S.portGame.title) === nameKey(x.name) ? S.portGame.romPath : null;
  if (own) { S.gitRom = own; $('#gitRomName').textContent = own.split(/[\\/]/).pop(); }
  showAddStep('addGit'); (own ? $('#addGit button.primary') : $('#gitRom')).focus();
}
$('#catLink').onclick = () => { UISound.play('select'); S.gitPick = null; $('#gitTitle').textContent = 'Add a PC port / recomp'; $('#gitNeeds').hidden = true; showAddStep('addGit'); };
$('#catFolder').onclick = () => { UISound.play('select'); pickPort(); };
// PC port from its GitHub page: Harbour installs it (in the download queue) with your game file next to it.
$('#gitRom').onclick = async () => {
  const file = await api.pickGameFile().catch(e => { toast(e.message); return null; });
  if (file) { S.gitRom = file; $('#gitRomName').textContent = file.split(/[\\/]/).pop(); }
};
$('#gitFolder').onclick = () => { UISound.play('select'); pickPort(); };
$('#addGit').addEventListener('submit', e => {
  e.preventDefault();
  const repo = e.target.repo.value.trim();
  if (!repo) { UISound.play('error'); toast('Paste its GitHub page first.'); return; }
  $('#addDlg').close(); UISound.play('select');
  // Chosen from the catalogue (and the link left as it was): its name and console come with it.
  const pick = S.gitPick && repo.toLowerCase().endsWith(S.gitPick.repo.toLowerCase()) ? S.gitPick : null;
  installPort(repo, S.gitRom, pick);
});
// A game whose saves sync with cloud saves: on its own, or through its emulator's Saves folder.
const savesSync = g => !!(S.config?.cloudSaves && (S.config?.savesFor?.[g.id] || (emulated(g) && S.config?.savesConsoles?.includes(g.system))));
// Installing a PC port of a game you already have saves for: one you've played in an emulator, or whose saves sync.
// Each port decides where it keeps its saves, so your progress won't carry over (or sync) by itself. Says so first;
// true to go ahead.
function portSavesOk(rom, pick) {
  const same = g => !g.recomp && ((rom && g.romPath === rom) || (pick && g.system === pick.platform && nameKey(g.title) === nameKey(pick.name)));
  const played = g => emulated(g) && (g.playMs > 0 || g.plays > 0);
  const g = S.games.find(g => same(g) && (played(g) || savesSync(g)));
  if (!g) return Promise.resolve(true);
  $('#psText').textContent = `${played(g) ? `You've played ${g.title} in an emulator, so you probably have saves for it.` : `${g.title} has saves.`} `
    + `Every PC port picks its own place for saves, so your progress won't carry over to it by itself. Once it's installed, check where it saves: some can bring in your old save.`
    + (savesSync(g) ? ' To sync its saves to your other devices too, use ••• → Sync saves on the port.' : '');
  const dlg = $('#portSavesDlg');
  return new Promise(done => {
    const end = ok => { $('#psOk').onclick = $('#psCancel').onclick = dlg.oncancel = null; dlg.close(); UISound.play(ok ? 'select' : 'back'); done(ok); };
    $('#psOk').onclick = () => end(true); $('#psCancel').onclick = () => end(false); dlg.oncancel = e => { e.preventDefault(); end(false); };
    dlg.showModal(); $('#psOk').focus();
  });
}
async function installPort(repo, rom, pick = null) {
  if (!(await portSavesOk(rom, pick))) return;
  const name = pick?.name || repo.replace(/^https?:[/][/](www[.])?github[.]com[/]/i, '').split('/')[1] || repo;
  return enqueue('port:' + repo.toLowerCase().split('/').slice(-2).join('/'), `Installing ${name}`, async () => {
    const entry = await api.installPort({ repo, rom, title: pick?.name, platform: pick?.platform });
    await afterAdd(g => g.added === entry.id, entry.title);
    // which program it starts, so a wrong pick is noticed (••• → Choose game .exe… changes it)
    if (entry.viaLauncher) { toast(`${entry.title}: press Play to build it from your copy with its own launcher. It keeps it up to date too.`, 8000); return { done: `${entry.title} installed` }; }
    toast(`${entry.title} starts with ${fileName(entry.executable)}${entry.setup ? `, after its setup ${fileName(entry.setup)}` : ''}. Wrong one? ••• → ${api.platform === 'linux' ? 'Choose game program…' : 'Choose game .exe…'}`, 7000);
    return { done: `${entry.title} installed` };
  });
}
// Back: to the Add menu, or out to the welcome screen when that's where you came from.
for (const b of document.querySelectorAll('#addDlg .addBack')) b.onclick = () => { UISound.play('back'); if (S.welcoming && ['addRoms', 'addCatalog', 'addEmuPick'].some(id => !$('#' + id).hidden)) $('#addDlg').close(); else showAddStep('addPick'); };
for (const b of document.querySelectorAll('#addDlg .addCancel')) b.onclick = () => { UISound.play('back'); $('#addDlg').close(); };
// After adding: show it, then fetch its artwork and a gameplay clip without being asked.
async function afterAdd(match, what) {
  $('#addDlg').close();
  await reload();
  const g = S.games.find(match);
  if (!g) { toast(`${what} added.`); return; }
  setTab(g.system); select(S.list.findIndex(x => x.id === g.id));
  UISound.play('select');
  toast(`Added ${g.title}.`, 4000);
  if (autoMediaOn()) { downloadArt('game', g.id); downloadVideos('game', g.id, 'missing'); }
}
$('#addPort').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, found = S.portFound;
  if (!found) return;
  try {
    // A changed GitHub link means the version Harbour matched no longer applies.
    const sameRepo = f.repo.value.trim() === (found.repo || '');
    const entry = await api.addPort({ folder: found.folder, executable: found.executable, setup: found.setup, platform: f.platform.value, title: f.title.value,
      repo: f.repo.value, prerelease: sameRepo && found.prerelease, installed: sameRepo ? found.installed : null });
    if (entry) afterAdd(g => g.added === entry.id, entry.title);
  } catch (err) { UISound.play('error'); toast(err.message, 6000); }
});
$('#addEmu').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  const systems = [...document.querySelectorAll('#emuSystems input:checked')].map(c => c.value);
  try {
    const r = await api.addEmulator({ name: f.name.value, systems, args: f.args.value, makeDefault: f.makeDefault.checked });
    if (!r) return;
    S.config = await api.getConfig();
    $('#addDlg').close(); UISound.play('select');
    toast(`${r.name} added.`, 4000);
  } catch (err) { UISound.play('error'); toast(err.message, 6000); }
});

// Every emulator in a folder you pick, added at once.
$('#emuScan').onclick = async () => {
  try {
    const r = await api.scanEmulators();
    if (!r) return;
    S.config = await api.getConfig(); await loadEmulators(true);
    renderRow(); select(S.sel, true); showEmuCatalog();
    if (r.added.length) { UISound.play('select'); toast(`Added ${r.added.join(', ')}.`, 6000); }
    else toast(r.skipped.length ? `Found ${r.skipped.join(', ')}, already added.` : 'No emulators found in that folder.', 6000);
  } catch (err) { UISound.play('error'); toast(err.message, 6000); }
};

// ---------- emulators: see, change, remove ----------
const sysName = id => shortName(S.config.systems.find(s => s.id === id)?.name || id);
async function openEmulators() {
  UISound.play('open');
  await renderEmulators();
  if (!$('#emusDlg').open) $('#emusDlg').showModal();
}
async function renderEmulators() {
  S.config = await api.getConfig();
  const all = await api.emuList().catch(() => []);
  S.emus = all;
  const mine = all;
  // Consoles worth listing: ones with games, or ones an emulator is set up for.
  const counts = {}; for (const g of S.games) counts[g.system] = (counts[g.system] || 0) + 1;
  const pending = installsPending();
  const listed = consoles().filter(s => counts[s.id] || mine.some(e => (e.systems || []).includes(s.id)) || pending.some(c => c.consoles.includes(s.id)));
  const catalog = await api.emulatorCatalog().catch(() => []);
  const rows = listed.map(s => {
    const row = el('div', 'emu-console');
    const label = el('span', '', s.name); if (counts[s.id]) label.append(el('small', '', ` · ${counts[s.id]} game${counts[s.id] === 1 ? '' : 's'}`));
    const pick = el('select');
    // Only emulators that play this console (plus the current choice, so it never silently disappears).
    const fits = mine.filter(e => (e.systems || []).includes(s.id) || e.id === s.emulator);
    pick.append(option('', s.direct ? 'Runs by itself' : 'None'), ...fits.map(e => option(e.id, e.name)));
    pick.value = fits.some(e => e.id === s.emulator) ? s.emulator : '';
    pick.onchange = async () => {
      try { await api.setSystemEmulator({ system: s.id, emulator: pick.value }); UISound.play('select'); toast(`${shortName(s.name)} games now start with ${pick.selectedOptions[0].textContent}.`); }
      catch (e) { UISound.play('error'); toast(e.message); }
    };
    row.append(label, pick);
    // Games that need an emulator but none is set: offer the well-known one for this console.
    const needOne = S.games.some(g => g.system === s.id && !g.recomp);
    const busy = !pick.value && pending.find(c => c.consoles.includes(s.id));
    const offer = !busy && needOne && !pick.value && catalog.find(c => c.consoles.includes(s.id) && !c.installed);
    if (busy) {
      // Being installed (or waiting its turn): it leaves the list again if the install fails and there are no games.
      const b = el('button'); b.type = 'button';
      spinnerButton(b, installState(busy.id) === 'installing' ? `Installing ${busy.name}` : `${busy.name}: queued`, installState(busy.id) === 'installing' ? Q.cur?.pct : 0);
      row.append(b);
    }
    if (offer) {
      // Say why the button is there: these games can't start until it's installed.
      label.querySelector('small')?.remove();
      label.append(el('small', 'need', ` · ${counts[s.id]} game${counts[s.id] === 1 ? '' : 's'}, no emulator`));
      const b = el('button', 'primary', `Install ${offer.name}`); b.type = 'button';
      b.onclick = () => installEmulator(offer);
      row.append(b);
    }
    return row;
  });
  $('#emuConsoles').replaceChildren(...(rows.length ? rows : [el('p', 'note', 'No consoles yet.')]));
  const cards = mine.map(e => {
    const card = el('div', 'emu-card');
    const head = el('div', 'emu-head'); head.append(el('b', '', e.name), el('small', '', e.exe ? e.exe : 'Program not found: choose it again'));
    const chips = el('div', 'chips');
    const used = S.config.systems.filter(s => s.emulator === e.id).map(s => s.id);
    for (const id of e.systems || []) chips.append(el('span', 'chip' + (used.includes(id) ? ' on' : ''), sysName(id)));
    if (!(e.systems || []).length) chips.append(el('span', 'note', 'No consoles chosen'));
    // Updates: where they come from, the version you have, the newest one.
    const st = S.emuStatus?.[e.id] || {};
    const info = !e.exe ? { state: 'missing' } : st.updateAvailable ? { state: 'update' } : { state: 'ok' };
    const where = sourceText(st.source);
    const line = !where ? 'Updates: no source set, so OneDeck can\'t tell when there\'s a new version.'
      : `Updates from ${where} · you have ${st.installed || '?'} · newest ${st.latest?.tag || '?'}` + (st.error ? ' (couldn\'t check)' : '');
    const upd = el('div', 'emu-update'); upd.append(emuBadge(info, 'emu-chip', st.updateAvailable ? `${st.latest.tag} available` : !e.exe ? 'Program missing' : where && st.installed ? 'Up to date' : 'Version unknown'), el('small', '', line));
    const btns = el('div', 'emu-btns');
    const b = (text, fn, cls = '') => { const x = el('button', cls, text); x.type = 'button'; x.onclick = fn; btns.append(x); };
    if (e.custom) b('Consoles…', () => editEmuConsoles(e, card));
    if (st.updateAvailable && st.canInstall) b(`Update to ${st.latest.tag}`, () => updateOne({ kind: 'emu', id: e.id, name: e.name, to: st.latest.tag }).then(() => renderEmulators()), 'primary');
    b('Updates…', () => editEmuSource(e, st, card));
    if (where) b('Release page', () => api.openEmulatorPage(e.id).catch(err => toast(err.message)));
    b('Change program…', async () => { const r = await api.emuPickExe(e.id).catch(err => toast(err.message)); if (r) { toast(`${e.name} now uses ${r.exe.split(/[\\/]/).pop()}.`); renderEmulators(); } });
    if (e.exe) b('Open (settings)', () => api.emuOpen(e.id).catch(err => toast(err.message)));
    b('Open folder', () => api.emuOpenFolder(e.id).catch(err => toast(err.message)));
    if (e.custom) b('Remove', async () => {
      if (!confirm(`Remove ${e.name} from OneDeck? Its files stay where they are; consoles that used it will have no emulator.`)) return;
      try { await api.emuRemove(e.id); UISound.play('back'); toast(`${e.name} removed.`); renderEmulators(); } catch (err) { toast(err.message); }
    }, 'danger');
    card.append(head, chips, upd, btns); return card;
  });
  $('#emuCards').replaceChildren(...(cards.length ? cards : [el('p', 'note', 'No emulators yet.')]));
  renderGameFolders();
}
const sourceText = src => !src ? null : src.type === 'dolphin' ? 'dolphin-emu.org' : src.type === 'github' ? src.repo : `${src.host}/${src.repo}`;
// Where an emulator's updates come from, and which version you have.
function editEmuSource(e, st, card) {
  const form = el('div', 'emu-source');
  const src = el('input'); src.placeholder = 'owner/name on GitHub, or a link to the project page';
  src.value = sourceText(st.source) || '';
  const tag = el('input'); tag.placeholder = 'the version you have, e.g. v0.2.1'; tag.value = st.installed || '';
  const pre = el('input'); pre.type = 'checkbox'; pre.checked = !!st.source?.prerelease;
  const preLabel = el('label', 'check'); preLabel.append(pre, 'Include test versions');
  const save = el('button', 'primary', 'Save'); save.type = 'button';
  save.onclick = async () => {
    try { S.emuStatus[e.id] = await api.setEmulatorSource({ id: e.id, source: src.value, prerelease: pre.checked, installedTag: tag.value }); UISound.play('select'); renderEmulators(); }
    catch (err) { UISound.play('error'); toast(err.message, 6000); }
  };
  const l1 = el('label', '', 'Updates come from'), l2 = el('label', '', 'Version you have');
  l1.append(src); l2.append(tag);
  form.append(l1, l2, preLabel, save);
  card.querySelector('.emu-btns').replaceWith(form);
  src.focus();
}
// Game folders: one row per folder, with the console it feeds.
function renderGameFolders() {
  const rows = [];
  for (const s of S.config.systems) for (const dir of String(s.romDir || '').split('|').map(d => d.trim()).filter(Boolean)) {
    const row = el('div', 'folder-row');
    const x = el('button', 'danger', 'Remove'); x.type = 'button';
    x.onclick = async () => {
      try { await api.removeGameFolder({ system: s.id, folder: dir }); UISound.play('back'); await reload(); renderEmulators(); toast(`${sysName(s.id)} folder removed. Its games are no longer listed (the files are untouched).`, 6000); }
      catch (e) { toast(e.message); }
    };
    row.append(el('b', '', sysName(s.id)), el('span', '', dir), x);
    rows.push(row);
  }
  $('#gameFolders').replaceChildren(...(rows.length ? rows : [el('p', 'note', 'No game folders yet.')]));
  const pick = $('#folderConsole');
  if (!pick.options.length) pick.replaceChildren(...consoles().map(s => option(s.id, s.name)));
}
async function addGameFolder(system) {
  try {
    const r = await api.addGameFolder({ system });
    if (!r) return;
    if (!r.added.length) return toast('That folder is already there.');
    UISound.play('select');
    toast(`Added ${r.added.map(a => sysName(a.system)).join(', ')}. Finding games…`, 5000);
    S.config = await api.getConfig();
    await reload(); renderEmulators();
    // No emulator is installed unasked: a game whose console has none shows "Install emulator" instead of Play.
    const fresh = S.games.filter(g => r.added.some(a => a.system === g.system) && !g.media?.front && !g.recomp);
    // New games get their artwork, then a gameplay clip each, without being asked.
    if (fresh.length && autoMediaOn()) { downloadArt('library'); downloadVideos('library', '', 'missing'); }
  } catch (e) { UISound.play('error'); toast(e.message, 7000); }
}
$('#addGamesRoot').onclick = () => addGameFolder('');
$('#addConsoleFolder').onclick = () => addGameFolder($('#folderConsole').value);

function editEmuConsoles(e, card) {
  const box = el('div', 'sys-grid');
  for (const s of consoles()) { const l = el('label', 'check'); const c = el('input'); c.type = 'checkbox'; c.value = s.id; c.checked = (e.systems || []).includes(s.id); l.append(c, s.name); box.append(l); }
  const args = el('input'); args.value = e.args || '{rom}'; args.title = 'Launch options: {rom} is the game file';
  const argsRow = el('label', 'emu-args', 'Launch options '); argsRow.append(args);
  const save = el('button', 'primary', 'Save'); save.type = 'button';
  save.onclick = async () => {
    try { await api.setEmulator({ id: e.id, systems: [...box.querySelectorAll('input:checked')].map(c => c.value), args: args.value }); UISound.play('select'); renderEmulators(); }
    catch (err) { toast(err.message); }
  };
  card.querySelector('.emu-btns').replaceWith(el('div'));
  card.append(box, argsRow, save);
}
// Sub-windows open on top of Settings first, then Settings closes underneath: no gap where the background flashes.
$('#setEmus').onclick = async () => { S.backToSettings = true; await openEmulators(); $('#settings').close(); };
$('#emusClose').onclick = () => { UISound.play('back'); $('#emusDlg').close(); };
// Changes made in there (emulators, versions) show on the covers' badges as soon as it closes.
$('#emusDlg').addEventListener('close', () => { const id = S.list[S.sel]?.id; renderRow(); const i = S.list.findIndex(g => g.id === id); select(i >= 0 ? i : 0, true); });
$('#emusAdd').onclick = async () => { await openAdd(); showEmuCatalog(); $('#emusDlg').close(); };

// ---------- rename ----------
let renaming = null;
function openRename(g) { renaming = g; $('#renameForm').title.value = g.title; $('#renameDlg').showModal(); $('#renameForm').title.select(); }
$('#renameCancel').onclick = () => $('#renameDlg').close();
$('#renameForm').addEventListener('submit', async e => {
  e.preventDefault(); const g = renaming, title = $('#renameForm').title.value.trim();
  $('#renameDlg').close(); if (!g || !title || title === g.title) return;
  try { await api.setTitle({ gameId: g.id, title }); g.title = title; renderRow(); select(S.sel, true); toast('Renamed.'); autoMedia(); }
  catch (err) { toast(err.message, 5000); }
});

// ---------- credits ----------
// Settings → Credits: the emulators OneDeck can install (each by its own team, under its own licence, downloaded from
// its own releases) and everything else it's built on, each with a link to its website.
const CREDITS = [
  ['Recompendium', 'The catalogue of PC ports (CC BY-SA 4.0)', 'https://recompendium.com/'],
  ['PyroCade', 'The launcher OneDeck started from (MIT)', 'https://github.com/Pyrodrifter/PyroCade'],
  ['LaunchBox Games Database', 'Game details and artwork', 'https://gamesdb.launchbox-app.com/'],
  ['GameTDB', 'Box art for Nintendo consoles', 'https://www.gametdb.com/'],
  ['libretro thumbnails', 'Box art', 'https://thumbnails.libretro.com/'],
  ['yt-dlp and FFmpeg', 'Making the gameplay clips (Unlicense, GPL)', 'https://github.com/yt-dlp/yt-dlp'],
  ['Proton and Wine', 'Windows-only ports on Linux, when they\'re installed', 'https://github.com/ValveSoftware/Proton'],
  ['OpenSave', 'Cloud saves: syncing them between your devices (MIT)', 'https://github.com/Liquid-co/OpenSave'],
  ['Electron', 'What OneDeck runs on (MIT)', 'https://www.electronjs.org/'],
];
function creditRow(name, line, url) {
  const row = el('div', 'emu-cat'), info = el('div', 'emu-cat-info');
  info.append(el('b', '', name), el('small', '', line));
  const b = el('button', '', 'Website'); b.type = 'button'; b.onclick = () => window.open(url);
  row.append(info, b);
  return row;
}
async function openCredits() {
  const emus = await api.emulatorCatalog().catch(() => []);
  $('#creditsList').replaceChildren(
    el('h4', 'emu-group', 'Emulators'),
    ...[...emus].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map(c => creditRow(c.name, `${c.consoles.map(sysName).join(' · ')} · ${c.licence}`, c.site)),
    el('h4', 'emu-group', 'Also used'),
    ...[...CREDITS].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" })).map(([n, l, u]) => creditRow(n, l, u)));
  $('#creditsDlg').showModal();
  $('#creditsList').querySelector('button')?.focus();
}
$('#setCredits').onclick = async () => { S.backToSettings = true; await openCredits(); $('#settings').close(); };
$('#creditsClose').onclick = () => { UISound.play('back'); $('#creditsDlg').close(); };

// ---------- cloud saves ----------
// Settings → Cloud saves (and a game's ••• → Sync saves): OpenSave, driven by cloudsaves.js, shown as OneDeck's own
// window. Turn it on (OpenSave is fetched once), link your devices with a code, pick which games' saves sync. Saves
// travel straight between your devices; a cloud-drive folder or Dropbox also carries them to devices that are off.
const SV = { st: null, view: null, addFor: null, timer: null, last: '', busy: '' };
// Cloud saves is a Settings tab. It keeps itself up to date (every 3 s) only while it's showing.
const savesShown = () => $('#settings').open && !$('#savesPage').hidden;
async function startSaves() {
  await refreshSaves(true);
  clearInterval(SV.timer); SV.timer = setInterval(() => { if (savesShown()) refreshSaves(); else clearInterval(SV.timer); }, 3000);
}
// A game's ••• → Sync saves opens Settings on the Cloud saves tab, ready to pick that game's folder.
async function openSaves({ addFor = null } = {}) {
  SV.addFor = addFor; SV.view = addFor ? 'add' : null;
  if (!$('#settings').open) openSettings();
  setPage('saves');
}
api.saves.onProgress(t => { if (SV.busy) $('#savesStatus').textContent = t; });  // download progress, while an action runs
// "2 min ago", "yesterday", or the date.
function ago(when) {
  const t = Date.parse(when || ''); if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : m < 2880 ? 'yesterday' : new Date(t).toLocaleDateString();
}
async function refreshSaves(force = false) {
  // While you're typing a code, the window holds still.
  if (!force && document.activeElement?.tagName === 'INPUT' && $('#savesPage').contains(document.activeElement)) return;
  const st = await api.saves.status().catch(e => ({ error: e.message }));
  const key = JSON.stringify([st, SV.view, SV.addFor?.id, SV.busy]);
  if (!force && key === SV.last) return;  // nothing changed: leave the window (and the selection) alone
  SV.last = key; SV.st = st; renderSaves();
  // The info line under a game shows "Saves sync" for the ones that do.
  if (S.config && 'on' in st) { S.config.cloudSaves = st.on; S.config.savesFor = st.savesFor; S.config.savesConsoles = st.savesConsoles; showGame(S.list[S.sel]); }
}
// Runs one action with a busy note, then shows what changed. Errors go to a toast.
async function savesDo(note, fn) {
  SV.busy = note; $('#savesStatus').textContent = note;
  try { return await fn(); } catch (e) { UISound.play('error'); toast(e.message, 6000); } finally { SV.busy = ''; await refreshSaves(true); }
}
const svRow = (title, line, buttons = []) => {
  const r = el('div', 'emu-cat'), info = el('div', 'emu-cat-info');
  info.append(el('b', '', title), ...(line ? [el('small', '', line)] : []));
  const btns = el('span', 'btn-pair');
  for (const [text, fn, cls] of buttons) { const b = el('button', cls || '', text); b.type = 'button'; b.onclick = fn; btns.append(b); }
  r.append(info, btns); return r;
};
const svHead = t => el('h4', 'emu-group', t);
const svBack = fn => { const d = el('div', 'sv-back'), b = el('button', '', '← Back'); b.type = 'button'; b.dataset.back = ''; b.onclick = () => { UISound.play('back'); fn(); }; d.append(b); return d; };
function renderSaves() {
  const st = SV.st || {}, body = $('#savesBody'), out = [];
  const toggle = $('#savesToggle');
  toggle.textContent = st.on ? 'Turn off' : 'Turn on'; toggle.className = st.on ? '' : 'primary';
  toggle.onclick = () => st.on ? savesDo('Turning off…', () => api.saves.disable())
    : savesDo('Getting OpenSave…', () => api.saves.enable().then(() => toast('Cloud saves are on. Link your other device next.', 5000)));
  if (st.error) { $('#savesStatus').textContent = st.error; body.replaceChildren(); return; }
  if (!SV.busy) $('#savesStatus').textContent = !st.on ? 'Your saves follow you to your other devices. They sync straight between them: no account, nothing stored on a server.'
    : !st.running ? "OpenSave isn't running." : `This device: ${st.device}${st.paused ? ' · syncing is paused' : ''}`;
  if (!st.on) {
    out.push(el('p', 'note', 'OneDeck uses OpenSave (free and open source) for this. Turning it on downloads it once, about 20 MB.'));
  } else if (!st.running) {
    out.push(svRow('OpenSave stopped', 'It runs while OneDeck is open.', [['Start', () => savesDo('Starting…', () => api.saves.enable()), 'primary']]));
  } else {
    // A device asking to link shows on every page: after making a code you're waiting on the Link page, and the
    // request arrives there. Saying yes goes back to the main page, where the new device is listed.
    for (const r of st.requests || []) out.push(svRow(`${r.name} wants to link`, 'Only say yes to your own devices.', [
      ['Allow', () => { SV.view = null; return savesDo('Linking…', () => api.saves.approve(r.id)); }, 'primary'],
      ['No', () => savesDo('…', () => api.saves.reject(r.id))]]));
  }
  const ready = st.on && st.running;
  if (ready && SV.view === 'add') {
    out.push(...renderSavesAdd(st));
  } else if (ready && SV.view === 'link') {
    out.push(...renderSavesLink(st));
  } else if (ready) {
    // Waiting for an answer from you first: saves from another device, clashes (link requests are above).
    // OneDeck's own emulator folders are placed and combined by themselves, so they never ask.
    const auto = n => / saves \(OneDeck\)$/.test(n || '');
    for (const o of (st.offers || []).filter(o => !auto(o.name))) out.push(svRow(`${o.name}: saves from your other device`, 'Choose where they go on this device.', [
      ['Choose folder…', () => placeOffer(o), 'primary'], ['Not here', () => savesDo('…', () => api.saves.decline(o.gameId))]]));
    for (const c of (st.conflicts || []).filter(c => !auto((st.games || []).find(g => g.id === c.gameId)?.name))) {
      const name = (st.games || []).find(g => g.id === c.gameId)?.name || c.gameId;
      out.push(svRow(`${name}: saved on two devices`, 'Both changed since they last synced. Keep both is safest: nothing is lost.', [
        ['Keep both', () => savesDo('…', () => api.saves.resolve({ gameId: c.gameId, choice: 'keep-both' })), 'primary'],
        ['This one', () => savesDo('…', () => api.saves.resolve({ gameId: c.gameId, choice: 'keep-local' }))],
        ['The other', () => savesDo('…', () => api.saves.resolve({ gameId: c.gameId, choice: 'keep-remote' }))]]));
    }
    // Your devices.
    out.push(svHead('Your devices'));
    if (!(st.paired || []).length) out.push(el('p', 'note', 'No other device linked yet. Link one to start syncing.'));
    for (const p of st.paired || []) out.push(svRow(p.name, `${p.online ? 'Online' : 'Offline'} · ${p.overRelay ? 'over the internet' : 'on your network'}${p.lastSynced ? ` · synced ${ago(p.lastSynced)}` : ''}`,
      [['Unlink', () => confirm(`Unlink ${p.name}? Saves already synced stay where they are.`) && savesDo('Unlinking…', () => api.saves.unlink(p.id))]]));
    for (const p of (st.nearby || []).filter(p => !p.overRelay)) out.push(svRow(`${p.name} (on your network)`, 'Has OpenSave too.', [['Link', () => savesDo('Asking it to link…', () => api.saves.link(p).then(() => toast(`Say yes on ${p.name}.`, 6000))), 'primary']]));
    out.push(svRow('Link a device', st.room ? 'Your code is on: devices that type it in can ask to link.' : 'A code you type in on your other device.', [['Link…', () => { SV.view = 'link'; renderSaves(); }, 'primary']]));
    // Games.
    // Emulators OneDeck set up save into its Saves folder, a folder each, and those sync by themselves.
    const ours = g => / saves \(OneDeck\)$/.test(g.name), stop = g => ['Stop', () => confirm(`Stop syncing ${g.name}? Its saves stay where they are.`) && savesDo('…', () => api.saves.untrack(g.id))];
    out.push(svHead('Emulator saves'));
    out.push(el('p', 'note', 'Games you play in an emulator OneDeck set up save into its Saves folder, and sync from there by themselves.'));
    for (const g of (st.games || []).filter(ours)) out.push(svRow(g.name.replace(/ saves \(OneDeck\)$/, ''), g.shown || g.path, [['Open folder', () => api.saves.openFolder(g.path)], stop(g)]));
    if (!(st.games || []).some(ours)) out.push(el('p', 'note', 'Nothing yet: an emulator starts syncing once you\'ve played a game in it.'));
    out.push(el('p', 'note', 'Not included: Switch, PS3, Wii U, 3DS, PSP and Xbox emulators keep saves in with their system files. Add those games one at a time below.'));
    out.push(svHead('Other games'));
    const others = (st.games || []).filter(g => !ours(g));
    out.push(el('p', 'note', others.length ? 'PC ports and anything else are set up one at a time: each keeps its saves in its own place.'
      : 'None yet. PC ports are set up one at a time, since each keeps its saves in its own place: add one here, or use ••• → Sync saves on it.'));
    for (const g of others) out.push(svRow(g.name, g.missing ? 'Its save folder is missing on this device.' : g.shown || g.path,
      [['Open folder', () => api.saves.openFolder(g.path)], stop(g)]));
    out.push(svRow('Add a game', '', [['Add…', () => { SV.view = 'add'; SV.addFor = null; renderSaves(); }, 'primary'], ['Sync now', () => savesDo('Syncing…', () => api.saves.syncNow())]]));
    // The cloud: for devices that aren't on at the same time.
    out.push(svHead('When your devices aren\'t on together'));
    if (st.cloud?.ready) out.push(svRow(st.cloud.provider === 'local' ? 'Your cloud folder' : st.cloud.provider === 'dropbox' ? 'Dropbox' : st.cloud.provider,
      st.cloud.folder || st.cloud.email || 'Connected', [['Stop using it', () => savesDo('…', () => api.saves.disconnectCloud())]]));
    else {
      out.push(svRow('A cloud folder', 'Pick a OneDrive, Dropbox or Google Drive folder on this PC. Its own app does the rest.', [['Choose…', () => savesDo('…', () => api.saves.useFolder()), 'primary']]));
      out.push(svRow('Dropbox sign-in', 'For a PC without a cloud drive app (like a Steam Deck).', [['Sign in…', () => savesDo('Signing in to Dropbox…', () => api.saves.dropbox())]]));
    }
    out.push(el('p', 'note', 'Over the internet your saves are encrypted from one device to the other. On the same home network they travel unencrypted.'));
  }
  body.replaceChildren(...out);
}
// Link a device: show this device's code, or type in the other one's.
function renderSavesLink(st) {
  const out = [svHead('Link a device')];
  if (st.room?.code?.startsWith('onedeck-')) {
    const code = st.room.code.slice(8).toUpperCase();
    out.push(svRow(`Your code: ${code}`, 'On your other device: Settings → Cloud saves → Link… → Type a code. Keep it to yourself.',
      [['Delete', () => confirm(`Delete the code ${code}? Your devices stay linked, but they'll only sync on the same home network until you generate a new code and type it on the other device.`) && savesDo('…', () => api.saves.leaveCode())]]));
  } else out.push(svRow('Generate a code', 'This device makes a code; you type it in on the other one.', [['Generate', () => savesDo('Generating a code…', () => api.saves.newCode()), 'primary']]));
  const box = el('div', 'emu-cat'), info = el('div', 'emu-cat-info'), input = el('input');
  input.placeholder = 'XXXX-XXXX-XXXX'; input.setAttribute('aria-label', 'Code from your other device'); input.autocomplete = 'off'; input.spellcheck = false;
  info.append(el('b', '', 'Type a code'), el('small', '', 'From your other device.'), input);
  const go = el('button', 'primary', 'Link'); go.type = 'button';
  go.onclick = () => savesDo('Looking for your other device…', async () => {
    const r = await api.saves.joinCode(input.value);
    toast(r.asked ? 'Asked it to link: say yes on your other device.' : "Couldn't find it yet. Is OneDeck open there with its code showing?", 7000);
    if (r.asked) SV.view = null;
  });
  box.append(info, go); out.push(box);
  out.push(svBack(() => { SV.view = null; renderSaves(); }));
  return out;
}
// Add a game: pick one of your games (or the one from its menu), then its save folder: OpenSave's scan suggests ones
// that match its name; otherwise you choose the folder.
function renderSavesAdd(st) {
  const out = [svHead('Sync a game\'s saves')];
  const g = SV.addFor;
  if (!g) {
    const synced = new Set(Object.keys(st.savesFor || {})), viaFolder = new Set(st.savesConsoles || []);
    const list = S.games.filter(x => !x.hidden && !synced.has(x.id) && !(emulated(x) && viaFolder.has(x.system))).sort((a, b) => a.title.localeCompare(b.title));
    for (const x of list.slice(0, 60)) out.push(svRow(x.title, sysName(x.system), [['Pick', () => { SV.addFor = x; SV.suggest = null; renderSaves(); }, 'primary']]));
    out.push(svRow('Something else', 'Any folder of saves, by its name.', [['Choose folder…', () => trackFolder(null)]]));
  } else if (emulated(g) && (st.savesConsoles || []).includes(g.system)) {
    out.push(el('p', 'note', `${g.title}'s saves already sync, from OneDeck's Saves folder with the rest of its emulator's saves.`));
    out.push(svRow('Saves folder', st.savesRoot || '', [['Open folder', () => api.saves.openFolder(st.savesRoot)]]));
  } else {
    out.push(el('p', 'note', emulated(g) ? `${g.title}: where does it keep its saves?`
      : `${g.title} is a PC port. Every port keeps its saves in its own place, so each one is set up once, by hand.`));
    if (SV.suggest === undefined || SV.suggest === null) {
      SV.suggest = 'loading'; api.saves.suggest(g.title).then(r => { SV.suggest = r; renderSaves(); }).catch(() => { SV.suggest = []; renderSaves(); });
    }
    if (SV.suggest === 'loading') out.push(el('p', 'note', 'Looking for its saves…'));
    else for (const s of SV.suggest || []) out.push(svRow(s.name, `${s.path}${s.note ? ` · ${s.note}` : s.files ? ` · ${s.files} file${s.files === 1 ? '' : 's'}` : ''}`, [['Use this', () => trackFolder(g, s.path), 'primary']]));
    out.push(svRow(Array.isArray(SV.suggest) && !SV.suggest.length ? 'None found' : 'Not listed?', 'Choose the folder yourself.', [['Choose folder…', () => trackFolder(g)]]));
  }
  out.push(svBack(() => { SV.view = null; SV.addFor = null; SV.suggest = null; renderSaves(); }));
  return out;
}
async function trackFolder(g, folder) {
  folder ||= await api.saves.pickFolder(g ? `Where ${g.title} keeps its saves` : 'Choose a folder of saves');
  if (!folder) return;
  await savesDo('Adding…', async () => {
    await api.saves.track({ gameId: g?.id, name: g?.title || folder.split(/[\\/]/).pop(), folder });
    toast(`${g?.title || 'Those saves'} will sync to your linked devices.`, 5000);
    SV.view = null; SV.addFor = null; SV.suggest = null;
  });
}
async function placeOffer(o) {
  const folder = await api.saves.pickFolder(`Where ${o.name}'s saves go on this device`);
  if (folder) await savesDo('Placing…', () => api.saves.place({ gameId: o.gameId, folder }));
}

// ---------- settings ----------
function openSettings() {
  const hidden = S.games.filter(g => g.hidden).length;
  $('#setUnhide').textContent = hidden ? `Redock (${hidden})` : 'None';
  $('#setUnhide').disabled = !hidden;
  $('#setIdle').value = String(S.config.harbourIdle ?? 120);
  $('#setAutoUpd').value = S.config.autoUpdates === false ? '0' : '1';
  // How much space the clips take, on the Delete button.
  showMediaRows();
  showVolumes(); showInstallDirs();
  api.selfStatus(false).then(st => { $('#setVersion').textContent = `OneDeck ${st.current}`; }).catch(() => {});
  S.backToSettings = false;
  $('#settings').showModal();
  if (!$('#savesPage').hidden) startSaves();
}
async function saveSetting(patch) {
  Object.assign(S.config, patch);
  try { S.config = await api.setConfig(structuredClone(S.config)); } catch (e) { toast('Could not save: ' + e.message); }
}
$('#btnSettings').onclick = openSettings;
// ---------- what's new ----------
// The release notes, as GitHub has them (a heading, bullets, **bold**): drawn as plain elements, never as HTML.
function notesView(md) {
  const out = [];
  let list = null;
  const inline = text => { const p = []; String(text).split(/\*\*/).forEach((part, i) => p.push(i % 2 ? el('b', '', part) : document.createTextNode(part))); return p; };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const head = line.match(/^#{1,4}\s+(.*)/), item = line.match(/^[-*]\s+(.*)/);
    if (head) { list = null; out.push(el('h4', 'emu-group', head[1])); }
    else if (item) { if (!list) { list = el('ul'); out.push(list); } const li = el('li'); li.append(...inline(item[1])); list.append(li); }
    else { list = null; const p = el('p'); p.append(...inline(line)); out.push(p); }
  }
  return out;
}
async function openNotes() {
  UISound.play('open');
  $('#notesTitle').textContent = `What's new in OneDeck`;
  $('#notesBody').replaceChildren(el('p', 'note', 'Loading…'));
  if (!$('#notesDlg').open) $('#notesDlg').showModal();
  try {
    const r = await api.notes();
    $('#notesTitle').textContent = `What's new in OneDeck ${r.version}`;
    $('#notesPage').hidden = !r.page; $('#notesPage').onclick = () => window.open(r.page);
    $('#notesBody').replaceChildren(...(r.notes ? notesView(r.notes) : [el('p', 'note', 'No notes for this version.')]));
  } catch (e) { $('#notesBody').replaceChildren(el('p', 'note', `Couldn't load the notes (${e.message}). Are you online?`)); }
}
$('#notesClose').onclick = () => { UISound.play('back'); $('#notesDlg').close(); };
$('#setNotes').onclick = async () => { S.backToSettings = true; await openNotes(); $('#settings').close(); };
// once, the first time OneDeck opens after an update
setTimeout(() => api.whatsNew().then(r => { if (r.show && !document.querySelector('dialog[open]')) openNotes(); }).catch(() => {}), 2500);
// Settings has a tab per kind of setting, so nothing needs scrolling to. It opens on the one you used last; Q / E or
// LB / RB step through them, like the consoles on the deck.
const SET_PAGES = [...document.querySelectorAll('#settings .set-tabs button')].map(b => b.dataset.page);
function setPage(page, focusTab = false) {
  if (!SET_PAGES.includes(page)) page = SET_PAGES[0];
  for (const b of document.querySelectorAll('#settings .set-tabs button')) { const on = b.dataset.page === page; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  for (const sec of document.querySelectorAll('#settings .set-page')) sec.hidden = sec.dataset.page !== page;
  try { localStorage.setItem('onedeckSettingsPage', page); } catch {}
  if (page === 'saves' && $('#settings').open) startSaves();
  if (focusTab) $(`#settings .set-tabs button[data-page="${page}"]`).focus({ focusVisible: true });
}
const stepPage = d => { const i = SET_PAGES.indexOf(document.querySelector('#settings .set-tabs button.on')?.dataset.page); UISound.play('move'); setPage(SET_PAGES[(i + d + SET_PAGES.length) % SET_PAGES.length], true); };
for (const b of document.querySelectorAll('#settings .set-tabs button')) b.onclick = () => { UISound.play('select'); setPage(b.dataset.page); };
{ let last = null; try { last = localStorage.getItem('onedeckSettingsPage'); } catch {} setPage(last); }
$('#setClose').onclick = () => $('#settings').close();
$('#setQuit').onclick = () => api.quitApp();
$('#setFull').onclick = () => api.isFullscreen().then(on => api.setFullscreen(!on));
$('#setIdle').onchange = e => saveSetting({ harbourIdle: Number(e.target.value) });
$('#setAutoUpd').onchange = e => { saveSetting({ autoUpdates: e.target.value === '1' }); if (e.target.value === '1') autoInstall(); };
// Volumes are 0-100 and start at 50: loud enough to hear, never a blast at full.
const uiVolume = () => S.config.harbourUiVolume ?? 50, videoVolume = () => S.config.harbourVideoVolume ?? 50;
// The built-in blips are generated at 0.5 of full scale, so 50 here is the level they were made for.
const applyUiVolume = () => UISound.configure({ volume: uiVolume() / 100 * .5 });
// One slider each for video sound and UI sounds: 0 is off (the volume underneath is kept for when it's back on).
const uiSoundsOn = () => S.config.harbourUiSound !== false, videoSoundOn = () => !!S.config.harbourVideoSound;
const showVolumes = () => {
  const ui = uiSoundsOn() ? uiVolume() : 0, vid = videoSoundOn() ? videoVolume() : 0;
  $('#setUiVol').value = ui; $('#setVidVol').value = vid;
  $('#setUiVolOut').textContent = ui || 'Off'; $('#setVidVolOut').textContent = vid || 'Off'; fillSliders();
};
function setUiSlider(v, save) {
  S.config.harbourUiSound = v > 0; if (v > 0) S.config.harbourUiVolume = v;
  UISound.configure({ enabled: v > 0 }); applyUiVolume(); showVolumes();
  if (save) { saveSetting({ harbourUiSound: v > 0, ...(v > 0 ? { harbourUiVolume: v } : {}) }); UISound.play('select'); }
}
function setVideoSlider(v, save) {
  S.config.harbourVideoSound = v > 0; if (v > 0) S.config.harbourVideoVolume = v;
  const video = $('#heroVideo'); video.muted = !(v > 0); video.volume = videoVolume() / 100; showVolumes();
  if (save) saveSetting({ harbourVideoSound: v > 0, ...(v > 0 ? { harbourVideoVolume: v } : {}) });
}
// Sliders: --p is where the handle is, so the filled part ends under the handle's centre (it runs end to end).
function sliderFill(i) { const t = (i.value - i.min) / (i.max - i.min); i.style.setProperty('--p', `calc(${t} * (100% - var(--th)) + var(--th) / 2)`); }
document.addEventListener('input', e => { if (e.target.matches?.('.slider input[type=range]')) sliderFill(e.target); });
const fillSliders = () => document.querySelectorAll('.slider input[type=range]').forEach(sliderFill);
// Cover size: the shelf's covers from 80% to 160% (the picture above and the game's details move with them).
// Settings → Top bar size: the top-right buttons, the clock and the cog (120% unless you change it).
const uiSize = () => S.config?.harbourUiSize ?? 120;
function applyUiSize(p = uiSize()) {
  document.documentElement.style.setProperty('--ui', String(p / 100));
  $('#setUi').value = p; $('#setUiOut').textContent = `${p}%`; sliderFill($('#setUi'));
}
$('#setUi').oninput = e => applyUiSize(Number(e.target.value));
$('#setUi').onchange = e => saveSetting({ harbourUiSize: Number(e.target.value) });
// The clock stays put: the wordmark is as wide as the longest name it can show (ONEDECK, DREAMCAST, SWITCH 2…).
function fixBrandWidth() {
  const word = document.querySelector('.brand .word');
  if (!word) return;
  const probe = word.cloneNode(true); probe.removeAttribute('style');
  probe.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
  probe.style.cssText = 'position: absolute; visibility: hidden; left: -9999px; min-width: 0';
  word.parentNode.append(probe);
  const [lead, main] = probe.children;
  let max = 0;
  for (const [l, m] of [['ONE', 'DECK'], ...Object.values(THEMES).map(t => ['', t[0]])]) {
    lead.textContent = l; main.textContent = m; max = Math.max(max, probe.getBoundingClientRect().width);
  }
  probe.remove();
  word.style.display = 'inline-block'; word.style.minWidth = `${Math.ceil(max)}px`;
}
addEventListener('resize', fixBrandWidth);
const coverSize = () => S.config?.harbourCoverSize ?? 100;
function applyCoverSize(p = coverSize()) {
  document.documentElement.style.setProperty('--row-h', `calc(${210 * p / 100} * var(--u))`);
  $('#setCover').value = p; $('#setCoverOut').textContent = `${p}%`; sliderFill($('#setCover'));
  if (S.list?.length) select(S.sel, true);
}
$('#setView').onchange = e => setView(e.target.value);
$('#setCover').oninput = e => applyCoverSize(Number(e.target.value));
// Where games (ROMs) go, and where new PC ports and emulators install (ones already installed stay put).
async function showInstallDirs() {
  const d = await api.installDirs().catch(() => null); if (!d) return;
  for (const [id, p] of [['#dirGames', d.games], ['#dirPorts', d.ports], ['#dirEmus', d.emulators]]) { $(id).textContent = p; $(id).title = p; }
}
const DIR_WHAT = { games: 'Games (ROMs) now go in', ports: 'New PC ports will install to', emulators: 'New emulators will install to' };
for (const [btn, kind] of [['#setDirGames', 'games'], ['#setDirPorts', 'ports'], ['#setDirEmus', 'emulators']]) $(btn).onclick = async () => {
  try {
    const p = await api.pickInstallDir(kind);
    if (!p) return;
    // a new games folder gets its folder per console, added as game folders
    if (kind === 'games') { await api.makeWelcomeFolders(); S.config = await api.getConfig(); }
    await showInstallDirs(); toast(`${DIR_WHAT[kind]} ${p}`, 5000);
  } catch (e) { UISound.play('error'); toast(e.message, 6000); }
};
$('#setCover').onchange = e => saveSetting({ harbourCoverSize: Number(e.target.value) });
$('#setUiVol').oninput = e => setUiSlider(Number(e.target.value), false);
$('#setUiVol').onchange = e => setUiSlider(Number(e.target.value), true);
$('#setVidVol').oninput = e => setVideoSlider(Number(e.target.value), false);
$('#setVidVol').onchange = e => setVideoSlider(Number(e.target.value), true);
$('#setUnhide').onclick = async () => {
  for (const g of S.games.filter(x => x.hidden)) { await api.setHidden({ gameId: g.id, hidden: false }).catch(() => {}); g.hidden = false; }
  $('#settings').close(); buildTabs(); setTab(S.tab, true); afterUpdates(); toast('Undocked games are back.');
};
// ---------- feedback ----------
// A short message to the OneDeck team (main.js feedback:send). What's typed stays if you close it or it can't send.
const FB = { kind: 'bug' };
function fbKind(kind) {
  FB.kind = kind;
  for (const b of document.querySelectorAll('#feedbackDlg .fb-kinds button')) { const on = b.dataset.kind === kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('#fbText').placeholder = kind === 'bug' ? 'What happened? What did you expect?' : kind === 'idea' ? 'What would you like OneDeck to do?' : 'What would you like to tell us?';
}
function openFeedback(fromSettings) {
  S.backToSettings = !!fromSettings;
  fbKind(FB.kind);
  $('#feedbackDlg').showModal();
  if (fromSettings) $('#settings').close();
  $('#fbText').focus();
}
for (const b of document.querySelectorAll('#feedbackDlg .fb-kinds button')) b.onclick = () => { UISound.play('select'); fbKind(b.dataset.kind); };
$('#btnFeedback').onclick = () => openFeedback(false);
$('#setFeedback').onclick = () => openFeedback(true);
$('#fbCancel').onclick = () => { UISound.play('back'); $('#feedbackDlg').close(); };
$('#fbSend').onclick = async () => {
  const send = $('#fbSend');
  send.disabled = true; send.textContent = 'Sending…';
  try {
    await api.sendFeedback({ kind: FB.kind, message: $('#fbText').value });
    $('#fbText').value = '';
    $('#feedbackDlg').close();
    toast('Sent. Thanks!', 4000);
  } catch (e) { toast(e.message, 6000); }
  finally { send.disabled = false; send.textContent = 'Send'; }
};
$('#setCheck').onclick = () => { $('#settings').close(); checkUpdates(true); };
// Artwork and clips download by themselves (autoMedia), so there are no buttons for them.
const sizeText = b => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`;
// Box art, background art and videos: each On/Off for everything, managed per game, or all deleted.
const MEDIA = {
  box: { label: 'Box art', setting: 'harbourBoxArt', flag: 'noBox', what: 'its box art' },
  background: { label: 'Background art', setting: 'harbourBackgrounds', flag: 'noBackground', what: 'its background art' },
  video: { label: 'Videos', setting: 'harbourVideos', flag: 'noVideo', what: 'its gameplay clip' },
};
const mediaOn = kind => S.config?.[MEDIA[kind].setting] !== false;
const mediaRow = kind => $(`.media-row[data-kind="${kind}"]`);
function showMediaRows() {
  $('#setAutoMedia').value = autoMediaOn() ? '1' : '0';
  const u = $('#setUnused'); u.textContent = 'Delete unused'; u.disabled = true;
  api.mediaUnused().then(b => { u.textContent = b ? `Delete unused (${sizeText(b)})` : 'Nothing unused'; u.disabled = !b; }).catch(() => {});
  for (const kind of Object.keys(MEDIA)) {
    const row = mediaRow(kind), clear = row.querySelector('.media-clear');
    row.querySelector('.media-on').value = mediaOn(kind) ? '1' : '0';
    clear.textContent = 'Delete all'; clear.disabled = true;
    api.mediaUsage(kind).then(b => { clear.textContent = b ? `Delete all (${sizeText(b)})` : 'Delete all'; clear.disabled = !b; }).catch(() => {});
  }
}
async function afterMediaChange(kind) {
  await reload(); S.artBust = Date.now(); renderRow(); select(S.sel, true);
  if (kind === 'video') startVideoSoon(S.list[S.sel]);
}
for (const kind of Object.keys(MEDIA)) {
  const row = mediaRow(kind);
  row.querySelector('.media-on').onchange = async e => {
    const on = e.target.value === '1';
    await saveSetting({ [MEDIA[kind].setting]: on });
    renderRow(); select(S.sel, true);
    if (kind === 'video') { if (on) { startVideoSoon(S.list[S.sel]); downloadVideos('library', '', 'missing'); } else stopVideo(); }
    else if (on) downloadArt('library');  // back on: fetch what's missing
  };
  row.querySelector('.media-manage').onclick = async () => { S.backToSettings = true; await openMediaPicker(kind); $('#settings').close(); };
  // Deleting them all also switches them off: otherwise Harbour would just download them again.
  row.querySelector('.media-clear').onclick = async () => {
    if (!confirm(`Delete all ${MEDIA[kind].label.toLowerCase()}? It will be switched off too, so it isn't downloaded again. Turn it back on any time.`)) return;
    if (kind === 'video') { stopVideo(); S.videoJob = 'library'; }
    try {
      const freed = await api.mediaClearAll(kind);
      await saveSetting({ [MEDIA[kind].setting]: false });
      showMediaRows(); toast(`${MEDIA[kind].label} deleted: ${sizeText(freed)} freed.`, 5000);
      await afterMediaChange(kind);
    } catch (err) { toast(err.message, 6000); }
    finally { if (kind === 'video') S.videoJob = null; }
  };
}
// Download automatically: new games get their pictures and clip by themselves. Off: only when you ask (••• menu).
const autoMediaOn = () => S.config?.harbourAutoMedia !== false;
$('#setAutoMedia').onchange = async e => { const on = e.target.value === '1'; await saveSetting({ harbourAutoMedia: on }); if (on) autoMedia(); };
// Files Harbour no longer uses: kinds switched off, and ones left by games that are gone.
$('#setUnused').onclick = async () => {
  if (!confirm('Delete media OneDeck isn\'t using? That\'s art and clips of games you unchecked in Manage, and anything left from games no longer in your library.')) return;
  stopVideo();
  try { const freed = await api.mediaDeleteUnused(); showMediaRows(); toast(`${sizeText(freed)} freed.`, 5000); await afterMediaChange('video'); }
  catch (e) { UISound.play('error'); toast(e.message, 6000); }
};
// Which games get it: checked = yes. Unchecked ones lose their files and aren't downloaded again.
let mediaPick = 'video', vidTicks = new Map(), vidSizes = {};
async function openMediaPicker(kind) {
  mediaPick = kind;
  const m = MEDIA[kind];
  $('#mediaTitle').textContent = m.label;
  $('#mediaNote').textContent = `Checked games get ${m.what.replace(/^its /, '')}. Unchecked ones don't show or download it; Delete unused frees the space.`;
  vidTicks = new Map(S.games.filter(visible).map(g => [g.id, !g[m.flag]]));
  vidSizes = await api.mediaSizes(kind).catch(() => ({}));
  $('#vidFilter').value = ''; renderVideoPicker();
  $('#videosDlg').showModal(); $('#vidFilter').focus();
}
// Check or uncheck every box under this element (the whole list, or one console's).
const checkAll = (root, v) => { for (const c of root.querySelectorAll('input')) { c.checked = v; c.dispatchEvent(new Event('change')); } };
function renderVideoPicker() {
  const q = searchKey($('#vidFilter').value);
  const games = S.games.filter(visible).filter(g => !q || searchKey(g.title).includes(q))
    .sort((a, b) => (releaseRank(a.system) - releaseRank(b.system)) || a.title.localeCompare(b.title));
  const out = []; let sys = null;
  for (const g of games) {
    if (g.system !== sys) {
      sys = g.system;
      const group = el('div', 'vid-group'), head = el('h4');
      const all = el('button', 'link', 'Check all'), none = el('button', 'link', 'Uncheck all'); all.type = none.type = 'button';
      all.onclick = () => checkAll(group, true); none.onclick = () => checkAll(group, false);
      head.append(el('span', '', sysOf(sys).name), all, none); group.append(head); out.push(group);
    }
    const l = el('label', vidSizes[g.id] ? 'has' : ''); const c = el('input'); c.type = 'checkbox'; c.checked = vidTicks.get(g.id);
    c.onchange = () => vidTicks.set(g.id, c.checked);
    l.append(c, el('span', '', g.title)); if (vidSizes[g.id]) l.append(el('small', '', sizeText(vidSizes[g.id])));
    out.at(-1).append(l);
  }
  $('#vidList').replaceChildren(...(out.length ? out : [el('p', 'note', 'No games match.')]));
}
async function setGameVideo(g, on) {
  try {
    if (!on && g === S.list[S.sel]) stopVideo();
    await api.mediaSet(on ? { kind: 'video', on: [g.id] } : { kind: 'video', off: [g.id] });
    await reload(); toast(on ? `Videos back on for ${g.title}.` : `No video for ${g.title}.`, 4000);
    if (on) downloadVideos('game', g.id, 'missing'); else startVideoSoon(S.list[S.sel]);
  } catch (e) { UISound.play('error'); toast(e.message, 6000); }
}
$('#vidFilter').oninput = renderVideoPicker;
// Only the games the filter shows.
for (const [id, v] of [['#vidAll', true], ['#vidNone', false]]) $(id).onclick = () => checkAll($('#vidList'), v);
$('#vidCancel').onclick = () => $('#videosDlg').close();
$('#vidSave').onclick = async () => {
  const kind = mediaPick, flag = MEDIA[kind].flag, off = [], on = [];
  for (const [id, want] of vidTicks) { const g = S.games.find(x => x.id === id); if (!g) continue; if (!want && !g[flag]) off.push(id); if (want && g[flag]) on.push(id); }
  $('#videosDlg').close();
  if (!off.length && !on.length) return;
  try {
    if (kind === 'video' && off.some(id => id === S.list[S.sel]?.id)) stopVideo();  // Windows won't delete a clip that's playing
    await api.mediaSet({ kind, off, on });
    await afterMediaChange(kind);
    toast(`${MEDIA[kind].label} off for ${off.length}, on for ${on.length}.` + (off.length ? ' Settings → Delete unused frees the space.' : ''), 5000);
    if (on.length) { if (kind === 'video') downloadVideos('library', '', 'missing'); else downloadArt('library'); }
  } catch (e) { UISound.play('error'); toast(e.message, 6000); }
};
// Artwork and clips are made by the main process; their queue jobs wait for it to say it's finished.
const mainJob = { art: null, video: null };
function downloadVideos(scope, gameId, mode = 'missing') {
  if (!videosOn()) return Promise.resolve(false);
  const label = mode === 'reroll' ? 'Rerolling the clip' : mode === 'new' ? 'Finding a different longplay' : 'Game videos';
  return enqueue(`video:${scope}:${gameId || ''}:${mode}`, label, () => new Promise((resolve, reject) => {
    if (!videosOn()) return resolve({ quiet: true });  // switched off while it waited
    // Let go of the clip first: Windows won't replace a video file that's still playing.
    if (mode !== 'missing') { S.videoJob = scope === 'game' ? gameId : 'library'; stopVideo(); }
    mainJob.video = resolve;
    api.videoStart({ scope, gameId, mode }).catch(e => {
      S.videoJob = null; mainJob.video = null; startVideoSoon(S.list[S.sel]);
      if (/already has a video/i.test(e.message)) resolve({ quiet: true }); else reject(e);  // nothing to do isn't a failure
    });
  }));
}
api.onVideoProgress?.(job => {
  if (job && job.status !== 'running') S.videoJob = null; // finished: clips can play again
  if (!job) return;
  if (job.status === 'running') { jobProgress(job.total > 1 ? `Videos ${job.done || 0} of ${job.total} · ${job.stage}` : job.stage, job.total > 1 ? (job.done || 0) / job.total : 0); return; }
  let result;
  if (job.status === 'failed') result = { fail: 'Videos stopped: ' + job.stage };
  else if (job.total === 1) result = job.saved ? { done: 'New clip ready' } : { fail: job.failed ? `Couldn't get a clip: ${job.errors?.[0]?.split(': ').slice(1).join(': ') || 'unknown error'}` : 'No gameplay video found' };
  else {
    const msg = `Videos done: ${job.saved} saved` + (job.noLink ? `, ${job.noLink} had no link` : '') + (job.failed ? `, ${job.failed} failed` : '');
    result = job.failed && !job.saved ? { fail: msg } : { done: msg };
  }
  S.videoBust = Date.now();
  const finish = mainJob.video; mainJob.video = null;
  reload().then(() => { startVideoSoon(S.list[S.sel]); finish?.(result); });
});
// reroll: the kinds to swap for the next of the database's pictures (else missing pictures are downloaded).
function downloadArt(scope, gameId, reroll = null) {
  const what = reroll?.[0] === 'front' ? 'box art' : 'background art';
  return enqueue(`art:${scope}:${gameId || ''}${reroll ? ':next:' + reroll[0] : ''}`, reroll ? `Changing ${what}` : 'Artwork', () => new Promise((resolve, reject) => {
    S.artBusy = true; S.artReroll = reroll ? what : false; mainJob.art = resolve;
    api.artStart({ scope, gameId, types: reroll || ['front', 'fanart', 'logo', 'screenshot'], retryMissing: true, upgrade: false, reroll: !!reroll })
      .catch(e => { S.artBusy = false; mainJob.art = null; reject(e); });
  }));
}
api.onArtProgress?.(job => {
  if (!job) return;
  if (job.status === 'running') { jobProgress(job.total > 1 ? `Artwork ${job.completed} of ${job.total}` + (job.lastTitle ? ` · ${job.lastTitle}` : '') : `Artwork · ${job.lastTitle || ''}`, job.total > 1 ? job.completed / job.total : 0); return; }
  const finish = mainJob.art; mainJob.art = null; S.artBusy = false;
  // Changed pictures keep their file names: a new ?v= makes the window load them again instead of its cached copies.
  if (S.artReroll) S.artBust = Date.now();
  const msg = S.artReroll ? (job.downloaded ? `New ${S.artReroll}` : `No other ${S.artReroll} for this game`) : `Artwork done: ${job.downloaded} new image${job.downloaded === 1 ? '' : 's'}`;
  if (S.artReroll) toast(msg, 4000);  // asked for by hand: always say what happened
  reload().then(() => finish?.(S.artReroll && !job.downloaded ? { fail: msg } : { done: msg }));
});

// ---------- search ----------
// Every console at once: all the words you type, in any order, ignoring case, accents and punctuation.
const searchKey = t => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const searchKeys = new Map();
let searchHits = [], searchSel = 0;
function openSearch() {
  if (document.querySelector('dialog[open]')) return;
  UISound.play('open');
  $('#searchBox').value = ''; renderSearch();
  $('#searchDlg').showModal(); $('#searchBox').focus();
}
function renderSearch() {
  const words = searchKey($('#searchBox').value).split(' ').filter(Boolean);
  const key = g => { let k = searchKeys.get(g.title); if (k == null) searchKeys.set(g.title, k = searchKey(g.title)); return k; };
  const all = S.games.filter(visible);
  searchHits = !words.length ? [] : all.filter(g => words.every(w => key(g).includes(w)))
    .sort((a, b) => (key(b).startsWith(words[0]) - key(a).startsWith(words[0])) || a.title.localeCompare(b.title));
  searchSel = 0;
  const box = $('#searchHits'); box.replaceChildren();
  if (!words.length) { box.append(el('div', 'none', `${all.length.toLocaleString()} games`)); return; }
  if (!searchHits.length) { box.append(el('div', 'none', 'No matches')); return; }
  for (const g of searchHits.slice(0, 80)) {
    const b = el('button'); b.type = 'button';
    const front = pic(boxArt(g));
    if (front) { const img = el('img'); img.src = front; img.loading = 'lazy'; img.alt = ''; b.append(img); } else b.append(el('span', 'noart'));
    b.append(el('span', '', g.title), el('span', 'sys', shortName(sysOf(g.system).name)));
    b.onclick = () => pickSearch(g);
    box.append(b);
  }
  if (searchHits.length > 80) box.append(el('div', 'none', `+${(searchHits.length - 80).toLocaleString()} more, keep typing`));
  markSearch();
}
function markSearch() { [...$('#searchHits').querySelectorAll('button')].forEach((b, i) => { b.classList.toggle('on', i === searchSel); if (i === searchSel) b.scrollIntoView({ block: 'nearest' }); }); }
function pickSearch(g) {
  $('#searchDlg').close();
  UISound.play('select');
  const keep = S.tab === 'all' || (S.tab === 'favorites' && g.favorite) || (S.tab === 'recent' && recentGames().includes(g)) || (S.tab === 'emulated' && emulated(g)) || (S.tab === 'ports' && g.recomp);
  setTab(keep ? S.tab : g.system);
  select(S.list.findIndex(x => x.id === g.id));
}
$('#btnSearch').onclick = () => openSearch();
$('#searchBox').addEventListener('input', renderSearch);
$('#searchBox').addEventListener('keydown', e => {
  setInput('kbm');
  const n = Math.min(searchHits.length, 80);
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); searchSel = (searchSel + 1) % n; markSearch(); }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); searchSel = (searchSel - 1 + n) % n; markSearch(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (searchHits[searchSel]) pickSearch(searchHits[searchSel]); }
});

// ---------- input: keyboard, mouse, controller ----------
function poke() {
  S.lastInput = Date.now();
  if (S.ambient) { S.ambient = false; document.body.classList.remove('ambient'); return true; } // the first input only wakes it
  return false;
}
// Windows (Settings, Add, Emulators, Platform & updates, Rename) with a controller: up/down move
// between the controls, left/right change a dropdown, A presses or ticks, B closes.
function dialogAct(dlg, a) {
  const controls = [...dlg.querySelectorAll('button, select, input, textarea')].filter(e => !e.disabled && e.offsetParent !== null && e.type !== 'hidden');
  if (!controls.length) { if (a === 'back') dlg.close(); return; }
  const cur = controls.indexOf(document.activeElement), el2 = controls[cur];
  const focusAt = i => { const t = controls[(i + controls.length) % controls.length]; t.focus({ focusVisible: true }); t.scrollIntoView({ block: 'nearest' }); UISound.play('move'); };
  if (a === 'back') {  // one step back when the window shows a Back button (Add's steps, Cloud saves' pages), else close
    const step = [...dlg.querySelectorAll('[data-back]')].find(b => b.offsetParent !== null && !b.disabled);
    UISound.play('back'); if (step) step.click(); else dlg.close(); return;
  }
  if (dlg.id === 'settings' && (a === 'tabprev' || a === 'tabnext')) return stepPage(a === 'tabnext' ? 1 : -1);
  if (a === 'up' || a === 'tabprev') return focusAt(cur < 0 ? 0 : cur - 1);
  if (a === 'down' || a === 'tabnext') return focusAt(cur + 1);
  if ((a === 'left' || a === 'right') && el2?.type === 'range') { // sliders: left/right move them
    const step = Number(el2.step) || 1, v = Math.max(Number(el2.min), Math.min(Number(el2.max), Number(el2.value) + (a === 'right' ? step : -step)));
    if (v !== Number(el2.value)) { el2.value = v; el2.dispatchEvent(new Event('input', { bubbles: true })); el2.dispatchEvent(new Event('change', { bubbles: true })); }
    return;
  }
  if ((a === 'left' || a === 'right') && el2?.tagName === 'SELECT') {
    const n = el2.options.length, i = Math.max(0, Math.min(n - 1, el2.selectedIndex + (a === 'right' ? 1 : -1)));
    if (i !== el2.selectedIndex) { el2.selectedIndex = i; el2.dispatchEvent(new Event('change', { bubbles: true })); UISound.play('move'); }
    return;
  }
  if (a === 'left') return focusAt(cur < 0 ? 0 : cur - 1);
  if (a === 'right') return focusAt(cur + 1);
  if (a === 'ok') {
    if (cur < 0) return focusAt(0);
    if (el2.tagName === 'BUTTON' || el2.type === 'checkbox') { UISound.play('select'); el2.click(); }
    else if (el2.tagName === 'SELECT') { el2.selectedIndex = (el2.selectedIndex + 1) % el2.options.length; el2.dispatchEvent(new Event('change', { bubbles: true })); }
    // Text boxes need a keyboard (on a Steam Controller: Steam + X shows one).
  }
}
function act(a) {
  if (S.running) return;
  if (poke()) return;
  const dlg = document.querySelector('dialog[open]');
  if (dlg) { dialogAct(dlg, a); return; }
  if (S.menuOpen) {
    const bs = [...$('#menu').children];
    if (a === 'up') { UISound.play('move'); menuFocus((S.menuIdx - 1 + bs.length) % bs.length); }
    else if (a === 'down') { UISound.play('move'); menuFocus((S.menuIdx + 1) % bs.length); }
    else if (a === 'ok') { UISound.play('select'); bs[S.menuIdx]?.click(); }
    else if (a === 'back' || a === 'more') { UISound.play('back'); closeMenu(); }
    return;
  }
  const tabIdx = S.tabs.findIndex(t => t.id === S.tab);
  switch (a) {
    case 'up': select(S.sel - (tilesView() ? tileCols() : 1)); break;      // list and tile views
    case 'down': select(S.sel + (tilesView() ? tileCols() : 1)); break;
    case 'view': cycleView(); break;
    case 'left': if (listView()) setTab(S.tabs[(tabIdx - 1 + S.tabs.length) % S.tabs.length].id); else select(S.sel - 1); break;
    case 'right': if (listView()) setTab(S.tabs[(tabIdx + 1) % S.tabs.length].id); else select(S.sel + 1); break;
    case 'pgleft': select(S.sel - 6); break;
    case 'pgright': select(S.sel + 6); break;
    case 'tabprev': setTab(S.tabs[(tabIdx - 1 + S.tabs.length) % S.tabs.length].id); break;
    case 'tabnext': setTab(S.tabs[(tabIdx + 1) % S.tabs.length].id); break;
    case 'ok': play(); break;
    case 'update': update(); break;
    case 'more': UISound.play('open'); openMenu($('#btnMore')); break;
    case 'settings': UISound.play('open'); openSettings(); break;
    case 'updates': openUpdates(); break;
    case 'search': openSearch(); break;
  }
}
addEventListener('keydown', e => {
  // Settings: Q / E step through its tabs (not while typing in a box)
  if ((e.key === 'q' || e.key === 'e') && e.target.closest('#settings') && e.target.tagName !== 'INPUT') { e.preventDefault(); poke(); stepPage(e.key === 'e' ? 1 : -1); return; }
  if (e.target.closest('dialog') && !['Escape'].includes(e.key)) { poke(); return; }
  if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !e.ctrlKey)) { e.preventDefault(); if (!poke()) act('search'); return; }
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: S.menuOpen || view() !== 'shelf' ? 'up' : 'tabprev', ArrowDown: S.menuOpen || view() !== 'shelf' ? 'down' : 'tabnext', v: 'view',
    Enter: 'ok', ' ': 'ok', Escape: 'back', PageUp: 'pgleft', PageDown: 'pgright', q: 'tabprev', e: 'tabnext', u: 'update', x: 'more', F1: 'settings' };
  const a = map[e.key]; if (!a) { poke(); return; }
  e.preventDefault(); act(a);
});
addEventListener('mousemove', e => { poke(); if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) setInput('kbm'); }, { passive: true });
addEventListener('mousedown', () => setInput('kbm'), { passive: true });
addEventListener('wheel', e => { if (poke()) return; if (e.target.closest('#rowWrap')) select(S.sel + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1)); }, { passive: true });
$('#btnPlay').onclick = () => play();
$('#btnUpdate').onclick = () => update();
$('#btnMore').onclick = e => S.menuOpen ? closeMenu() : openMenu(e.currentTarget);

// Controller (XInput layout; Steam Input presents the Steam Controller as one). Polled only while needed.
const held = new Map(); let pollTimer = null, rafId = null, quitHoldSince = 0;
function pollPads() {
  for (const p of navigator.getGamepads?.() || []) {
    if (!p) continue;
    const b = i => !!p.buttons[i]?.pressed, ax = (i, s) => (p.axes[i] || 0) * s > .6;
    if (S.running) { // only "hold Back + Start" to close the game
      if (b(8) && b(9)) { quitHoldSince ||= Date.now(); if (Date.now() - quitHoldSince > 1500) { quitHoldSince = 0; api.quitGame().catch(() => {}); } }
      else quitHoldSince = 0;
      continue;
    }
    if (p.buttons.some(x => x.pressed)) setPadFamily(p.id);
    const keys = { left: b(14) || ax(0, -1), right: b(15) || ax(0, 1), up: b(12) || ax(1, -1), down: b(13) || ax(1, 1),
      ok: b(0), back: b(1), more: b(2), update: b(3), tabprev: b(4), tabnext: b(5), pgleft: b(6), pgright: b(7), settings: b(9), updates: b(8), search: b(10), view: b(11) };
    for (const [k, down] of Object.entries(keys)) {
      const key = p.index + k, t = held.get(key);
      if (!down) { held.delete(key); continue; }
      const now = performance.now(), repeat = ['left', 'right', 'up', 'down'].includes(k);
      if (!t) { held.set(key, now + 380); dispatchPad(k); }
      else if (repeat && now >= t) { held.set(key, now + 90); dispatchPad(k); }
    }
  }
}
function dispatchPad(k) {
  setInput('pad');
  const listy = S.menuOpen || view() !== 'shelf' || !!document.querySelector('dialog[open]');  // in a window, up is up
  if (k === 'up') return act(listy ? 'up' : 'tabprev');
  if (k === 'down') return act(listy ? 'down' : 'tabnext');
  act(k);
}
function padLoop() { pollPads(); rafId = requestAnimationFrame(padLoop); }
function setPolling() {
  cancelAnimationFrame(rafId); clearInterval(pollTimer); rafId = pollTimer = null;
  if (!navigator.getGamepads?.().some(Boolean)) return;
  if (S.focused && !S.running) padLoop();               // smooth while you're using it
  else pollTimer = setInterval(pollPads, 250);          // background: 4 checks a second, nothing drawn
}
addEventListener('gamepadconnected', setPolling);
addEventListener('gamepaddisconnected', setPolling);

// ---------- freeze in the background / while a game runs ----------
function setFrozen() {
  renderHints();
  const frozen = S.running || !S.focused || document.hidden;
  document.body.classList.toggle('frozen', frozen);
  UISound.suspend(frozen);
  if (frozen) { stopVideo(); if (S.ambient) { S.ambient = false; document.body.classList.remove('ambient'); } }
  else { S.lastInput = Date.now(); startVideoSoon(S.list[S.sel]); }
  setPolling();
}
const onFocus = () => { S.focused = true; setFrozen(); noticeOwnUpdates(); rescanOnReturn(); };
addEventListener('focus', onFocus);
// Windows doesn't always send "focus" after a folder picker or confirm box closes, which left OneDeck paused (no
// videos, no smooth scrolling). So any input, and a check every second, notices it's in front again.
const recheckFocus = () => { if (!S.focused && document.hasFocus()) onFocus(); };
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(ev, recheckFocus, { capture: true, passive: true });
setInterval(() => { if (document.hasFocus() !== S.focused) document.hasFocus() ? onFocus() : (S.focused = false, setFrozen()); }, 1000);
// Coming back to Harbour: games added to the folders meanwhile show up (and get their artwork), at most every 20 s.
let lastRescan = Date.now();
async function rescanOnReturn() {
  if (S.running || Date.now() - lastRescan < 20000) return;
  lastRescan = Date.now();
  const fresh = await api.scan(false, { onlyIfChanged: true }).catch(() => null);
  if (fresh) {
    const id = S.list[S.sel]?.id, before = S.games.length;
    S.games = fresh; buildTabs(); setTab(S.tab, true);
    const i = S.list.findIndex(g => g.id === id); if (i >= 0) select(i, true);
    if (fresh.length > before) toast(`${fresh.length - before} new game${fresh.length - before === 1 ? '' : 's'} found.`);
  }
  autoMedia();
}
// Coming back to Harbour (e.g. after updating an emulator yourself): look again, without asking the internet.
async function noticeOwnUpdates() {
  if (!pendingUpdates().length) return;
  const before = pendingUpdates().length;
  await loadEmulators(false);
  if (S.games.some(g => g.recomp)) try { Object.assign(S.recomp, await api.recompCheckAll(false)); } catch {}
  const after = pendingUpdates().length;
  if (after !== before) { afterUpdates(); Activity.done('noticed', after < before ? 'Update noticed: you\'re on the newest version' : 'Updates changed'); }
}
addEventListener('blur', () => { S.focused = false; setFrozen(); });
document.addEventListener('visibilitychange', setFrozen);
api.onGameStarted(() => { S.running = true; setFrozen(); });
api.onGameEnded(p => {
  syncSoon();  // saves move right after a game closes: watch them go
  S.running = (p?.running || 0) > 0; const g = S.games.find(x => x.id === p?.gameId);
  if (!S.running) autoInstall();  // updates that waited for the game to close
  if (g) {
    Object.assign(g, { playMs: p.playMs, lastPlayed: p.lastPlayed, plays: p.plays });
    // Recent: the game just played moves to the front (and the tab appears after the first game)
    const had = S.tabs.some(t => t.id === 'recent'); buildTabs();
    if (S.tab === 'recent' || !had) setTab(S.tab, true); else if (g === S.list[S.sel]) showGame(g);
  }
  setFrozen();
});

// ---------- cloud sync state on the game's info line ----------
const SYNC_TEXT = {
  synced: ['☁ Synced', "Your other devices have this game's latest saves."],
  syncing: ['☁ Syncing…', "Sending this game's latest saves to your other devices."],
  waiting: ['☁ Not synced yet', 'Saved here since your other devices last got it. It goes across when one of them is on.'],
  conflict: ['☁ Needs a choice', 'Saved on two devices. Settings → Cloud saves to choose which to keep.'],
  missing: ['☁ Save folder missing', "Its save folder isn't on this device. Settings → Cloud saves to fix it."],
  alone: ['☁ Not synced', 'No other device is linked yet. Settings → Cloud saves → Link…'] };
function syncState(g) {
  const s = S.sync; if (!g || !s || !savesSync(g)) return null;
  const id = s.savesFor[g.id] || (emulated(g) ? s.consoles[g.system] : null);
  return id ? s.states[id] || null : null;
}
// Checked every 20 s while cloud saves are on and OneDeck is in front; every 3 s for a minute and a half after a game
// closes, when its saves move.
function pollSync() {
  if (!S.config?.cloudSaves || S.running) return;
  api.saves.states().then(r => { const k = JSON.stringify(r); if (k === S.syncKey) return; S.syncKey = k; S.sync = r; if (S.list?.[S.sel]) showGame(S.list[S.sel]); }).catch(() => {});
}
let syncBurst = 0;
function syncSoon() { syncBurst = Date.now() + 90000; }
setInterval(() => { if (Date.now() < syncBurst || (S.focused && Date.now() % 20000 < 3000)) pollSync(); }, 3000);
setTimeout(pollSync, 4000);

// ---------- screensaver + clock (one cheap timer, only while in front) ----------
setInterval(() => {
  if (document.body.classList.contains('frozen')) return;
  const d = new Date(); $('#clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const idle = S.config?.harbourIdle ?? 120;
  if (idle && !S.ambient && !S.menuOpen && !document.querySelector('dialog[open]') && Date.now() - S.lastInput > idle * 1000) {
    S.ambient = true; document.body.classList.add('ambient');
    const v = $('#heroVideo'); if (S.list[S.sel]?.media?.video && !v.getAttribute('src')) startVideoSoon(S.list[S.sel]);
  }
}, 1000);

// ---------- hints ----------
// ---------- controller glyphs ----------
// With a controller in hand, buttons show the one to press (Search: the left stick, Settings: Menu, a window's Close or
// Back: B), in that controller's own labels and colours: PlayStation and Nintendo ones by their name, anything else as
// Xbox (also what Steam Input presents). With the keyboard and mouse they go away.
const PAD_LABELS = {
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', back: 'View', start: 'Menu', l3: 'LS', r3: 'RS' },
  ps: { a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', back: 'Create', start: 'Options', l3: 'L3', r3: 'R3' },
  nintendo: { a: 'B', b: 'A', x: 'Y', y: 'X', lb: 'L', rb: 'R', back: '−', start: '+', l3: 'LS', r3: 'RS' } };  // by position, as the browser reads it
const padFamily = id => /054c|playstation|dualsense|dualshock|wireless controller/i.test(id || '') ? 'ps'
  : /057e|nintendo|pro controller|joy-con/i.test(id || '') ? 'nintendo' : 'xbox';
S.padFam = 'xbox';
function setPadFamily(id) { const f = padFamily(id); if (f !== S.padFam) { S.padFam = f; renderHints(); } }
function padGlyph(key) {
  const g = el('kbd', `pg pg-${S.padFam} pg-${key}`, PAD_LABELS[S.padFam][key] || key);
  g.setAttribute('aria-hidden', 'true'); return g;
}
let glyphing = false;
function applyGlyphs() {
  glyphing = true;
  const pad = S.input === 'pad';
  document.body.classList.toggle('pad', pad);
  const put = (e, key, cls) => {
    let g = e.querySelector(':scope > .pg');
    if (!pad || !key) { g?.remove(); return; }
    const want = PAD_LABELS[S.padFam][key];
    if (!g || g.textContent !== want || !g.classList.contains(`pg-${S.padFam}`)) { g?.remove(); g = padGlyph(key); g.classList.add(cls); e.prepend(g); }
  };
  for (const e of document.querySelectorAll('[data-pad]')) put(e, e.dataset.pad, 'pg-badge');
  for (const e of document.querySelectorAll('[data-pad-inline]')) put(e, e.dataset.padInline, 'pg-inline');
  // B: on the Back button when the open window shows one, else on its Close / Cancel / Done
  const dlg = document.querySelector('dialog[open]');
  const back = dlg && [...dlg.querySelectorAll('[data-back]')].find(b => b.offsetParent !== null && !b.disabled);
  const close = dlg && !back && [...dlg.querySelectorAll('[data-close]')].find(b => b.offsetParent !== null);
  for (const e of document.querySelectorAll('[data-back], [data-close]')) put(e, e === back || e === close ? 'b' : null, 'pg-inline');
  queueMicrotask(() => { glyphing = false; });
}
// a window's contents change (Add's steps, Cloud saves' pages): its B moves with them
new MutationObserver(() => { if (!glyphing && S.input === 'pad') renderHints(); })
  .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open'] });

// The buttons that do something right now, for what you're using: a controller's, or the keyboard's once you type
// or move the mouse. They follow what's open (the shelf, the ••• menu, search, a window) and stay in front of windows.
S.input = 'kbm';
addEventListener('gamepadconnected', e => { setPadFamily(e.gamepad?.id); setInput('pad'); });
function setInput(kind) { if (S.input !== kind) { S.input = kind; renderHints(); } }
let hintsQueued = false;
function renderHints() {
  if (hintsQueued) return;
  hintsQueued = true;
  queueMicrotask(() => { hintsQueued = false; drawHints(); });
}
function drawHints() {
  const pad = S.input === 'pad', h = [];
  const P = (...keys) => ({ pad: keys });  // controller buttons, drawn as that controller's glyphs
  const dlg = document.querySelector('dialog[open]');
  if (S.running) { if (pad) h.push([P('back', 'start'), 'Hold to close game']); }
  else if (dlg?.id === 'searchDlg') h.push(['↑↓', 'Choose'], [pad ? P('a') : 'Enter', 'Go to game'], [pad ? P('b') : 'Esc', 'Close']);
  else if (dlg) {
    const back = [...dlg.querySelectorAll('[data-back]')].some(b => b.offsetParent !== null);
    if (pad) h.push(['↑↓', 'Move'], ['←→', 'Change'], [P('a'), 'Select'], [P('b'), back ? 'Back' : 'Close'], ...(dlg.id === 'settings' ? [[P('lb', 'rb'), 'Tabs']] : []));
    else h.push(['Tab', 'Move'], ['Enter', 'Select'], ['Esc', 'Close'], ...(dlg.id === 'settings' ? [['Q E', 'Tabs']] : []));
  }
  else if (S.menuOpen) h.push(['↑↓', 'Choose'], [pad ? P('a') : 'Enter', 'Select'], [pad ? P('b') : 'Esc', 'Close']);
  else {
    const g = S.list[S.sel], updates = pendingUpdates().length;
    if (g) h.push([pad ? P('a') : 'Enter', emuOffer(g) ? 'Install' : 'Play']);
    if (g && S.recomp[g.id]?.updateAvailable) h.push([pad ? P('y') : 'U', 'Update']);
    if (g) h.push([pad ? P('x') : 'X', 'More']);
    if (listView()) h.push(['↑↓', 'Game']); else if (tilesView()) h.push([pad ? '✥' : '↑↓←→', 'Move']);
    h.push([pad ? P('lb', 'rb') : listView() ? '←→' : tilesView() ? 'Q E' : '↑↓', 'Console'],
      [pad ? P('r3') : 'V', 'View'], [pad ? P('l3') : 'Ctrl+F', 'Search'], [pad ? P('start') : 'F1', 'Settings']);
    if (updates) h.push([pad ? P('back') : '', `Updates (${updates})`]);
  }
  $('#hints').replaceChildren(...h.filter(([k]) => k).map(([k, t]) => {
    const s = el('span');
    if (k.pad) s.append(...k.pad.map(padGlyph), t); else s.append(el('kbd', '', k), t);
    return s;
  }));
  applyGlyphs();
}
document.addEventListener('close', renderHints, true);  // a window closed (close doesn't bubble: caught on the way down)
// A window opened from Settings (emulators, media) goes back to Settings when it's closed, once nothing else is open.
document.addEventListener('close', e => {
  if (e.target.id === 'settings' || !S.backToSettings) return;
  // before the next frame is drawn, so the background never drops out
  queueMicrotask(() => { if (S.backToSettings && !document.querySelector('dialog[open]')) openSettings(); });
}, true);

// New games (dropped into a game folder, added any way) get artwork, then a gameplay clip, by themselves.
// A game tried without luck waits a week before the next try, so hopeless ones aren't searched every start.
const AUTO_RETRY_MS = 7 * 864e5;
function autoMedia() {
  if (!autoMediaOn()) return;
  let tried = {};
  try { tried = JSON.parse(localStorage.getItem('harbourAutoTried') || '{}'); } catch {}
  const now = Date.now();
  // Tried per name: a game whose name changed (renamed, or read better) is tried again straight away.
  const key = g => `${g.id}|${g.title}`;
  const fresh = S.games.filter(g => !g.demo && (!g.media?.front || !g.media?.video) && !(now - (tried[key(g)] || 0) < AUTO_RETRY_MS));
  if (!fresh.length) return;
  for (const g of fresh) tried[key(g)] = now;
  try { localStorage.setItem('harbourAutoTried', JSON.stringify(tried)); } catch {}
  // Artwork first, then clips: the queue keeps that order.
  if (fresh.some(g => !g.media?.front && !g.noBox) || fresh.some(g => !g.media?.fanart && !g.noBackground)) downloadArt('library');
  if (fresh.some(g => !g.media?.video && !g.noVideo)) downloadVideos('library', '', 'missing');
}

// ---------- start ----------
async function reload() {
  const games = await api.scan(false).catch(e => { toast('Scan failed: ' + e.message); return null; });
  if (!games) return;
  const id = S.list[S.sel]?.id;
  S.games = games; buildTabs(); setTab(S.tab, true);
  const i = S.list.findIndex(g => g.id === id); if (i >= 0) select(i, true);
}
async function init() {
  S.config = await api.getConfig();
  UISound.configure({ enabled: S.config.harbourUiSound !== false });
  applyUiVolume(); applyCoverSize(); applyUiSize(); applyView();
  document.fonts.ready.then(fixBrandWidth); fixBrandWidth();
  S.uiState = await api.libraryUi().catch(() => ({}));
  S.tab = S.uiState?.system || 'all';
  renderHints();
  let games = await api.cachedLibrary().catch(() => null);
  if (!games) games = await api.scan(false);
  S.games = games || []; buildTabs(); setTab(S.tab);
  // Rescan behind the cached library; redraw only if something changed.
  api.scan(false, { onlyIfChanged: true }).then(fresh => { if (fresh) { const id = S.list[S.sel]?.id; S.games = fresh; buildTabs(); setTab(S.tab, true); const i = S.list.findIndex(g => g.id === id); if (i >= 0) select(i, true); } })
    .catch(() => {}).then(autoMedia);
  checkUpdates(false);
  api.portCatalog().then(list => { S.portList = list; showGame(S.list[S.sel]); }).catch(() => {});
  // First run: a few choices, then the ways in. Later, with nothing to show yet: just the ways in.
  if (!S.config.harbourWelcomed || !S.games.length) openWelcome(!S.config.harbourWelcomed);
  // Emulator badges: draw them once the emulators' update checks are in.
  loadEmulators().then(() => { autoInstall(); const id = S.list[S.sel]?.id; renderRow(); const i = S.list.findIndex(g => g.id === id); select(i >= 0 ? i : 0, true); });
  api.onToast?.(m => toast(m, 5000));
  // Descriptions, years and developers arrive from the LaunchBox database after the library shows.
  api.onLibraryInfo?.(changed => {
    for (const c of changed || []) { const g = S.games.find(x => x.id === c.gameId); if (g) g.info = c.info; }
    showGame(S.list[S.sel]);
  });
  api.onRecompProgress?.(p => {
    if (p.done) return;
    // Installs and updates run one at a time, so this is the running queue job's progress.
    // The stage is left out when it only repeats the job ("Installing X" · "Installing…") or is the download itself.
    const first = s => String(s).toLowerCase().split(/[^a-z]/)[0];
    // Each update's progress carries its key, so one that stepped back still shows how far it got on its own row.
    const job = [Q.cur, ...Q.list].find(j => j?.pid && j.pid === p.gameId) || Q.cur;
    if (!job) return;
    job.downloading = /^(downloading|paused)/i.test(p.stage || '') && !(p.pct >= 1);
    jobProgress(!p.stage || /download/i.test(p.stage) || first(p.stage) === first(job.label) ? job.label : `${job.label} · ${p.stage}`, p.pct, job);
  });
  setFrozen();
}
init().catch(e => toast('OneDeck failed to start: ' + e.message, 10000));

// ---------- first start ----------
function openWelcome(setup) {
  $('#welcomeSetup').hidden = !setup; $('#welcomeStart').hidden = setup;
  if (setup) {
    S.wDirs = {};  // folders picked here, saved on Next
    $('#wAuto').value = autoMediaOn() ? '1' : '0'; $('#wView').value = view();
    api.installDirs().then(d => {
      $('#wDirPorts').textContent = $('#wDirPorts').title = d.ports; $('#wDirEmus').textContent = $('#wDirEmus').title = d.emulators;
      $('#wDirGames').textContent = $('#wDirGames').title = d.games;
    }).catch(() => {});
  }
  UISound.play('open'); $('#welcomeDlg').showModal();
}
for (const [btn, kind, out] of [['#wDirPortsBtn', 'ports', '#wDirPorts'], ['#wDirEmusBtn', 'emulators', '#wDirEmus'], ['#wDirGamesBtn', 'games', '#wDirGames']]) $(btn).onclick = async () => {
  try { const p = await api.pickInstallDir(kind, { save: false }); if (p) { S.wDirs[kind] = p; $(out).textContent = $(out).title = p; } } catch (e) { UISound.play('error'); toast(e.message, 6000); }
};
$('#welcomeNext').onclick = async () => {
  UISound.play('select');
  for (const [kind, dir] of Object.entries(S.wDirs || {})) await api.setInstallDir({ kind, dir }).catch(e => toast(e.message, 6000));
  // the folders made where they aren't yet, the games folder with one per console inside
  try { await api.makeWelcomeFolders(); S.config = await api.getConfig(); } catch (e) { toast(e.message, 6000); }
  showInstallDirs();
  await saveSetting({ harbourAutoMedia: $('#wAuto').value === '1', harbourWelcomed: true });
  if ($('#wView').value !== view()) await setView($('#wView').value);
  autoMedia();
  showWelcomeStart();
};
// Cancel (or Esc): nothing changes, and it isn't asked again.
$('#welcomeCancel').onclick = () => { UISound.play('back'); $('#welcomeDlg').close(); };
$('#welcomeDlg').addEventListener('close', () => { if (!S.config.harbourWelcomed) saveSetting({ harbourWelcomed: true }); });
// The welcome's second step: the Add menu's three ways in. Each opens that Add screen; finishing or Back comes back
// here, and what you have now gets a tick.
function showWelcomeStart() {
  $('#welcomeSetup').hidden = true; $('#welcomeStart').hidden = false;
  // ticked once there's something: a game found in a games folder (empty console folders don't count), a port, an emulator
  const has = { roms: S.games.some(g => !g.recomp && g.system !== 'pc'), port: S.games.some(g => g.recomp), emu: (S.config.customEmulators || []).length > 0 };
  for (const b of document.querySelectorAll('#welcomeStart .choice')) b.classList.toggle('done', !!has[b.dataset.wkind]);
  if (!$('#welcomeDlg').open) $('#welcomeDlg').showModal();
  $('#welcomeStart .choice')?.focus();
}
const backToWelcome = () => { if (S.welcoming && !S.pickingFolder) setTimeout(() => { if (!document.querySelector('dialog[open]')) showWelcomeStart(); }, 50); };
for (const b of document.querySelectorAll('#welcomeStart .choice')) b.onclick = async () => {
  UISound.play('select'); S.welcoming = true; $('#welcomeDlg').close();
  await openAdd();
  if (b.dataset.wkind === 'roms') showAddStep('addRoms'); else if (b.dataset.wkind === 'port') showPortCatalog(); else showEmuCatalog();
};
$('#addDlg').addEventListener('close', backToWelcome);
$('#welcomeBack').onclick = () => { UISound.play('back'); openWelcome(true); };
$('#welcomeLater').onclick = () => { UISound.play('select'); S.welcoming = false; $('#welcomeDlg').close(); };

// ---------- installing well-known emulators ----------
// The catalogue step of ＋ → Emulator: each one with an Install button (or "Set up" once it's there).
async function showEmuCatalog() {
  showAddStep('addEmuPick');
  const list = await api.emulatorCatalog().catch(() => []);
  const counts = {};
  for (const g of S.games) counts[g.system] = (counts[g.system] || 0) + 1;
  // Under a heading for the console(s) each plays: consoles you have games for first, then in release order.
  const has = c => Number(c.consoles.some(x => counts[x]));
  list.sort((a, b) => (has(b) - has(a)) || (releaseRank(a.consoles[0]) - releaseRank(b.consoles[0])));
  const out = []; let heading = null;
  for (const c of list) {
    const h = c.consoles.map(sysName).join(' · ');
    if (h !== heading) { heading = h; out.push(el('h4', 'emu-group', h)); }
    const card = el('div', 'emu-cat');
    const info = el('div', 'emu-cat-info');
    info.append(el('b', '', c.name), el('small', '', c.note || ''));
    const btn = el('button'); btn.type = 'button'; btn.dataset.id = c.id; btn.dataset.installed = c.installed ? '1' : '';
    btn.onclick = () => installEmulator(c);
    catalogButton(btn);
    // Credit where it's due: each emulator's own website, next to its Install button.
    const site = el('button', '', 'Website'); site.type = 'button'; site.title = `${c.name}'s website (opens in your browser)`;
    site.onclick = () => window.open(c.site);
    const btns = el('span', 'btn-pair'); btns.append(site, btn);
    card.append(info, c.site ? btns : btn);
    out.push(card);
  }
  $('#emuCatalog').replaceChildren(...out);
  $('#emuCatalog').querySelector('button:not([disabled])')?.focus();
}
// Installs the catalogue's emulator for each of these consoles that has none. True when they all have one after.
async function installFor(systems) {
  const catalog = await api.emulatorCatalog().catch(() => []);
  const picks = [...new Set(systems.map(id => catalog.find(c => c.consoles.includes(id))).filter(Boolean))];
  if (!picks.length) { toast(`No emulator OneDeck knows plays ${systems.map(sysName).join(', ')}. Add one with ＋ → Emulator.`, 6000); return false; }
  try {
    for (const c of picks) {
      // Installed already but not set for this console: just use it.
      if (c.installed) { for (const id of systems.filter(id => c.consoles.includes(id))) await api.setSystemEmulator({ system: id, emulator: c.installed }).catch(() => {}); S.config = await api.getConfig(); await loadEmulators(false); continue; }
      if (!(await installEmulator(c))) return false;
    }
    const ok = systems.every(id => emuDef(id));
    if (!ok) toast("The emulator is set up but its program wasn't found. Fix it in Settings → Emulators.", 6000);
    return ok;
  } finally { renderRow(); select(S.sel, true); }
}
const emuDef = sysId => (S.emus || []).some(e => e.id === S.config.systems.find(s => s.id === sysId)?.emulator && e.exe);
// ---------- the download queue ----------
// Everything Harbour downloads (emulator installs, updates, artwork, game clips) waits its turn and runs one at a
// time, in the order asked for. One quiet badge shows what's running and how many are waiting; a failure gets a
// badge of its own and the queue carries on. Asking for something already waiting just waits for that one.
// Downloads work like Steam's: one job runs at a time (cur), the rest wait in list ("up next"). Pause holds the running
// download where it is and starts nothing else (S.dlPaused). Update on any other one starts it now, at the top, and the
// one that was downloading steps back to up next, keeping what it had. pid: the key its progress messages carry.
// held: ones you took out of the queue (✕), with whatever they'd downloaded; Update or ↑ brings them back.
const Q = { list: [], cur: null, held: [], finished: 0, lastDone: '' };
const jobState = key => Q.cur?.key === key ? 'running' : Q.list.some(j => j.key === key) ? 'queued' : Q.held.some(j => j.key === key) ? 'held' : null;
const findJob = key => [Q.cur, ...Q.list, ...Q.held].find(j => j?.key === key);
// run(job) does the work and returns { done: 'message' } (or { fail: 'message' }, or { quiet: true } when there
// was nothing to do). Resolves true when it worked.
function enqueue(key, label, run, extra = {}) {
  const known = findJob(key);
  if (known) return known.promise;
  const job = { key, label, run, text: label, pct: 0, ...extra };
  job.promise = new Promise(resolve => { job.resolve = resolve; });
  Q.list.push(job);
  queueChanged(); pumpQueue();
  return job.promise;
}
function pumpQueue() {
  if (Q.cur || !Q.list.length || S.dlPaused) return;
  const job = Q.cur = Q.list.shift();
  queueChanged();
  // One that stepped back partway carries on from where its download stopped; a new one starts.
  if (job.started) api.pauseDownload(job.pid, false).catch(() => {});
  else { job.started = true; runJob(job); }
}
async function runJob(job) {
  let ok = false;
  try {
    const r = (await job.run(job)) || {};
    if (r.fail) { UISound.play('error'); Activity.fail('fail-' + job.key, r.fail); }
    else if (!r.quiet && isUpdateJob(job)) {
      // An update's done: a tick on the updates pill for a moment (not the activity chip).
      ok = true; S.pillFlash = { text: r.done || `${job.label}: done`, until: Date.now() + 2600 };
      setTimeout(showUpdatePill, 2700);
    }
    else if (!r.quiet) { ok = true; Q.finished++; Q.lastDone = r.done || `${job.label}: done`; }
  } catch (e) { UISound.play('error'); Activity.fail('fail-' + job.key, `${job.label}: ${e.message}`); }
  if (Q.cur === job) Q.cur = null;
  Q.list = Q.list.filter(j => j !== job); Q.held = Q.held.filter(j => j !== job);
  job.resolve(ok);
  if (!Q.cur && !Q.list.length) {
    if (Q.finished) Activity.done('queue', Q.finished > 1 ? `All done: ${Q.finished} downloads` : Q.lastDone);
    else Activity.end('queue', '', 'ok', '', 1);
    Q.finished = 0;
  }
  queueChanged(); pumpQueue();
}
// A button whose job is waiting or running: a spinning circle in place of its words (and how far, once it's going).
function spinnerButton(btn, label, pct = 0) {
  btn.classList.add('waiting'); btn.disabled = true; btn.title = label; btn.setAttribute('aria-label', label);
  btn.replaceChildren(el('span', 'spinner'), ...(pct > 0 && pct < 1 ? [`${Math.round(pct * 100)}%`] : []));
}
// How far the running job is: the badge, and its button in the Updates window.
function jobProgress(text, pct = 0, job = Q.cur) {
  if (!job) return;
  job.text = text; job.pct = pct;
  if (job !== Q.cur) return;  // one that stepped back: its row shows how far it got
  showQueueBadge();
  const btn = document.querySelector(`#updList button[data-key="${job.key}"]`);
  // Downloading: its Pause button counts up in place (redrawing would knock a controller's selection off it).
  if (job.downloading) { if (btn?.dataset.pause) btn.textContent = `${S.dlPaused ? 'Resume' : 'Pause'}${pct > 0 && pct < 1 ? ` ${Math.round(pct * 100)}%` : ''}`; else if ($('#updatesDlg').open) renderUpdates(); }
  else if (btn) spinnerButton(btn, 'Updating', pct);
  if (job.c) document.querySelectorAll(`#emuCatalog button[data-id="${job.c.id}"]`).forEach(catalogButton);
}
// Pause / Resume: the running download holds where it is (unpacking and copying are quick and finish), and nothing new
// starts until Resume. Only for this session.
function setDownloadsPaused(on) {
  S.dlPaused = on;
  const cur = Q.cur;
  if (cur?.pid && cur.started) api.pauseDownload(cur.pid, on).catch(() => {});
  UISound.play(on ? 'back' : 'select');
  queueChanged(); if (!on) pumpQueue();
  if (cur) keepOnRow(cur);
}
// ✕: out of the queue, to Not queued at the bottom. The one downloading keeps what it had and the next one starts;
// one that's unpacking finishes first. Update or ↑ on it later brings it back.
function unqueue(job) {
  if (!job || jobState(job.key) === 'held') return;
  if (job === Q.cur) { if (!job.downloading || !job.pid) return; api.pauseDownload(job.pid, true).catch(() => {}); Q.cur = null; }
  else Q.list = Q.list.filter(j => j !== job);
  Q.held.push(job);
  UISound.play('back'); queueChanged(); pumpQueue(); keepOnRow(job);
}
// After a press the row's button changes: the selection stays on it.
const keepOnRow = job => $('#updList').querySelector(`button[data-key="${CSS.escape(job.key)}"]`)?.focus();
// Update on one that isn't downloading: it goes to the top and starts now, and downloads resume. The one that was
// downloading steps back to the front of up next and keeps what it had; one that's unpacking finishes first.
function startNow(job) {
  if (!job || job === Q.cur) return;
  Q.held = Q.held.filter(j => j !== job);
  Q.list = [job, ...Q.list.filter(j => j !== job)];
  const cur = Q.cur;
  if (cur?.downloading && cur.pid) {
    api.pauseDownload(cur.pid, true).catch(() => {});
    Q.cur = null; Q.list.splice(1, 0, cur);
  }
  if (S.dlPaused) { S.dlPaused = false; }
  UISound.play('select'); queueChanged(); pumpQueue(); keepOnRow(job);
}
function showQueueBadge() {
  showUpdatePill();
  // Updates show on the updates pill; the activity chip is for everything else (artwork, installs).
  if (isUpdateJob(Q.cur) || (!Q.cur && S.dlPaused && Q.list.some(isUpdateJob))) { Activity.clear('queue'); return; }
  const j = Q.cur;
  if (!j) { if (S.dlPaused && Q.list.length) Activity.set('queue', `Downloads paused · ${Q.list.length} up next`, 0); return; }
  if (S.dlPaused) { Activity.set('queue', `Paused · ${j.label}`, j.pct); return; }
  const pct = j.pct > 0 && j.pct < 1 ? ` ${Math.round(j.pct * 100)}%` : '';
  // The waiting count goes first so a long status line can't cut it off.
  Activity.set('queue', (Q.list.length ? `${Q.list.length} queued · ` : '') + j.text + pct, j.pct);
}
// Everything that shows the queue: the badge, the install list's buttons, Manage and the Updates window.
function queueChanged() {
  showQueueBadge();
  document.querySelectorAll('#emuCatalog button[data-id]').forEach(catalogButton);
  if ($('#emusDlg').open) renderEmulators();
  if ($('#updatesDlg').open) renderUpdates();
}
// The badges and toasts stay in front of open windows: windows sit in the browser's top layer, so these join it
// (as popovers) and step back in front each time a window opens.
const raiseNotices = () => { for (const n of [$('#hints'), $('#activity'), $('#toast')]) try { if (n.matches(':popover-open')) n.hidePopover(); n.showPopover(); } catch {} };
{
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () { showModal.call(this); raiseNotices(); renderHints(); };
  raiseNotices();
}

// Emulator installs (＋ → Emulator, Manage, the Install button on a game).
function installEmulator(c) {
  return enqueue('install:' + c.id, `Installing ${c.name}`, async () => {
    const r = await api.installEmulator(c.id);
    UISound.play('select');
    document.querySelectorAll(`#emuCatalog button[data-id="${c.id}"]`).forEach(b => { b.dataset.installed = '1'; });
    if (r.note) toast(`${c.name}: ${r.note}`, 6000);
    S.config = await api.getConfig();
    await loadEmulators(false); renderRow(); select(S.sel, true);
    return { done: `${c.name} installed` };
  }, { c });
}
const installState = id => ({ running: 'installing', queued: 'queued' })[jobState('install:' + id)] || null;
const installsPending = () => [Q.cur, ...Q.list].filter(j => j?.c).map(j => j.c);
function catalogButton(btn) {
  const st = btn.dataset.installed ? 'installed' : installState(btn.dataset.id);
  btn.className = st ? '' : 'primary'; btn.removeAttribute('title');
  if (st === 'installing' || st === 'queued') return spinnerButton(btn, st === 'installing' ? 'Installing' : 'Queued', st === 'installing' ? Q.cur?.pct : 0);
  btn.textContent = st === 'installed' ? 'Installed' : 'Install';
  btn.disabled = !!st;
}
// From the install list back to your emulators (Manage), and the other way with "＋ Add emulators".
$('#emuManage').onclick = () => { UISound.play('select'); $('#addDlg').close(); openEmulators(); };
$('#emuOwn').onclick = () => { UISound.play('select'); showAddStep('addEmu'); };

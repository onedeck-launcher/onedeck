// Harbour: settings, library scanning, artwork, launching, recomp updates and game videos.
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, net } = require('electron');
if (process.platform === 'win32') app.commandLine.appendSwitch('force-high-performance-gpu');
app.setName('OneDeck');
// Settings kept by the window (like what's already been looked up) stay in an older folder (AnyDeck, AnyDock,
// Harbour) when there is one.
{ const appData = app.getPath('appData'), p = require('path'), fs = require('fs');
  const older = ['AnyDeck', 'AnyDock', 'Harbour'].map(n => p.join(appData, n)).find(d => fs.existsSync(d));
  if (older && !fs.existsSync(p.join(appData, 'OneDeck'))) app.setPath('userData', older); }
if (process.platform === 'win32') app.setAppUserModelId('local.harbour.launcher');
// Harbour stays open behind a running game. Without this, Windows reports the covered window as
// hidden and Chromium stops reading controllers, so "hold to quit" would never be seen.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { randomUUID, createHash } = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { createArtworkService } = require('./artwork');
const { createLaunchBox } = require('./launchbox');
const { createVideoService } = require('./videos');
const { CATALOG } = require('./emulators');
const compat = require('./compat');
const { createCloudSaves } = require('./cloudsaves');
const { createSaveFolders } = require('./savefolders');

const ROOT = __dirname;
const PACKAGE = require('./package.json');
const APP_VERSION = PACKAGE.version;
// Settings, artwork, videos and logs live in data\: next to Harbour.exe in a release (so an update, which replaces
// Harbour's own files, never touches them), or in the source folder when run from there. The Linux AppImage is one
// read-only file, so its data goes in an OneDeck folder in your home (with Games, Ports and Emulators beside it),
// unless a data folder sits next to the AppImage (a portable copy, like the Windows folder).
function appImageData() {
  const beside = path.join(path.dirname(process.env.APPIMAGE), 'data');
  return fs.existsSync(beside) ? beside : path.join(os.homedir(), 'OneDeck', 'data');
}
const DATA = !app.isPackaged ? path.join(ROOT, 'data') : process.env.APPIMAGE ? appImageData() : path.join(path.dirname(process.execPath), 'data');
const LOG_PATH = path.join(DATA, 'logs', 'harbour.log');
function log(...parts) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    try { if (fs.statSync(LOG_PATH).size > 512 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.old'); } catch {}
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`);
  } catch {}
}
log(`start ${APP_VERSION}`, { electron: process.versions.electron });
process.on('uncaughtExceptionMonitor', e => log('error', e?.stack || String(e)));
app.on('child-process-gone', (_e, d) => log('child process gone', d));
app.on('render-process-gone', (_e, _w, d) => log('window process gone', d));
app.whenReady().then(() => log('ready')).catch(e => log('not ready', e?.stack || String(e)));
const CONFIG_PATH = path.join(DATA, 'config.json');
const UA = { 'User-Agent': 'OneDeck', Accept: 'application/vnd.github+json' };

// ---------- Systems ----------
// Each console: its file types, colour (for cards without art) and libretro name (for artwork).
const DEFAULT_SYSTEMS = [
  // Sony
  { id: 'ps1', name: 'PlayStation', color: '#9aa3ad', extensions: ['.m3u', '.cue', '.chd', '.pbp'], emulator: '', libretro: 'Sony - PlayStation' },
  { id: 'ps2', name: 'PlayStation 2', color: '#1d3f8f', extensions: ['.iso', '.chd', '.cso', '.gz'], emulator: '', libretro: 'Sony - PlayStation 2' },
  { id: 'ps3', name: 'PlayStation 3', color: '#2b2b2b', extensions: ['.iso'], emulator: '', libretro: 'Sony - PlayStation 3' },
  { id: 'ps4', name: 'PlayStation 4', color: '#1a4fb5', extensions: ['.pkg'], emulator: '' },
  { id: 'psp', name: 'PSP', color: '#111111', extensions: ['.iso', '.cso', '.chd'], emulator: '', libretro: 'Sony - PlayStation Portable' },
  // Nintendo
  { id: 'switch', name: 'Nintendo Switch', color: '#e60012', extensions: ['.nsp', '.xci', '.nsz'], emulator: '', artworkProvider: 'gametdb-switch' },
  { id: 'switch2', name: 'Nintendo Switch 2', color: '#d0021b', extensions: ['.nsp', '.xci', '.nsz', '.xcz', '.nup'], emulator: '', artworkProvider: 'gametdb-switch' },
  { id: 'wiiu', name: 'Wii U', color: '#1a9ad6', extensions: ['.wua', '.wud', '.wux', '.rpx'], emulator: '', libretro: 'Nintendo - Wii U' },
  { id: 'wii', name: 'Wii', color: '#e9eef2', extensions: ['.rvz', '.wbfs', '.iso'], emulator: '', libretro: 'Nintendo - Wii' },
  { id: 'gc', name: 'GameCube', color: '#5a4a9c', extensions: ['.rvz', '.iso', '.gcm', '.ciso'], emulator: '', libretro: 'Nintendo - GameCube' },
  { id: 'n64', name: 'Nintendo 64', color: '#2a7d3a', extensions: ['.z64', '.n64', '.v64'], emulator: '', libretro: 'Nintendo - Nintendo 64' },
  { id: 'snes', name: 'Super Nintendo', color: '#7b6fb5', extensions: ['.sfc', '.smc'], emulator: '', libretro: 'Nintendo - Super Nintendo Entertainment System' },
  { id: 'nes', name: 'NES', color: '#c4262e', extensions: ['.nes', '.zip'], emulator: '', libretro: 'Nintendo - Nintendo Entertainment System' },
  { id: '3ds', name: 'Nintendo 3DS', color: '#d41e2a', extensions: ['.3ds', '.cci', '.cxi', '.cia'], emulator: '', libretro: 'Nintendo - Nintendo 3DS' },
  { id: 'nds', name: 'Nintendo DS', color: '#c9c9c9', extensions: ['.nds', '.zip'], emulator: '', libretro: 'Nintendo - Nintendo DS' },
  { id: 'gba', name: 'Game Boy Advance', color: '#4b3a9b', extensions: ['.gba', '.zip'], emulator: '', libretro: 'Nintendo - Game Boy Advance' },
  { id: 'gbc', name: 'Game Boy Color', color: '#7a3fb0', extensions: ['.gbc', '.zip'], emulator: '', libretro: 'Nintendo - Game Boy Color' },
  { id: 'gb', name: 'Game Boy', color: '#8b8f6a', extensions: ['.gb', '.zip'], emulator: '', libretro: 'Nintendo - Game Boy' },
  // Sega / Microsoft / other
  { id: 'dreamcast', name: 'Dreamcast', color: '#e8e8e8', extensions: ['.chd', '.gdi', '.cdi'], emulator: '', libretro: 'Sega - Dreamcast' },
  { id: 'genesis', name: 'Sega Genesis', color: '#1b1b1b', extensions: ['.md', '.gen', '.smd', '.zip'], emulator: '', libretro: 'Sega - Mega Drive - Genesis' },
  { id: 'xbox', name: 'Xbox', color: '#1c8a2e', extensions: ['.iso', '.xiso'], emulator: '', libretro: 'Microsoft - Xbox' },
  { id: 'x360', name: 'Xbox 360', color: '#7cbb00', extensions: ['.iso', '.xex', '.zar'], emulator: '', libretro: 'Microsoft - Xbox 360' },
  // PC: a folder of shortcuts (.lnk, Steam .url, Linux .desktop) or game programs. Games start directly, no emulator.
  { id: 'recomp', name: 'Recomp', color: '#a685ff', extensions: ['.exe'], emulator: '', direct: true },
  { id: 'pc', name: 'PC Games', color: '#3b82f6', extensions: ['.lnk', '.url', '.exe', '.desktop', '.sh', '.appimage'], emulator: '', direct: true },
  { id: 'a2600', name: 'Atari 2600', color: '#a0522d', extensions: ['.a26', '.zip'], emulator: '', libretro: 'Atari - 2600' },
  { id: 'arcade', name: 'Arcade', color: '#d4a017', extensions: ['.zip'], emulator: '', libretro: 'MAME' },
];
// Folders inside ROM folders that hold extras rather than games.
const SKIP_DIRS = /^(source archives|_extras|extras|texture packs|saves?|states|bios|cheats|patches|media|images|manuals|downloaded_media|covers|screenshots)$/i;

function defaultConfig() {
  return {
    fullscreen: false,
    systems: DEFAULT_SYSTEMS.map(s => ({ ...s, romDir: '' })),
    emulators: {},        // per emulator: { exe } when its program was moved
    customEmulators: [],  // { id, name, exe, args, systems: [] }
    extraGames: [],       // games added one by one: { id, system, path, title } (+ recomp fields)
  };
}

let configWarning = null;
function loadConfig() {
  let text;
  try { text = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { return defaultConfig(); } // first run
  try {
    const saved = JSON.parse(text);
    if (!saved || !Array.isArray(saved.systems)) throw new Error('missing systems');
    saved.emulators ||= {};
    saved.customEmulators ||= [];
    saved.extraGames ||= [];
    const def = defaultConfig();
    // Keep new default systems appearing for older configs.
    const ids = new Set(saved.systems.map(s => s.id));
    for (const s of def.systems) if (!ids.has(s.id)) saved.systems.push(s);
    // Fill in fields added in newer versions (libretro name, case shape…).
    saved.systems = saved.systems.map(s => ({ ...(def.systems.find(d => d.id === s.id) || {}), ...s }));
    // File types added to a built-in system after release reach existing settings once; a type the
    // user removes afterwards stays removed.
    const done = new Set(saved.migrations || []);
    for (const [key, sysId, ext] of [['ext-switch2-nup', 'switch2', '.nup']]) {
      if (done.has(key)) continue;
      const sys = saved.systems.find(s => s.id === sysId);
      if (sys && Array.isArray(sys.extensions) && !sys.extensions.includes(ext)) sys.extensions = [...sys.extensions, ext];
      done.add(key);
    }
    saved.migrations = [...done];
    // A console set to an emulator that isn't set up (older settings named built-in ones) has none.
    const known = new Set((saved.customEmulators || []).map(e => e.id));
    for (const s of saved.systems || []) if (s.emulator && !known.has(s.emulator)) s.emulator = '';
    return { ...def, ...saved };
  } catch (e) {
    // Keep the damaged file instead of letting the next save overwrite it with defaults.
    const backup = `${CONFIG_PATH}.broken-${Date.now()}`;
    try { fs.copyFileSync(CONFIG_PATH, backup); } catch {}
    console.error(`config.json could not be read (${e.message}); a copy was kept at ${backup}`);
    configWarning = `Your settings file was damaged, so defaults were loaded. The old file was kept as ${path.basename(backup)} in the data folder.`;
    return defaultConfig();
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  // Write to a temp file and swap it in, so a crash mid-save can't leave a half-written config.
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}
let config = loadConfig();

// ---------- Library state: favourites, play time, last selection ----------
// Kept apart from config.json: it changes after every game and every selection, and the window's
// "Save & rescan" (which sends a whole config) must never overwrite it.
const STATE_PATH = path.join(DATA, 'library-state.json');
const emptyState = () => ({ favorites: {}, hidden: {}, titles: {}, metadata: {}, order: {}, stats: {}, discs: {}, ui: {} });
function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); return { ...emptyState(), ...(s && typeof s === 'object' ? s : {}) }; }
  catch { return emptyState(); }
}
let libraryState = loadState(), stateTimer = null;
function writeState() {
  clearTimeout(stateTimer); stateTimer = null;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(libraryState));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { console.error(`library-state.json could not be saved: ${e.message}`); }
}
const saveState = () => { clearTimeout(stateTimer); stateTimer = setTimeout(writeState, 800); };
// What the window needs to know about one game: favourite, hidden, play time, last played, chosen disc.
function gameState(id) {
  const st = libraryState.stats[id] || {};
  const metadata = libraryState.metadata?.[id] || {};
  const customTitle = metadata.title || libraryState.titles?.[id] || '';
  return { ...metadata, customTitle, hidden: !!libraryState.hidden?.[id], favorite: !!libraryState.favorites[id], noVideo: !!libraryState.noVideo?.[id], noBox: !!libraryState.noBox?.[id], noBackground: !!libraryState.noBackground?.[id], playMs: st.ms || 0, lastPlayed: st.last || 0, plays: st.plays || 0, disc: libraryState.discs[id] || 0 };
}

// ---------- Library scanning ----------
const IMG = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
// For each media kind: names used in per-game folders, and ES-DE / Skraper style folder names.
const KINDS = {
  front:      { names: ['front', 'cover', 'box-front', 'boxfront', 'box'], folders: ['covers', 'box2dfront', 'boxart'], exts: IMG },
  frontHQ:    { names: ['front-hq'], folders: ['cover-hq'], exts: IMG },
  back:       { names: ['back', 'box-back', 'boxback'], folders: ['backcovers', 'box2dback'], exts: IMG },
  spine:      { names: ['spine', 'box-spine', 'side'], folders: ['spines', 'box2dside'], exts: IMG },
  disc:       { names: ['disc', 'cd', 'cart', 'cartridge', 'media', 'physicalmedia'], folders: ['physicalmedia', 'discs', 'support'], exts: IMG },
  manual:     { names: ['manual'], folders: ['manuals'], exts: ['.pdf'] },
  screenshot: { names: ['screenshot', 'snap', 'screen'], folders: ['screenshots', 'snaps', 'images'], exts: IMG },
  title:      { names: ['title', 'titlescreen'], folders: ['titlescreens', 'titles'], exts: IMG },
  fanart:     { names: ['fanart', 'background', 'bg'], folders: ['fanart', 'backgrounds'], exts: IMG },
  logo:       { names: ['logo', 'marquee', 'wheel'], folders: ['marquees', 'wheel', 'logos'], exts: IMG },
  video:      { names: ['video', 'trailer'], folders: ['videos'], exts: ['.mp4', '.webm'] },
};

// During a scan each folder is listed once: the ROM walk, the media index and the per-game media
// lookup all ask for the same folders, and on a hard drive every listing costs a seek.
let scanListings = null;
async function listDir(dir) {
  const cache = scanListings, key = cache && dir.toLowerCase();
  if (cache?.has(key)) return cache.get(key);
  const listing = fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  cache?.set(key, listing);
  return listing;
}
// Runs fn over items with at most `limit` running at once, results in input order. Scans are mostly
// waiting on the disk, so overlapping the waits is where the time goes.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const SCAN_CONCURRENCY = 16;
const stem = f => path.basename(f, path.extname(f)).toLowerCase();
const fileUrl = p => (p ? pathToFileURL(p).href : null);

// Leftover format tags in a file name: "Crash Nitro Kart (USA).xiso.iso" leaves ".xiso" once ".iso" is taken off.
const FORMAT_TAG = /(\.(xiso|iso|cso|zso|chd|rvz|wbfs|gcm|ciso|nsp|xci|nsz|bin|cue|img|z64|n64|v64|nds|3ds|cia|gba|gbc|gb|sfc|smc|nes))+$/i;
function cleanTitle(name) {
  return name.replace(FORMAT_TAG, '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')
    .replace(/_/g, ' ')
    .replace(/^\d{3,5}\s*-?\s+(?=\S)/, '')          // release numbers: "0004 - Zelda", "1158 Zelda"
    .replace(/\s*\b(decrypted|encrypted)\b\s*$/i, '')
    .replace(/\s+/g, ' ').trim() || name;
}
// "Legend of Zelda, The - Ocarina" -> "The Legend of Zelda - Ocarina" (display only)
const displayTitle = s => cleanTitle(s).replace(/^(.+?),? (The|A|An)(?= - |$)/, '$2 $1');

// Index a media root once: folder-per-game dirs + ES-DE style kind folders.
// Kind folders (covers, manuals…) are found directly in a root or one level down, so extras kept
// in e.g. "00 Goodies\Manuals" are picked up too. Files are matched by exact name, then loosely by
// title ("Game (USA).pdf" for "Game (USA) (Rev 1).rvz").
async function indexMediaRoot(root) {
  // files: every file seen in a kind folder (lower-case path), so side files such as a disc's
  // .json can be checked without trying to read files that aren't there.
  const idx = { gameDirs: new Map(), kinds: {}, loose: {}, files: new Set() };
  const kindOf = name => Object.entries(KINDS).find(([, k]) => k.folders.includes(name.toLowerCase()));
  async function addKindFolder(dir, [kind, k], entries) {
    const m = (idx.kinds[kind] ||= new Map()), loose = (idx.loose[kind] ||= new Map());
    for (const f of entries ?? await listDir(dir)) {
      if (f.isFile()) idx.files.add(path.join(dir, f.name).toLowerCase());
      if (!f.isFile() || !k.exts.includes(path.extname(f.name).toLowerCase())) continue;
      const file = path.join(dir, f.name);
      if (!m.has(stem(f.name))) m.set(stem(f.name), file);
      const key = looseKey(path.basename(f.name, path.extname(f.name)));
      for (const k of [key, bareKey(path.basename(f.name, path.extname(f.name)))]) if (k && !loose.has(k)) loose.set(k, file);
    }
  }
  // Folders are listed in parallel but added in their listed order, so "first match wins" is unchanged.
  const dirs = (await listDir(root)).filter(e => e.isDirectory());
  const listed = await mapLimit(dirs, SCAN_CONCURRENCY, async e => {
    const kind = kindOf(e.name), dir = path.join(root, e.name);
    if (kind) return { kind, dir, entries: await listDir(dir) };
    const subs = (await listDir(dir)).filter(sub => sub.isDirectory() && kindOf(sub.name));
    return { dir, subs: await Promise.all(subs.map(async sub => ({ kind: kindOf(sub.name), dir: path.join(dir, sub.name), entries: await listDir(path.join(dir, sub.name)) }))) };
  });
  for (const [i, e] of dirs.entries()) {
    const l = listed[i];
    if (l.kind) { await addKindFolder(l.dir, l.kind, l.entries); continue; }
    idx.gameDirs.set(e.name.toLowerCase(), l.dir);
    for (const sub of l.subs) await addKindFolder(sub.dir, sub.kind, sub.entries);
  }
  return idx;
}

async function findMedia(indexes, base) {
  const key = base.toLowerCase();
  const media = {}, seen = new Set();
  let info = null;
  for (const idx of indexes) {
    const dir = idx.gameDirs.get(key) || idx.gameDirs.get(cleanTitle(base).toLowerCase());
    if (dir) {
      const files = (await listDir(dir)).filter(f => f.isFile());
      for (const f of files) seen.add(path.join(dir, f.name).toLowerCase());
      for (const [kind, k] of Object.entries(KINDS)) {
        if (media[kind]) continue;
        const hit = k.names.map(name=>files.filter(f=>stem(f.name)===name&&k.exts.includes(path.extname(f.name).toLowerCase())).sort((a,b)=>(path.extname(a.name).toLowerCase()==='.png'?0:1)-(path.extname(b.name).toLowerCase()==='.png'?0:1))[0]).find(Boolean);
        if (hit) media[kind] = path.join(dir, hit.name);
      }
      const inf = files.find(f => f.name.toLowerCase() === 'info.json');
      if (inf && !info) try { info = JSON.parse(await fsp.readFile(path.join(dir, inf.name), 'utf8')); } catch {}
    }
    for (const [kind, m] of Object.entries(idx.kinds)) if (!media[kind] && m.has(key)) media[kind] = m.get(key);
  }
  const loose = looseKey(base);
  for (const k of [loose, bareKey(base)]) if (k) for (const idx of indexes) for (const [kind, m] of Object.entries(idx.loose || {})) if (!media[kind] && m.has(k)) media[kind] = m.get(k);
  // Whether a file next to the found media exists, from the folder listings already made.
  const has = p => { const lower = p.toLowerCase(); return seen.has(lower) || indexes.some(idx => idx.files?.has(lower)); };
  return { media, info, has };
}

// Minimal EmulationStation gamelist.xml reader.
async function readGamelist(dir) {
  const map = new Map();
  let xml;
  try { xml = await fsp.readFile(path.join(dir, 'gamelist.xml'), 'utf8'); } catch { return map; }
  const tag = (s, t) => { const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1].trim()) : undefined; };
  const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  for (const g of xml.match(/<game[\s>][\s\S]*?<\/game>/g) || []) {
    const p = tag(g, 'path'); if (!p) continue;
    const rd = tag(g, 'releasedate');
    map.set(stem(p), {
      title: tag(g, 'name'), description: tag(g, 'desc'), developer: tag(g, 'developer'),
      publisher: tag(g, 'publisher'), genre: tag(g, 'genre'), players: tag(g, 'players'),
      year: rd ? rd.slice(0, 4) : undefined,
    });
  }
  return map;
}

// Walk a ROM folder (and its sub-folders) collecting files with matching extensions.
const exists = p => fsp.access(p).then(() => true, () => false);
async function walkRoms(dir, exts, depth = 0, out = [], rootEntries) {
  const entries = rootEntries ?? await listDir(dir);
  // Decrypted Switch / Switch 2 dumps are folders: <game>\base\exefs\main (+ romfs), or <game>\exefs\main.
  // The whole folder counts as one game, launched through its exefs\main. Only folders that
  // actually contain base\ or exefs\ are checked, so normal folders cost no extra disk access.
  if (exts.includes('.nsp') && entries.some(e => e.isDirectory() && /^(base|exefs)$/i.test(e.name))) {
    for (const main of [path.join(dir, 'base', 'exefs', 'main'), path.join(dir, 'exefs', 'main')]) {
      if (!(await exists(main))) continue;
      const label = path.basename(dir).replace(/([a-z])([A-Z])/g, '$1 $2'); // DonkeyKongBananza -> Donkey Kong Bananza
      out.push({ name: label + '.dump', path: main, size: 9e9, dump: true });
      return out;
    }
  }
  // PS4 games are folders too: eboot.bin, with the game's name in sce_sys/param.sfo (folders are often just "CUSA01234").
  const eboot = exts.includes('.pkg') && entries.find(e => e.isFile() && e.name.toLowerCase() === 'eboot.bin');
  if (eboot) {
    const title = (await ps4Title(dir)) || path.basename(dir);
    out.push({ name: title.replace(/[™®©]/g, '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() + '.dump', path: path.join(dir, eboot.name), size: 9e9, dump: true });
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 4 && !SKIP_DIRS.test(e.name)) await walkRoms(p, exts, depth + 1, out); }
    else if (exts.includes(path.extname(e.name).toLowerCase())) {
      out.push({ name: e.name, path: p });
    }
  }
  return out;
}

// A PS4 game's name from its param.sfo: a small table of keys and values; TITLE is the name.
async function ps4Title(dir) {
  try {
    const b = await fsp.readFile(path.join(dir, 'sce_sys', 'param.sfo'));
    if (b.length < 20 || b.toString('latin1', 0, 4) !== '\x00PSF') return null;
    const keys = b.readUInt32LE(8), data = b.readUInt32LE(12), count = b.readUInt32LE(16);
    for (let i = 0; i < count && 20 + i * 16 + 16 <= b.length; i++) {
      const at = 20 + i * 16;
      const keyStart = keys + b.readUInt16LE(at), keyEnd = b.indexOf(0, keyStart);
      if (b.toString('latin1', keyStart, keyEnd) !== 'TITLE') continue;
      const start = data + b.readUInt32LE(at + 12), len = b.readUInt32LE(at + 4);
      return b.toString('utf8', start, start + len).replace(/\0+$/, '').trim() || null;
    }
  } catch {}
  return null;
}
// Loose key for matching names across naming schemes: "Pokémon - Ruby (U) [!]" -> "pokemonruby".
const looseKey = s => cleanTitle(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&|\band\b|\bthe\b/g, '').replace(/[^a-z0-9]/g, '');

// The same key without a leading brand ("Nickelodeon SpongeBob…", "DreamWorks Shrek…"), which
// manual and artwork collections often leave out. Only used as a last resort.
// Works on the original name, where "Nickelodeon's" and "Nickelodeon SpongeBob" can still be told apart.
const BRAND = /^\s*(disney\s*[-•]?\s*pixar|disney|pixar|dreamworks|nickelodeon|nicktoons)('s)?\b[\s:-]*/i;
const bareKey = name => { if (!BRAND.test(cleanTitle(name))) return ''; const b = looseKey(cleanTitle(name).replace(BRAND, '')); return b.length >= 6 ? b : ''; };

// Nintendo Switch dumps write the 16-digit title ID into the file name:
// "Game [0100ABCD12345000][v0].nsp". A game's update ends in …800 and its downloadable content in
// …1000 and up, so clearing the low 13 bits of any of them gives the base game's own ID. Nintendo
// never hands out a base ID inside that range, so two different games can never collide here.
const TITLE_ID = /\[([0-9a-f]{16})\]/i;
function switchTitleId(name) {
  const m = name.match(TITLE_ID);
  if (!m) return null;
  const id = BigInt('0x' + m[1]);
  // part: 0 = the game itself, 0x800 = its update, 0x1000 and up = one of its DLC packs.
  return { base: (id & ~0x1fffn).toString(16).padStart(16, '0'), part: Number(id & 0x1fffn) };
}
// Updates and DLC join the game they belong to instead of each becoming a game of their own.
const switchGroup = name => switchTitleId(name)?.base || '';
// A file's title ID: from its name ("[0100…]"), else from inside it (f.tid, read during the scan).
const fileTitleId = f => switchTitleId(f.name) || (f.tid ? switchTitleId(`[${f.tid}]`) : null);
// The title ID inside a Switch game whose name doesn't carry one: a dump folder's exefs/main.npdm (ACI0 block), or an
// NSP/NSZ's ticket ("<title id><key gen>.tik" in its file table). Copies of one game then become one entry, however
// they're named ("Mario Odyssey.nsp" and a "SMO-1.0.0" dump folder).
async function innerTitleId(f) {
  try {
    if (f.dump) {
      const b = await fsp.readFile(path.join(path.dirname(f.path), 'main.npdm'));
      if (b.toString('latin1', 0, 4) !== 'META') return null;
      const aci = b.readUInt32LE(0x70);
      return b.toString('latin1', aci, aci + 4) === 'ACI0' ? b.readBigUInt64LE(aci + 0x10).toString(16).padStart(16, '0') : null;
    }
    if (!/\.(nsp|nsz)$/i.test(f.name)) return null;
    const fh = await fsp.open(f.path, 'r');
    try {
      const b = Buffer.alloc(0x8000);
      await fh.read(b, 0, b.length, 0);
      if (b.toString('latin1', 0, 4) !== 'PFS0') return null;
      const count = b.readUInt32LE(4), names = 0x10 + count * 0x18;
      for (let i = 0; i < count && names < b.length; i++) {
        const start = names + b.readUInt32LE(0x10 + i * 0x18 + 0x10), end = b.indexOf(0, start);
        const m = b.toString('latin1', start, end).match(/^([0-9a-f]{16})[0-9a-f]{16}\.tik$/i);
        if (m) return m[1].toLowerCase();
      }
    } finally { await fh.close(); }
  } catch {}
  return null;
}

// When the same game appears more than once, keep the best copy.
function copyScore(f, titleIds) {
  const n = f.name;
  let s = 0;
  if (/\((u|usa|us|e|eu|europe|world|en)\b|\(usa?,|\[usa?\]|\(ue\)/i.test(n)) s += 4;
  if (/\((j|jp|japan)\)/i.test(n)) s -= 2;
  if (/\[!\]/.test(n)) s += 2;
  if (/\b(update|upd|dlc)\b|\[v[1-9]\d*\]|\(beta|\(proto|\(demo|\(hack|\[(b|h|t|o)\d*\]/i.test(n)) s -= 6;
  if (!/\.zip$/i.test(n)) s += 1;
  // Switch: the game itself is what you launch, so it beats its own update and DLC files.
  if (titleIds) { const id = fileTitleId(f); if (id) s += id.part === 0 ? 8 : -8; }
  if (f.dump) s -= 1;  // a properly named file of the same game names it better than a dump folder ("SMO-1.0.0")
  return s;
}

// Only tied copies need a size check. Keep the existing 9 GB cap on the tie-break.
// Sizes of tied copies are remembered in the library cache: on a hard drive (and with antivirus
// opening every .zip) reading them is most of a scan. A full rescan from Settings reads them again.
// knownSizes: from the cache; scanSizes: the sizes this scan used, saved for the next one.
let knownSizes = null, scanSizes = null, rereadSizes = false;
async function copySize(file) {
  if (file.size === undefined && !rereadSizes && knownSizes?.has(file.path)) file.size = knownSizes.get(file.path);
  if (file.size === undefined) {
    try { file.size = (await fsp.stat(file.path)).size; } catch { file.size = 0; }
  }
  if (!file.dump) scanSizes?.set(file.path, file.size);
  return Math.min(file.size, 9e9);
}

const romDirsOf = sys => [...new Set(String(sys.romDir || '').split('|')
  .map(folder => folder.trim().replace(/^"(.*)"$/, '$1').trim()).filter(Boolean))];
let libraryGames = [], savesMoved = false;
async function scanLibrary(folderReport) {
  if (!knownSizes) await readLibraryCache();
  const listings = scanListings = new Map(), sizes = scanSizes = new Map();
  rereadSizes = !!folderReport; // Settings' "Save & rescan" reads every size again
  try {
    const games = await scanFolders(folderReport, listings);
    knownSizes = sizes;
    lastScanChanged = writeLibraryCache(games.raw);
    return games.shown;
  } finally {
    if (scanListings === listings) scanListings = null;
    if (scanSizes === sizes) scanSizes = null;
  }
}
async function scanFolders(folderReport, listings) {
  const games = [];
  for (const sys of config.systems) {
    // A system can have several ROM folders (e.g. games split across two SD cards), separated by "|".
    // Folders that are missing - an SD card that isn't inserted - are skipped.
    const dirs = sys.id === 'recomp' ? [] : romDirsOf(sys);
    // Recomps sit on their original platform's shelf when one is set ("platform"), else on the Recomp shelf.
    const extras = (config.extraGames || []).filter(x => shelfOf(x) === sys.id && fs.existsSync(x.path));
    if (!dirs.length && !extras.length) continue;
    const exts = sys.extensions.map(e => e.toLowerCase());
    const files = [];
    // Direct-launch systems (PC) only look at the folder itself: game folders are full of helper programs.
    const scannedDirs = [];
    for (const [ri, dir] of dirs.entries()) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        const reason = error.code === 'ENOENT' ? 'Folder unavailable'
          : error.code === 'ENOTDIR' ? 'Path is not a folder' : 'Could not read folder';
        folderReport?.push({ system: sys.name, folder: dir, problem: reason });
        continue;
      }
      scannedDirs.push(dir);
      listings.set(dir.toLowerCase(), Promise.resolve(entries));
      const matches = (await walkRoms(dir, exts, sys.direct ? 4 : 0, [], entries))
        .filter(file => !/\(track \d+\)/i.test(file.name));
      for (const file of matches) files.push({ ...file, root: dir, rootIndex: ri });
      folderReport?.push({ system: sys.name, folder: dir, count: matches.length, extensions: exts });
    }
    for (const x of extras) {
      files.push({ name: path.basename(x.path), path: x.path, root: path.dirname(x.path), rootIndex: 'added-' + x.id, title: x.title, added: x.id, score: Infinity, recomp: x.system === 'recomp' });
    }
    if (!files.length) continue;
    // Prefer .m3u playlists over their individual discs.
    const m3u = new Set(files.filter(f => /\.m3u$/i.test(f.name)).map(f => looseKey(stem(f.name))));
    // Switch-style libraries group by title ID, so an update or a DLC pack never becomes its own game.
    const titleIds = ['.nsp', '.xci', '.nsz', '.xcz'].some(e => exts.includes(e));
    if (titleIds) await mapLimit(files.filter(f => !f.added && !TITLE_ID.test(f.name)), SCAN_CONCURRENCY, async f => { f.tid = await innerTitleId(f); });
    // Keep every copy that shares the top score; only those ties need their file sizes read,
    // and those reads all run together.
    const tops = new Map();
    for (const f of files) {
      // Games added one by one are named by their title: two Switch folder dumps are both called "main".
      const base = f.recomp ? f.name : f.added && f.title ? f.title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() : path.basename(f.name, path.extname(f.name));
      if (!/\.m3u$/i.test(f.name) && /\(disc \d+\)/i.test(base) && m3u.has(looseKey(base))) continue;
      // Games added one by one are always their own game (two Switch folder dumps are both called "main").
      const key = f.added ? f.added : (titleIds && fileTitleId(f)?.base) || looseKey(base) || base.toLowerCase();
      if (f.score !== Infinity) f.score = copyScore(f, titleIds);
      const top = tops.get(key);
      if (!top || top[0].score < f.score) tops.set(key, [f]);
      else if (top[0].score === f.score) top.push(f);
    }
    const tied = [...tops.values()].filter(t => t.length > 1 && t[0].score !== Infinity).flat();
    await mapLimit(tied, SCAN_CONCURRENCY, copySize);
    const best = new Map();
    for (const [key, top] of tops) {
      let pick = top[0];
      // The first copy wins unless a later one is strictly bigger (sizes capped at 9 GB).
      for (const f of top.slice(1)) if (pick.score !== Infinity && await copySize(pick) < await copySize(f)) pick = f;
      // An update or DLC file is never a game of its own: when its base game's file is there it was
      // grouped with it above; when it isn't (or the base file's name has no title ID), it's left out.
      if (titleIds && !pick.added && (fileTitleId(pick)?.part || 0) !== 0) continue;
      best.set(key, pick);
    }
    const roots = [...extras.filter(x => x.system === 'recomp').flatMap(x => [path.join(x.path, 'media'), x.path]), config.mediaRoot && path.join(config.mediaRoot, sys.id), ...scannedDirs.flatMap(d => [path.join(d, 'media'), d]), path.join(DATA, 'media', sys.id)].filter(Boolean);
    const indexes = await Promise.all(roots.map(indexMediaRoot));
    const gamelist = new Map();
    for (const d of scannedDirs) for (const [k, v] of await readGamelist(d)) if (!gamelist.has(k)) gamelist.set(k, v);
    // Multi-disc games without an .m3u: "Game (USA) (Disc 1).cue", "(Disc 2).cue"… become one game
    // with a disc list. Only discs of the same copy (same name apart from the disc number) are grouped.
    const discTag = /\s*\(dis[ck]\s*(\d+)[^)]*\)/i;
    for (const [key, chosen] of best) {
      const copy = n => path.basename(n, path.extname(n)).replace(discTag, '').toLowerCase();
      if (chosen.added || !discTag.test(chosen.name)) continue;
      const seen = new Map();
      for (const f of files) {
        if (f.added || /\.m3u$/i.test(f.name) || copy(f.name) !== copy(chosen.name)) continue;
        const n = Number(path.basename(f.name, path.extname(f.name)).match(discTag)?.[1]);
        if (n && !seen.has(n)) seen.set(n, f);
      }
      if (seen.size < 2) continue;
      const discs = [...seen].sort((a, b) => a[0] - b[0]);
      best.set(key, { ...discs[0][1], score: chosen.score, discs: discs.map(([n, f]) => ({ n, path: f.path })) });
    }
    // Games are matched to their media in parallel; results keep the order of `best`.
    games.push(...await mapLimit([...best.values()], SCAN_CONCURRENCY, async f => {
      // Games added one by one are named by their title: two Switch folder dumps are both called "main".
      const base = f.recomp ? f.name : f.added && f.title ? f.title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() : path.basename(f.name, path.extname(f.name));
      const { media, info, has } = await findMedia(indexes, base);
      const meta = { ...(gamelist.get(base.toLowerCase()) || {}), ...(info || {}), ...(f.title ? { title: f.title } : {}) };
      let shell = null;
      const shellFile = media.disc && media.disc.replace(/\.[^.\\/]+$/, '.json');
      if (shellFile && has(shellFile)) try { shell = JSON.parse(await fsp.readFile(shellFile, 'utf8')).shell || null; } catch {}
      return {
        id: `${sys.id}:${f.rootIndex ? f.rootIndex + ':' : ''}${path.relative(f.root, f.path)}`,
        system: sys.id,
        romPath: f.path,
        base,
        title: meta.title || displayTitle(base),
        ...(f.added ? { added: f.added } : {}),
        ...(f.recomp ? { recomp: true } : {}),
        ...(f.recomp && inPortsDir(config.extraGames.find(x => x.id === f.added)) ? { deletable: true } : {}),
        ...(f.discs ? { discs: f.discs.map(d => d.n), discPaths: f.discs.map(d => d.path) } : {}),
        ...(shell && /^#[0-9a-f]{6}$/i.test(shell) ? { shell } : {}),
        info: meta,
        media: Object.fromEntries(Object.entries(media).map(([k, v]) => [k, k === 'manual' ? v : fileUrl(v)])),
      };
    }));
  }
  // The cache copy is taken before presentLibrary lays the player's settings over the games.
  const raw = JSON.stringify(games);
  return { raw, shown: presentLibrary(games) };
}
let lastScanChanged = true;

// ---------- Library cache ----------
// The last scan, so the next start shows the shelf at once and rescans behind it. It holds only
// what the scan found: favourites, play time, custom titles and per-game settings are laid over it
// fresh every time. It is used only while the folders and app version it was made with still match.
const LIBRARY_CACHE_PATH = path.join(DATA, 'library-cache.json');
const libraryCacheKey = () => JSON.stringify({
  version: APP_VERSION, mediaRoot: config.mediaRoot || '', extraGames: config.extraGames || [],
  systems: config.systems.map(s => [s.id, s.romDir || '', s.extensions || [], !!s.direct]),
});
let libraryCacheText = null; // the games part of the last written or read cache, to tell if a rescan changed anything
let libraryCacheSizes = null;
// text: the scanned games as JSON. Returns whether they differ from the cached ones.
function writeLibraryCache(text) {
  const sizes = JSON.stringify(Object.fromEntries(knownSizes || []));
  const changed = text !== libraryCacheText;
  if (!changed && sizes === libraryCacheSizes) return false;
  libraryCacheText = text; libraryCacheSizes = sizes;
  const tmp = `${LIBRARY_CACHE_PATH}.tmp`;
  fsp.mkdir(DATA, { recursive: true })
    .then(() => fsp.writeFile(tmp, `{"key":${JSON.stringify(libraryCacheKey())},"sizes":${sizes},"games":${text}}`))
    .then(() => fsp.rename(tmp, LIBRARY_CACHE_PATH))
    .catch(e => log(`library cache not saved: ${e.message}`));
  return changed;
}
// Returns the cached games when they were scanned with the current folders and app version.
// File sizes are kept whatever the key: they belong to files, not to the settings.
async function readLibraryCache() {
  let cached = null;
  try { cached = JSON.parse(await fsp.readFile(LIBRARY_CACHE_PATH, 'utf8')); } catch {}
  if (!knownSizes) {
    knownSizes = new Map(Object.entries(cached?.sizes && typeof cached.sizes === 'object' ? cached.sizes : {}).filter(([, v]) => Number.isFinite(v)));
    libraryCacheSizes = JSON.stringify(Object.fromEntries(knownSizes));
  }
  if (cached?.key !== libraryCacheKey() || !Array.isArray(cached.games) || !cached.games.length) return null;
  libraryCacheText = JSON.stringify(cached.games);
  return cached.games;
}

// Lays the player's own settings over scanned games and sorts them for the shelf.
function presentLibrary(games) {
  for (const g of games) {
    // A title typed in Rename… wins over the scanned one, so the shelf sorts by it too.
    // The scanned title is kept so "Use the file name" can put it back exactly.
    g.scannedTitle = g.title;
    g.title = gameState(g.id).customTitle || g.scannedTitle;
  }
  // A PC port beats a ROM of the same game on the same shelf: the ROM in a games folder (often the
  // very file the port was built from) stays out of sight.
  const ports = new Set(games.filter(g => g.recomp && !gameState(g.id).hidden).map(g => g.system + '|' + looseKey(g.title)));
  games = games.filter(g => g.recomp || !ports.has(g.system + '|' + looseKey(g.title)));
  const compareTitles = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;
  games.sort((a, b) => compareTitles(a.title, b.title));
  libraryGames = games;
  // Once the games are known (saves next to them get copied too), emulators' saves move to the Saves folder.
  if (!savesMoved) { savesMoved = true; setTimeout(moveAllSaves, 2000); }
  // The window gets the disc numbers and the game's own state, never the other disc paths.
  return games.map(({ discPaths, ...g }) => ({ ...g, ...gameState(g.id) }));
}

// ---------- Artwork download ----------
// WebP (common in newer LaunchBox uploads, often named .jpg) is not readable by nativeImage,
// so it is decoded by Chromium in a hidden sandboxed window and handed back as PNG.
let webpWindow=null,webpQueue=Promise.resolve(),webpIdle=null;
const closeWebpWindow=()=>{clearTimeout(webpIdle);if(webpWindow&&!webpWindow.isDestroyed())webpWindow.destroy();webpWindow=null};
const isWebp=b=>b.length>12&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP';
function webpToPng(bytes) {
  const run=webpQueue.then(async()=>{
    if(!webpWindow||webpWindow.isDestroyed()) {
      webpWindow=new BrowserWindow({show:false,width:64,height:64,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:true}});
      await webpWindow.loadURL('about:blank');
    }
    const script=`(async()=>{const b=Uint8Array.from(atob("${bytes.toString('base64')}"),c=>c.charCodeAt(0));
      const bmp=await createImageBitmap(new Blob([b],{type:'image/webp'}));
      if(bmp.width>16384||bmp.height>16384||bmp.width*bmp.height>40e6)throw new Error('too large');
      const c=new OffscreenCanvas(bmp.width,bmp.height);c.getContext('2d').drawImage(bmp,0,0);
      const out=new Uint8Array(await (await c.convertToBlob({type:'image/png'})).arrayBuffer());
      let s='';for(let i=0;i<out.length;i+=32768)s+=String.fromCharCode(...out.subarray(i,i+32768));return btoa(s)})()`;
    return Buffer.from(await webpWindow.webContents.executeJavaScript(script),'base64');
  });
  webpQueue=run.catch(()=>{});
  // Close the helper once it has been idle for a while, so it never keeps the app running.
  webpQueue.then(()=>{clearTimeout(webpIdle);webpIdle=setTimeout(closeWebpWindow,15000)});
  return run.catch(()=>{throw new Error('Could not read this WebP image.')});
}
function artworkPng(bytes) {
  if(isWebp(bytes))return webpToPng(bytes);
  const image=nativeImage.createFromBuffer(bytes),size=image.getSize();
  if(image.isEmpty()||size.width>16384||size.height>16384||size.width*size.height>40e6)throw new Error('Choose a valid image smaller than 40 megapixels.');
  return image.toPNG();
}
// Downloaded artwork is kept at a sensible size: full-size scans are scaled to fit these limits
// (longest side, in pixels) and photos are saved as JPEG. Small pixel art and anything with
// transparency (discs, logos) stays PNG so it keeps crisp edges.
const ARTWORK_LIMITS = { front: 1600, frontHQ: 2000, back: 1600, spine: 1600, screenshot: 1920, title: 1920, disc: 1200, logo: 1000, fanart: 1920 };
function hasTransparency(image) {
  const { width, height } = image.getSize(), px = image.toBitmap();
  const step = Math.max(1, Math.floor(width * height / 40000)); // sample ~40k pixels
  for (let i = 0; i < width * height; i += step) if (px[i * 4 + 3] < 250) return true;
  return false;
}
function encodeArtwork(png, type) {
  let image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize(), limit = ARTWORK_LIMITS[type] || 1600;
  if (image.isEmpty()) return { bytes: png, ext: 'png' };
  if (Math.max(width, height) > limit) image = image.resize(width >= height ? { width: limit, quality: 'best' } : { height: limit, quality: 'best' });
  const size = image.getSize();
  if (Math.max(size.width, size.height) < 400 || hasTransparency(image)) return { bytes: image.toPNG(), ext: 'png' };
  return { bytes: image.toJPEG(88), ext: 'jpg' };
}

const launchbox = createLaunchBox({
  dataDir: DATA,
  normalize: looseKey,
  download: (url, file, onBytes) => artwork.download(url, file, onBytes),
  onStatus: message => artwork.note(message),
});
const artwork = createArtworkService({
  launchbox,
  encodeImage: encodeArtwork,
  dataDir: DATA,
  getSystems: () => config.systems,
  getGames: () => libraryGames,
  wants: (game, kind) => mediaWanted(game, kind),
  normalize: looseKey,
  decodeImage: artworkPng,
  onProgress: progress => {
    if (win && !win.isDestroyed()) win.webContents.send('art:progress', progress);
    // The first download builds the LaunchBox database; fill in game details right away.
    if (progress.status === 'complete') fillGameDetails(libraryGames).then(changed => {
      if (changed.length && win && !win.isDestroyed()) win.webContents.send('library:info', changed);
    }).catch(() => {});
  },
});

// ---------- Emulators ----------
// Emulators Harbour installed or you added, linked by their .exe. "{rom}" in the launch options is
// replaced with the game's file.
function emuDef(id) {
  const e = config.customEmulators.find(x => x.id === id);
  if (!e) return null;
  return { ...e, exePath: config.emulators[id]?.exe || e.exe, custom: true };
}
function resolveExe(id) {
  const def = emuDef(id);
  return def?.exePath && fs.existsSync(def.exePath) ? def.exePath : null;
}
function emuStatus(id) {
  const def = emuDef(id);
  return { id, name: def.name, systems: def.systems || [], args: def.args, custom: true, exe: resolveExe(id) };
}

// "owner/repo" or a github.com link -> "owner/repo".
function parseRepo(input) {
  const text = String(input || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = text.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/);
  if (!m || m[2] === '.' || m[2] === '..') throw new Error('Enter a GitHub repository as owner/name, e.g. eden-emulator/Releases');
  return `${m[1]}/${m[2]}`;
}
function checkPattern(pattern, what) {
  if (!pattern) return '';
  const text = String(pattern).trim().slice(0, 200);
  try { new RegExp(text, 'i'); } catch { throw new Error(`The ${what} pattern is not a valid regular expression.`); }
  return text;
}
// Picks the download for this computer when the repository gives no pattern (or for another system: a Windows build
// to run through Proton on Linux).
function guessAsset(assets, platform = process.platform) {
  const win = platform === 'win32';
  const score = a => {
    const n = a.name.toLowerCase();
    if (/source|src\b|symbols|pdb|debug|[-_.]dbg[-_.]|libretro|\.sha\d*|\.sig$|\.asc$|\.txt$|\.json$/.test(n)) return -1;
    if (/arm64|aarch64|armv7|x86(?!_64)|i686|32bit|win32(?!-x64)/.test(n)) return -1;
    let v = 0;
    if (win) {
      if (!/\.(zip|7z|rar|exe)$/.test(n)) return -1;
      if (/(macos|mac|osx|darwin|linux|android|ios|appimage|flatpak)/.test(n)) return -1;
      if (/win|windows|msvc|mingw/.test(n)) v += 4;
      if (/x64|x86_64|amd64|win64/.test(n)) v += 2;
      if (/\.(zip|7z|rar)$/.test(n)) v += 2; // portable archives over installers
      if (/setup|install/.test(n)) v -= 3;
      if (/rog-?ally|steam-?deck|legacy/.test(n)) return -1; // builds for one handheld or old CPUs
      if (/no-?avx|no-?sse|compat|fallback|safe-?mode/.test(n)) v -= 3; // builds for old CPUs, when a normal one exists
      if (/msvc|clang|mingw|llvm/.test(n)) v -= .5; // when a plain build sits next to compiler variants, take the plain one
      if (/pgo/.test(n)) v += 1; // profile-optimised builds are the same program, just faster
    } else if (platform === 'darwin') {
      // Mac: archives that hold an .app (disk images can't be unpacked here).
      if (/(windows|win64|win32|\.exe$|linux|appimage|android|\.deb$|\.rpm$|\.dmg$)/.test(n)) return -1;
      if (!/\.(zip|tar\.(gz|xz|zst|bz2)|tgz)$/.test(n)) return -1;
      if (/mac|macos|osx|darwin|apple/.test(n)) v += 5; else return -1;
      if (/universal/.test(n)) v += 2;
      else if (process.arch === 'arm64' ? /arm64|aarch64|apple/.test(n) : /x64|x86_64|intel/.test(n)) v += 2;
    } else {
      if (/(windows|win64|\.exe$|macos|osx|darwin|android)/.test(n)) return -1;
      if (/\.appimage$/.test(n)) v += 6;
      else if (/linux/.test(n) && /\.(tar\.(gz|xz|zst)|zip|7z)$/.test(n)) v += 3;
      else return -1;
      if (/x86_64|amd64|x64/.test(n)) v += 2;
      if (/rog-?ally|steam-?deck|legacy/.test(n)) return -1;
      if (/pgo/.test(n)) v += 1;
    }
    return v;
  };
  return assets.map(a => [score(a), a]).filter(([v]) => v >= 0).sort((x, y) => y[0] - x[0])[0]?.[1] || null;
}
// Picks the emulator program among unpacked files when the repository gives no pattern.
function guessProgram(dir, repo) {
  const files = [], stack = [dir];
  while (stack.length) {
    const d = stack.shift();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else files.push(p);
    }
  }
  const win = process.platform === 'win32';
  const hint = String(repo || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (process.platform === 'darwin') {
    // Mac: the program is an .app bundle; pick the best-named one and start the binary inside.
    const apps = [], walk = [dir];
    while (walk.length) {
      const d = walk.shift();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(d, e.name);
        if (/\.app$/i.test(e.name)) apps.push(p); else walk.push(p);
      }
    }
    const best = apps.sort((a, b) => Number(path.basename(b).toLowerCase().replace(/[^a-z0-9]/g, '').includes(hint)) - Number(path.basename(a).toLowerCase().replace(/[^a-z0-9]/g, '').includes(hint)))[0];
    return best ? macAppBinary(best) : null;
  }
  const candidates = files.filter(f => {
    const n = path.basename(f).toLowerCase();
    if (/unins|uninstall|update|crash|redist|vc_?redist|setup|installer|helper|elevate|dxwebsetup/.test(n)) return false;
    return win ? n.endsWith('.exe') : (n.endsWith('.appimage') || (!path.extname(n) && isLinuxProgram(f)));
  });
  const rank = f => {
    const n = path.basename(f).toLowerCase().replace(/[^a-z0-9]/g, '');
    let v = fs.statSync(f).size / 1e9; // larger programs first, as a tiebreak
    if (hint && (n.includes(hint) || hint.includes(n.replace(/exe$|appimage$/, '')))) v += 10;
    if (/qt|gui/.test(n)) v += 1;
    if (/cli|cmd|test|bench/.test(n)) v -= 2;
    return v;
  };
  return candidates.sort((a, b) => rank(b) - rank(a))[0] || null;
}
// GitHub allows 60 requests an hour without an account. If the GitHub CLI (gh) is logged in on this
// PC, its token is used instead (5,000 an hour). It is only ever sent to api.github.com.
let ghToken;
function githubToken() {
  if (ghToken !== undefined) return ghToken;
  ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!ghToken) try {
    const r = spawnSync('gh', ['auth', 'token'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && /^[\w-]{20,}$/.test(r.stdout.trim())) ghToken = r.stdout.trim();
  } catch {}
  return ghToken;
}
async function ghJson(url) {
  const token = /^https:\/\/api\.github\.com\//.test(url) && githubToken();
  const r = await fetch(url, { headers: token ? { ...UA, Authorization: `Bearer ${token}` } : UA });
  if (!r.ok) {
    const e = new Error(r.status === 403 || r.status === 429 ? "GitHub's limit for update checks is used up for now. Try again in an hour."
      : r.status === 404 ? "GitHub can't find that project." : `GitHub didn't answer (error ${r.status}). Try again later.`);
    e.status = r.status; throw e;
  }
  return r.json();
}

// orWindows: a PC port with no Linux build gets its Windows one, which runs through Proton (compat.js).
// A project that publishes its own self-updating launcher next to its setup (DKB-Launcher.exe: it downloads the build
// tools, builds the game from your copy and updates it in place) is installed and updated through that launcher.
function portLauncherAsset(assets) {
  if (process.platform !== 'win32') return null;
  // only beside a setup kit (DKB-Setup-*.zip): a project whose launcher IS its game (rac1-launcher.exe) installs as usual
  if (!(assets || []).some(x => /-setup[-.]/i.test(x.name))) return null;
  const a = (assets || []).find(x => /-launcher\.exe$/i.test(x.name));
  return a ? { name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || null } : null;
}
async function findRelease(repo, { asset: pattern, prerelease, orWindows }) {
  const re = pattern ? new RegExp(pattern, 'i') : null;
  let list;
  if (prerelease) list = await ghJson(`https://api.github.com/repos/${repo}/releases?per_page=15`);
  else {
    // Forks often only publish pre-releases, which /releases/latest skips.
    try { list = [await ghJson(`https://api.github.com/repos/${repo}/releases/latest`)]; }
    catch (e) { if (e.status !== 404) throw e; list = (await ghJson(`https://api.github.com/repos/${repo}/releases?per_page=15`)).filter(r => !r.draft); }
    if (!list.length) throw new Error(`${repo} has no releases to download.`);
  }
  for (const rel of list) {
    if (rel.draft) continue;
    const asset = re ? rel.assets.find(a => re.test(a.name))
      : guessAsset(rel.assets) || (orWindows && process.platform === 'linux' ? guessAsset(rel.assets, 'win32') : null);
    if (asset) return {
      tag: rel.tag_name, releaseName: rel.name || rel.tag_name, publishedAt: asset.updated_at || rel.published_at,
      assetId: asset.id, assetName: asset.name, size: asset.size, url: asset.browser_download_url, notes: rel.body || '',
      digest: asset.digest || null, page: rel.html_url || `https://github.com/${repo}/releases`, api: asset.url || null,
      uploader: asset.uploader?.login || rel.author?.login || null,
      launcher: portLauncherAsset(rel.assets),
    };
  }
  const platformName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  throw new Error(re ? `No ${platformName} download matching /${pattern}/ found in recent releases of ${repo}.` : `No ${platformName} download found in recent releases of ${repo}. Set its download file pattern in ••• → Platform & updates.`);
}

// Linux programs (AppImages, binaries) usually have no .exe extension.
const PROGRAM_FILTERS = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }]
  : process.platform === 'darwin' ? [{ name: 'Applications', extensions: ['app'] }, { name: 'All files', extensions: ['*'] }]
  : [{ name: 'All files', extensions: ['*'] }];
const PROGRAM_START = process.platform === 'darwin' ? { defaultPath: '/Applications' } : {};
const ARCHIVE = /\.(zip|7z|rar|tar|tgz|tar_?\.(gz|xz|zst|bz2))$/i;  // bsdtar (built into Windows) reads all of these
function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', rej);
    p.on('close', c => (c === 0 ? res() : rej(new Error(`Extract failed: ${err.trim() || 'exit ' + c}`))));
  });
}
// Windows has bsdtar built in (handles zip and 7z). On Linux try the usual tools in turn:
// bsdtar (Arch/SteamOS), unzip / 7z, then GNU tar for tarballs.
async function extract(archive, dest) {
  if (process.platform === 'win32') return run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dest]);
  const tries = [['bsdtar', ['-xf', archive, '-C', dest]]];
  if (/\.zip$/i.test(archive)) tries.push(['unzip', ['-o', '-q', archive, '-d', dest]], ['7z', ['x', '-y', `-o${dest}`, archive]]);
  else if (/\.7z$/i.test(archive)) tries.push(['7z', ['x', '-y', `-o${dest}`, archive]], ['7za', ['x', '-y', `-o${dest}`, archive]]);
  else tries.push(['tar', ['-xf', archive, '-C', dest]]);
  for (const [cmd, args] of tries) {
    try { return await run(cmd, args); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error(`Can't unpack ${path.basename(archive)}: install bsdtar (libarchive) or ${/\.zip$/i.test(archive) ? 'unzip' : '7-Zip'}.`);
}

// Downloads pause one by one (Updates: Pause on its row), like Steam's: a paused one stops reading where it is and keeps
// its partial file until it's resumed. Keyed like the progress messages ('emu:<id>', a game's id).
const pausedDownloads = new Set(), resumeWaiters = new Map();
const waitForResume = key => new Promise(resume => { if (!resumeWaiters.has(key)) resumeWaiters.set(key, []); resumeWaiters.get(key).push(resume); });
function pauseDownload(key, on) {
  if (!key) return false;
  if (on) pausedDownloads.add(key);
  else { pausedDownloads.delete(key); (resumeWaiters.get(key) || []).splice(0).forEach(resume => resume()); resumeWaiters.delete(key); }
  log(`download ${key} ${on ? 'paused' : 'resumed'}`);
  return !!on;
}
// Stream a fetch() response to a file, calling onChunk for progress. While paused it waits between pieces (onPause
// says so). If the connection drops (a server gives up on a long pause), again(fromByte) asks for the rest and the
// file carries on from where it got to, up to three times.
async function downloadTo(response, file, onChunk = () => {}, { again = null, onPause = () => {}, key = null } = {}) {
  let res = response, flags = 'w';
  for (let tries = 0; ; tries++) {
    try {
      await pipeline(Readable.fromWeb(res.body), async function* (source) {
        for await (const chunk of source) {
          if (key && pausedDownloads.has(key)) { onPause(); await waitForResume(key); }
          onChunk(chunk); yield chunk;
        }
      }, fs.createWriteStream(file, { flags }));
      return;
    } catch (e) {
      if (!again || tries >= 3) throw e;
      const from = fs.existsSync(file) ? fs.statSync(file).size : 0;
      while (key && pausedDownloads.has(key)) await waitForResume(key);
      res = await again(from);
      if (res.status !== 206) throw e;
      flags = 'a';
      log(`download dropped at ${from} bytes, carrying on from there`);
    }
  }
}

// ---------- Recomp updates ----------
// A recomp can have an update source: { repo, prerelease, asset, auto }. "installed" remembers which
// release is in its folder ({ tag, assetId }); without it the version is unknown until you set it.
function shelfOf(x) { return x.system === 'recomp' && x.platform && config.systems.some(s => s.id === x.platform) ? x.platform : x.system; }
function recompEntry(gameId) {
  const game = libraryGames.find(g => g.id === gameId && g.recomp);
  const entry = game && config.extraGames.find(x => x.id === game.added);
  if (!entry) throw new Error('Select a recomp game first.');
  return { game, entry };
}
// gameId -> { at, latest, repo }. Kept on disk too, so restarting Harbour doesn't re-ask GitHub
// (60 requests an hour without an account) for every game.
const RECOMP_CHECKS_PATH = path.join(DATA, 'recomp-checks.json');
const recompChecks = new Map((() => { try { return Object.entries(JSON.parse(fs.readFileSync(RECOMP_CHECKS_PATH, 'utf8'))); } catch { return []; } })());
let recompSaveTimer = null;
function saveRecompChecks() {
  clearTimeout(recompSaveTimer);
  recompSaveTimer = setTimeout(() => { try { fs.writeFileSync(RECOMP_CHECKS_PATH, JSON.stringify(Object.fromEntries(recompChecks))); } catch {} }, 500);
}
const RECOMP_CHECK_MS = 3 * 3600 * 1000;
// Updates you do yourself (an emulator's own updater, a download from the release page) are noticed
// by the program file: Harbour remembers its size and date while your version is current, and once a
// newer release is out, a changed program file (or one dated after that release) means you have it.
function fileStamp(file) { try { const s = fs.statSync(file); return { id: `${s.size}:${Math.round(s.mtimeMs)}`, mtime: s.mtimeMs }; } catch { return null; } }
function noticeUpdate(holder, file, latest, outdated, current, name) {
  const inst = holder.installed, stamp = file && fileStamp(file);
  if (!inst || !stamp || !latest) return;
  if (!outdated(inst)) { if (inst.stamp !== stamp.id) { inst.stamp = stamp.id; saveConfig(config); } return; }
  // Needs the exact release time: a day-only date would count a file from earlier that day as newer.
  const released = Date.parse(latest.published || latest.publishedAt || '') || Infinity;
  if ((inst.stamp && inst.stamp !== stamp.id) || stamp.mtime > released) {
    holder.installed = { ...current(), uploader: inst.uploader, stamp: stamp.id }; saveConfig(config);
    log(`noticed ${name} was updated to ${latest.tag}`);
  } else if (!inst.stamp) { inst.stamp = stamp.id; saveConfig(config); }
}
// The version a self-updating game has, from the files its own launcher or installer keeps: VERSION, version.txt,
// current.txt (NX2navi's app\current.txt), or an *install*.json with "release" / "version" (DKB's dkb-install.json),
// beside its program or one folder up. Its program file often doesn't change when it updates itself (NX2navi starts
// through pythonw.exe), so this is what shows an in-app update happened.
function versionOnDisk(exe) {
  if (!exe) return null;
  const semver = t => String(t || '').match(/\d+\.\d+(?:\.\d+)?/)?.[0] || null;
  const here = path.dirname(exe), up = path.dirname(here);
  for (const dir of [here, path.join(here, 'app'), up, path.join(up, 'app')]) {
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const low = n.toLowerCase(), f = path.join(dir, n);
      try {
        if (['version', 'version.txt', 'current.txt'].includes(low)) { const v = semver(fs.readFileSync(f, 'utf8').split(/\r?\n/)[0]); if (v) return v; }
        if (/install.*\.json$/.test(low) && fs.statSync(f).size < 1e6) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const v = semver(j.release || j.version); if (v) return v; }
      } catch {}
    }
  }
  return null;
}
const sameVersion = (a, b) => !!a && !!b && semver3(a) === semver3(b);
const semver3 = t => (String(t || '').match(/\d+\.\d+(?:\.\d+)?/)?.[0] || '').split('.').concat(['0', '0']).slice(0, 3).join('.');
function recompStatus(entry, latest) {
  // Updated itself (in its own app or launcher): its version file says so, whether or not its program changed.
  // (a game built by its own launcher: its version file is in the launcher's install folder)
  let gameDir = entry.executable && path.dirname(entry.executable);
  if (entry.updater) { try { gameDir = JSON.parse(fs.readFileSync(path.join(launcherBase(entry.updater), 'launcher.json'), 'utf8')).dest || gameDir; } catch {} }
  const disk = entry.installed && latest && gameDir && versionOnDisk(path.join(gameDir, '_'));
  if (disk && !sameVersion(disk, entry.installed.tag)) {
    entry.installed = sameVersion(disk, latest.tag) ? { ...entry.installed, tag: latest.tag, assetId: latest.assetId, date: latest.publishedAt }
      : { ...entry.installed, tag: `v${disk}`, assetId: undefined };
    saveConfig(config); log(`noticed ${entry.title} is now ${entry.installed.tag} (its version file)`);
  }
  // Without a version file, a changed program file (or one newer than the release) means it updated itself. With
  // one, that file alone says: a program swapped for another (like its launcher) is not an update.
  if (!disk) noticeUpdate(entry, entry.executable, latest, i => i.assetId ? i.assetId !== latest.assetId : i.tag !== latest.tag,
    () => ({ tag: latest.tag, assetId: latest.assetId, date: latest.publishedAt }), entry.title);
  const inst = entry.installed || null;
  const updateAvailable = !latest ? null : inst?.assetId ? inst.assetId !== latest.assetId : inst?.tag ? inst.tag !== latest.tag : null;
  return {
    installed: inst, updateAvailable, auto: harbourInstalls(entry.source), repo: entry.source?.repo || null,
    launcher: !!(entry.updater || latest?.launcher),  // updated with the project's own launcher (Update runs it)
    latest: latest && { tag: latest.tag, name: latest.releaseName, date: latest.publishedAt, notes: latest.notes, page: latest.page, assetName: latest.assetName, size: latest.size },
  };
}
async function checkRecomp(gameId, force = false) {
  const { entry } = recompEntry(gameId);
  if (!entry.source?.repo) return { repo: null };
  const hit = recompChecks.get(gameId);
  if (!force && hit && Date.now() - hit.at < RECOMP_CHECK_MS && hit.repo === entry.source.repo) return recompStatus(entry, hit.latest);
  try {
    const latest = await findRelease(entry.source.repo, { asset: entry.source.asset, prerelease: entry.source.prerelease, orWindows: true });
    // A new release Harbour would install: look inside its zip now (a few small reads, once per release) so a project
    // whose downloads aren't the program you start shows "update in app" straight away, not when you press Update.
    const lookedIn = hit?.lookedIn === latest.assetId ? hit.lookedIn : null;
    if (!lookedIn && harbourInstalls(entry.source) && entry.executable && !isAppImage(entry.executable) && /\.zip$/i.test(latest.assetName) && recompStatus(entry, latest).updateAvailable) {
      const names = await remoteZipNames(latest.url);
      const exe = path.basename(entry.executable).toLowerCase();
      if (names && !names.some(n => n.split('/').pop().toLowerCase() === exe)) updatesWithOwnTool(entry.source, entry.title);
    }
    recompChecks.set(gameId, { at: Date.now(), latest, repo: entry.source.repo, lookedIn: lookedIn || latest.assetId }); saveRecompChecks();
    return recompStatus(entry, latest);
  } catch (e) {
    return { ...recompStatus(entry, null), error: e.message };
  }
}
async function sha256File(file) {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
// Windows Defender scans a download before anything is unpacked. If Defender isn't there, the scan is skipped (and logged).
function defenderScan(file) {
  const exe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
  if (process.platform !== 'win32' || !fs.existsSync(exe)) return Promise.resolve('skipped');
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('error', () => resolve('skipped'));
    p.on('close', code => {
      if (code === 0) return resolve('clean');
      if (code === 2 || /threat/i.test(out) && !/no threats/i.test(out)) return reject(new Error('Windows Defender flagged the download. Nothing was installed.'));
      resolve('skipped');
    });
  });
}
// Your settings: files with these endings are never overwritten by an update if they already exist.
const KEEP_FILES = /\.(ini|toml|cfg|conf|ya?ml|sav|save)$/i;
async function copyUpdate(src, dest, backup, kept) {
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(dest, e.name), bak = path.join(backup, e.name);
    if (e.isDirectory()) { await fsp.mkdir(to, { recursive: true }); await copyUpdate(from, to, bak, kept); continue; }
    if (fs.existsSync(to)) {
      if (KEEP_FILES.test(e.name)) { kept.push(to); continue; }
      await fsp.mkdir(backup, { recursive: true });
      await fsp.copyFile(to, bak);
    }
    await fsp.copyFile(from, to);
  }
}
// Download a release file, check it (checksum when the site gives one, Windows Defender), and give
// back the folder of new files ready to copy. The caller removes tmp afterwards.
async function fetchRelease(rel, tmp, send, key = null) {
  const archive = path.join(tmp, rel.assetName);
  let src = { url: rel.url, headers: { 'User-Agent': UA['User-Agent'] } };
  let r = await fetch(src.url, { headers: src.headers });
  // A private GitHub repository's downloads need the GitHub login (gh) on this PC, through GitHub's own address.
  // The login is sent only to api.github.com: the redirect to the file itself drops it.
  if (r.status === 404 && /^https:[/][/]api[.]github[.]com[/]/.test(rel.api || '') && githubToken()) {
    src = { url: rel.api, headers: { 'User-Agent': UA['User-Agent'], Accept: 'application/octet-stream', Authorization: `Bearer ${githubToken()}` } };
    r = await fetch(src.url, { headers: src.headers });
  }
  if (!r.ok) throw new Error(`The download failed (error ${r.status}). Try again later.`);
  const total = Number(r.headers.get('content-length')) || rel.size || 0;
  let got = 0, last = 0;
  await downloadTo(r, archive, chunk => {
    got += chunk.length;
    if (Date.now() - last > 120) { last = Date.now(); send({ stage: `Downloading ${rel.assetName}`, pct: total ? got / total : 0 }); }
  }, { key, onPause: () => send({ stage: 'Paused', pct: total ? got / total : 0 }),
       again: from => { got = from; return fetch(src.url, { headers: { ...src.headers, Range: `bytes=${from}-` } }); } });
  send({ stage: 'Checking the download…', pct: 1 });
  if (rel.digest && /^sha256:/i.test(rel.digest)) {
    const want = rel.digest.slice(7).toLowerCase(), have = await sha256File(archive);
    if (want !== have) throw new Error("The download doesn't match its published checksum. Nothing was installed.");
  }
  const scan = await defenderScan(archive);
  return { archive, scan };
}
async function unpackRelease(rel, archive, tmp, send) {
  const stage = path.join(tmp, 'x');
  await fsp.mkdir(stage);
  if (ARCHIVE.test(rel.assetName)) { send({ stage: 'Extracting…', pct: 1 }); await extract(archive, stage); }
  else await fsp.rename(archive, path.join(stage, rel.assetName));
  makeRunnable(stage);
  const top = fs.readdirSync(stage, { withFileTypes: true });
  return top.length === 1 && top[0].isDirectory() ? path.join(stage, top[0].name) : stage;
}
// A downloaded AppImage (or one unpacked from a zip) can't start until it's marked as a program.
function makeRunnable(dir) {
  if (process.platform === 'win32') return;
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (/\.appimage$/i.test(e.name)) try { fs.chmodSync(p, fs.statSync(p).mode | 0o755); } catch {}
    }
  };
  try { walk(dir, 0); } catch {}
}
// ---- Same uploader ----
// An update is only installed when the same account uploaded it as the version you have: a project taken over by
// someone else, or a stranger's file, is stopped. (The first version Harbour installs sets who that is.) This and the
// checksum work on any system; the Windows Defender scan is an extra where it's there.
// A release uploaded by a different account than before isn't installed: a taken-over account can't slip one in. A
// project moving between automated accounts (GitHub Actions, a build app: names ending in [bot]) is normal and goes ahead.
function checkUploader(installed, rel, name) {
  const bot = u => /\[bot\]$/i.test(u || '');
  if (installed?.uploader && rel.uploader && installed.uploader.toLowerCase() !== rel.uploader.toLowerCase() && !(bot(installed.uploader) && bot(rel.uploader)))
    throw new Error(`${name} ${rel.tag} was uploaded by a different account (${rel.uploader}, before: ${installed.uploader}). OneDeck didn't install it: check its release page.`);
}
// ---- Can Harbour install this update, and where do its files go? ----
// Harbour installs every update itself unless you switched that off, or it found that a project's downloads are
// not the program itself (a setup kit or builder that makes the game from your copy): then that project updates
// with its own tool, and Harbour only says so.
const harbourInstalls = source => !!source && source.auto !== false && !source.ownTool;
class NotReadyToRun extends Error {}
function updatesWithOwnTool(source, name) {
  if (source && !source.ownTool) { source.ownTool = true; saveConfig(config); log(`${name}: downloads aren't ready-to-run builds, updates with its own tool`); }
  return new NotReadyToRun(`${name}: update in app.`);
}
// The files inside a remote zip, read from its end with a few small range requests instead of downloading it all.
// null when the server can't do that (the full download then decides).
async function remoteZipNames(url) {
  try {
    const part = async (start, end) => {
      const r = await fetch(url, { headers: { ...UA, Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(20000) });
      if (r.status !== 206) throw new Error('no ranges');
      return { bytes: Buffer.from(await r.arrayBuffer()), size: Number((r.headers.get('content-range') || '').split('/')[1]) };
    };
    const { size } = await part(0, 0);
    const tailLength = Math.min(size, 0xffff + 22);
    const { bytes: tail } = await part(size - tailLength, size - 1);
    const end = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (end < 0) return null;
    let dirSize = tail.readUInt32LE(end + 12), dirStart = tail.readUInt32LE(end + 16);
    if (dirStart === 0xffffffff) {  // zip64: the real numbers are in the zip64 end record
      const locator = tail.lastIndexOf(Buffer.from('PK\x06\x07', 'latin1'));
      if (locator < 0) return null;
      const at = Number(tail.readBigUInt64LE(locator + 8));
      const { bytes: z } = await part(at, at + 55);
      dirSize = Number(z.readBigUInt64LE(40)); dirStart = Number(z.readBigUInt64LE(48));
    }
    const { bytes: dir } = await part(dirStart, dirStart + dirSize - 1);
    // The names, with each file's unpacked size in names.sizes (used to tell which release a program is from).
    const names = [];
    names.sizes = new Map();
    for (let p = 0; p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50;) {
      const n = dir.readUInt16LE(p + 28);
      const name = dir.toString('utf8', p + 46, p + 46 + n);
      names.push(name);
      names.sizes.set(name, dir.readUInt32LE(p + 24));
      p += 46 + n + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return names;
  } catch { return null; }
}
// An AppImage is the whole program in one file whose name carries its version, so a release with one AppImage in it
// replaces the one you have, under the same name (so everything pointing at it keeps working). Returns whether it did.
const isAppImage = p => /\.appimage$/i.test(String(p || ''));
async function swapAppImage(src, exe) {
  if (process.platform === 'win32' || !isAppImage(exe)) return false;
  const found = [];
  const walk = (dir, depth) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 2) walk(p, depth + 1); } else if (isAppImage(e.name)) found.push(p);
  } };
  walk(src, 0);
  if (found.length !== 1) return false;
  const next = exe + '.new';
  await fsp.copyFile(found[0], next);
  await fsp.chmod(next, 0o755);
  await fsp.rename(next, exe);
  return true;
}
// Where an unpacked release goes: find the program you start (exe) inside it, and line the two up. A release whose
// folders sit one level deeper or shallower than your install lines up by itself. null when the program isn't in
// the release at all.
function placeRelease(src, exe) {
  if (!exe) return null;
  const want = path.basename(exe).toLowerCase();
  const found = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r.split('/').length < 6) walk(path.join(dir, e.name), r); }
      else if (e.name.toLowerCase() === want) found.push(r);
    }
  };
  walk(src, '');
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const rel of found.sort((a, b) => a.split('/').length - b.split('/').length)) {
    const parts = rel.split('/');
    let root = path.dirname(exe);
    for (let i = 1; i < parts.length; i++) root = path.dirname(root);
    if (same(path.join(root, ...parts), exe) && fs.existsSync(root)) return root;
  }
  return null;
}

// Copy new files over a program folder: the files replaced go to _harbour-backup\<old version>,
// settings files are kept, and only the newest two backups are left so the folder doesn't grow forever.
async function installInto(folder, src, oldTag, send) {
  send({ stage: 'Installing…', pct: 1 });
  const root = path.join(folder, '_harbour-backup');
  const backup = path.join(root, (oldTag || 'before-' + new Date().toISOString().slice(0, 10)).replace(/[^\w.-]+/g, '_'));
  const kept = [];
  try { await copyUpdate(src, folder, backup, kept); }
  catch (e) { if (/EBUSY|EPERM|EACCES/.test(e.code || '')) throw new Error('A file is in use or protected. Close the program and try again.'); throw e; }
  try {
    const old = fs.readdirSync(root).map(n => ({ p: path.join(root, n), t: fs.statSync(path.join(root, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(2);
    for (const o of old) await fsp.rm(o.p, { recursive: true, force: true });
  } catch {}
  return { kept, backup: fs.existsSync(backup) ? backup : null };
}
// Is a program (by its file name) running right now? On Linux: any process started as that file (a Windows game in
// Proton or Wine shows its .exe there too). On a Mac, assume not.
function isRunning(exe) {
  if (!exe) return false;
  if (process.platform === 'linux') {
    const want = path.basename(exe).toLowerCase();
    try {
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        let cmd; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
        if (cmd.split('\0').slice(0, 3).some(a => a.split(/[\\/]/).pop().toLowerCase() === want)) return true;
      }
    } catch {}
    return false;
  }
  if (process.platform !== 'win32') return false;
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/NH'], { windowsHide: true, encoding: 'utf8' });
  return (r.stdout || '').toLowerCase().includes(path.basename(exe).toLowerCase());
}
const updatingRecomps = new Set();
async function updateRecomp(gameId, sendRaw) {
  const { game, entry } = recompEntry(gameId);
  if (!entry.source?.repo) throw new Error('Set an update source for this game first.');
  if (!harbourInstalls(entry.source)) throw new NotReadyToRun(`${game.title}: update in app.`);
  if (updatingRecomps.has(gameId)) throw new Error('Already updating');
  if (running.has(gameId) || isRunning(entry.executable)) throw new Error('Close the game before updating it.');
  const send = p => sendRaw({ gameId, ...p });
  updatingRecomps.add(gameId);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbour-recomp-'));
  try {
    send({ stage: 'Checking latest release…', pct: 0 });
    const hit = recompChecks.get(gameId);
    const rel = hit && hit.repo === entry.source.repo && Date.now() - hit.at < 10 * 60 * 1000 && hit.latest?.url ? hit.latest
      : await findRelease(entry.source.repo, { asset: entry.source.asset, prerelease: entry.source.prerelease, orWindows: true });
    checkUploader(entry.installed, rel, game.title);
    // A zip's file list says, before the big download, whether it holds the game's program at all.
    const exeName = entry.executable && path.basename(entry.executable).toLowerCase();
    if (exeName && !isAppImage(exeName) && /\.zip$/i.test(rel.assetName)) {
      send({ stage: 'Looking inside the release…', pct: 0 });
      const names = await remoteZipNames(rel.url);
      if (names && !names.some(n => n.split('/').pop().toLowerCase() === exeName)) throw updatesWithOwnTool(entry.source, game.title);
    }
    const { archive, scan } = await fetchRelease(rel, tmp, send, gameId);
    const src = await unpackRelease(rel, archive, tmp, send);
    // The release's files go wherever its copy of the program lines up with the one you start.
    const swapped = await swapAppImage(src, entry.executable);
    const root = swapped ? path.dirname(entry.executable) : entry.executable ? placeRelease(src, entry.executable) : entry.path;
    if (!root) throw updatesWithOwnTool(entry.source, game.title);
    const { kept, backup } = swapped ? { kept: [], backup: null } : await installInto(root, src, entry.installed?.tag, send);
    if (inPortsDir(entry) && path.resolve(root) === path.resolve(entry.path)) await rememberRelease(entry.id, src);
    if (entry.executable && !fs.existsSync(entry.executable)) {
      const exe = findGameExe(root, { repo: entry.source.repo, title: entry.title }) || guessProgram(root, entry.source.repo);
      if (exe) entry.executable = exe;
    }
    entry.installed = { tag: rel.tag, assetId: rel.assetId, date: rel.publishedAt, at: new Date().toISOString(), uploader: rel.uploader || entry.installed?.uploader };
    saveConfig(config);
    recompChecks.set(gameId, { at: Date.now(), latest: rel, repo: entry.source.repo }); saveRecompChecks();
    send({ stage: 'Done', pct: 1, done: true });
    log(`recomp update ${game.title} -> ${rel.tag} (defender: ${scan}, kept ${kept.length} settings files)`);
    return { ...recompStatus(entry, rel), backup, kept, scan };
  } finally {
    updatingRecomps.delete(gameId);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Launching ----------
// While Steam runs it owns a Steam Controller and hands games a virtual gamepad instead. SDL's own Steam Controller
// driver (used by many emulators) would read the raw device and get nothing, so programs Harbour starts are told to
// leave it to Steam then. Without Steam running, the emulator may read the controller directly.
function launchEnv() {
  return isRunning(process.platform === 'win32' ? 'steam.exe' : 'steam') ? { ...process.env, SDL_JOYSTICK_HIDAPI_STEAM: '0' } : process.env;
}
// Emulators that start with no controller buttons set get a standard gamepad layout, so a pad works straight away.
// Only when nothing is bound yet: anything the player set themselves is left alone. melonDS: SDL button numbers of
// an Xbox-style pad, d-pad as hat 0 (0x100 + up 1 / right 2 / down 4 / left 8), DS A/B on the pad's east/south.
const PAD_DEFAULTS = [
  { name: /^melonds(?![a-z0-9])/i, files: dir => [path.join(dir, 'melonDS.toml'), path.join(xdgConfig(), 'melonDS', 'melonDS.toml')], section: '[Instance0.Joystick]',
    keys: { A: 1, B: 0, X: 3, Y: 2, L: 4, R: 5, Select: 6, Start: 7, Up: 0x101, Right: 0x102, Down: 0x104, Left: 0x108 } },
];
function padDefaults(exe) {
  const d = PAD_DEFAULTS.find(x => x.name.test(programName(exe)));
  if (!d) return;
  try {
    const file = d.files(path.dirname(exe)).find(f => fs.existsSync(f));
    if (!file) return;
    const text = fs.readFileSync(file, 'utf8');
    const a = text.indexOf(d.section);
    if (a < 0) return;
    const next = text.indexOf('\n[', a + d.section.length);
    const b = next < 0 ? text.length : next;
    let sec = text.slice(a, b);
    const bound = Object.keys(d.keys).some(k => { const m = sec.match(new RegExp(`^${k} = (-?\\d+)`, 'm')); return m && m[1] !== '-1'; });
    if (bound) return;
    for (const [k, v] of Object.entries(d.keys)) sec = sec.replace(new RegExp(`^${k} = -1`, 'm'), `${k} = ${v}`);
    fs.writeFileSync(file, text.slice(0, a) + sec + text.slice(b));
  } catch {}
}
function splitArgs(s) {
  const out = []; let cur = '', q = false, any = false;
  for (const ch of s || '') {
    if (ch === '"') { q = !q; any = true; }
    else if (/\s/.test(ch) && !q) { if (any) out.push(cur); cur = ''; any = false; }
    else { cur += ch; any = true; }
  }
  if (any) out.push(cur);
  return out;
}

let win;
// On a Mac, emulators are .app bundles (folders). Start the program inside: Contents/MacOS/<CFBundleExecutable>.
function macAppBinary(p) {
  if (process.platform !== 'darwin' || !/\.app\/?$/i.test(p || '')) return p;
  try {
    const plist = fs.readFileSync(path.join(p, 'Contents', 'Info.plist'), 'utf8');
    const name = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (name && fs.existsSync(path.join(p, 'Contents', 'MacOS', name))) return path.join(p, 'Contents', 'MacOS', name);
    const first = fs.readdirSync(path.join(p, 'Contents', 'MacOS'))[0];
    if (first) return path.join(p, 'Contents', 'MacOS', first);
  } catch {}
  return p;
}
// ---------- Running games: play time and "hold to quit" ----------
// Each started game is tracked until its process exits, so play time and "last played" are counted.
// Shortcuts opened through the system (.lnk, Steam .url) have no process to follow: they only count
// as played.
const running = new Map(); // game id -> { child, start }
const sendWindow = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
function recordPlay(gameId, ms = 0, started = !ms) {
  const st = (libraryState.stats[gameId] ||= { ms: 0, last: 0, plays: 0 });
  st.ms = (st.ms || 0) + Math.max(0, Math.round(ms)); st.last = Date.now(); st.plays = (st.plays || 0) + (started ? 1 : 0);
  saveState();
  const g = libraryGames.find(x => x.id === gameId);
  return { gameId, ...gameState(gameId), title: g?.title };
}
// stop: anything more that quitting needs (a Windows game in Proton: its Wine service, see compat.js).
function track(game, child, stop) {
  const start = Date.now();
  running.set(game.id, { child, start, stop });
  sendWindow('game:started', recordPlay(game.id));
  child.once('exit', () => {
    if (running.get(game.id)?.child === child) running.delete(game.id);
    // The game window opened on top of Harbour, so there was nothing to minimize; just come back to the front.
    try { const { entry } = recompEntry(game.id); if (entry?.updater) adoptLauncherBuild(entry); } catch {}  // built through its launcher: plays the game now
    sendWindow('game:ended', { ...recordPlay(game.id, Date.now() - start, false), running: running.size });
    if (win && !win.isDestroyed()) win.focus();
  });
}
// Ends the newest running game and everything it started (an emulator's helper processes).
function quitGame() {
  const last = [...running.values()].pop();
  if (!last) return false;
  const pid = last.child.pid;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM'); // detached: the game leads its own process group
  } catch { try { last.child.kill(); } catch {} }
  last.stop?.();
  return true;
}

// PC games and other "run the file itself" systems: programs are started in their own folder;
// shortcuts (.lnk, .url) and anything else are opened the way Windows would open them.
async function launchDirect(game) {
  let file = game.recomp ? config.extraGames.find(x => x.id === game.added)?.executable : game.romPath;
  // the game's program gone (a port rebuilds it), its setup still there: the setup makes it again
  const own = game.recomp ? config.extraGames.find(x => x.id === game.added) : null;
  if (file && !fs.existsSync(file) && own?.setup && fs.existsSync(own.setup)) file = own.setup;
  if (!file) throw new Error(`Choose its program first: ••• → ${process.platform === 'linux' ? 'Choose game program…' : 'Choose game .exe…'}`);
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} is missing. Was it moved or deleted?`);
  // Programs are started directly; batch files, shortcuts and anything else open the way the system would.
  // On Linux a Windows program (.exe) starts through Proton.
  const windowsGame = process.platform === 'linux' && /\.exe$/i.test(file);
  const program = process.platform === 'win32' ? /\.exe$/i.test(file) : (windowsGame || /\.app$/i.test(file) || (fs.statSync(file).mode & 0o111) !== 0);
  if (process.platform === 'linux' && /\.desktop$/i.test(file)) return launchDesktopFile(game, file);
  if (!program) {
    const err = await shell.openPath(file);
    if (err) throw new Error(`Couldn't open ${path.basename(file)}: ${err}`);
    sendWindow('game:started', { ...recordPlay(game.id), untracked: true });
    return true;
  }
  const exe = macAppBinary(file);
  // A PC port can need options or its own starting folder (some start through their own launcher's play mode).
  const entry = game.recomp ? config.extraGames.find(x => x.id === game.added) : null;
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  const cwd = entry?.cwd && fs.existsSync(entry.cwd) ? entry.cwd : path.dirname(exe);
  const run = windowsGame ? compat.windowsCommand(exe, args, launchEnv()) : { cmd: exe, args, env: launchEnv() };
  if (run.via) log(`${game.title}: Windows game, started through ${run.via}`);
  return new Promise((resolve, reject) => {
    padDefaults(exe);
    const child = spawn(run.cmd, run.args, { cwd, env: run.env, detached: true, stdio: 'ignore' });
    child.once('error', e => reject(new Error(`Launch failed: ${e.message}`)));
    child.once('spawn', () => { track(game, child, run.stop); child.unref(); resolve(true); });
    // A port's setup that makes the game's program: once it closes, Play starts that program from then on.
    if (entry && SETUP_EXE.test(path.basename(exe))) child.once('exit', () => {
      const best = portPrograms(entry.path, { repo: entry.source?.repo, title: entry.title }).programs[0];
      if (!best || path.resolve(best) === path.resolve(exe)) return;
      entry.setup = exe; entry.executable = best; saveConfig(config);
      log(`${entry.title}: setup made ${path.basename(best)}, which Play starts now`);
      win?.webContents.send('toast', `${entry.title} is set up: Play now starts ${path.basename(best)}.`);
    });
  });
}
// A Linux shortcut (.desktop, like the ones Steam makes): started the way the desktop would, through gio.
// Like Windows shortcuts it has no process to follow, so it only counts as played.
function launchDesktopFile(game, file) {
  return new Promise((resolve, reject) => {
    const child = spawn('gio', ['launch', file], { detached: true, stdio: 'ignore', env: launchEnv() });
    child.once('error', () => reject(new Error(`Couldn't open ${path.basename(file)}: gio (part of GLib) isn't installed.`)));
    child.once('spawn', () => { child.unref(); sendWindow('game:started', { ...recordPlay(game.id), untracked: true }); resolve(true); });
  });
}
// The disc to start a multi-disc game with. Systems whose emulators read .m3u playlists get one
// (written to the data folder, chosen disc first), so the emulator can still swap discs in-game.
function discFile(game, sys, index) {
  if (!game.discPaths?.length) return game.romPath;
  const i = Math.max(0, Math.min(game.discPaths.length - 1, Number(index) || 0));
  if (!(sys.extensions || []).includes('.m3u')) return game.discPaths[i];
  const order = [...game.discPaths.slice(i), ...game.discPaths.slice(0, i)];
  const dir = path.join(DATA, 'playlists', sys.id);
  const file = path.join(dir, `${(looseKey(game.base) || 'game').slice(0, 80)}-disc${game.discs[i]}.m3u`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, order.join('\n') + '\n');
  return file;
}
// ---------- Emulator setup: fullscreen and a sharp picture ----------
// Every emulator Harbour starts a game in opens fullscreen, and draws at a resolution that fits this screen instead
// of the console's own (480 lines on a PS2, stretched up). Works for emulators you added too: they're known by their
// program's name. The resolution is set once per settings file and screen size, so a change you make inside the
// emulator stays (until the screen changes). Emulators that already draw at the screen's resolution (RMG, PPSSPP)
// and ones too heavy to push further on most PCs (Switch, Wii U, PS3, Xbox 360) are left as they are.

// The console's own picture height, and the most Harbour scales it up (a cap so older GPUs keep full speed).
const NATIVE_LINES = { ps1: 240, n64: 240, ps2: 480, gc: 480, wii: 480, xbox: 480, dreamcast: 480, psp: 272, nds: 192, '3ds': 240 };
const MAX_SCALE = { ps1: 8, ps2: 4, gc: 4, wii: 4, xbox: 3, dreamcast: 4, nds: 8, '3ds': 5 };
function resolutionScale(sysId) {
  if (!NATIVE_LINES[sysId] || !MAX_SCALE[sysId]) return 0;
  let height = 1080;
  try {
    const { screen } = require('electron');
    const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    height = Math.round(d.size.height * d.scaleFactor);
  } catch {}
  return Math.max(1, Math.min(MAX_SCALE[sysId], Math.round(height / NATIVE_LINES[sysId])));
}
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const documents = () => { try { return app.getPath('documents'); } catch { return path.join(os.homedir(), 'Documents'); } };
const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const xdgData = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
// A program's name without its ending: "pcsx2-qt.exe" and "pcsx2-v2.8.2-linux-appimage-x64-Qt.AppImage" both start
// "pcsx2", so one rule fits an emulator on Windows and Linux.
const programName = exe => path.basename(String(exe || '')).replace(/\.(exe|appimage)$/i, '').toLowerCase();
const named = s => new RegExp(`^(${s})(?![a-z0-9])`, 'i');
// What each emulator needs: its fullscreen switch, and how to set its resolution (a launch option, or a settings
// file: the first of `files` that exists, with section -> key -> value).
const EMU_SETUP = [
  { exe: named('dolphin'), fullscreen: ['-C', 'Dolphin.Display.Fullscreen=True'], args: s => ['-C', `GFX.Settings.InternalResolution=${s}`] },
  { exe: named('flycast'), fullscreen: ['-config', 'window:fullscreen=yes'], args: s => ['-config', `config:rend.Resolution=${480 * s}`] },
  { exe: named('pcsx2'), fullscreen: ['-fullscreen'],
    files: dir => [path.join(dir, 'inis', 'PCSX2.ini'), path.join(documents(), 'PCSX2', 'inis', 'PCSX2.ini'), path.join(xdgConfig(), 'PCSX2', 'inis', 'PCSX2.ini')],
    values: s => ({ 'EmuCore/GS': { upscale_multiplier: s } }) },
  { exe: named('duckstation'), fullscreen: ['-fullscreen'],
    files: dir => [path.join(dir, 'settings.ini'), path.join(localAppData(), 'DuckStation', 'settings.ini'), path.join(documents(), 'DuckStation', 'settings.ini'),
      path.join(xdgData(), 'duckstation', 'settings.ini')],
    values: s => ({ GPU: { ResolutionScale: s } }) },
  { exe: named('melonds'), fullscreen: ['-f'],
    files: dir => [path.join(dir, 'melonDS.toml'), path.join(appData(), 'melonDS', 'melonDS.toml'), path.join(xdgConfig(), 'melonDS', 'melonDS.toml')],
    values: s => ({ '3D': { Renderer: 1 }, '3D.GL': { ScaleFactor: s } }) },  // the OpenGL renderer can scale; software can't
  { exe: named('xemu'), fullscreen: ['-full-screen'],
    files: dir => [path.join(dir, 'xemu.toml'), path.join(appData(), 'xemu', 'xemu', 'xemu.toml'), path.join(xdgData(), 'xemu', 'xemu', 'xemu.toml')],
    values: s => ({ 'display.quality': { surface_scale: s } }) },
  { exe: named('azahar(plus)?|citra(-qt)?|lime3ds'), fullscreen: ['-f'],
    files: dir => [path.join(dir, 'user', 'config', 'qt-config.ini'), path.join(appData(), 'Azahar', 'config', 'qt-config.ini'),
      path.join(xdgConfig(), 'azahar-emu', 'qt-config.ini'), path.join(xdgConfig(), 'Azahar', 'qt-config.ini')],
    values: s => ({ Renderer: { 'resolution_factor\\default': 'false', resolution_factor: s } }) },
  { exe: named('rpcs3'), fullscreen: ['--fullscreen'], only: args => args.includes('--no-gui') },  // RPCS3's switch needs --no-gui
  { exe: named('eden|lichii|yuzu|citron|suyu|sudachi|torzu'), fullscreen: ['-f'] },
  { exe: named('rmg'), fullscreen: ['--fullscreen'] },
  { exe: named('shadps4'), fullscreen: ['-f', 'true'] },
  { exe: named('ppsspp\\w*'), fullscreen: ['--fullscreen'] },
  { exe: named('xenia\\w*'), fullscreen: ['--fullscreen'] },
  { exe: named('cemu'), fullscreen: ['-f'] },
  { exe: named('ryujinx'), fullscreen: ['--fullscreen'] },
  { exe: named('mgba(-qt)?'), fullscreen: ['-f'] },
  { exe: named('snes9x'), fullscreen: ['-fullscreen'] },
  { exe: named('mesen'), fullscreen: ['--fullscreen'] },
];
const setupFor = exe => EMU_SETUP.find(x => x.exe.test(programName(exe)));
// Sets key = value lines inside [section] blocks of an ini/TOML-style file, adding what's missing. Keeps the rest.
function setFileValues(file, sections) {
  const text = fs.readFileSync(file, 'utf8'), nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [section, values] of Object.entries(sections)) {
    let start = lines.findIndex(l => l.trim() === `[${section}]`);
    if (start < 0) { if (lines.length && lines[lines.length - 1].trim() !== '') lines.push(''); lines.push(`[${section}]`); start = lines.length - 1; }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    for (const [key, value] of Object.entries(values)) {
      const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${esc(key)}\\s*=`).test(l));
      if (at >= 0) lines[at] = `${key} = ${value}`;
      else { lines.splice(start + 1, 0, `${key} = ${value}`); end++; }
    }
  }
  fs.writeFileSync(file, lines.join(nl));
}
// The launch options for a game: the emulator's own, plus its fullscreen switch and resolution when they're missing.
// Settings files are written here too (before the game starts, and again after it closes, for an emulator whose
// settings file only appears on its first run).
function emulatorSetup(exe, sysId, args, rom) {
  padDefaults(exe);
  moveSaves(exe, rom);
  const s = setupFor(exe);
  if (!s) return args;
  // Added at the front: some emulators stop reading options at the game file, and options like "-dvd_path <file>"
  // must stay together.
  let out = [...args];
  const present = flag => out.some(a => a.toLowerCase() === flag.toLowerCase());
  if (s.fullscreen && (!s.only || s.only(out)) && !s.fullscreen.every(present)) out = [...s.fullscreen, ...out];
  const scale = resolutionScale(sysId);
  if (scale && s.args) out = [...s.args(scale), ...out];
  if (scale && s.files) tuneFile(exe, s, scale);
  return out;
}
function tuneFile(exe, s, scale) {
  const file = s.files(path.dirname(exe)).find(f => fs.existsSync(f));
  if (!file) return;
  config.tuned ||= {};
  const key = file.toLowerCase();
  if (config.tuned[key] === scale) return;  // set already; a change made in the emulator since then stays
  try { setFileValues(file, s.values(scale)); config.tuned[key] = scale; saveConfig(config); log(`set ${path.basename(exe)} to ${scale}x resolution (${file})`); }
  catch (e) { log(`couldn't set ${path.basename(exe)}'s resolution: ${e.message}`); }
}

function launchGame(gameId, options = {}) {
  // The ROM path always comes from the scanned library, never from the renderer.
  const game = libraryGames.find(g => g.id === gameId);
  if (!game) throw new Error('This game is no longer in your library. Was it moved or deleted?');
  const sys = config.systems.find(s => s.id === game.system);
  if (!sys) throw new Error('Unknown system');
  let disc = 0;
  if (game.discPaths?.length) {
    disc = Math.max(0, Math.min(game.discPaths.length - 1, Number(options.disc ?? libraryState.discs[game.id] ?? 0) || 0));
    if (disc) libraryState.discs[game.id] = disc; else delete libraryState.discs[game.id];
    saveState();
  }
  // PC ports run themselves; everything else starts with the emulator its console uses.
  if (game.recomp || sys.direct) return launchDirect(game);
  const emuId = sys.emulator;
  if (!emuId || !emuDef(emuId)) throw new Error(`No emulator is set for ${sys.name}. Choose one in Settings → Emulators.`);
  const exe = macAppBinary(resolveExe(emuId));
  if (!exe) throw new Error(`${emuDef(emuId).name}'s program wasn't found. Choose it again in Settings → Emulators.`);
  const tpl = emuDef(emuId).args || '{rom}';
  const rom = discFile(game, sys, disc);
  // split/join instead of replace(): "$&", "$$" etc. in a filename must stay literal.
  const args = emulatorSetup(exe, sys.id, splitArgs(tpl).map(a => a.split('{rom}').join(rom)), rom);
  return new Promise((resolve, reject) => {
    // detached: the game keeps running if Harbour is closed or restarted while playing.
    const child = spawn(exe, args, { cwd: path.dirname(exe), env: launchEnv(), detached: true, stdio: 'ignore' });
    child.once('error', e => reject(new Error(`Launch failed: ${e.message}`)));
    // An emulator's settings file can first appear when it closes: set its resolution then, for next time.
    child.once('exit', () => { const s = setupFor(exe), scale = resolutionScale(sys.id); if (s?.files && scale) tuneFile(exe, s, scale); moveSaves(exe); });
    child.once('spawn', () => { track(game, child); child.unref(); resolve(true); });
  });
}

// ---------- Window & IPC ----------
// Fullscreen is remembered, so Harbour opens the way it was left. --fullscreen and --windowed set
// it from a shortcut or from Steam's launch options; like F11, the choice is then remembered.
const flag = name => process.argv.slice(1).includes('--' + name);
const startFullscreen = flag('fullscreen') || (!!config.fullscreen && !flag('windowed'));
function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 1100, minHeight: 650,
    fullscreen: startFullscreen,
    backgroundColor: '#07080c', autoHideMenuBar: true, title: 'OneDeck',
    icon:path.join(ROOT,'ui/assets/brand/onedeck-icon-256.png'),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  // A --fullscreen / --windowed launch is the same choice as pressing F11, so record it either way.
  if (config.fullscreen !== startFullscreen) { config.fullscreen = startFullscreen; saveConfig(config); }
  win.loadFile(path.join(ROOT, 'ui', 'index.html'));
  // Web links (like the catalogue's credit) open in the normal browser, never inside Harbour.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:[/][/]/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https:[/][/]/.test(url)) shell.openExternal(url); } });
  win.webContents.once('did-finish-load', () => log('window loaded', { visible: win.isVisible(), bounds: win.getBounds() }));
  win.webContents.on('did-fail-load', (_e, code, desc) => log('window failed to load', code, desc));
  if (configWarning) win.webContents.once('did-finish-load', () => win.webContents.send('toast', configWarning));
  // Consume F11 before Electron's menu can also toggle fullscreen.
  // Ctrl/Cmd+Shift+F also works when F11 is taken by the window manager.
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '');
    if (key !== 'F11' && !(key.toLowerCase() === 'f' && input.shift && (input.control || input.meta))) return;
    event.preventDefault();
    if (input.type === 'keyDown' && !input.isAutoRepeat) setFullScreen(!win.isFullScreen());
  });
  // Remember the choice however it was made: the shortcut, the setting, or the title bar.
  for (const [event, on] of [['enter-full-screen', true], ['leave-full-screen', false]])
    win.on(event, () => {
      if (config.fullscreen !== on) { config.fullscreen = on; saveConfig(config); }
      if (!win.isDestroyed()) win.webContents.send('fullscreen', on);
    });
}
function setFullScreen(on) {
  if (!win || win.isDestroyed()) return false;
  win.setFullScreen(!!on);
  // Linux window managers answer asynchronously, so report what was asked for.
  return !!on;
}

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  try { return { ok: true, value: await fn(...a) }; } catch (err) { return { ok: false, error: err.message }; }
});

handle('config:get', () => config);
// Emulators, added games and fullscreen are owned by their own handlers, so a window holding an
// older copy of the settings can never overwrite them.
handle('config:set', cfg => {
  if (!cfg || !Array.isArray(cfg.systems)) throw new Error('Invalid settings');
  // What the main process owns (emulators, games, cloud saves, tuned emulator settings) is kept from its own copy.
  const next = { ...cfg, emulators: config.emulators, customEmulators: config.customEmulators, extraGames: config.extraGames, fullscreen: config.fullscreen,
    cloudSaves: config.cloudSaves, savesFor: config.savesFor, tuned: config.tuned,
    saveFolders: config.saveFolders, savesConsoles: config.savesConsoles, savesSkip: config.savesSkip };
  saveConfig(next);
  config = next;
  return config;
});
// Game details (description, year, developer, publisher, genre, players) from the LaunchBox database.
// Only empty fields are filled, so gamelist.xml and info.json always win. Needs no network.
async function fillGameDetails(games) {
  if (!launchbox.available()) return [];
  const changed = [];
  for (const game of games) {
    if (game.demo || (game.info?.description && game.info?.year)) continue;
    let details = null;
    try { details = await launchbox.details(game.system, artwork.titleKeys(game)); } catch { return changed; }
    if (!details) continue;
    const added = {};
    for (const [k, v] of Object.entries(details)) if (!game.info?.[k]) added[k] = v;
    if (!Object.keys(added).length) continue;
    game.info = { ...(game.info || {}), ...added };
    changed.push({ gameId: game.id, info: game.info });
  }
  return changed;
}

// Details are filled in after the library is shown, so a scan never waits on them.
const fillDetailsLater = games => setImmediate(() => fillGameDetails(games).then(changed => {
  if (changed.length && win && !win.isDestroyed()) win.webContents.send('library:info', changed);
}).catch(() => {}));
// The last scan's games, for showing the shelf before the first scan of this start finishes.
handle('library:cached', async () => {
  const cached = await readLibraryCache();
  if (!cached) return null;
  const games = presentLibrary(cached);
  fillDetailsLater(games);
  return games;
});
// onlyIfChanged: the window already shows the cached library, so return null when nothing changed.
handle('library:scan', async (withReport = false, { onlyIfChanged = false } = {}) => {
  const folders = withReport ? [] : undefined;
  const games = await scanLibrary(folders);
  if (onlyIfChanged && !withReport && !lastScanChanged) return null;
  fillDetailsLater(games);
  return withReport ? { games, folders } : games;
});
ipcMain.on('app:quit', event => {
  if (event.sender === win?.webContents && event.senderFrame === event.sender.mainFrame) app.quit();
});
handle('game:launch', (id, options) => launchGame(id, options || {}));
handle('game:quit', () => quitGame());
handle('game:running', () => [...running.keys()]);
function setGameHidden(gameId, hidden) {
  if (!libraryGames.some(g => g.id === gameId)) throw new Error('Select a game in your library first.');
  if (hidden) libraryState.hidden[gameId] = true; else delete libraryState.hidden[gameId];
  writeState();
  return gameState(gameId);
}
handle('game:setHidden', ({ gameId, hidden }) => setGameHidden(gameId, !!hidden));
handle('game:openFolder', async gameId => {
  const game = libraryGames.find(g => g.id === gameId);
  if (!game?.romPath || !fs.existsSync(game.romPath)) throw new Error('The game file is missing. Was it moved or deleted?');
  const folder = fs.statSync(game.romPath).isDirectory() ? game.romPath : path.dirname(game.romPath);
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
  return true;
});
handle('game:chooseExecutable', async gameId => {
  const game = libraryGames.find(g => g.id === gameId && g.recomp);
  const entry = game && config.extraGames.find(x => x.id === game.added);
  if (!entry) throw new Error('Select a Recomp game first.');
  const linux = process.platform === 'linux';
  const result = await dialog.showOpenDialog(win, {title:'Choose the program for ' + game.title,defaultPath:entry.path,properties:['openFile'],
    filters: linux ? [{name:'All files',extensions:['*']}] : [{name:'Game executable',extensions:['exe']}]});
  if (result.canceled) return null;
  const file = result.filePaths[0];
  if (!fs.statSync(file).isFile() || !(/\.exe$/i.test(file) || (linux && isLinuxProgram(file)))) throw new Error(linux ? 'Choose the game\'s program (a Linux program or a Windows .exe).' : 'Choose a game .exe file.');
  entry.executable = file; saveConfig(config);
  return {gameId, executable:file};
});
// Box art, background art and videos: each can be off for everything (Settings) or for single games. Either way it
// isn't shown or downloaded, and the files stay: "Delete unused" removes the ones of games it's off for.
const MEDIA = {
  box: { flag: 'noBox', setting: 'harbourBoxArt', folders: ['covers'], kinds: ['front'] },
  background: { flag: 'noBackground', setting: 'harbourBackgrounds', folders: ['fanart', 'screenshots'], kinds: ['fanart', 'screenshot'] },
  video: { flag: 'noVideo', setting: 'harbourVideos', folders: ['videos'], kinds: ['video'] },
};
const mediaKind = kind => { const m = MEDIA[kind]; if (!m) throw new Error('Unknown media.'); return m; };
function mediaWanted(game, kind) {
  const m = Object.values(MEDIA).find(x => x.kinds.includes(kind));
  return !m || (config[m.setting] !== false && !libraryState[m.flag]?.[game.id]);
}
// A game's files of this kind in Harbour's media folders.
function mediaFiles(g, m) {
  if (!g.base) return [];
  const out = [];
  for (const f of m.folders) {
    const dir = path.join(DATA, 'media', g.system, f);
    try { for (const n of fs.readdirSync(dir)) if (n.startsWith(g.base + '.')) out.push(path.join(dir, n)); } catch {}
  }
  return out;
}
const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
handle('media:set', async ({ kind, off = [], on = [] }) => {
  const m = mediaKind(kind);
  libraryState[m.flag] ||= {};
  for (const id of on) delete libraryState[m.flag][id];
  for (const id of off) if (libraryGames.some(x => x.id === id)) libraryState[m.flag][id] = true;
  saveState();
  if (off.length || on.length) log(`${kind}: off for ${off.length}, on for ${on.length}`);
  return true;
});
// Each game's size for this kind (games that have some), and all of it together.
handle('media:sizes', kind => {
  const m = mediaKind(kind), out = {};
  for (const g of libraryGames) { const n = mediaFiles(g, m).reduce((t, f) => t + sizeOf(f), 0); if (n) out[g.id] = n; }
  return out;
});
const mediaFolders = m => { try { return fs.readdirSync(path.join(DATA, 'media'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_'))
  .flatMap(e => m.folders.map(f => path.join(DATA, 'media', e.name, f))).filter(d => fs.existsSync(d)); } catch { return []; } };
// Unused: a kind's files for games it's unchecked for (Manage), and anything left by games no longer in the library.
// Switching a kind Off for everything doesn't make it unused. Only Harbour's own media folders are looked at.
const OWN_MEDIA = ['covers', 'fanart', 'screenshots', 'logos', 'videos'];
function unusedMedia() {
  const bases = new Map();  // console -> names of its games' files
  for (const g of libraryGames) if (g.base) (bases.get(g.system) || bases.set(g.system, new Set()).get(g.system)).add(g.base);
  const out = [];
  for (const m of Object.values(MEDIA)) for (const g of libraryGames) if (libraryState[m.flag]?.[g.id]) out.push(...mediaFiles(g, m));
  let systems = [];
  try { systems = fs.readdirSync(path.join(DATA, 'media'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => e.name); } catch {}
  for (const sys of systems) for (const folder of OWN_MEDIA) {
    const dir = path.join(DATA, 'media', sys, folder);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name); } catch { continue; }
    for (const n of names) {
      const base = /\.source\.json$/i.test(n) ? n.slice(0, -12) : n.replace(/\.[^.]+$/, '');  // a clip's notes: X.source.json
      if (!bases.get(sys)?.has(base)) out.push(path.join(dir, n));
    }
  }
  return out;
}
handle('media:unused', () => unusedMedia().reduce((n, f) => n + sizeOf(f), 0));
handle('media:deleteUnused', async () => {
  let freed = 0, count = 0;
  for (const f of unusedMedia()) { freed += sizeOf(f); count++; await fsp.rm(f, { force: true }).catch(() => {}); }
  log(`deleted unused media: ${count} files (${Math.round(freed / 1048576)} MB)`);
  return freed;
});
handle('media:usage', kind => mediaFolders(mediaKind(kind)).reduce((n, d) => n + folderSize(d), 0));
handle('media:clearAll', async kind => {
  const m = mediaKind(kind);
  if (kind === 'video') videos.cancel(); else artwork.cancel();
  let freed = 0;
  for (const d of mediaFolders(m)) { freed += folderSize(d); await fsp.rm(d, { recursive: true, force: true }); }
  log(`deleted all ${kind} (${Math.round(freed / 1048576)} MB)`);
  return freed;
});
handle('game:setFavorite', ({ gameId, favorite }) => {
  if (!libraryGames.some(g => g.id === gameId)) throw new Error('Select a game in your library first.');
  if (favorite) libraryState.favorites[gameId] = true; else delete libraryState.favorites[gameId];
  saveState();
  return gameState(gameId);
});
// Rename a game. Like hiding, this lives in library-state.json; the file on disk keeps its name.
// An empty title clears the override and the scanned file name comes back.
handle('game:setTitle', ({ gameId, title }) => {
  const game = libraryGames.find(g => g.id === gameId);
  if (!game) throw new Error('Select a game in your library first.');
  const wanted = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  libraryState.titles ||= {};
  if (libraryState.metadata?.[gameId]) delete libraryState.metadata[gameId].title;
  if (wanted) libraryState.titles[gameId] = wanted; else delete libraryState.titles[gameId];
  game.title = wanted || game.scannedTitle || displayTitle(game.base);
  saveState();
  return { title: game.title, ...gameState(gameId) };
});
handle('app:fullscreen', () => !!(win && !win.isDestroyed() && win.isFullScreen()));
handle('app:setFullscreen', on => setFullScreen(on));
handle('library:ui', () => libraryState.ui || {});
handle('library:saveUi', patch => {
  if (!patch || typeof patch !== 'object') return false;
  const ui = { ...(libraryState.ui || {}) };
  for (const k of ['system', 'game', 'perSystem', 'sort', 'filter']) if (k in patch) ui[k] = patch[k];
  if (ui.perSystem && typeof ui.perSystem === 'object') ui.perSystem = Object.fromEntries(Object.entries(ui.perSystem).slice(-100).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'));
  libraryState.ui = ui; saveState();
  return true;
});
// ---------- Adding things the easy way ----------
// A PC port / recomp: the programs in its folder, sorted the same way wherever Harbour needs one. Helpers are never
// the game (uninstallers, crash reporters, redistributables, the build tools some recomps ship); a setup or installer
// is kept apart: some ports only have one at first, and it makes the game's program from your files. The rest are
// ranked: in the folder itself before deeper ones, named like the project or the game, then the biggest.
const HELPER_EXE = /unins|crash_?(pad|handler|report|dump|sender|upload)|report|redist|clang|lld|ninja|cmake|python|xbe_recomp|dxsetup|dxwebsetup|updater|update|ffmpeg|ffprobe|7z|helper|elevate|cli\.exe$|dotnet|vc_|createdump/i;
const SETUP_EXE = /setup|install/i;
// A Linux program: an AppImage, or a file marked runnable with no ending (or a game ending like .x86_64). Not libraries.
function isLinuxProgram(p) {
  const n = path.basename(p).toLowerCase();
  if (/\.so(\.|$)/.test(n)) return false;
  if (!/\.(appimage|x86_64|x86|sh)$/.test(n) && path.extname(n)) return false;
  try { return (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; }
}
function portPrograms(folder, { repo, title } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !/^(_harbour-backup|disc|data|saves?|mods|cache|shaders?|tools?|toolchain|deps|redist)$/i.test(e.name)) walk(p, depth + 1);
      else if (e.isFile() && !HELPER_EXE.test(e.name) && (/\.exe$/i.test(e.name) || (process.platform === 'linux' && isLinuxProgram(p)))) {
        let size = 0;
        try { size = fs.statSync(p).size; } catch {}
        found.push({ p, depth, size, setup: SETUP_EXE.test(e.name), native: !/\.exe$/i.test(e.name) });
      }
    }
  };
  walk(folder, 0);
  const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !/^(the|recomp|recompiled|port|win64|x64|windows|pc)$/.test(w));
  const hints = new Set([...words(String(repo || '').split('/').pop()), ...words(title)]);
  const score = f => {
    const name = programName(f.p);
    let v = -f.depth * 100 + Math.min(f.size / 1e6, 99) / 10;  // a megabyte is a tenth of a point, up to ten
    if (f.native) v += 50;  // on Linux, a port's own Linux build before its Windows one
    for (const w of hints) if (name.includes(w)) v += 30;
    return v;
  };
  const ranked = found.sort((a, b) => score(b) - score(a));
  const programs = ranked.filter(f => !f.setup), setups = ranked.filter(f => f.setup);
  // only a setup beside the folder's top and programs deeper in: those are tools it ships, the setup comes first
  const setupFirst = setups[0]?.depth === 0 && !programs.some(f => f.depth === 0);
  return { programs: programs.map(f => f.p), setups: setups.map(f => f.p), setupFirst };
}
// The program that starts the game (its setup while the game's own program isn't made yet)
function findGameExe(folder, hints) {
  const { programs, setups, setupFirst } = portPrograms(folder, hints);
  return (setupFirst ? setups[0] : programs[0]) || setups[0] || null;
}
function findSetupExe(folder, hints) { return portPrograms(folder, hints).setups[0] || null; }
// "BanjoKazooie-PC" -> "Banjo Kazooie", "gta-vcs-recomp" -> "Gta Vcs" (a starting point; you can rename it).
const titleFromFolder = name => name.replace(/[-_ .](pc|port|recomp(iled)?|windows|win64|x64)$/i, '').replace(/[-_.]+/g, ' ')
  .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
// ---- Working out what a PC port is, from its folder ----
// Consoles named in text, most specific first ("Switch 2" before "Switch", "Xbox 360" before "Xbox").
const CONSOLE_NAMES = [
  ['switch2', /\bswitch ?2\b|\bnx2\b/i], ['switch', /\bswitch\b/i], ['x360', /xbox ?360|\bx360\b/i],
  ['xbox', /\bxbox\b(?! ?(?:360|one|series))|\bog xbox\b/i], ['ps4', /\bps4\b|playstation ?4/i], ['ps3', /\bps3\b|playstation ?3/i],
  ['ps2', /\bps2\b|playstation ?2/i], ['psp', /\bpsp\b/i], ['ps1', /\bps1\b|\bpsx\b|playstation(?! ?[2-5])/i],
  ['n64', /\bn64\b|nintendo ?64/i], ['gc', /gamecube|\bngc\b/i], ['wiiu', /\bwii ?u\b/i], ['wii', /\bwii\b(?! ?u)/i],
  ['3ds', /\b3ds\b/i], ['nds', /\bnds\b|nintendo ds\b/i], ['gba', /\bgba\b|game ?boy advance/i], ['dreamcast', /dreamcast/i],
  ['genesis', /genesis|mega ?drive/i], ['snes', /\bsnes\b|super nintendo/i], ['nes', /\bnes\b/i],
];
const consolesNamedIn = text => CONSOLE_NAMES.filter(([, re]) => re.test(text || '')).map(([id]) => id);
// "SuperMarioOdyssey_v2" -> "Super Mario Odyssey v2"
const splitName = s => String(s || '').replace(/\.exe$/i, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[-_.]+/g, ' ').trim();
const PORT_JARGON = /\b(re-?comp(?:iled|ilation)?|static|native|pc|ports?|decomp(?:iled|ilation)?|launcher|win(?:dows|64)?|x64|setup|portable|release)\b/gi;

// GitHub projects the game's own files link to (readme, licence, credits), most mentioned first.
function linkedRepos(folder) {
  const counts = new Map();
  let budget = 400;  // files looked at, so a folder of unpacked game data doesn't take minutes
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (depth > 0 && entries.length > 300) return;  // a data folder, not docs
    for (const e of entries) {
      if (budget <= 0) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2 && !/^(_harbour-backup|node_modules|\.git|cache|shaders?|saves?|romfs|exefs)$/i.test(e.name)) walk(p, depth + 1); continue; }
      if (!/\.(md|txt|json|ini|toml|ya?ml|cfg|html?)$|^(license|readme|credits|notice)/i.test(e.name)) continue;
      budget--;
      let text = '';
      try { if (fs.statSync(p).size < 300 * 1024) text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/\s"'`)<>#?,]|$)/gi)) {
        const repo = `${m[1]}/${m[2]}`;
        if (!/^(sponsors|orgs|features|topics|login)$/i.test(m[1])) counts.set(repo, (counts.get(repo) || 0) + 1);
      }
    }
  };
  walk(folder, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([repo]) => repo);
}

// Is this project the one in the folder? Its newest release must hold the program. The release whose copy of the
// program is exactly the size of yours is the version you have (exact: true); failing that, the newest release
// published by the time your copy was made.
async function matchReleases(repo, exe) {
  const want = path.basename(exe).toLowerCase(), { size, mtimeMs } = fs.statSync(exe);
  let releases;
  try { releases = (await ghJson(`https://api.github.com/repos/${repo}/releases?per_page=4`)).filter(r => !r.draft); } catch { return null; }
  const held = [];
  for (const [i, rel] of releases.entries()) {
    const asset = guessAsset(rel.assets || []);
    if (!asset || !/\.zip$/i.test(asset.name)) continue;
    const names = await remoteZipNames(asset.browser_download_url);
    if (!names) continue;
    const inside = names.find(n => n.split('/').pop().toLowerCase() === want);
    if (!inside) { if (i === 0) return null; continue; }   // the newest release doesn't have it: not this project
    const installed = { tag: rel.tag_name, assetId: asset.id, date: asset.updated_at || rel.published_at };
    if (names.sizes.get(inside) === size) return { repo, prerelease: rel.prerelease, installed, exact: true };
    held.push(installed);
  }
  if (!held.length) return null;
  const byDate = held.find(r => Date.parse(r.date) <= mtimeMs + 2 * 864e5) || null;
  return { repo, prerelease: !!releases[0]?.prerelease, installed: byDate, exact: false };
}

// Words around a title that aren't part of it ("the Perfect Dark", "Nitro-Fueled and").
const EDGE_WORDS = /^(the|a|an|and|of|for|on|in|to|with|by|is|from)$/i;
// The game's real name and console: the longest run of words in the project's description, readme title, repo name
// or folder name that the LaunchBox database knows on a console (its PC listings are often the fan ports themselves,
// so they don't count). A console named in the text decides between several.
// When a game came out on several consoles and nothing names one: the consoles PC ports are usually made from first.
const PORT_CONSOLES = ['n64', 'ps2', 'x360', 'xbox', 'switch', 'gc', 'ps1', 'ps3', 'wii', 'switch2', 'ps4', 'dreamcast', 'psp', 'wiiu', 'snes', 'genesis', 'nds', '3ds', 'gba', 'gbc', 'gb', 'nes', 'a2600', 'arcade'];
const portRank = id => { const i = PORT_CONSOLES.indexOf(id); return i < 0 ? 99 : i; };
async function nameAndConsole(texts, ownName = '', clues = []) {
  texts = texts.filter(Boolean).map(t => t.replace(PORT_JARGON, ' '));
  const named = [...new Set([...clues, ...consolesNamedIn(texts.join(' \n '))])];
  // The first text with a match wins (the project's own title and description before anything it mentions later);
  // within it, the longest match.
  for (const text of texts) {
    let best = null;
    const words = text.replace(/[^\p{L}\p{N}'&:!.\- ]+/gu, ' ').split(/\s+/).map(w => w.replace(/^[:.\-]+$/, '')).filter(Boolean);
    for (let len = Math.min(words.length, 8); len >= 1; len--)
      for (let start = 0; start + len <= words.length; start++) {
        let run = words.slice(start, start + len);
        while (run.length && EDGE_WORDS.test(run[0].replace(/[:.\-]/g, '')) && run[0][0] === run[0][0].toLowerCase()) run = run.slice(1);
        while (run.length && EDGE_WORDS.test(run.at(-1).replace(/[:.\-]/g, ''))) run = run.slice(0, -1);
        const phrase = run.join(' ').replace(/^[:.\-]+|[:.\-]+$/g, '').trim();
        const key = looseKey(phrase);
        // A name starts with a capital or a number ("using" in a sentence is not the game Using).
        if (key.length < 5 || key === ownName || !/^[\p{Lu}\p{N}]/u.test(phrase) || (best && key.length <= best.key.length)) continue;
        const consoles = (await launchbox.consolesFor(key)).filter(c => c !== 'pc');
        if (!consoles.length) continue;
        const pick = consoles.find(c => named.includes(c)) || [...consoles].sort((a, b) => portRank(a) - portRank(b))[0];
        best = { key, title: phrase, platform: pick };
      }
    if (best) return { title: best.title, platform: best.platform };
  }
  return { title: null, platform: named.find(c => c !== 'pc') || null };
}

// Consoles the game's own folder gives away: its readme and notes, and files only one console's games have.
const CONSOLE_FILES = [['n64', /\.(z64|n64|v64)$/i], ['switch', /^(romfs|exefs)$|\.(nsp|xci)$/i], ['x360', /\.xex$/i], ['xbox', /\.xbe$/i],
  ['ps2', /\.(elf|irx)$|^slus_|^sles_/i], ['gc', /\.(gcm|rvz)$/i], ['ps1', /\.cue$/i]];
function consoleClues(folder) {
  const found = new Set();
  let text = '', budget = 200;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget-- <= 0) return;
      for (const [id, re] of CONSOLE_FILES) if (re.test(e.name)) found.add(id);
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 1 && entries.length < 300) walk(p, depth + 1); continue; }
      if (/\.(md|txt)$|^readme/i.test(e.name)) try { if (fs.statSync(p).size < 100 * 1024) text += fs.readFileSync(p, 'utf8').slice(0, 4000) + '\n'; } catch {}
    }
  };
  walk(folder, 0);
  for (const id of consolesNamedIn(text)) found.add(id);
  return [...found];
}

// Folder names that say nothing about the game: look one folder up as well.
const GENERIC_FOLDER = /^(launcher|bin|game|port|app|x64|win64|windows|build|release|dist|portable|files)$/i;

async function detectPort(folder, exe, known = null) {
  // 1. Which GitHub project: ones the game's files link to, then a search on its folder and program names.
  // (Installed from its GitHub page: the project and version are known already.)
  const folders = [path.basename(folder)];
  if (GENERIC_FOLDER.test(folders[0])) folders.push(path.basename(path.dirname(folder)));
  const candidates = known ? [] : linkedRepos(GENERIC_FOLDER.test(folders[0]) ? path.dirname(folder) : folder);
  const linked = new Set(candidates);
  // A name without the port jargon ("sly2-windows-x64" -> "sly2").
  const plain = s => splitName(String(s || '').replace(/[-_.]+/g, ' ').replace(PORT_JARGON, ' ')).replace(PORT_JARGON, ' ').replace(/\s+/g, ' ').trim();
  const names = [...new Set([...folders, path.basename(exe)].flatMap(n => [plain(n), splitName(n)]))].filter(n => n.length > 2 && !GENERIC_FOLDER.test(n));
  for (const n of known ? [] : names.slice(0, 3)) {  // GitHub allows only a few searches a minute
    try {
      const found = await ghJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(n)}&sort=stars&per_page=5`);
      for (const r of found.items || []) candidates.push(r.full_name);
    } catch {}
  }
  // The first project whose release has exactly your program wins. One that only holds a program of that name
  // counts just when the game's own files link to it: from a search alone it could be a fork (blank beats wrong).
  // (linked: the projects the game's own files mention, captured before the search results were added)
  let match = known ? { repo: known.repo, installed: known.installed, prerelease: false, exact: true } : null;
  for (const repo of known ? [] : [...new Set(candidates)].slice(0, 8)) {
    const m = await matchReleases(repo, exe);
    if (!m) continue;
    if (m.exact) { match = m; break; }
    if (linked.has(repo)) match ||= m;
  }

  // 2. Its name and console, from the project's description and readme title, else the folder's name.
  // The GitHub description usually names the game ("A PC port of Super Mario 64"); a readme's title is often the
  // port's own name ("Ghostship"), and the rest of the readme mentions other games too, so it comes last.
  let description = '', readmeTitle = '', readmeBody = '';
  if (match) {
    try { description = (await ghJson(`https://api.github.com/repos/${match.repo}`)).description || ''; } catch {}
    try {
      const readme = Buffer.from((await ghJson(`https://api.github.com/repos/${match.repo}/readme`)).content || '', 'base64').toString('utf8');
      readmeTitle = (/^#\s+(.+)$/m.exec(readme) || [])[1] || '';
      readmeBody = readme.slice(0, 1500);
    } catch {}
  }
  // The project's own name ("Ghostship") isn't the game's name, even if the games database lists it.
  const ownName = match ? looseKey(plain(match.repo.split('/')[1])) : '';
  // Your own game file's name ("Mario Kart 64 (USA).z64") says best which game it is, so it's asked first.
  const guess = await nameAndConsole([known?.gameFile ? cleanTitle(path.basename(known.gameFile, path.extname(known.gameFile))) : '', description, readmeTitle, match && plain(match.repo.split('/')[1]), ...folders.map(plain), plain(path.basename(exe)), readmeBody], ownName, consoleClues(GENERIC_FOLDER.test(folders[0]) ? path.dirname(folder) : folder));
  return {
    title: (guess.title || plain(folders.at(-1)) || titleFromFolder(path.basename(folder))).slice(0, 120),
    platform: guess.platform && config.systems.some(s => s.id === guess.platform) ? guess.platform : '',
    repo: match?.repo || '', prerelease: !!match?.prerelease, installed: match?.installed || null,
  };
}

// Works out a port's project, version, name and console (also run when adding one).
handle('harbour:detectPort', ({ folder, executable }) => detectPort(folder, executable));
// Step 1 of adding a PC port: choose its folder; Harbour finds the program and works out the rest.
handle('harbour:pickPort', async () => {
  const picked = await dialog.showOpenDialog(win, { title: 'Choose the game\'s folder', properties: ['openDirectory'] });
  if (picked.canceled) return null;
  const folder = picked.filePaths[0];
  if (config.extraGames.some(x => x.system === 'recomp' && path.resolve(x.path) === path.resolve(folder))) throw new Error('That game is already in OneDeck.');
  let executable = findGameExe(folder);
  if (!executable) {
    const r = await dialog.showOpenDialog(win, { title: 'Which program starts the game?', defaultPath: folder, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
    if (r.canceled) return null;
    executable = r.filePaths[0];
  }
  const found = await detectPort(folder, executable);
  log(`detected ${folder}: ${JSON.stringify(found)}`);
  const setup = findSetupExe(folder, { repo: found.repo, title: found.title });
  return { folder, executable, exeName: path.basename(executable), setup: setup && path.resolve(setup) !== path.resolve(executable) ? setup : null, ...found };
});
// The add card's "Change": another program in the port's folder (or anywhere) starts the game.
handle('harbour:pickPortExe', async folder => {
  const r = await dialog.showOpenDialog(win, { title: 'Which program starts the game?', defaultPath: folder, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
  return r.canceled ? null : r.filePaths[0];
});
// Step 2: add it as confirmed.
handle('harbour:addPort', async ({ folder, executable, setup, platform, title, repo, prerelease, installed }) => {
  if (!folder || !executable || !fs.existsSync(executable)) throw new Error('Choose the game\'s folder first.');
  if (platform && !config.systems.some(s => s.id === platform)) throw new Error('Unknown console.');
  if (config.extraGames.some(x => x.system === 'recomp' && path.resolve(x.path) === path.resolve(folder))) throw new Error('That game is already in OneDeck.');
  const source = String(repo || '').trim() ? { repo: parseRepo(repo), prerelease: !!prerelease } : undefined;
  const entry = { id: randomUUID().slice(0, 8), system: 'recomp', path: folder, title: String(title || '').trim().slice(0, 120) || titleFromFolder(path.basename(folder)),
    executable, platform: platform || undefined, source, installed: source && installed?.tag ? installed : undefined,
    setup: setup && fs.existsSync(setup) && path.resolve(setup) !== path.resolve(executable) ? setup : undefined };
  config.extraGames.push(entry); saveConfig(config);
  return { ...entry, exeName: path.basename(executable) };
});
// ---- Installing a PC port from its GitHub page, with your game file ----
// Harbour downloads the newest Windows release (checked like any update), unpacks it into Ports\<name> beside its
// data, puts your ROM or disc next to the program (where these ports look for it on their first start), works out
// the name and console and adds it. Projects without a ready-to-run Windows build are refused up front.
// Where ports and emulators install: beside Harbour's data, or a folder you chose (Settings). Installs already made
// stay where they are.
// games: the folder for your ROMs, one folder per console inside (the welcome screen makes them).
const DEFAULT_DIRS = { ports: path.join(path.dirname(DATA), 'Ports'), emulators: path.join(path.dirname(DATA), 'Emulators'),
  games: path.join(path.dirname(DATA), 'Games'), saves: path.join(path.dirname(DATA), 'Saves') };
const installDir = kind => config.installDirs?.[kind] || DEFAULT_DIRS[kind];
handle('harbour:installDirs', () => ({ ports: installDir('ports'), emulators: installDir('emulators'), games: installDir('games'), saves: installDir('saves') }));
// save: false only picks (the welcome screen saves its choices on Next). A folder that isn't there yet is made.
const setInstallDir = (kind, dir) => {
  if (!DEFAULT_DIRS[kind]) throw new Error('Unknown folder.');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (!canWrite(dir)) throw new Error("OneDeck can't write in that folder. Pick another (Program Files needs admin rights).");
  config.installDirs = { ...(config.installDirs || {}), [kind]: path.resolve(dir) === path.resolve(DEFAULT_DIRS[kind]) ? undefined : dir };
  saveConfig(config);
  return installDir(kind);
};
handle('harbour:setInstallDir', ({ kind, dir }) => setInstallDir(kind, dir));
handle('harbour:pickInstallDir', async (kind, { save = true } = {}) => {
  if (!DEFAULT_DIRS[kind]) throw new Error('Unknown folder.');
  const r = await dialog.showOpenDialog(win, { title: kind === 'ports' ? 'Where should PC ports install?' : kind === 'games' ? 'Where should your games (ROMs) go?' : 'Where should emulators install?',
    defaultPath: installDir(kind), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  if (!save) { if (!canWrite(dir)) throw new Error("OneDeck can't write in that folder. Pick another (Program Files needs admin rights)."); return dir; }
  return setInstallDir(kind, dir);
});
const GAME_FILE_EXTS = [...new Set(DEFAULT_SYSTEMS.filter(s => !s.direct).flatMap(s => s.extensions).map(e => e.slice(1)))];
handle('harbour:pickGameFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your game file (the ROM or disc the port is made from)', properties: ['openFile'],
    filters: [{ name: 'Game files', extensions: [...GAME_FILE_EXTS, 'sfc', 'smc', 'rsdk', 'bin', 'img'] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
// The catalogue of ports to choose from: Recompendium's (https://recompendium.com/, CC BY-SA 4.0), read once a week.
// Only what Harbour shows is kept: the game, the project, its GitHub page, its console and what it needs from you.
const CATALOG_FILE = path.join(DATA, 'media', '_index', 'recompendium.json');
const CATALOG_CONSOLES = { gamecube: 'gc', megadrive: 'genesis' };
// OneDeck's own ports, listed with Recompendium's and marked as OneDeck's: every public repository of HARBOUR_OWNERS
// with the onedeck-recomp topic and a onedeck.json saying what it is ({ name, project, console, consoleName,
// tier: alpha | beta | complete, needs, year, romDir: the folder beside the program the game file goes in }).
// Read once a day, so a new one shows up by itself. The old names (anydock-recomp, anydock.json, the goodthanksdev
// account) are still read for a while, for ports not moved over yet.
const HARBOUR_OWNERS = ['onedeck-launcher', 'goodthanksdev'];
const HARBOUR_TOPICS = ['onedeck-recomp', 'anydock-recomp'];
const HARBOUR_INFO = ['onedeck.json', 'anydock.json'];
const HARBOUR_TIERS = ['alpha', 'beta', 'complete'];
const HARBOUR_FILE = path.join(DATA, 'media', '_index', 'anydock-ports.json');
let harbourList = null;
async function harbourPorts() {
  if (!harbourList) try { harbourList = JSON.parse(await fsp.readFile(HARBOUR_FILE, 'utf8')); } catch {}
  if (harbourList && Date.now() - harbourList.at < 864e5) return harbourList.list;
  try {
    const users = HARBOUR_OWNERS.map(u => `user:${u}`).join(' '), repos = new Map();
    for (const topic of HARBOUR_TOPICS) {
      const found = await ghJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:${topic} ${users}`)}&per_page=100`);
      for (const r of found.items || []) if (!r.archived && !r.private) repos.set(r.full_name.toLowerCase(), r);
    }
    const list = (await Promise.all([...repos.values()].map(async r => {
      try {
        let j = null;
        for (const name of HARBOUR_INFO) {
          try { const file = await ghJson(`https://api.github.com/repos/${r.full_name}/contents/${name}`); j = JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8')); break; }
          catch (e) { if (e.status !== 404) throw e; }
        }
        if (!j) return null;
        if (!j.name || !j.console) return null;
        let released = false;
        try { released = (await ghJson(`https://api.github.com/repos/${r.full_name}/releases?per_page=5`)).some(x => !x.draft); } catch {}
        return { name: String(j.name), project: String(j.project || r.name), repo: r.full_name, console: String(j.console),
          consoleName: String(j.consoleName || j.console), status: HARBOUR_TIERS.includes(j.tier) ? j.tier : 'alpha',
          needs: String(j.needs || ''), stars: r.stargazers_count || 0, year: j.year || null, released, harbour: true,
          romDir: String(j.romDir || '').replace(/[\\/:*?"<>|.]+/g, '') };
      } catch { return null; }
    }))).filter(Boolean);
    harbourList = { at: Date.now(), list };
    await fsp.mkdir(path.dirname(HARBOUR_FILE), { recursive: true });
    await fsp.writeFile(HARBOUR_FILE, JSON.stringify(harbourList));
  } catch { if (!harbourList) return []; }  // offline or GitHub's limit: the last list is fine
  return harbourList.list;
}
handle('harbour:portCatalog', async () => {
  let cached = null;
  try { cached = JSON.parse(await fsp.readFile(CATALOG_FILE, 'utf8')); } catch {}
  if (!cached || Date.now() - cached.at > 7 * 864e5) {
    try {
      const r = await fetch('https://recompendium.com/unricopie/catalogo.json', { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`recompendium.com didn't answer (error ${r.status})`);
      const list = ((await r.json()).entradas || [])
        .filter(x => x.repo && /^[\w.-]+\/[\w.-]+$/.test(x.repo) && !x.retirado && !x.sin_enlace)
        .map(x => ({ name: x.nombre, project: x.proyecto, repo: x.repo, console: CATALOG_CONSOLES[x.consola] || x.consola, consoleName: x.consola_nombre,
          status: x.estado, needs: x.requisitos?.en || '', stars: x.estrellas || 0, year: x.anio || null, released: !!x.version }));
      cached = { at: Date.now(), list };
      await fsp.mkdir(path.dirname(CATALOG_FILE), { recursive: true });
      await fsp.writeFile(CATALOG_FILE, JSON.stringify(cached));
    } catch (e) { if (!cached) throw e; }  // offline: last week's list is fine
  }
  const have = new Set(config.extraGames.map(x => x.source?.repo?.toLowerCase()).filter(Boolean));
  const own = await harbourPorts(), mine = new Set(own.map(x => x.repo.toLowerCase()));
  return [...cached.list.filter(x => !mine.has(x.repo.toLowerCase())), ...own].map(x => ({ ...x, platform: config.systems.some(s => s.id === x.console) ? x.console : '', installed: have.has(x.repo.toLowerCase()) }));
});
const installingPorts = new Set();
handle('harbour:installPort', async ({ repo: link, rom, title, platform }) => {
  const repo = parseRepo(link);
  if (config.extraGames.some(x => x.source?.repo?.toLowerCase() === repo.toLowerCase())) throw new Error('That game is already in OneDeck.');
  if (rom && !fs.existsSync(rom)) throw new Error("Can't find that game file.");
  if (installingPorts.has(repo)) throw new Error('Already installing.');
  installingPorts.add(repo);
  const send = p => win?.webContents.send('recomp:progress', { gameId: 'port:' + repo, ...p });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbour-port-'));
  try {
    send({ stage: 'Finding the latest release…', pct: 0 });
    let rel;
    try { rel = await findRelease(repo, { prerelease: false, orWindows: true }); }
    catch (e) { throw new Error(e.status === 404 ? "GitHub can't find that project." : `${repo} has no download OneDeck can install. Install it the way its page says, then add its folder.`); }
    if (rel.launcher) {
      // Its own launcher builds the game from your copy and keeps it updated: that's what goes in. Play opens it
      // until the game is built; after that the game itself (adoptLauncherBuild).
      send({ stage: 'Getting its launcher…', pct: 0 });
      const exe = await placeLauncher(repo, rel.launcher, title || repo);
      const entry = { id: randomUUID().slice(0, 8), system: 'recomp', path: path.dirname(exe), title: String(title || repo.split('/')[1]).slice(0, 120),
        executable: exe, updater: exe, platform: config.systems.some(s => s.id === platform) ? platform : undefined,
        source: { repo, prerelease: false, ownTool: true }, installed: { tag: rel.tag, date: rel.publishedAt, uploader: rel.uploader || undefined },
        installRoot: installDir('ports') };
      config.extraGames.push(entry); saveConfig(config);
      log(`installed port ${repo} ${rel.tag} through its launcher ${rel.launcher.name} as ${entry.title}`);
      send({ stage: 'Done', pct: 1, done: true });
      return { ...entry, viaLauncher: true };
    }
    const notReady = () => new Error(`${repo} doesn't publish a ready-to-run build. Install it the way its page says, then add its folder.`);
    if (/setup|install/i.test(rel.assetName) && /\.(exe|msi)$/i.test(rel.assetName)) throw notReady();
    const linuxBuild = /linux|appimage/i.test(rel.assetName);
    if (!linuxBuild && /\.zip$/i.test(rel.assetName)) { const names = await remoteZipNames(rel.url); if (names && !names.some(n => /\.exe$/i.test(n))) throw notReady(); }
    if (!linuxBuild && process.platform === 'linux' && !compat.canRunWindows()) throw new Error(`${repo} only has a Windows build. Install Steam (it brings Proton) or Wine, then try again.`);
    const { archive, scan } = await fetchRelease(rel, tmp, send);
    const src = await unpackRelease(rel, archive, tmp, send);
    send({ stage: 'Installing…', pct: 1 });
    // Its own folder, named after the project ("SpaghettiKart"). Installed before and deleted: the same folder again,
    // where your saves and mods still are. Never on top of a folder another game in Harbour uses.
    const used = f => config.extraGames.some(x => path.resolve(x.path).toLowerCase() === path.resolve(f).toLowerCase());
    const portsDir = installDir('ports');
    let folder = path.join(portsDir, repo.split('/')[1].replace(/[<>:"|?*]/g, ''));
    for (let n = 2; used(folder); n++) folder = path.join(portsDir, `${repo.split('/')[1]} ${n}`);
    await fsp.mkdir(folder, { recursive: true });
    // Files already there are yours from before (a settings file you changed): the download doesn't replace them.
    await fsp.cp(src, folder, { recursive: true, force: false, errorOnExist: false });
    const hints = { repo, title };
    const exe = findGameExe(folder, hints) || guessProgram(folder, repo);
    if (!exe) { await fsp.rm(folder, { recursive: true, force: true }); throw notReady(); }
    const setup = findSetupExe(folder, hints);
    const returning = (await filesIn(folder)).length > (await filesIn(src)).length;  // your files were already there
    const romDir = path.join(path.dirname(exe), (await harbourPorts()).find(x => x.repo.toLowerCase() === repo.toLowerCase())?.romDir || '');
    if (rom) { await fsp.mkdir(romDir, { recursive: true }); await fsp.copyFile(rom, path.join(romDir, path.basename(rom))); }
    const installed = { tag: rel.tag, assetId: rel.assetId, date: rel.publishedAt, uploader: rel.uploader || undefined };
    // From the catalogue the name and console are known; otherwise Harbour works them out.
    const found = title ? { title: String(title).slice(0, 120), platform: config.systems.some(s => s.id === platform) ? platform : '' }
      : await detectPort(folder, exe, { repo, installed, gameFile: rom });
    const entry = { id: randomUUID().slice(0, 8), system: 'recomp', path: folder, title: found.title, executable: exe,
      platform: found.platform || undefined, source: { repo, prerelease: false }, installed, gameFile: rom ? path.basename(rom) : undefined,
      installRoot: portsDir, setup: setup && path.resolve(setup) !== path.resolve(exe) ? setup : undefined };
    config.extraGames.push(entry); saveConfig(config);
    await rememberRelease(entry.id, src);
    log(`installed port ${repo} ${rel.tag} (${rel.assetName}, defender: ${scan}) to ${folder} as ${found.title} [${found.platform || 'recomp'}]${rom ? ' with ' + path.basename(rom) : ''}${returning ? ', back into its folder with your files' : ''}`);
    send({ stage: 'Done', pct: 1, done: true });
    return entry;
  } finally {
    installingPorts.delete(repo);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
// An emulator you already have: pick its .exe, say which consoles it plays, and optionally make it
// the one those consoles use. "{rom}" in the arguments is replaced with the game's file.
handle('harbour:addEmulator', async ({ name, systems, args, makeDefault }) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the emulator\'s program', filters: PROGRAM_FILTERS, properties: ['openFile'], ...PROGRAM_START });
  if (r.canceled) return null;
  const exe = r.filePaths[0];
  const label = String(name || '').trim().slice(0, 60) || titleFromFolder(path.basename(exe, path.extname(exe)));
  const id = 'custom-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const list = (systems || []).filter(s => config.systems.some(x => x.id === s));
  config.customEmulators = config.customEmulators.filter(e => e.id !== id);
  config.customEmulators.push({ id, name: label, exe, args: String(args || '').trim() || '{rom}', systems: list });
  if (makeDefault) for (const s of config.systems) if (list.includes(s.id)) s.emulator = id;
  saveConfig(config);
  return { id, name: label };
});
// ---- Finding emulators you already have ----
// Program names Harbour recognises: the ones it can install (their release source too, so they get updates), and
// other common ones it can only run.
const EMU_FIND = [
  { re: named('rmg'), catalog: 'rmg' },
  { re: named('duckstation'), catalog: 'duckstation' },
  { re: named('pcsx2'), catalog: 'pcsx2' },
  { re: named('rpcs3'), catalog: 'rpcs3' },
  { re: named('shadps4'), catalog: 'shadps4' },
  { re: named('ppsspp(windows(64)?|sdl|qt)?'), catalog: 'ppsspp' },
  { re: named('xemu'), catalog: 'xemu' },
  { re: named('xenia_canary'), catalog: 'xenia-canary' },
  { re: named('melonds'), catalog: 'melonds' },
  { re: named('azaharplus'), catalog: 'azaharplus' },
  { re: named('azahar'), catalog: 'azahar' },
  { re: named('mgba(-qt)?'), catalog: 'mgba' },
  { re: named('cemu'), catalog: 'cemu' },
  { re: named('dolphin(-emu)?'), catalog: 'dolphin', name: 'Dolphin', consoles: ['gc', 'wii'], args: '-b -C Dolphin.Display.Fullscreen=True -e {rom}' },  // its own entry: no Linux download to install
  { re: named('eden'), catalog: 'eden' },
  { re: named('lichii'), catalog: 'lichii' },
  { re: named('flycast'), catalog: 'flycast' },
  { re: named('snes9x'), catalog: 'snes9x' },
  { re: named('mesen'), catalog: 'mesen' },
  { re: named('ryujinx'), catalog: 'ryujinx' },
  { re: named('yuzu|citron|suyu|sudachi|torzu'), consoles: ['switch'], args: '-g {rom}' },
  { re: named('project64'), name: 'Project64', consoles: ['n64'], args: '{rom}' },
  { re: named('xenia'), name: 'Xenia', consoles: ['x360'], args: '{rom}' },
  { re: named('citra(-qt)?|lime3ds(-gui)?'), consoles: ['3ds'], args: '{rom}' },
  { re: named('redream'), name: 'redream', consoles: ['dreamcast'], args: '{rom}' },
  { re: named('bsnes'), name: 'bsnes', consoles: ['snes'], args: '{rom}' },
];
// Programs beside an emulator that aren't it (its command-line copy, updater, server, tools).
const EMU_HELPER = /(^|[-_ ])(cli|cmd|room|tool|tools|updater|update|uninstall|unins\d*|headless|nogui|crash\w*|config|test)([-_ .]|$)|tool$/i;
// An emulator's program on this system: an .exe on Windows; on Linux an AppImage or a runnable file with no ending.
const emuProgram = (p, name) => process.platform === 'win32' ? /\.exe$/i.test(name)
  : isAppImage(name) ? true : !path.extname(name) && isLinuxProgram(p);
const SCAN_SKIP = /^(\$recycle\.bin|system volume information|windows|node_modules|\.git|cache|shadercache|shaders|logs?|screenshots|saves?|nand|sdmc|dev_hdd0|memcards)$/i;
// Pick a folder; every emulator found in it (four folders deep) is added for its consoles, and becomes the one a
// console uses when that console has none that works. Ones already added are left alone.
handle('harbour:scanEmulators', async folder => {
  const r = typeof folder === 'string' ? { canceled: false, filePaths: [folder] }  // tests pass the folder
    : await dialog.showOpenDialog(win, { title: 'Choose a folder with your emulators in it', properties: ['openDirectory'] });
  if (r.canceled) return null;
  const found = new Map();  // kind -> exe
  let looked = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++looked > 200000) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !SCAN_SKIP.test(e.name)) walk(p, depth + 1); continue; }
      if (!emuProgram(p, e.name) || EMU_HELPER.test(programName(e.name))) continue;
      const k = EMU_FIND.find(f => f.re.test(programName(e.name)));
      if (!k) continue;
      const kind = k.catalog || programName(e.name);
      if (!found.has(kind)) found.set(kind, { k, exe: p });
    }
  };
  walk(r.filePaths[0], 0);
  const known = new Set(config.customEmulators.map(e => resolveExe(e.id)?.toLowerCase()).filter(Boolean));
  const added = [], skipped = [];
  for (const { k, exe } of found.values()) {
    const c = k.catalog && CATALOG.find(x => x.id === k.catalog);
    const name = c?.name || k.name || titleFromFolder(path.basename(exe, path.extname(exe)));
    const id = 'custom-' + (c ? c.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    if (known.has(exe.toLowerCase()) || (resolveExe(id) && config.customEmulators.some(e => e.id === id))) { skipped.push(name); continue; }
    const consoles = (c?.consoles || k.consoles || []).filter(s => config.systems.some(x => x.id === s));
    config.customEmulators = config.customEmulators.filter(e => e.id !== id);
    config.customEmulators.push({ id, name, exe, args: c?.args || k.args, systems: consoles,
      ...(c ? { source: { ...c.source, prerelease: false }, scanned: true } : {}) });
    for (const s of config.systems) if (consoles.includes(s.id) && !resolveExe(s.emulator)) s.emulator = id;
    added.push(name);
  }
  if (added.length) saveConfig(config);
  log(`emulator scan of ${r.filePaths[0]}: added ${added.join(', ') || 'none'}; already had ${skipped.join(', ') || 'none'}`);
  return { added, skipped };
});
// ---- Installing a well-known emulator (emulators.js) ----
// Into an Emulators folder beside Harbour's data, ready for its consoles, with updates from where it's released.
const sameSource = (a, b) => !!a && !!b && a.repo?.toLowerCase() === b.repo?.toLowerCase() && (a.host || '') === (b.host || '');
handle('harbour:emulatorCatalog', () => CATALOG
  .map(c => ({ ...c, consoles: c.consoles.filter(id => config.systems.some(s => s.id === id)),
    installed: config.customEmulators.find(e => sameSource(e.source, c.source))?.id || null }))
  .filter(c => c.consoles.length));
const installing = new Set();
handle('harbour:installEmulator', async catalogId => {
  const c = CATALOG.find(x => x.id === catalogId);
  if (!c) throw new Error('Unknown emulator.');
  if (config.customEmulators.some(e => sameSource(e.source, c.source))) throw new Error(`${c.name} is already set up.`);
  if (installing.has(c.id)) throw new Error('Already installing.');
  installing.add(c.id);
  const send = p => win?.webContents.send('recomp:progress', { gameId: 'install:' + c.id, ...p });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbour-install-'));
  try {
    send({ stage: 'Finding the latest release…', pct: 0 });
    const source = { ...c.source, prerelease: false };
    const rel = await emulatorDownload(source);
    const { archive, scan } = await fetchRelease(rel, tmp, send);
    const src = await unpackRelease(rel, archive, tmp, send);
    send({ stage: 'Installing…', pct: 1 });
    const folder = path.join(installDir('emulators'), c.name);
    await fsp.mkdir(folder, { recursive: true });
    await fsp.cp(src, folder, { recursive: true, force: false, errorOnExist: false });
    // The program: the one the catalogue names, wherever it sits in the release, else the best guess.
    let exe = null;
    const look = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 3 && !exe) look(p, depth + 1); }
        else if (c.exe && e.name.toLowerCase() === c.exe.toLowerCase()) exe ||= p;
      }
    };
    look(folder, 0);
    exe ||= guessProgram(folder, c.source.repo);
    if (!exe) throw new Error(`${c.name} was downloaded, but its program wasn't found in it.`);
    // Portable mode: its settings live in its own folder, where Harbour can find them.
    if (c.portable && !fs.existsSync(path.join(path.dirname(exe), c.portable))) fs.writeFileSync(path.join(path.dirname(exe), c.portable), '');
    const id = 'custom-' + c.id;
    config.customEmulators = config.customEmulators.filter(e => e.id !== id);
    config.customEmulators.push({ id, name: c.name, exe, args: c.args, systems: [...c.consoles],
      source: { ...c.source, prerelease: false },
      installed: { tag: rel.tag, stamp: fileStamp(exe)?.id, uploader: rel.uploader || undefined } });
    // Consoles without a working emulator start using it.
    for (const s of config.systems) if (c.consoles.includes(s.id) && !emuDef(s.emulator)) s.emulator = id;
    saveConfig(config);
    log(`installed ${c.name} ${rel.tag} (${rel.assetName}, defender: ${scan}) to ${folder}`);
    send({ stage: 'Done', pct: 1, done: true });
    return { id, name: c.name, note: c.note || '' };
  } finally {
    installing.delete(c.id);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

// Change the consoles an emulator you added plays (and its launch options).
handle('harbour:setEmulator', ({ id, systems, args, name }) => {
  const e = config.customEmulators.find(x => x.id === id);
  if (!e) throw new Error('Only emulators you added can be changed here.');
  if (Array.isArray(systems)) e.systems = systems.filter(s => config.systems.some(x => x.id === s));
  if (typeof args === 'string') e.args = args.trim() || '{rom}';
  if (typeof name === 'string' && name.trim()) e.name = name.trim().slice(0, 60);
  // A console it no longer plays stops using it.
  for (const s of config.systems) if (s.emulator === id && !e.systems.includes(s.id)) s.emulator = '';
  saveConfig(config);
  return true;
});
// ---------- Game folders ----------
// A folder of game files for a console. Choosing a parent folder instead finds the consoles' own folders
// inside it by name: "N64", "PS2", "Switch", "X360", "DS"…
const FOLDER_NAMES = {
  a2600: ['atari 2600', '2600', 'atari'], arcade: ['arcade', 'mame'], nes: ['nes', 'famicom'], genesis: ['genesis', 'mega drive', 'megadrive', 'md'],
  gb: ['gb', 'game boy', 'gameboy'], snes: ['snes', 'super nintendo', 'super famicom', 'sfc'], ps1: ['ps1', 'psx', 'playstation', 'playstation 1'],
  n64: ['n64', 'nintendo 64'], gbc: ['gbc', 'game boy color', 'gameboy color'], dreamcast: ['dreamcast', 'dc'], ps2: ['ps2', 'playstation 2'],
  gba: ['gba', 'game boy advance', 'gameboy advance'], gc: ['gc', 'gamecube', 'ngc', 'gcn'], xbox: ['xbox', 'og xbox', 'xbox original'],
  nds: ['ds', 'nds', 'nintendo ds'], psp: ['psp'], x360: ['x360', 'xbox 360', '360'], ps3: ['ps3', 'playstation 3'], wii: ['wii'],
  '3ds': ['3ds', 'nintendo 3ds'], wiiu: ['wii u', 'wiiu'], ps4: ['ps4', 'playstation 4'], switch: ['switch', 'nintendo switch', 'nsw', 'ns'],
  switch2: ['switch 2', 'switch2', 'nintendo switch 2'],
};
const folderKey = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function consoleForFolder(name) {
  const key = folderKey(name);
  return Object.entries(FOLDER_NAMES).find(([, names]) => names.includes(key))?.[0] || null;
}
function addRomDir(sys, folder) {
  const dirs = romDirsOf(sys);
  if (dirs.some(d => path.resolve(d).toLowerCase() === path.resolve(folder).toLowerCase())) return false;
  sys.romDir = [...dirs, folder].join('|');
  return true;
}
// system: a console id, or '' to find consoles' folders inside the chosen one.
handle('harbour:addGameFolder', async ({ system }) => {
  const picked = await dialog.showOpenDialog(win, { title: system ? 'Choose the folder with your games' : 'Choose the folder that holds your consoles\' game folders', properties: ['openDirectory'] });
  if (picked.canceled) return null;
  const folder = picked.filePaths[0], added = [];
  if (system) {
    const sys = config.systems.find(s => s.id === system);
    if (!sys) throw new Error('Unknown console.');
    if (addRomDir(sys, folder)) added.push({ system, folder });
  } else {
    const own = consoleForFolder(path.basename(folder));
    const subs = own ? [] : (await fsp.readdir(folder, { withFileTypes: true })).filter(e => e.isDirectory());
    const found = own ? [[own, folder]] : subs.map(e => [consoleForFolder(e.name), path.join(folder, e.name)]).filter(([id]) => id);
    if (!found.length) throw new Error('No console folders found in there (folders named like N64, PS2, Switch, X360). Add it for one console instead.');
    for (const [id, dir] of found) { const sys = config.systems.find(s => s.id === id); if (sys && addRomDir(sys, dir)) added.push({ system: id, folder: dir }); }
  }
  saveConfig(config);
  return { added };
});
// The welcome screen's Next: the install folders made if they aren't there yet, and the games folder with a folder
// per console inside (named as people know them, and as consoleForFolder reads them), each added as that console's
// game folder. Games dropped into them later show up by themselves.
const CONSOLE_FOLDER = {
  a2600: 'Atari 2600', arcade: 'Arcade', nes: 'NES', genesis: 'Genesis', gb: 'Game Boy', snes: 'SNES', ps1: 'PS1', n64: 'N64',
  gbc: 'Game Boy Color', dreamcast: 'Dreamcast', ps2: 'PS2', gba: 'GBA', gc: 'GameCube', xbox: 'Xbox', nds: 'DS', psp: 'PSP',
  x360: 'Xbox 360', ps3: 'PS3', wii: 'Wii', '3ds': '3DS', wiiu: 'Wii U', ps4: 'PS4', switch: 'Switch', switch2: 'Switch 2',
};
handle('harbour:makeWelcomeFolders', async () => {
  for (const kind of ['ports', 'emulators']) await fsp.mkdir(installDir(kind), { recursive: true }).catch(() => {});
  const games = installDir('games');
  await fsp.mkdir(games, { recursive: true });
  const added = [];
  for (const sys of config.systems) {
    const name = CONSOLE_FOLDER[sys.id];
    if (!name) continue;
    const dir = path.join(games, name);
    await fsp.mkdir(dir, { recursive: true });
    if (addRomDir(sys, dir)) added.push({ system: sys.id, folder: dir });
  }
  saveConfig(config);
  return { games, added };
});
handle('harbour:removeGameFolder', ({ system, folder }) => {
  const sys = config.systems.find(s => s.id === system);
  if (!sys) throw new Error('Unknown console.');
  sys.romDir = romDirsOf(sys).filter(d => path.resolve(d).toLowerCase() !== path.resolve(folder).toLowerCase()).join('|');
  saveConfig(config);
  return true;
});
// ---------- Emulator updates ----------
// An emulator can have an update source: a GitHub repository ("owner/name"), one on another Forgejo/Gitea site
// ("git.eden-emu.dev/eden-emu/eden") or Dolphin's own site. Harbour installs its updates (see harbour:emuUpdate), and
// notices when you update it some other way (see noticeUpdate).
function parseSource(input) {
  const text = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!text) return null;
  if (/^(www.)?dolphin-emu.org(?:[/]|$)/i.test(text)) return { type: 'dolphin', repo: 'dolphin-emu/dolphin' };
  const m = text.match(/^(?:(?:www\.)?github\.com\/)?([\w.-]+\/[\w.-]+)$/i);
  if (m) return { type: 'github', repo: parseRepo(m[1]) };
  const f = text.match(/^([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+\/[\w.-]+)(?:\/.*)?$/i);
  if (f) return { type: 'forgejo', host: f[1].toLowerCase(), repo: f[2] };
  throw new Error('Enter a GitHub repository (owner/name) or a link to the project page.');
}
// Dolphin publishes its builds on its own site, not GitHub: its built-in updater reads this feed of the newest release.
async function dolphinRelease() {
  const r = await fetch('https://dolphin-emu.org/update/latest/beta/', { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!r.ok) throw new Error(`dolphin-emu.org didn't answer (error ${r.status}). Try again later.`);
  const j = await r.json();
  const a = (j.artifacts || []).find(x => /^windows x64/i.test(x.system));
  if (!a) throw new Error('No Windows download in the newest Dolphin release.');
  return { tag: j.shortrev, date: (j.date || '').slice(0, 10), publishedAt: j.date || null, published: j.date || null,
    assetId: j.hash, assetName: path.basename(new URL(a.url).pathname), size: 0, url: a.url, digest: null, page: 'https://dolphin-emu.org/download/' };
}
async function latestEmulatorRelease(source, prerelease) {
  let list, page;
  if (source.type === 'dolphin') return dolphinRelease();
  if (source.type === 'github') {
    page = `https://github.com/${source.repo}/releases`;
    // Stable track: ask GitHub for the latest stable release directly. Busy projects (PCSX2) publish
    // so many test builds that a stable one may not be among the newest few.
    if (!prerelease) {
      try {
        const rel = await ghJson(`https://api.github.com/repos/${source.repo}/releases/latest`);
        return { tag: rel.tag_name, date: (rel.published_at || '').slice(0, 10), published: rel.published_at || null, page: rel.html_url || page };
      } catch (e) { if (e.status !== 404) throw e; } // only test builds published: fall through
    }
    list = await ghJson(`https://api.github.com/repos/${source.repo}/releases?per_page=10`);
  } else {
    const r = await fetch(`https://${source.host}/api/v1/repos/${source.repo}/releases?limit=10`, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!r.ok) throw new Error(`${source.host} didn't answer (error ${r.status}). Try again later.`);
    list = await r.json();
    page = `https://${source.host}/${source.repo}/releases`;
  }
  const rel = list.find(x => !x.draft && (prerelease || !x.prerelease)) || list.find(x => !x.draft);
  if (!rel) throw new Error(`${source.repo} has no releases.`);
  return { tag: rel.tag_name, date: (rel.published_at || '').slice(0, 10), published: rel.published_at || null, page: rel.html_url || page };
}
function emulatorUpdateStatus(e, latest, error) {
  noticeUpdate(e, resolveExe(e.id), latest, i => i.tag !== latest.tag, () => ({ tag: latest.tag }), e.name);
  const installed = e.installed?.tag || null;
  return { id: e.id, source: e.source || null, installed, latest: latest || null, error: error || null, canInstall: harbourInstalls(e.source) && !!resolveExe(e.id),
    updateAvailable: latest && installed ? latest.tag !== installed : null };
}
async function checkEmulator(id, force = false) {
  const e = config.customEmulators.find(x => x.id === id);
  if (!e) throw new Error('Unknown emulator.');
  if (!e.source) return emulatorUpdateStatus(e);
  const key = 'emu:' + id, hit = recompChecks.get(key), sig = JSON.stringify(e.source);
  if (!force && hit && hit.repo === sig && Date.now() - hit.at < RECOMP_CHECK_MS) return emulatorUpdateStatus(e, hit.latest);
  try {
    const latest = await latestEmulatorRelease(e.source, e.source.prerelease);
    recompChecks.set(key, { at: Date.now(), latest, repo: sig }); saveRecompChecks();
    if (e.scanned && !e.installed) {  // found by a folder scan: its version is unknown until the first check
      const st = fileStamp(resolveExe(e.id) || ''), released = Date.parse(latest.published || latest.publishedAt || '') || Infinity;
      e.installed = st && st.mtime >= released ? { tag: latest.tag, stamp: st.id } : { tag: 'older' };
      delete e.scanned; saveConfig(config);
    }
    return emulatorUpdateStatus(e, latest);
  } catch (err) { return emulatorUpdateStatus(e, hit?.latest, err.message); }
}
handle('harbour:setEmulatorSource', ({ id, source, prerelease, installedTag }) => {
  const e = config.customEmulators.find(x => x.id === id);
  if (!e) throw new Error('Unknown emulator.');
  const parsed = parseSource(source);
  e.source = parsed ? { ...parsed, prerelease: !!prerelease } : undefined;
  const tag = String(installedTag || '').trim();
  e.installed = tag ? { tag } : undefined;
  recompChecks.delete('emu:' + id);
  saveConfig(config);
  return checkEmulator(id, true);
});
handle('harbour:checkEmulators', async force => {
  const out = {};
  await mapLimit(config.customEmulators, 4, async e => { out[e.id] = await checkEmulator(e.id, !!force); });
  return out;
});
// ---- Installing emulator updates ----
// The release with its Windows download. installer: true picks the setup .exe instead of the portable archive.
async function emulatorDownload(source, { installer = false } = {}) {
  if (source.type === 'dolphin') { if (installer) throw new Error('Dolphin has no installer here.'); return dolphinRelease(); }
  const pattern = installer ? '(setup|install).*\\.exe$' : source.asset;
  if (source.type === 'github') return findRelease(source.repo, { asset: pattern, prerelease: source.prerelease });
  const r = await fetch(`https://${source.host}/api/v1/repos/${source.repo}/releases?limit=10`, { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!r.ok) throw new Error(`${source.host} didn't answer (error ${r.status}). Try again later.`);
  const re = pattern ? new RegExp(pattern, 'i') : null;
  for (const rel of (await r.json()).filter(x => !x.draft && (source.prerelease || !x.prerelease))) {
    const a = re ? rel.assets.find(x => re.test(x.name)) : guessAsset(rel.assets);
    if (a) return { tag: rel.tag_name, publishedAt: rel.published_at, assetId: a.id, assetName: a.name, size: a.size || 0,
      url: a.browser_download_url, digest: null, page: rel.html_url || `https://${source.host}/${source.repo}/releases`, uploader: rel.author?.login || null };
  }
  throw new Error(`No ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'} download found in the recent releases of ${source.repo}.`);
}
// Can Harbour write into this folder? (Program Files can't be written without admin rights.)
function canWrite(folder) {
  const probe = path.join(folder, `.harbour-${process.pid}.tmp`);
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; } catch { return false; }
}
// Run a program's own installer with admin rights (one Windows prompt) and silent switches.
// NSIS installers (like PCSX2's) take /S; Inno Setup ones take /VERYSILENT.
function runInstallerElevated(file) {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const ps = `$p = Start-Process -FilePath ${q(file)} -ArgumentList '/S','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = ''; p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(/canceled|cancelled/i.test(err) ? 'The admin prompt was cancelled. Nothing was installed.' : `The installer stopped (code ${code}).`)));
  });
}
const updatingEmus = new Set();
handle('harbour:emuUpdate', id => emuUpdate(id).catch(err => {
  if (!(err instanceof NotReadyToRun)) log(`emulator update ${config.customEmulators.find(x => x.id === id)?.name || id} failed: ${err.message}`);
  throw err;
}));
async function emuUpdate(id) {
  const e = config.customEmulators.find(x => x.id === id);
  const exe = e && resolveExe(id);
  if (!e?.source) throw new Error('Set where this emulator\'s updates come from first (Updates…).');
  if (!exe) throw new Error(`Can't find ${e.name}'s program. Choose it again first.`);
  if (!harbourInstalls(e.source)) throw new NotReadyToRun(`${e.name}: update in app.`);
  if (updatingEmus.has(id)) throw new Error('Already updating.');
  if (running.size || isRunning(exe)) throw new Error(`Close ${e.name} (and any game) before updating it.`);
  const send = p => win?.webContents.send('recomp:progress', { gameId: 'emu:' + id, ...p });
  updatingEmus.add(id);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbour-emu-'));
  try {
    send({ stage: 'Checking latest release…', pct: 0 });
    const folder = path.dirname(exe);
    const viaInstaller = process.platform === 'win32' && !canWrite(folder);
    const rel = await emulatorDownload(e.source, { installer: viaInstaller });
    checkUploader(e.installed, rel, e.name);
    if (!viaInstaller && !isAppImage(exe) && /\.zip$/i.test(rel.assetName)) {
      const names = await remoteZipNames(rel.url);
      if (names && !names.some(n => n.split('/').pop().toLowerCase() === path.basename(exe).toLowerCase())) throw updatesWithOwnTool(e.source, e.name);
    }
    const { archive, scan } = await fetchRelease(rel, tmp, send, 'emu:' + id);
    let kept = [];
    if (viaInstaller) {
      send({ stage: 'Installing (approve the Windows prompt)…', pct: 1 });
      await runInstallerElevated(archive);
    } else {
      const src = await unpackRelease(rel, archive, tmp, send);
      if (!(await swapAppImage(src, exe))) {
        const root = placeRelease(src, exe);
        if (!root) throw updatesWithOwnTool(e.source, e.name);
        ({ kept } = await installInto(root, src, e.installed?.tag, send));
      }
    }
    if (!fs.existsSync(exe)) throw new Error(`${path.basename(exe)} is gone after the update. Choose the program again in Emulators.`);
    e.installed = { tag: rel.tag, stamp: fileStamp(exe)?.id, uploader: rel.uploader || e.installed?.uploader };
    saveConfig(config);
    const latest = { tag: rel.tag, date: (rel.publishedAt || '').slice(0, 10), published: rel.publishedAt, page: rel.page };
    recompChecks.set('emu:' + id, { at: Date.now(), latest, repo: JSON.stringify(e.source) }); saveRecompChecks();
    send({ stage: 'Done', pct: 1, done: true });
    log(`emulator update ${e.name} -> ${rel.tag} (${rel.assetName}, ${viaInstaller ? 'installer' : 'copied'}, defender: ${scan}, kept ${kept.length} settings files)`);
    return emulatorUpdateStatus(e, latest);
  } finally {
    updatingEmus.delete(id);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Harbour's own updates ----------
// A release of Harbour is a zip: Harbour.exe and the Electron runtime, with Harbour's own files in resources\app.
// An update replaces resources\app (your data\ is outside it) and restarts. A release built on a different Electron
// can't be swapped in while Harbour runs, so that one is "update in app": its release page.
const SELF_REPO = String(PACKAGE.repository?.url || PACKAGE.repository || '').replace(/^github:|^https:\/\/github\.com\/|\.git$/g, '');
let selfCheck = null;  // { at, latest }
// The release file for this system: the Windows zip, or on Linux the AppImage (the whole of OneDeck in one file,
// swapped for the new one).
const SELF_ASSET = process.env.APPIMAGE ? 'x86_64\\.AppImage$' : 'win64\\.zip$';
async function harbourStatus(force = false) {
  if (process.platform !== 'win32' && !process.env.APPIMAGE) return { packaged: app.isPackaged, current: APP_VERSION, updateAvailable: false };
  if (!app.isPackaged || !SELF_REPO) return { packaged: app.isPackaged, current: APP_VERSION, updateAvailable: false };
  if (force || !selfCheck || Date.now() - selfCheck.at > RECOMP_CHECK_MS) {
    try { selfCheck = { at: Date.now(), latest: await findRelease(SELF_REPO, { asset: SELF_ASSET, prerelease: false }) }; }
    catch (e) { return { packaged: true, current: APP_VERSION, updateAvailable: false, error: e.message }; }
  }
  const latest = selfCheck.latest;
  const tag = String(latest.tag || '').replace(/^v/, '');
  const newer = tag.localeCompare(APP_VERSION, undefined, { numeric: true }) > 0;
  return { packaged: true, current: APP_VERSION, updateAvailable: newer, latest: { tag: latest.tag, page: latest.page, notes: latest.notes } };
}
handle('harbour:selfStatus', force => harbourStatus(!!force));
// What's new: this version's release notes (its GitHub release), shown once after OneDeck updates itself, and from
// Settings → About. config.seenVersion is the version you last opened; a first install shows nothing.
handle('harbour:whatsNew', () => {
  const show = !!config.seenVersion && config.seenVersion !== APP_VERSION;
  if (config.seenVersion !== APP_VERSION) { config.seenVersion = APP_VERSION; saveConfig(config); }
  return { show, version: APP_VERSION };
});
handle('harbour:notes', async () => {
  if (!SELF_REPO) return { version: APP_VERSION, notes: '', page: '' };
  for (const tag of [`v${APP_VERSION}`, APP_VERSION]) {
    try {
      const rel = await ghJson(`https://api.github.com/repos/${SELF_REPO}/releases/tags/${encodeURIComponent(tag)}`);
      return { version: APP_VERSION, notes: rel.body || '', page: rel.html_url || '' };
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return { version: APP_VERSION, notes: '', page: `https://github.com/${SELF_REPO}/releases` };
});
handle('downloads:pause', ({ key, on }) => pauseDownload(String(key || ''), !!on));
// Feedback: what you type goes to hello@onedeck.org through Web3Forms (web3forms.com), with OneDeck's version and
// Windows or Linux. Nothing else (no way to reply: it's anonymous), and only when you press Send. The key can only send to that inbox, so it can be public.
// Sent with Electron's own network (net.fetch): Web3Forms turns away requests that don't come from a browser.
const FEEDBACK_KEY = 'd79b27cb-cfa0-40ca-9441-443a2e07d8cc';
handle('feedback:send', async ({ kind, message } = {}) => {
  const text = String(message || '').trim().slice(0, 5000);
  if (text.length < 3) throw new Error('Write a little more first.');
  const what = { bug: 'Bug', idea: 'Idea' }[kind] || 'Feedback';
  const system = `${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'} ${os.release()}`;
  const body = { access_key: FEEDBACK_KEY, from_name: 'OneDeck', subject: `OneDeck ${what.toLowerCase()}: ${text.split('\n')[0].slice(0, 60)}`,
    message: `${text}\n\n--\n${what} · OneDeck ${APP_VERSION} · ${system}` };
  let r;
  try { r = await net.fetch('https://api.web3forms.com/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error("Couldn't send: are you online? Your message is still there."); }
  const out = await r.json().catch(() => null);
  if (!r.ok || !out?.success) throw new Error(`Couldn't send (${out?.message || `error ${r.status}`}). Try again later.`);
  log(`feedback sent (${what})`);
  return true;
});
handle('harbour:selfUpdate', async () => {
  const st = await harbourStatus(true);
  if (!st.updateAvailable) return st;
  const rel = selfCheck.latest;
  const send = p => win?.webContents.send('recomp:progress', { gameId: 'harbour', ...p });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbour-self-'));
  try {
    const { archive, scan } = await fetchRelease(rel, tmp, send);
    if (process.env.APPIMAGE) {
      send({ stage: 'Installing…', pct: 1 });
      const next = process.env.APPIMAGE + '.new';
      await fsp.copyFile(archive, next);
      await fsp.chmod(next, 0o755);
      await fsp.rename(next, process.env.APPIMAGE);
      log(`harbour updated ${APP_VERSION} -> ${rel.tag} (AppImage)`);
      send({ stage: 'Restarting…', pct: 1, done: true });
      setTimeout(() => { app.relaunch({ execPath: process.env.APPIMAGE, args: process.argv.slice(1) }); app.exit(0); }, 800);
      return { ...st, installed: rel.tag };
    }
    const src = await unpackRelease(rel, archive, tmp, send);
    const appSrc = path.join(src, 'resources', 'app');
    if (!fs.existsSync(path.join(appSrc, 'main.js'))) throw new Error('That release doesn\'t look like OneDeck.');
    const runtime = (() => { try { return fs.readFileSync(path.join(src, 'electron-version.txt'), 'utf8').trim(); } catch { return ''; } })();
    if (runtime && runtime !== process.versions.electron) {
      await shell.openExternal(rel.page);
      throw new NotReadyToRun('This OneDeck update needs a fresh download: update in app (its release page is open).');
    }
    send({ stage: 'Installing…', pct: 1 });
    const backup = path.join(DATA, '_harbour-backup', 'harbour-' + APP_VERSION);
    await copyUpdate(appSrc, ROOT, backup, []);
    log(`harbour updated ${APP_VERSION} -> ${rel.tag} (defender: ${scan})`);
    send({ stage: 'Restarting…', pct: 1, done: true });
    setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
    return { ...st, installed: rel.tag };
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

handle('harbour:openEmulatorPage', async id => {
  const e = config.customEmulators.find(x => x.id === id);
  const page = recompChecks.get('emu:' + id)?.latest?.page || (e?.source && (e.source.type === 'dolphin' ? 'https://dolphin-emu.org/download/' : e.source.type === 'github' ? `https://github.com/${e.source.repo}/releases` : `https://${e.source.host}/${e.source.repo}/releases`));
  if (!page || !/^https:\/\//.test(page)) throw new Error('No update source set for this emulator.');
  await shell.openExternal(page);
  return true;
});
// Which emulator a console uses (an emulator id, or '' for none).
handle('harbour:setSystemEmulator', ({ system, emulator }) => {
  const sys = config.systems.find(s => s.id === system);
  if (!sys) throw new Error('Unknown console.');
  if (emulator && !emuDef(emulator)) throw new Error('That emulator is not set up.');
  sys.emulator = emulator || ''; saveConfig(config);
  return true;
});
// ---- What a port's install put in its folder ----
// Harbour remembers the files that came in a port's download, with their sizes (data\ports\<id>.json). Deleting the
// port removes just those (and the copy of your game file Harbour placed there); everything else in its folder (saves,
// mods you added, settings you changed) stays where it is, so installing it again picks up right where you were.
const manifestFile = id => path.join(DATA, 'ports', `${id}.json`);
async function filesIn(dir, base = dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await filesIn(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
async function rememberRelease(id, dir) {
  let known = {};
  try { const j = JSON.parse(await fsp.readFile(manifestFile(id), 'utf8')); if (!Array.isArray(j)) known = j; } catch {}
  for (const rel of await filesIn(dir)) { try { known[rel.toLowerCase()] = (await fsp.stat(path.join(dir, rel))).size; } catch {} }
  await fsp.mkdir(path.dirname(manifestFile(id)), { recursive: true });
  await fsp.writeFile(manifestFile(id), JSON.stringify(known));
}
// What came in the download: the list Harbour kept, or (for ports installed before it kept one) the release's zip.
async function releaseFilesOf(entry) {
  try { return new Map(Object.entries(JSON.parse(await fsp.readFile(manifestFile(entry.id), 'utf8')))); } catch {}
  try {
    const rel = await findRelease(entry.source.repo, { asset: entry.source.asset, prerelease: entry.source.prerelease, orWindows: true });
    const all = await remoteZipNames(rel.url), names = all?.filter(n => !n.endsWith('/'));
    if (!names?.length) return null;
    const top = names[0].split('/')[0] + '/';  // a zip holding one folder: it was unpacked without it
    const strip = names.every(m => m.startsWith(top));
    return new Map(names.map(n => [(strip ? n.slice(top.length) : n).toLowerCase(), all.sizes.get(n) ?? null]));
  } catch { return null; }
}
// Removes what the install put there (files changed since are yours and stay), then any folders left empty.
async function removeInstalled(entry) {
  const release = await releaseFilesOf(entry);
  if (!release) throw new Error("OneDeck can't tell which files came with it, so it didn't delete anything. Undock it instead.");
  const ownGameFile = entry.gameFile && path.relative(entry.path, path.join(path.dirname(entry.executable), entry.gameFile)).split(path.sep).join('/').toLowerCase();
  let removed = 0, left = 0;
  for (const rel of await filesIn(entry.path)) {
    const lower = rel.toLowerCase(), file = path.join(entry.path, rel);
    let size; try { size = (await fsp.stat(file)).size; } catch { continue; }
    const fromInstall = (release.has(lower) && (release.get(lower) == null || release.get(lower) === size)) || lower === ownGameFile;
    if (!fromInstall) { left++; continue; }
    await fsp.unlink(file); removed++;
  }
  const prune = async dir => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) await prune(path.join(dir, e.name));
    if (!(await fsp.readdir(dir).catch(() => ['x'])).length) await fsp.rmdir(dir).catch(() => {});
  };
  await prune(entry.path);
  return { removed, left };
}
// "Undock and delete": only for a port Harbour installed into a ports folder (just its install is removed, see
// above): straight inside the folder it was installed to, or the default one. Ports you installed yourself are never
// deleted by Harbour; they can only be undocked.
const inside = (dir, p) => { const rel = path.relative(dir, path.resolve(p)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep); };
const inPortsDir = entry => !!entry?.path && [DEFAULT_DIRS.ports, entry.installRoot].some(d => d && inside(d, entry.path));
handle('game:delete', async gameId => {
  const game = libraryGames.find(g => g.id === gameId && g.recomp);
  const entry = game && config.extraGames.find(x => x.id === game.added);
  if (!entry) throw new Error('Select a PC port first.');
  if (!inPortsDir(entry)) throw new Error('OneDeck only deletes ports it installed itself. Undock this one instead.');
  if (running.has(gameId) || isRunning(entry.executable)) throw new Error('Close the game first.');
  let result;
  try { result = await removeInstalled(entry); }
  catch (e) { throw new Error(/EBUSY|EPERM/.test(e.code || '') ? 'A file in it is in use. Close the game and try again.' : e.message); }
  config.extraGames = config.extraGames.filter(x => x.id !== entry.id); saveConfig(config);
  delete libraryState.hidden[gameId]; saveState();
  recompChecks.delete(gameId); saveRecompChecks();
  await fsp.rm(manifestFile(entry.id), { force: true });
  log(`deleted port ${entry.title} (${entry.path}): ${result.removed} installed files removed, ${result.left} of yours left in place`);
  return { kept: result.left };
});
handle('game:remove', id => {
  config.extraGames = config.extraGames.filter(x => x.id !== id);
  saveConfig(config);
  return true;
});
// Recomps: platform shelf, update source, checks and updates.
handle('recomp:get', gameId => {
  const { entry } = recompEntry(gameId);
  return { platform: entry.platform || '', source: entry.source || null, installed: entry.installed || null };
});
handle('recomp:set', ({ gameId, platform, repo, prerelease, asset, auto, installedTag }) => {
  const { entry } = recompEntry(gameId);
  if (platform && !config.systems.some(s => s.id === platform)) throw new Error('Unknown platform.');
  entry.platform = platform || undefined;
  const r = String(repo || '').trim();
  if (r) {
    const parsed = parseRepo(r);
    if (!parsed) throw new Error('Enter a GitHub repository like owner/name, or its link.');
    if (asset) checkPattern(asset, 'download');
    if (entry.source?.repo !== parsed) entry.installed = undefined;
    entry.source = { repo: parsed, prerelease: !!prerelease, asset: String(asset || '').trim() || undefined, auto: !!auto };
  } else entry.source = undefined;
  const tag = String(installedTag || '').trim();
  if (tag && tag !== entry.installed?.tag) entry.installed = { tag };
  if (!tag && entry.installed && !entry.installed.assetId) entry.installed = undefined;
  recompChecks.delete(gameId);
  saveConfig(config);
  return true;
});
handle('recomp:check', (gameId, force) => checkRecomp(gameId, !!force));
handle('recomp:checkAll', async force => {
  const ids = libraryGames.filter(g => g.recomp && config.extraGames.find(x => x.id === g.added)?.source?.repo).map(g => g.id);
  const out = {};
  await mapLimit(ids, 4, async id => { out[id] = await checkRecomp(id, !!force); });
  return out;
});
// ---- A port's own launcher: Update installs it (once) and runs it ----
// Its own folder in Ports (named after the project; an old setup kit OneDeck put there is replaced, as the launcher
// would otherwise act as that kit), checked against the release's checksum and scanned. It's told where the game
// already is (<Name>-Recomp\launcher.json "dest"), so it opens on Update, not on a first install. When it closes,
// OneDeck checks the version again (the game's version file, see versionOnDisk).
const runningLaunchers = new Set();
async function placeLauncher(repo, asset, title) {
  const folder = path.join(installDir('ports'), repo.split('/')[1].replace(/[<>:"|?*]/g, ''));
  // the old setup kit (its own Python beside a *-Setup.exe): replaced, as the launcher would act as that kit
  if (fs.existsSync(path.join(folder, 'python')) && fs.readdirSync(folder).some(n => /-setup\.exe$/i.test(n))) {
    await fsp.rm(folder, { recursive: true, force: true });
    log(`removed the old setup kit in ${folder} (the launcher replaces it)`);
  }
  await fsp.mkdir(folder, { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'onedeck-launcher-'));
  try {
    const file = path.join(tmp, asset.name);
    const r = await fetch(asset.url, { headers: UA });
    if (!r.ok) throw new Error(`Couldn't download ${asset.name} (${r.status}).`);
    await downloadTo(r, file);
    if (asset.digest?.startsWith('sha256:') && (await sha256File(file)) !== asset.digest.slice(7).toLowerCase())
      throw new Error(`${asset.name} doesn't match its published checksum. Nothing was installed.`);
    const scan = await defenderScan(file);
    const exe = path.join(folder, asset.name);
    await fsp.copyFile(file, exe);
    log(`installed ${asset.name} for ${title} in ${folder} (defender: ${scan})`);
    return exe;
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
const launcherBase = exe => path.join(path.dirname(exe), path.basename(exe).replace(/-launcher\.exe$/i, '') + '-Recomp');
// After the launcher closes: a game installed through it plays its built program (the launcher's install folder,
// from launcher.json), once there is one.
function adoptLauncherBuild(entry) {
  if (!entry.updater || (entry.executable && path.resolve(entry.executable) !== path.resolve(entry.updater))) return;
  let dest = '';
  try { dest = JSON.parse(fs.readFileSync(path.join(launcherBase(entry.updater), 'launcher.json'), 'utf8')).dest || ''; } catch {}
  const exe = dest && fs.existsSync(dest) && findGameExe(dest, { repo: entry.source?.repo, title: entry.title });
  if (exe && path.resolve(exe) !== path.resolve(entry.updater)) { entry.executable = exe; saveConfig(config); log(`${entry.title} now starts ${exe}`); }
}
handle('recomp:runLauncher', async gameId => {
  const { game, entry } = recompEntry(gameId);
  const repo = entry.source?.repo;
  if (!repo) throw new Error('Set an update source for this game first.');
  if (runningLaunchers.has(gameId)) throw new Error(`${game.title}'s launcher is already open.`);
  if (running.has(gameId) || isRunning(entry.executable)) throw new Error('Close the game before updating it.');
  const send = p => win?.webContents.send('recomp:progress', { gameId, ...p });
  let exe = entry.updater && fs.existsSync(entry.updater) ? entry.updater : null;
  if (!exe) {
    send({ stage: 'Getting its launcher…', pct: 0 });
    const rel = await findRelease(repo, { prerelease: !!entry.source.prerelease, orWindows: true });
    if (!rel.launcher) throw new Error(`${repo} has no launcher to update with. Open its release page instead.`);
    exe = await placeLauncher(repo, rel.launcher, game.title);
    entry.updater = exe; saveConfig(config);
  }
  // where the game is: the launcher keeps it in <Name>-Recomp\launcher.json beside itself
  const base = launcherBase(exe);
  const settingsFile = path.join(base, 'launcher.json');
  if (!fs.existsSync(settingsFile) && entry.executable && path.resolve(entry.executable) !== path.resolve(exe)) {
    await fsp.mkdir(base, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ dest: path.dirname(entry.executable), check_updates: true }, null, 1) + '\n');
  }
  send({ stage: 'Updating in its own window', pct: 1, done: true });
  runningLaunchers.add(gameId);
  // The game older than the latest release (built by an older kit, or the launcher's tools arrived already current):
  // --after-update, the launcher's own "rebuild the install folder now", so Update goes straight to the rebuild.
  let dest = ''; try { dest = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).dest || ''; } catch {}
  const have = dest && versionOnDisk(path.join(dest, '_'));
  const want = recompChecks.get(gameId)?.latest?.tag;
  const rebuild = !!(have && want && !sameVersion(have, want));
  const child = spawn(exe, rebuild ? ['--after-update'] : [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
  if (rebuild) log(`${game.title} is ${have}, the latest is ${want}: its launcher rebuilds it`);
  child.once('error', () => runningLaunchers.delete(gameId));
  child.once('exit', () => {
    runningLaunchers.delete(gameId);
    adoptLauncherBuild(entry);
    // the launcher hands over to the new version's window, which can keep updating for a while: check now and again
    for (const ms of [2000, 60000, 300000]) setTimeout(() => { recompChecks.delete(gameId); win?.webContents.send('recomp:recheck', gameId); }, ms);
  });
  log(`started ${path.basename(exe)} for ${game.title}`);
  return true;
});
handle('recomp:update', gameId => updateRecomp(gameId, p => win.webContents.send('recomp:progress', p)).catch(err => {
  if (!(err instanceof NotReadyToRun)) log(`recomp update ${gameId} failed: ${err.message}`);
  throw err;
}));
handle('recomp:openPage', async gameId => {
  const { entry } = recompEntry(gameId);
  const page = recompChecks.get(gameId)?.latest?.page || (entry.source?.repo && `https://github.com/${entry.source.repo}/releases`);
  if (!page || !/^https:\/\/github\.com\//.test(page)) throw new Error('No release page for this game.');
  await shell.openExternal(page);
  return true;
});


// ---------- Game videos ----------
const videos = createVideoService({
  dataDir: DATA, ghJson, extract, sha256File, defenderScan, log,
  download: (url, file, onBytes) => artwork.download(url, file, onBytes),
  getGames: () => libraryGames.filter(g => !libraryState.noVideo?.[g.id]),  // games with videos off are never fetched
  getSystemName: id => config.systems.find(s => s.id === id)?.name || '',
  // The game's trailer / gameplay link from the LaunchBox database (rebuilt with links if it predates them).
  lookup: async game => { await launchbox.load(false); return (await launchbox.details(game.system, artwork.titleKeys(game)))?.video || null; },
  emit: job => { if (win && !win.isDestroyed()) win.webContents.send('video:progress', job); },
});
handle('video:start', options => videos.start(options || {}));
// Game clips Harbour downloaded: how much space they take, and deleting them all (data\media\<console>\videos).
const clipFolders = () => { try { return fs.readdirSync(path.join(DATA, 'media'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => path.join(DATA, 'media', e.name, 'videos')).filter(d => fs.existsSync(d)); } catch { return []; } };
const folderSize = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? folderSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
handle('video:status', () => videos.status());

// ---------- Cloud saves (cloudsaves.js drives OpenSave) ----------
// On in Settings → Cloud saves: OpenSave's program is fetched once, then runs while OneDeck does. config.cloudSaves
// says it's on; config.savesFor maps a OneDeck game id to the OpenSave game that holds its saves.
const saves = createCloudSaves({ dataDir: DATA, ghJson, sha256File, extract, log,
  downloadFile: (url, file, onBytes) => artwork.download(url, file, onBytes) });
const savesProgress = text => sendWindow('saves:progress', text);
// OneDeck's Saves folder (savefolders.js): the emulators OneDeck starts save into a folder each there. With cloud saves
// on, each of those folders syncs by itself under the same name on every device ("DuckStation saves (OneDeck)"), and
// one offered from another device goes straight into its folder here. config.saveFolders remembers which settings
// files were pointed there; config.savesConsoles is the consoles whose saves sync that way; config.savesSkip the
// folders you stopped syncing.
const saveFolders = createSaveFolders({ root: () => installDir('saves'), setFileValues, log,
  gamesFor: consoles => libraryGames.filter(g => consoles.includes(g.system)).flatMap(g => g.discPaths?.length ? g.discPaths : [g.romPath]).filter(Boolean),
  marked: key => config.saveFolders?.[key],
  mark: (key, dir) => { config.saveFolders = { ...(config.saveFolders || {}), [key]: dir }; saveConfig(config); } });
function moveSaves(exe, rom) {
  const f = saveFolders.apply(exe, rom);
  if (f?.fresh && config.cloudSaves) syncSaveFolders().catch(e => log(`cloud saves: ${e.message}`));
}
// Every emulator OneDeck knows: its saves moved without waiting for a game to be played.
function moveAllSaves() {
  const ids = new Set(config.systems.map(s => s.emulator).filter(Boolean));
  for (const id of ids) { try { const exe = resolveExe(id); if (exe) saveFolders.apply(exe); } catch {} }
}
let savesSyncing = null;
const OURS = / saves \(OneDeck\)$/;
function syncSaveFolders() {
  savesSyncing ||= (async () => {
    if (!config.cloudSaves) return;
    const st = await saves.status();
    if (!st.running) return;
    const skip = new Set(config.savesSkip || []), have = new Set((st.games || []).map(g => g.name));
    // A conflict in one of these folders: combined, not asked about (see savefolders.js merge).
    for (const c of running.size ? [] : st.conflicts || []) {  // never while a game is being played: it waits for the next check
      const g = (st.games || []).find(x => x.id === c.gameId);
      if (g && OURS.test(g.name)) await saveFolders.merge({ saves, id: g.id, name: g.name, folder: g.path }).catch(e => log(`cloud saves: couldn't combine ${g.name}: ${e.message}`));
    }
    for (const f of saveFolders.all()) {
      if (skip.has(f.cloudName) || have.has(f.cloudName)) continue;
      const offer = (st.offers || []).find(o => o.name === f.cloudName);
      if (offer) { await saves.place(offer.gameId, f.folder); have.add(f.cloudName); log(`cloud saves: ${f.cloudName} from another device, into ${f.folder}`); }
      else if (fs.existsSync(f.folder)) { await saves.track(f.cloudName, f.folder); have.add(f.cloudName); log(`cloud saves: syncing ${f.folder}`); }
    }
    const consoles = saveFolders.all().filter(f => have.has(f.cloudName)).flatMap(f => f.consoles);
    if (JSON.stringify(consoles) !== JSON.stringify(config.savesConsoles || [])) { config.savesConsoles = consoles; saveConfig(config); }
  })().finally(() => { savesSyncing = null; });
  return savesSyncing;
}
// Checked now and then too, for folders another device starts syncing later.
let savesTimer = null;
const startSavesTimer = () => { savesTimer ||= setInterval(() => syncSaveFolders().catch(() => {}), 5 * 60 * 1000); };

handle('saves:status', async () => {
  const st = await saves.status();
  const name = id => (st.games || []).find(g => g.id === id)?.name || '';
  const ours = st.running && ((st.offers || []).some(o => OURS.test(o.name || '')) || (st.conflicts || []).some(c => OURS.test(name(c.gameId))));
  if (ours) await syncSaveFolders().catch(() => {});
  return { on: !!config.cloudSaves, savesFor: config.savesFor || {}, savesConsoles: config.savesConsoles || [], savesRoot: installDir('saves'),
    ...(ours ? await saves.status() : st) };
});
// Every game's cloud sync state (cloudsaves.js syncStates), and which OpenSave entry is whose: a game you set up
// (config.savesFor), or an emulator's Saves folder for its consoles.
handle('saves:states', async () => {
  if (!config.cloudSaves) return null;
  const states = await saves.syncStates().catch(() => null);
  if (!states) return null;
  const byName = Object.fromEntries(Object.entries(states).map(([id, s]) => [s.name, id]));
  const consoles = {};
  for (const f of saveFolders.all()) { const id = byName[f.cloudName]; if (id) for (const c of f.consoles) consoles[c] = id; }
  return { states, consoles, savesFor: config.savesFor || {} };
});
handle('saves:enable', async () => {
  if (!saves.installed()) await saves.install(savesProgress);
  savesProgress('Starting OpenSave…');
  await saves.start();
  await saves.scanFolders([installDir('emulators'), installDir('ports')]);
  config.cloudSaves = true; saveConfig(config);
  moveAllSaves();
  await syncSaveFolders().catch(e => log(`cloud saves: ${e.message}`));
  startSavesTimer();
  return true;
});
handle('saves:disable', () => { saves.stop(); config.cloudSaves = false; saveConfig(config); return true; });
// Link a device: this one makes a code and waits in its room; the other types it in (joinCode) and asks to link.
handle('saves:newCode', async () => saves.joinCode(saves.newCode()));
handle('saves:joinCode', async code => {
  const c = await saves.joinCode(code);
  // Give the room a moment to show who's in it, then ask each device there to link (they say yes on their side).
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await saves.status();
    const there = (st.nearby || []).filter(p => p.overRelay);
    if (there.length) { for (const p of there) await saves.askToLink(p).catch(e => log(`link request failed: ${e.message}`)); return { code: c, asked: there.length }; }
  }
  return { code: c, asked: 0 };
});
handle('saves:link', async peer => saves.askToLink(peer));
handle('saves:approve', id => saves.approve(String(id)));
handle('saves:reject', id => saves.reject(String(id)));
handle('saves:unlink', id => saves.unlink(String(id)));
handle('saves:leaveCode', () => saves.leaveCode());
handle('saves:suggest', title => saves.suggest(String(title || '')));
handle('saves:pickFolder', async title => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose the save folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Sync a game's saves: OpenSave tracks the folder under the game's name; OneDeck remembers which game it belongs to.
handle('saves:track', async ({ gameId, name, folder }) => {
  if (!folder || !fs.existsSync(folder)) throw new Error("That folder isn't there.");
  const r = await saves.track(String(name || path.basename(folder)).slice(0, 80), folder);
  const st = await saves.status();
  const g = (st.games || []).find(x => path.resolve(x.path) === path.resolve(folder));
  if (gameId && g) { config.savesFor = { ...(config.savesFor || {}), [gameId]: g.id }; saveConfig(config); }
  log(`cloud saves: tracking ${name} at ${folder}`);
  return r;
});
handle('saves:untrack', async id => {
  // One of the Saves folder's: remembered, so it isn't added back by itself.
  const g = ((await saves.status()).games || []).find(x => x.id === id);
  if (g && OURS.test(g.name)) {
    config.savesSkip = [...new Set([...(config.savesSkip || []), g.name])];
    config.savesConsoles = (config.savesConsoles || []).filter(c => !(saveFolders.all().find(f => f.cloudName === g.name)?.consoles || []).includes(c));
  }
  await saves.untrack(String(id));
  config.savesFor = Object.fromEntries(Object.entries(config.savesFor || {}).filter(([, v]) => v !== id)); saveConfig(config);
  return true;
});
handle('saves:place', ({ gameId, folder }) => saves.place(String(gameId), folder));
handle('saves:decline', gameId => saves.decline(String(gameId)));
handle('saves:resolve', ({ gameId, choice }) => {
  if (!['keep-both', 'keep-local', 'keep-remote'].includes(choice)) throw new Error('Unknown choice.');
  return saves.resolve(String(gameId), choice);
});
handle('saves:syncNow', () => saves.syncNow());
handle('saves:openFolder', p => { if (p && fs.existsSync(p)) shell.openPath(p); return true; });
// Also through a folder: a OneDrive, Dropbox or Google Drive folder on this PC carries saves to devices that aren't on.
handle('saves:useFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder your cloud drive syncs (OneDrive, Dropbox, Google Drive…)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return null;
  const folder = path.join(r.filePaths[0], 'OneDeck saves');
  fs.mkdirSync(folder, { recursive: true });
  await saves.useFolder(folder);
  return folder;
});
handle('saves:disconnectCloud', () => saves.disconnectCloud());
// Dropbox sign-in, for a PC without Dropbox's own app (Linux, a Steam Deck): Dropbox's page opens in a OneDeck window,
// and where it sends you back (localhost/callback?code=…) is caught here, so there's no code to copy.
handle('saves:dropbox', async () => {
  const start = await saves.connectStart('dropbox');
  if (!start?.authUrl || !/^https:\/\/www\.dropbox\.com\//.test(start.authUrl)) throw new Error("OpenSave didn't give a Dropbox sign-in link.");
  const code = await new Promise((resolve, reject) => {
    const w = new BrowserWindow({ parent: win, modal: true, width: 520, height: 720, title: 'Sign in to Dropbox', autoHideMenuBar: true,
      webPreferences: { partition: 'onedeck-dropbox', contextIsolation: true, sandbox: true } });
    let done = false;
    const check = (e, url) => {
      if (!/^http:\/\/localhost\/callback/.test(url)) return;
      e?.preventDefault?.(); done = true;
      const u = new URL(url), c = u.searchParams.get('code');
      w.close();
      c ? resolve(c) : reject(new Error(u.searchParams.get('error_description') || 'Dropbox sign-in was cancelled.'));
    };
    w.webContents.on('will-redirect', check); w.webContents.on('will-navigate', check);
    w.on('closed', () => { if (!done) reject(new Error('Dropbox sign-in was closed.')); });
    w.loadURL(start.authUrl);
  });
  await saves.connectFinish('dropbox', code);
  log('cloud saves: Dropbox connected');
  return true;
});
// On with OneDeck, off when it quits (unless OpenSave's own app or service is the one running).
app.whenReady().then(() => {
  if (config.cloudSaves && saves.installed()) saves.start().then(() => { startSavesTimer(); return new Promise(r => setTimeout(r, 4000)).then(syncSaveFolders); })
    .catch(e => log(`OpenSave didn't start: ${e.message}`));
});
app.on('will-quit', () => saves.stop());
process.on('exit', () => saves.stop());  // also when OneDeck ends without a normal quit
handle('video:cancel', () => { videos.cancel(); return true; });
handle('art:start', options => artwork.start(options));
handle('art:status', () => artwork.status());
handle('art:cancel', () => artwork.cancel());
handle('emu:list', () => config.customEmulators.map(e => emuStatus(e.id)));
handle('emu:openFolder', id => { const exe = resolveExe(id); if (exe) shell.openPath(path.dirname(exe)); return !!exe; });
// Start an emulator on its own (no game, not fullscreen), to change its settings.
handle('emu:open', id => {
  const exe = resolveExe(id);
  if (!exe) throw new Error("Can't find that emulator's program.");
  padDefaults(exe);
  spawn(exe, [], { cwd: path.dirname(exe), env: launchEnv(), detached: true, stdio: 'ignore' }).unref();
  return true;
});
handle('emu:pickExe', async id => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose emulator program', filters: PROGRAM_FILTERS, properties: ['openFile'], ...PROGRAM_START });
  if (r.canceled) return null;
  config.emulators[id] = { ...(config.emulators[id] || {}), exe: r.filePaths[0] };
  saveConfig(config);
  return emuStatus(id);
});
handle('emu:remove', id => {
  if (!config.customEmulators.some(e => e.id === id)) throw new Error('Only emulators you added can be removed');
  config.customEmulators = config.customEmulators.filter(e => e.id !== id);
  delete config.emulators[id];
  for (const s of config.systems) if (s.emulator === id) s.emulator = ''; // consoles that used it have none now
  saveConfig(config);
  return true;
});
handle('dialog:folder', async title => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (stateTimer) writeState(); });
app.on('browser-window-created', (_e, created) => { if (created !== webpWindow) created.on('closed', () => { if (BrowserWindow.getAllWindows().every(w => w === webpWindow)) closeWebpWindow(); }); });

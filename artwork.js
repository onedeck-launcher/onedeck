// Artwork: box covers, logos, background art and screenshots, saved in data/media/<console>/<kind folder>/.
//
// Where pictures come from, tried in this order for each game:
//   1. the LaunchBox Games Database (see launchbox.js): the best and most complete source;
//   2. GameTDB, for Switch box covers;
//   3. libretro's thumbnail collection (covers and screenshots), matched by file name.
// No account or key is needed for any of them.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');

// Artwork kinds: the folder they're saved in, and libretro's folder name where libretro has them.
const TYPES = {
  front: { folder: 'covers', libretro: 'Named_Boxarts' },
  screenshot: { folder: 'screenshots', libretro: 'Named_Snaps' },
  logo: { folder: 'logos' },
  fanart: { folder: 'fanart' },
};
const SAVED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const SHARP_ENOUGH = { front: 700 };     // covers narrower than this are replaced when a sharper one turns up
const MAX_IMAGE_BYTES = 20 * 1048576;
const MAX_DOWNLOAD_BYTES = 600 * 1048576;
const PARALLEL_REQUESTS = 4;
const REQUEST_TIMEOUT = 18000;
const AGENT = { 'User-Agent': 'OneDeck-Frontend' };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = b => b.length >= 24 && b.subarray(0, 8).equals(PNG_MAGIC);

const cancelled = () => new DOMException('Cancelled', 'AbortError');
const stopIfCancelled = signal => { if (signal?.aborted) throw cancelled(); };

// Picture width from the PNG or JPEG header, without decoding it (0 when unknown).
function widthOf(bytes) {
  if (!bytes || bytes.length < 24) return 0;
  if (isPng(bytes)) return bytes.readUInt32BE(16);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 0;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) { at++; continue; }
    const marker = bytes[at + 1];
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) return bytes.readUInt16BE(at + 7);
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return 0;
}
function widthOfFile(file) {
  try {
    const head = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    try { return widthOf(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0))); } finally { fs.closeSync(fd); }
  } catch {
    return 0;
  }
}

// Marks an error as "the source's list couldn't be read" (not a cancel), so the source is skipped for the run.
const listError = signal => e => { if (!signal?.aborted) e.listFailed = true; throw e; };

// Waits for a promise, or rejects as soon as the signal is cancelled.
function untilCancelled(promise, signal) {
  if (!signal) return promise;
  stopIfCancelled(signal);
  let onAbort;
  const stop = new Promise((_, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); });
  return Promise.race([promise, stop]).finally(() => signal.removeEventListener('abort', onAbort));
}

function createArtworkService({ dataDir, getSystems, getGames, wants = () => true, normalize, fetchImpl = fetch, onProgress = () => {},
  source = 'https://thumbnails.libretro.com', decodeImage, launchbox = null, encodeImage = null,
  switchDatabase = 'https://www.gametdb.com/switchtdb.txt?LANG=EN', switchImages = 'https://art.gametdb.com/switch' }) {
  const indexFolder = path.join(dataDir, 'media', '_index');
  const mediaFolder = (consoleId, kind) => path.join(dataDir, 'media', consoleId, TYPES[kind].folder);

  // ---- requests: at most a few at once ----
  let running = 0;
  const waiting = [];
  function limited(work, signal) {
    return new Promise((resolve, reject) => {
      const go = async () => {
        running++;
        try { stopIfCancelled(signal); resolve(await work()); } catch (e) { reject(e); } finally { running--; waiting.shift()?.(); }
      };
      if (running < PARALLEL_REQUESTS) go(); else waiting.push(go);
    });
  }
  // A text file, or null on 404.
  function getText(url, signal) {
    return limited(async () => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
      const r = await fetchImpl(url, { headers: AGENT, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`The artwork site didn't answer (error ${r.status})`);
      return r.text();
    }, signal);
  }
  // A picture as PNG bytes (other formats are converted by decodeImage), or null on 404.
  function getImage(url, signal) {
    return limited(async () => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
      const r = await fetchImpl(url, { headers: AGENT, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`The artwork site didn't answer (error ${r.status})`);
      if (Number(r.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Artwork image is too large');
      const parts = [];
      let size = 0;
      for await (const part of r.body) {
        size += part.length;
        if (size > MAX_IMAGE_BYTES) { await r.body.cancel?.().catch(() => {}); throw new Error('Artwork image is too large'); }
        parts.push(Buffer.from(part));
      }
      let bytes = Buffer.concat(parts);
      if (!isPng(bytes) && decodeImage) bytes = await decodeImage(bytes);
      if (!isPng(bytes)) throw new Error('Artwork server did not return a picture OneDeck can read');
      const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
      if (!w || !h || w > 16384 || h > 16384) throw new Error('Artwork picture has an impossible size');
      return bytes;
    }, signal);
  }
  // Streams a big file (the LaunchBox database) to disk, reporting bytes as they arrive.
  async function download(url, file, onBytes = () => {}) {
    const r = await fetchImpl(url, { headers: AGENT, signal: AbortSignal.timeout(15 * 60e3) });
    if (!r.ok || !r.body) throw new Error(`The game database download failed (error ${r.status})`);
    const total = Number(r.headers.get('content-length')) || 0;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error('Database download is unexpectedly large');
    const part = file + '.part';
    let got = 0;
    async function* counted(chunks) { for await (const c of chunks) { got += c.length; onBytes(got, total); yield c; } }
    try {
      await pipeline(Readable.fromWeb(r.body), counted, fs.createWriteStream(part));
      await fsp.rename(part, file);
    } catch (e) {
      await fsp.unlink(part).catch(() => {});
      throw e;
    }
  }

  // ---- names: the loose keys a game is looked up by ----
  // "Super Mario 64 (USA) [!]" and "SuperMario64" both become one key; version numbers are ignored.
  function titleKeys(game) {
    const tidy = s => String(s || '').replace(/\bv?\d+(?:\.\d+)+\b/gi, '').replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, '');
    const keys = [game.title, game.base].map(s => normalize(tidy(s)));
    keys.push(normalize(tidy(game.base).replace(/([a-z])([A-Z])/g, '$1 $2')));
    return [...new Set(keys.filter(Boolean))];
  }

  // ---- source: GameTDB (Switch covers) ----
  let switchTitles = null;  // promise of Map(key -> [title codes])
  function loadSwitchTitles(refresh) {
    if (switchTitles && !refresh) return switchTitles;
    const job = (async () => {
      const file = path.join(indexFolder, 'gametdb-switch.txt');
      let text = null;
      if (!refresh) try { if (Date.now() - fs.statSync(file).mtimeMs < 7 * 864e5) text = fs.readFileSync(file, 'utf8'); } catch {}
      if (!text) {
        text = await getText(switchDatabase);
        if (!text || !/^TITLES\s*=/m.test(text)) throw new Error('Could not read the GameTDB Switch title list');
        fs.mkdirSync(indexFolder, { recursive: true });
        fs.writeFileSync(file, text);
      }
      const byKey = new Map();
      for (const line of text.split(/\r?\n/)) {
        const m = /^([A-Z0-9]{5}) = (.+)$/.exec(line);
        const k = m && normalize(m[2]);
        if (k) byKey.set(k, [...(byKey.get(k) || []), m[1]]);
      }
      return byKey;
    })();
    switchTitles = job;
    job.catch(() => { if (switchTitles === job) switchTitles = null; });
    return job;
  }
  async function fromGameTdb(game, kind, signal, refresh) {
    if (kind !== 'front') return null;
    const byKey = await untilCancelled(loadSwitchTitles(refresh), signal).catch(listError(signal));
    const codes = [...new Set(titleKeys(game).flatMap(k => byKey.get(k) || []))].slice(0, 4);
    for (const code of codes)
      for (const region of ['US', 'EN', 'JA']) {
        stopIfCancelled(signal);
        const bytes = await getImage(`${switchImages}/cover/${region}/${code}.jpg`, signal);
        if (bytes) return bytes;
      }
    return null;
  }

  // ---- source: libretro thumbnails (a folder listing per console and kind, cached for a month) ----
  const libretroLists = new Map();  // "console/kind" -> promise of { exact, loose }
  function loadLibretroList(console_, kind, refresh) {
    const id = `${console_.id}/${kind}`;
    if (!refresh && libretroLists.has(id)) return libretroLists.get(id);
    const job = (async () => {
      const file = path.join(indexFolder, `${console_.id}-${kind}.json`);
      let names = null;
      if (!refresh) {
        // Older Harbour versions kept the cover list as <console>.json.
        const candidates = [file, ...(kind === 'front' ? [path.join(indexFolder, console_.id + '.json')] : [])];
        for (const f of candidates) try {
          if (Date.now() - fs.statSync(f).mtimeMs < 30 * 864e5) { const list = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(list)) { names = list; break; } }
        } catch {}
      }
      if (!names) {
        const html = await getText(`${source}/${encodeURIComponent(console_.libretro)}/${TYPES[kind].libretro}/`);
        names = [];
        for (const m of (html || '').matchAll(/href="([^"?]*?\.png)"/gi)) {
          try { const n = decodeURIComponent(m[1]); if (!n.includes('/') && path.basename(n) === n) names.push(n); } catch {}
        }
        if (html !== null && !names.length) throw new Error(`Could not read the ${TYPES[kind].libretro} artwork list`);
        fs.mkdirSync(indexFolder, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(names));
      }
      // US releases first, then Europe/World, so a loose match prefers them.
      const order = n => (/\(USA/.test(n) ? 0 : /\((Europe|World)/.test(n) ? 1 : 2);
      const exact = new Map(), loose = new Map();
      for (const n of names.filter(x => typeof x === 'string').sort((a, b) => order(a) - order(b))) {
        exact.set(n.toLowerCase(), n);
        const k = normalize(n.replace(/\.png$/i, ''));
        if (k && !loose.has(k)) loose.set(k, n);
      }
      return { exact, loose };
    })();
    libretroLists.set(id, job);
    job.catch(() => { if (libretroLists.get(id) === job) libretroLists.delete(id); });
    return job;
  }
  async function fromLibretro(console_, game, kind, signal, refresh) {
    const { exact, loose } = await untilCancelled(loadLibretroList(console_, kind, refresh), signal).catch(listError(signal));
    const name = exact.get(`${game.base}.png`.toLowerCase()) || loose.get(normalize(game.base));
    if (!name) return null;
    return getImage(`${source}/${encodeURIComponent(console_.libretro)}/${TYPES[kind].libretro}/${encodeURIComponent(name)}`, signal);
  }

  // ---- finding a picture for one game and kind ----
  // The first of a list of URLs that gives a usable picture; one dead link doesn't stop the rest.
  async function firstWorking(urls, signal) {
    let lastError = null;
    for (const url of urls) {
      stopIfCancelled(signal);
      try { const bytes = await getImage(url, signal); if (bytes) return bytes; } catch (e) { if (signal?.aborted) throw e; lastError = e; }
    }
    if (lastError) throw lastError;
    return null;
  }
  // Asks each source in turn. A source that breaks (its list won't load) is skipped for the rest of the run
  // (run.broken); an error only reaches the caller when no source could be asked at all.
  // run.refreshed remembers which lists were already re-fetched in this run.
  async function fetchPicture(game, console_, kind, { signal, run, retryMissing, sharpOnly = false, background = false }) {
    const freshOnce = name => { if (!retryMissing || run.refreshed.has(name)) return false; run.refreshed.add(name); return true; };
    const sources = [];
    // Background lookups never start the big LaunchBox download; a download from Settings may.
    if (launchbox && (!background || launchbox.available()))
      sources.push(['launchbox', async () => firstWorking(
        await launchbox.find(console_.id, titleKeys(game), kind, { refresh: !background && freshOnce('launchbox'), offline: background }), signal)]);
    if (console_.artworkProvider === 'gametdb-switch')
      sources.push(['gametdb-switch', () => fromGameTdb(game, kind, signal, freshOnce('gametdb-switch'))]);
    if (!sharpOnly && console_.libretro && TYPES[kind].libretro)
      sources.push([`${console_.id}/${kind}`, () => fromLibretro(console_, game, kind, signal, freshOnce(`${console_.id}/${kind}`))]);
    const problems = [];
    let asked = 0;
    for (const [name, ask] of sources) {
      if (run.broken.has(name)) { problems.push(run.broken.get(name)); continue; }
      try {
        asked++;
        const bytes = await ask();
        if (bytes) return bytes;
      } catch (e) {
        if (signal?.aborted) throw e;
        asked--;
        problems.push(e.message);
        // LaunchBox breaks as a whole; GameTDB and libretro only when their list can't be read (one bad picture is fine).
        if (name === 'launchbox' || e.listFailed) run.broken.set(name, e.message);
      }
    }
    if (!asked && problems.length) throw new Error(problems[0]);
    return null;
  }

  // ---- saving ----
  function checkBase(base) {
    if (typeof base !== 'string' || !base || base === '.' || base === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(base)) throw new Error('Invalid game filename');
    return base;
  }
  // A picture Harbour saved itself (in media/<console>/<kind folder>/): only those may be replaced by a sharper copy.
  // Pictures people picked themselves live elsewhere and are never touched.
  function ourFile(url, console_, kind) {
    if (typeof url !== 'string' || !url.startsWith('file:')) return null;
    try {
      const file = fileURLToPath(url.split('?')[0]);
      const folder = mediaFolder(console_.id, kind) + path.sep;
      const inside = file.toLowerCase().startsWith(folder.toLowerCase()) && !file.slice(folder.length).includes(path.sep);
      return inside && SAVED_EXTENSIONS.includes(path.extname(file).toLowerCase()) && fs.existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }
  function existingFile(console_, kind, base) {
    for (const ext of SAVED_EXTENSIONS) {
      const file = path.join(mediaFolder(console_.id, kind), base + ext);
      try { if (fs.statSync(file).size > 0) return file; } catch {}
    }
    return null;
  }
  const prepare = (bytes, kind) => (encodeImage ? encodeImage(bytes, kind) : { bytes, ext: 'png' });

  const notFound = new Set();   // "console/base/kind" with nothing anywhere, until a retry
  const busy = new Map();       // the same picture asked for twice at once shares one download
  async function shared(id, signal, work) {
    if (busy.has(id)) return untilCancelled(busy.get(id), signal);
    const job = work();
    busy.set(id, job);
    try { return await job; } finally { if (busy.get(id) === job) busy.delete(id); }
  }

  // Which of LaunchBox's pictures each game shows after "Change artwork" ("console/base/kind" -> its place in the list).
  const picksFile = path.join(dataDir, 'media', '_index', 'art-picks.json');
  // Read once and shared: the four kinds change at the same time and must all land in the same record.
  let picks = null, picksLoading = null;
  const loadPicks = () => (picksLoading ||= fsp.readFile(picksFile, 'utf8').then(JSON.parse).catch(() => ({})).then(p => (picks = p)));
  const savePicks = () => fsp.mkdir(path.dirname(picksFile), { recursive: true }).then(() => fsp.writeFile(picksFile, JSON.stringify(picks))).catch(() => {});

  // "Change artwork": the next of LaunchBox's pictures for this game and kind, in place of the one shown. Going
  // round again comes back to the first. Kinds with only one picture stay as they are.
  async function nextPicture(game, console_, kind, base, have, keep, signal) {
    const urls = launchbox ? await launchbox.find(console_.id, titleKeys(game), kind, {}).catch(() => []) : [];
    if (urls.length < (keep.media[kind] ? 2 : 1)) return { ...keep, same: 1 };
    const all = await loadPicks(), key = `${console_.id}/${base}/${kind}`;
    for (let step = 1; step <= urls.length; step++) {
      const i = ((all[key] ?? 0) + step) % urls.length;
      let bytes = null;
      try { bytes = await getImage(urls[i], signal); } catch (e) { if (signal?.aborted) throw e; }
      if (!bytes) continue;
      const saved = await prepare(bytes, kind);
      stopIfCancelled(signal);
      const target = path.join(mediaFolder(console_.id, kind), `${base}.${saved.ext}`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      try { await fsp.writeFile(temp, saved.bytes); await fsp.rename(temp, target); } catch (e) { await fsp.unlink(temp).catch(() => {}); throw e; }
      if (have && have !== target) await fsp.unlink(have).catch(() => {});
      all[key] = i; await savePicks();
      return { downloaded: 1, upgraded: 1, media: { [kind]: `${pathToFileURL(target).href}?v=${Date.now()}` } };
    }
    return { ...keep, same: 1 };
  }

  // One picture for one game. Keeps what's there (unless `upgrade` and it's blurry, or `reroll`), else downloads.
  async function onePicture(game, kind, { signal, run, retryMissing = false, upgrade = false, background = false, reroll = false }) {
    stopIfCancelled(signal);
    const console_ = getSystems().find(s => s.id === game.system);
    const base = checkBase(game.base);
    const have = game.media?.[kind] ? ourFile(game.media[kind], console_, kind) : existingFile(console_, kind, base);
    const haveUrl = game.media?.[kind] || (have && pathToFileURL(have).href);
    const keep = { existing: 1, media: { [kind]: haveUrl } };
    if (reroll) return shared(`${console_.id}/${base}/${kind}/next`, signal, () => nextPicture(game, console_, kind, base, have, keep, signal));

    if (haveUrl) {
      const width = have && upgrade && SHARP_ENOUGH[kind] ? widthOfFile(have) : 0;
      if (!width || width >= SHARP_ENOUGH[kind]) return keep;
      return shared(`${console_.id}/${base}/${kind}/sharper`, signal, async () => {
        let bytes = null;
        try { bytes = await fetchPicture(game, console_, kind, { signal, run, retryMissing, sharpOnly: true, background }); } catch (e) { if (signal?.aborted) throw e; }
        if (!bytes) return keep;
        const saved = await prepare(bytes, kind);
        if (widthOf(saved.bytes) <= width) return keep;
        stopIfCancelled(signal);
        const target = path.join(path.dirname(have), `${path.basename(have, path.extname(have))}.${saved.ext}`);
        const temp = `${target}.${randomUUID()}.tmp`;
        try { await fsp.writeFile(temp, saved.bytes); await fsp.rename(temp, target); } catch (e) { await fsp.unlink(temp).catch(() => {}); throw e; }
        if (target !== have) await fsp.unlink(have).catch(() => {});
        // The ?v= makes the window load the new picture instead of its cached copy of the old one.
        return { downloaded: 1, upgraded: 1, media: { [kind]: `${pathToFileURL(target).href}?v=${Date.now()}` } };
      });
    }

    const id = `${console_.id}/${base}/${kind}`;
    if (!retryMissing && notFound.has(id)) return { missing: 1, media: {} };
    if (busy.has(id)) {
      const other = await untilCancelled(busy.get(id), signal);
      return other.downloaded ? { ...other, downloaded: 0, existing: 1 } : other;
    }
    return shared(id, signal, async () => {
      const bytes = await fetchPicture(game, console_, kind, { signal, run, retryMissing, background });
      if (!bytes) { notFound.add(id); return { missing: 1, media: {} }; }
      const saved = await prepare(bytes, kind);
      stopIfCancelled(signal);
      const file = path.join(mediaFolder(console_.id, kind), `${base}.${saved.ext}`);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // 'wx' never overwrites: a picture saved meanwhile (by another download or by hand) wins.
      try {
        await fsp.writeFile(file, saved.bytes, { flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') return { existing: 1, media: { [kind]: pathToFileURL(file).href } };
        await fsp.unlink(file).catch(() => {});
        throw e;
      }
      notFound.delete(id);
      return { downloaded: 1, media: { [kind]: pathToFileURL(file).href } };
    });
  }

  async function forGame(game, kinds, options) {
    const result = { gameId: game.id, title: game.title, media: {}, downloaded: 0, upgraded: 0, existing: 0, missing: 0, errors: [], unsupported: false };
    const console_ = getSystems().find(s => s.id === game.system);
    if (!console_ || !(console_.libretro || console_.artworkProvider === 'gametdb-switch' || launchbox?.platforms[console_.id])) {
      result.unsupported = true;
      return result;
    }
    // Kinds switched off (for everything or this game) aren't downloaded; a reroll is asked for by hand.
    const outcomes = await Promise.all(kinds.filter(k => options.reroll || wants(game, k)).map(kind => onePicture(game, kind, options).catch(e => {
      if (options.signal?.aborted) throw e;
      return { error: e.message };
    })));
    for (const o of outcomes) {
      for (const k of ['downloaded', 'upgraded', 'existing', 'missing']) result[k] += o[k] || 0;
      Object.assign(result.media, o.media);
      if (o.error) result.errors.push(o.error);
    }
    // A sharper picture is a new file (often with a new extension): the window must swap its address.
    if (result.upgraded) result.replace = true;
    return result;
  }

  // ---- the download job shown in the window ----
  let job = null, controller = null, lastSent = 0;
  const status = () => (job ? structuredClone(job) : null);
  function send(item = null, now = false) {
    if (!now && !item && Date.now() - lastSent < 100) return;
    lastSent = Date.now();
    job.seq++;
    onProgress({ ...status(), ...(item ? { item } : {}) });
  }

  // scope: 'game' (gameId), 'system' (systemId) or 'library'. types: artwork kinds.
  // retryMissing: ask again for pictures not found earlier. upgrade: replace blurry covers.
  function start(options = {}) {
    if (job?.status === 'running' || job?.status === 'cancelling') throw new Error('An artwork download is already running');
    const kinds = [...new Set((options.types || []).filter(t => Object.hasOwn(TYPES, t)))];
    if (!kinds.length) throw new Error('Choose at least one artwork type');
    const { scope } = options;
    if (!['game', 'system', 'library'].includes(scope)) throw new Error('Choose a download scope');
    const games = getGames().filter(g => scope === 'library' || (scope === 'game' ? g.id === options.gameId : g.system === options.systemId));
    if (!games.length) throw new Error('No games found. Add a game folder first.');

    controller = new AbortController();
    const { signal } = controller;
    job = { id: randomUUID(), seq: 0, status: 'running', scope, types: kinds, total: games.length, completed: 0, downloaded: 0, upgraded: 0,
      existing: 0, missing: 0, unsupported: 0, errors: 0, lastTitle: 'Preparing download…', entries: [], startedAt: Date.now() };
    const run = { refreshed: new Set(), broken: new Map() };
    const settings = { signal, run, retryMissing: !!options.retryMissing, upgrade: !!options.upgrade, reroll: !!options.reroll };
    send(null, true);

    let next = 0;
    const worker = async () => {
      while (!signal.aborted && next < games.length) {
        const game = games[next++];
        job.lastTitle = game.title;
        send();
        let result;
        try {
          result = await forGame(game, kinds, settings);
        } catch (e) {
          if (signal.aborted) return;
          result = { gameId: game.id, title: game.title, media: {}, downloaded: 0, existing: 0, missing: 0, errors: [e.message] };
        }
        job.completed++;
        for (const k of ['downloaded', 'upgraded', 'existing', 'missing']) job[k] += result[k] || 0;
        if (result.unsupported) job.unsupported++;
        if (result.errors.length) job.errors++;
        for (const [kind, url] of Object.entries(result.media)) if (!game.media[kind] || result.upgraded) game.media[kind] = url;
        job.entries = [{ ...result }, ...job.entries].slice(0, 8);
        send(result.downloaded && Object.keys(result.media).length ? result : null);
      }
    };
    Promise.all([worker(), worker()])
      .then(() => { job.status = signal.aborted ? 'cancelled' : 'complete'; job.finishedAt = Date.now(); send(null, true); })
      .catch(e => { job.status = 'failed'; job.error = e.message; send(null, true); });
    return status();
  }
  function cancel() {
    if (job?.status === 'running') { job.status = 'cancelling'; controller.abort(); send(null, true); }
    return status();
  }
  // Shows what a source is busy with (like preparing the LaunchBox database) as the job's current line.
  function note(message) {
    if (job?.status === 'running') { job.lastTitle = message; send(null, true); }
  }

  return { start, cancel, status, download, note, titleKeys };
}

module.exports = { createArtworkService, TYPES };

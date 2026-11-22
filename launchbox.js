// Game details and artwork links from the LaunchBox Games Database (gamesdb.launchbox-app.com).
//
// LaunchBox publishes the whole database as one Metadata.zip (about 100 MB) holding Metadata.xml. Harbour downloads it
// at most once a month, reads the XML once as a stream, and keeps a small index on disk:
//   media/_index/launchbox-index.json          names -> game ids, game id -> image file names, per platform
//   media/_index/launchbox-meta/<platform>.json game id -> description, year, developer... (read when needed)
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');

// Harbour console id -> LaunchBox platform name.
const PLATFORMS = {
  a2600: 'Atari 2600', arcade: 'Arcade', nes: 'Nintendo Entertainment System', snes: 'Super Nintendo Entertainment System',
  n64: 'Nintendo 64', gc: 'Nintendo GameCube', wii: 'Nintendo Wii', wiiu: 'Nintendo Wii U', switch: 'Nintendo Switch',
  switch2: 'Nintendo Switch 2', gb: 'Nintendo Game Boy', gbc: 'Nintendo Game Boy Color', gba: 'Nintendo Game Boy Advance',
  nds: 'Nintendo DS', '3ds': 'Nintendo 3DS', genesis: 'Sega Genesis', dreamcast: 'Sega Dreamcast', ps1: 'Sony Playstation',
  ps2: 'Sony Playstation 2', ps3: 'Sony Playstation 3', ps4: 'Sony Playstation 4', psp: 'Sony PSP', xbox: 'Microsoft Xbox',
  x360: 'Microsoft Xbox 360', pc: 'Windows',
};

// Which LaunchBox image types count as each Harbour artwork kind, in order of preference.
const KINDS = {
  front: ['Box - Front', 'Box - Front - Reconstructed'],
  logo: ['Clear Logo'],
  fanart: ['Fanart - Background'],
  screenshot: ['Screenshot - Gameplay'],
};
const INDEX_VERSION = 3;              // the index layout; a different number means "build it again"
const REFRESH_AFTER = 30 * 864e5;     // a month
const IMAGES_KEPT = 6;                // per game and kind
const DESCRIPTION_MAX = 1200;

// Prefer North American / worldwide images, then European, then the rest.
function regionScore(region) {
  if (!region) return 1;
  if (/North America|United States|Canada|World/.test(region)) return 0;
  if (/Europe|United Kingdom|Australia|Oceania/.test(region)) return 2;
  return 3;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  });
}
// The text of <tag>…</tag> inside one record, or ''.
function tagText(record, tag) {
  const start = record.indexOf(`<${tag}>`);
  if (start < 0) return '';
  const from = start + tag.length + 2, end = record.indexOf(`</${tag}>`, from);
  return end < 0 ? '' : unescapeXml(record.slice(from, end)).trim();
}

// Opens one file inside a zip as a readable stream, using the zip's central directory (no unzip tool needed).
async function openZipEntry(zipFile, wanted) {
  const file = await fsp.open(zipFile, 'r');
  try {
    const { size } = await file.stat();
    // The end-of-central-directory record is in the last 64 KB (+22 bytes) of the file.
    const tailLength = Math.min(size, 0xffff + 22);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (end < 0) throw new Error('The LaunchBox database download is not a zip file.');
    const dirSize = tail.readUInt32LE(end + 12), dirStart = tail.readUInt32LE(end + 16);
    const dir = Buffer.alloc(dirSize);
    await file.read(dir, 0, dirSize, dirStart);
    let at = 0;
    while (at + 46 <= dir.length && dir.readUInt32LE(at) === 0x02014b50) {
      const nameLength = dir.readUInt16LE(at + 28);
      const name = dir.toString('utf8', at + 46, at + 46 + nameLength);
      if (name === wanted) {
        const method = dir.readUInt16LE(at + 10), packed = dir.readUInt32LE(at + 20), localHeader = dir.readUInt32LE(at + 42);
        const local = Buffer.alloc(30);
        await file.read(local, 0, 30, localHeader);
        const dataStart = localHeader + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const raw = fs.createReadStream(zipFile, { start: dataStart, end: dataStart + packed - 1 });
        if (method === 0) return raw;
        if (method === 8) return raw.pipe(zlib.createInflateRaw());
        throw new Error('The LaunchBox database uses a compression OneDeck cannot read.');
      }
      at += 46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
    }
    throw new Error(`The LaunchBox database has no ${wanted}.`);
  } finally {
    await file.close();
  }
}

// Reads Metadata.xml once, keeping only Harbour's platforms and artwork kinds.
// `key` turns a game name into the loose lookup key Harbour uses everywhere.
async function readDatabase(zipFile, key) {
  const wantedPlatforms = new Set(Object.values(PLATFORMS));
  const kindOf = new Map();
  for (const [kind, types] of Object.entries(KINDS)) types.forEach((type, rank) => kindOf.set(type, { kind, rank }));
  const table = () => Object.create(null);
  const names = table(), images = table(), meta = table();
  const platformOfGame = new Map();

  const addName = (platform, name, id) => {
    const k = key(name);
    if (!k) return;
    const ids = ((names[platform] ||= table())[k] ||= []);
    if (!ids.includes(id)) ids.push(id);
  };
  const onGame = (record, id) => {
    const platform = tagText(record, 'Platform');
    if (!wantedPlatforms.has(platform)) return;
    platformOfGame.set(id, platform);
    addName(platform, tagText(record, 'Name'), id);
    let description = tagText(record, 'Overview').replace(/\r/g, '');
    if (description.length > DESCRIPTION_MAX) description = description.slice(0, DESCRIPTION_MAX).replace(/\s+\S*$/, '') + '…';
    const genres = tagText(record, 'Genres').split(';').map(g => g.trim()).filter(Boolean);
    const info = {
      description,
      year: (tagText(record, 'ReleaseDate') || tagText(record, 'ReleaseYear')).slice(0, 4),
      developer: tagText(record, 'Developer'),
      publisher: tagText(record, 'Publisher'),
      genre: genres.slice(0, 2).join(', '),
      players: tagText(record, 'MaxPlayers'),
      video: tagText(record, 'VideoURL'),  // a trailer or gameplay link, one source for the game's clip
    };
    for (const [k, v] of Object.entries(info)) if (!v || v === '0') delete info[k];
    if (Object.keys(info).length) (meta[platform] ||= table())[id] = info;
  };
  const onImage = (record, id) => {
    const platform = platformOfGame.get(id);
    const type = kindOf.get(tagText(record, 'Type'));
    const fileName = tagText(record, 'FileName');
    if (!platform || !type || !/^[\w.-]+\.(png|jpe?g)$/i.test(fileName)) return;
    const kinds = ((images[platform] ||= table())[id] ||= table());
    (kinds[type.kind] ||= []).push({ fileName, score: type.rank * 10 + regionScore(tagText(record, 'Region')) });
  };

  const stream = await openZipEntry(zipFile, 'Metadata.xml');
  stream.setEncoding('utf8');
  // Records are <Game>, <GameAlternateName> and <GameImage> blocks, read as they stream past.
  const record = /<(Game|GameAlternateName|GameImage)>([\s\S]*?)<\/\1>/g;
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk;
    record.lastIndex = 0;
    let used = 0;
    for (let m; (m = record.exec(pending)); used = record.lastIndex) {
      const id = tagText(m[2], 'DatabaseID');
      if (!id) continue;
      if (m[1] === 'Game') onGame(m[2], id);
      else if (m[1] === 'GameImage') onImage(m[2], id);
      else if (platformOfGame.has(id)) addName(platformOfGame.get(id), tagText(m[2], 'AlternateName'), id);
    }
    pending = pending.slice(used);
    if (pending.length > 4e6) pending = pending.slice(-1e6);  // never let a malformed record grow without end
  }
  if (!platformOfGame.size) throw new Error('No games could be read from the LaunchBox database.');

  // Best few images per game and kind, as plain file names.
  for (const byGame of Object.values(images))
    for (const kinds of Object.values(byGame))
      for (const kind of Object.keys(kinds))
        kinds[kind] = kinds[kind].sort((a, b) => a.score - b.score).slice(0, IMAGES_KEPT).map(i => i.fileName);
  return { version: INDEX_VERSION, built: Date.now(), names, images, meta };
}

const fileSafe = platform => platform.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function createLaunchBox({ dataDir, normalize, download, onStatus = () => {},
  metadataUrl = 'https://gamesdb.launchbox-app.com/Metadata.zip', imageUrl = 'https://images.launchbox-app.com' }) {
  const folder = path.join(dataDir, 'media', '_index');
  const indexFile = path.join(folder, 'launchbox-index.json');
  const metaFolder = path.join(folder, 'launchbox-meta');
  let current = null;              // the index, or the promise of it
  let building = null;             // a download and rebuild of the index under way
  const metaByPlatform = new Map();

  async function readIndex() {
    const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    if (index?.version !== INDEX_VERSION) throw new Error('The LaunchBox index is from another OneDeck version.');
    return index;
  }
  const ageOfIndex = () => { try { return Date.now() - fs.statSync(indexFile).mtimeMs; } catch { return Infinity; } };

  async function rebuild() {
    await fsp.mkdir(folder, { recursive: true });
    const zip = path.join(folder, 'launchbox-metadata.zip');
    onStatus('Downloading the LaunchBox games database (about 100 MB, once a month)…');
    let lastShown = 0;
    await download(metadataUrl, zip, (got, total) => {
      if (Date.now() - lastShown < 400) return;
      lastShown = Date.now();
      const mb = n => (n / 1048576).toFixed(0);
      onStatus(`Downloading the LaunchBox games database: ${mb(got)}${total ? ` of ${mb(total)}` : ''} MB (once a month)…`);
    });
    onStatus('Reading the LaunchBox games database…');
    const { meta, ...index } = await readDatabase(zip, normalize);
    await fsp.mkdir(metaFolder, { recursive: true });
    for (const [platform, byGame] of Object.entries(meta))
      await fsp.writeFile(path.join(metaFolder, fileSafe(platform) + '.json'), JSON.stringify(byGame));
    metaByPlatform.clear();
    await fsp.writeFile(indexFile + '.tmp', JSON.stringify(index));
    await fsp.rename(indexFile + '.tmp', indexFile);
    await fsp.unlink(zip).catch(() => {});
    return index;
  }

  // The index. offline: whatever is on disk, never a download (background work is always offline).
  // refresh: download a new copy if the one on disk is over a day old.
  function load(refresh = false, { offline = false } = {}) {
    if (offline) return current || readIndex().then(index => (current ||= Promise.resolve(index)));
    const age = ageOfIndex();
    const stale = age >= REFRESH_AFTER || (refresh && age >= 864e5);
    if (current && !stale) return current;
    // One download at a time: on a first run every picture asks at once, and each would otherwise start its own
    // 100 MB download into the same file (they'd break each other, and that run would get no LaunchBox pictures).
    if (building) return building;
    const job = (stale ? Promise.reject() : readIndex()).catch(() => rebuild());
    current = building = job;
    job.catch(() => { if (current === job) current = null; }).finally(() => { if (building === job) building = null; });
    return job;
  }

  const idsFor = (index, platform, keys) => {
    const byName = index.names[platform] || {};
    const ids = keys.filter(Boolean).flatMap(k => (Object.hasOwn(byName, k) && Array.isArray(byName[k]) ? byName[k] : []));
    return [...new Set(ids)];
  };

  // Image URLs for a game and artwork kind, best first; [] when LaunchBox doesn't know it.
  async function find(consoleId, keys, kind, { refresh = false, offline = false } = {}) {
    const platform = PLATFORMS[consoleId];
    if (!platform || !KINDS[kind]) return [];
    const index = await load(refresh, { offline });
    const byGame = index.images[platform] || {};
    for (const id of idsFor(index, platform, keys)) {
      const files = Object.hasOwn(byGame, id) ? byGame[id][kind] : null;
      if (files?.length) return files.map(f => `${imageUrl}/${encodeURIComponent(f)}`);
    }
    return [];
  }

  // Description, year, developer, publisher, genre, players and video link for a game, or null.
  async function details(consoleId, keys) {
    const platform = PLATFORMS[consoleId];
    if (!platform) return null;
    const index = await load(false, { offline: true });
    const ids = idsFor(index, platform, keys);
    if (!ids.length) return null;
    if (!metaByPlatform.has(platform)) {
      let byGame = {};
      try { byGame = JSON.parse(await fsp.readFile(path.join(metaFolder, fileSafe(platform) + '.json'), 'utf8')); } catch {}
      metaByPlatform.set(platform, byGame);
    }
    const byGame = metaByPlatform.get(platform);
    const id = ids.find(i => Object.hasOwn(byGame, i));
    return id ? byGame[id] : null;
  }

  // Whether the index is on disk and current, without reading all ~18 MB of it: its version is near the start.
  let checkedAt = null, isAvailable = false;
  function available() {
    try {
      const { mtimeMs } = fs.statSync(indexFile);
      if (mtimeMs !== checkedAt) {
        const head = Buffer.alloc(64);
        const fd = fs.openSync(indexFile, 'r');
        try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
        isAvailable = Number(/"version":(\d+)/.exec(head.toString('utf8'))?.[1]) === INDEX_VERSION;
        checkedAt = mtimeMs;
      }
      return isAvailable;
    } catch {
      return false;
    }
  }

  // The Harbour consoles a game name (as a lookup key) exists on, from the index on disk. [] when unknown.
  async function consolesFor(key) {
    if (!key || !available()) return [];
    const index = await load(false, { offline: true });
    return Object.entries(PLATFORMS).filter(([, platform]) => Object.hasOwn(index.names[platform] || {}, key)).map(([id]) => id);
  }

  return { find, load, details, available, consolesFor, platforms: PLATFORMS };
}

module.exports = { createLaunchBox, PLATFORMS };

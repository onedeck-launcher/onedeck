// Game videos: a one-minute clip of each game's trailer / gameplay video, saved next to its artwork
// (data/media/<system>/videos/<game>.mp4) and played from disk. The link comes from the LaunchBox
// games database; the clip is cut with yt-dlp + FFmpeg, which are downloaded into data/tools the
// first time videos are fetched (checked against GitHub's checksums and scanned by Defender).
// A video you put there yourself is never replaced unless you ask.
'use strict';
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os');
const { spawn } = require('child_process');

const YOUTUBE = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]{6,}/i;
// H.264 + AAC up to 1080p: decoded by the graphics card cheaply, and every Chromium build plays it.
const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/b';
const CLIP_SECONDS = 45;
// Clips come from the first half of the longplay (past the opening menus), where the game looks
// most like itself and doesn't spoil the ending.
const CLIP_FROM = .06, CLIP_TO = .50;
const HD_TITLE = /\b(hd|1080p?|1440p?|2160p?|4k|uhd|60\s?fps|upscaled?)\b/i;
// Words that don't help tell one game's video from another's.
const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'in', 'on', 'to', 'for', 'mods', 'edition', 'remake', 'hd']);
// Apostrophes join words ("Bowser's" -> "bowsers"), so a title with one still matches.
const words = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !STOP.has(w));
// A search result belongs to the game only when every word of the game's title is in the video title
// ("Vice City" is not "Vice City Stories"), and the video names no sequel number the game doesn't have
// ("Gears of War 3" is not "Gears of War 2").
// Titles with a subtitle ("The Legend of Zelda: Tears of the Kingdom"): every subtitle word must be
// there, but only half the series name (videos often drop "The Legend of"). Numbers from the console's
// name ("Nintendo 64", "Switch 2") and "part 3" / "episode 12" don't count as sequel numbers.
const SEQUEL = /^(\d{1,2}|ii|iii|iv|v|vi)$/;
// Console names a video title may mention. One that isn't the game's own console means it's another version.
const CONSOLES = { n64: ['n64', 'nintendo 64'], '3ds': ['3ds', '3d'], gc: ['gamecube', 'gcn', 'ngc'], wii: ['wii'], wiiu: ['wii u', 'wiiu'],
  switch: ['switch', 'nsw'], switch2: ['switch 2', 'switch2'], ps1: ['ps1', 'psx', 'playstation 1'], ps2: ['ps2', 'playstation 2'], ps3: ['ps3', 'playstation 3'],
  ps4: ['ps4', 'playstation 4'], ps5: ['ps5', 'playstation 5'], psp: ['psp'], xbox: ['xbox', 'og xbox'], x360: ['xbox 360', 'x360', '360'], xone: ['xbox one'],
  pc: ['pc', 'steam'], snes: ['snes'], nes: ['nes'], gba: ['gba'], ds: ['nds'], dreamcast: ['dreamcast'] };
const OWN = { n64: ['n64'], switch: ['switch'], switch2: ['switch2', 'switch'], ps2: ['ps2'], ps4: ['ps4'], xbox: ['xbox'], x360: ['x360', 'xbox'] };
function otherConsole(videoTitle, systemId, gameTitle = '') {
  const flat = s => ' ' + String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
  const t = flat(videoTitle), own = new Set(OWN[systemId] || [systemId]), title = flat(gameTitle);
  // Longer names first, so "xbox 360" is read as one console and not also as "xbox". A name that's
  // part of the game's own title ("Super Mario 3D World") is the game, not another console.
  const found = Object.entries(CONSOLES).flatMap(([id, names]) => names.map(n => [id, n]))
    .filter(([, n]) => !title.includes(` ${n} `)).sort((a, b) => b[1].length - a[1].length);
  let rest = t;
  for (const [id, n] of found) if (rest.includes(` ${n} `)) { if (!own.has(id)) return true; rest = rest.split(` ${n} `).join(' '); }
  return false;
}
function matches(gameTitle, videoTitle, systemName = '') {
  const got = words(String(videoTitle).replace(/\b(part|episode|ep|pt)\.?\s*\d+\b/gi, ' '));
  const have = new Set(got.flatMap(w => [w, w.replace(/s$/, '')]));
  const has = w => have.has(w) || have.has(w.replace(/s$/, ''));
  const [main, ...rest] = String(gameTitle).split(/:\s+|\s+-\s+/);
  const sub = words(rest.join(' ')), head = words(main);
  if (!head.length && !sub.length) return false;
  if (sub.length) { if (!sub.every(has) || head.filter(has).length < head.length / 2) return false; }
  else if (!head.every(has)) return false;
  const allowed = new Set([...words(gameTitle), ...words(systemName)].filter(w => SEQUEL.test(w)));
  return !got.some(w => SEQUEL.test(w) && !allowed.has(w));
}

function createVideoService({ dataDir, ghJson, download, extract, sha256File, defenderScan, getGames, getSystemName, lookup, log, emit }) {
  const toolsDir = path.join(dataDir, 'tools');
  // The tools' own builds for this system: Windows .exe files, or Linux programs (no ending).
  const win = process.platform === 'win32', ext = win ? '.exe' : '';
  const ytdlp = path.join(toolsDir, 'yt-dlp' + ext);
  const ffDir = path.join(toolsDir, 'ffmpeg');
  let job = null, cancelled = false;

  const toolsReady = () => fs.existsSync(ytdlp) && fs.existsSync(path.join(ffDir, 'ffmpeg' + ext)) && fs.existsSync(path.join(ffDir, 'ffprobe' + ext));
  const update = patch => { job = { ...job, ...patch }; emit({ ...job }); };

  // One release asset: downloaded, checked against GitHub's sha256, scanned, then handed back.
  async function fetchAsset(repo, name, tmp) {
    const rel = await ghJson(`https://api.github.com/repos/${repo}/releases/latest`);
    const asset = (rel.assets || []).find(a => a.name === name);
    if (!asset) throw new Error(`${repo} has no ${name} in its latest release`);
    const file = path.join(tmp, name);
    await download(asset.browser_download_url, file, (got, total) => update({ stage: `Getting ${name} (${(got / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ''} MB, one time only)` }));
    let want = /^sha256:/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null;
    if (!want) { // older releases: a checksums file next to the asset
      const sums = (rel.assets || []).find(a => /sha2?-?256|checksums/i.test(a.name));
      if (sums) { const f = path.join(tmp, sums.name); await download(sums.browser_download_url, f); want = (fs.readFileSync(f, 'utf8').split(/\r?\n/).find(l => l.includes(name)) || '').split(/\s+/)[0].toLowerCase() || null; }
    }
    if (!want) throw new Error(`No checksum published for ${name}; not using it.`);
    if ((await sha256File(file)) !== want) throw new Error(`${name} doesn't match GitHub's checksum; not using it.`);
    await defenderScan(file);
    return file;
  }
  async function ensureTools() {
    if (toolsReady()) return;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbour-tools-'));
    try {
      await fsp.mkdir(toolsDir, { recursive: true });
      if (!fs.existsSync(ytdlp)) { await fsp.copyFile(await fetchAsset('yt-dlp/yt-dlp', win ? 'yt-dlp.exe' : 'yt-dlp_linux', tmp), ytdlp); await fsp.chmod(ytdlp, 0o755); }
      if (!fs.existsSync(path.join(ffDir, 'ffmpeg' + ext))) {
        const zip = await fetchAsset('yt-dlp/FFmpeg-Builds', win ? 'ffmpeg-master-latest-win64-gpl-shared.zip' : 'ffmpeg-master-latest-linux64-gpl.tar.xz', tmp);
        update({ stage: 'Unpacking FFmpeg…' });
        const out = path.join(tmp, 'ff'); await fsp.mkdir(out);
        await extract(zip, out);
        const find = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name.toLowerCase() === 'ffmpeg' + ext) return dir; } return null; };
        const bin = find(out); if (!bin) throw new Error('FFmpeg download had no ffmpeg' + ext);
        await fsp.rm(ffDir, { recursive: true, force: true }); await fsp.mkdir(ffDir, { recursive: true });
        for (const f of fs.readdirSync(bin)) if ((win ? /\.(exe|dll)$/i : /^ff(mpeg|probe)$/).test(f) && !/^ffplay/i.test(f)) {
          await fsp.copyFile(path.join(bin, f), path.join(ffDir, f));
          if (!win) await fsp.chmod(path.join(ffDir, f), 0o755);
        }
      }
      log('video tools ready');
    } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }

  function run(args, timeoutMs = 4 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const p = spawn(ytdlp, args, { windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', d => (out += d));
      p.stderr.on('data', d => (err += d));
      const timer = setTimeout(() => { p.kill(); reject(new Error('timed out')); }, timeoutMs);
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((err.trim().split(/\r?\n/).pop() || `yt-dlp exit ${code}`).replace(/^ERROR:\s*/, '').slice(0, 160))); });
    });
  }
  // The tallest picture a YouTube video offers (0 if it can't be read).
  async function videoHeight(url) {
    try {
      const j = JSON.parse(await run(['-J', '--no-playlist', '--no-warnings', '--', url], 90 * 1000));
      return Math.max(0, ...(j.formats || []).filter(f => f.vcodec && f.vcodec !== 'none').map(f => f.height || 0));
    } catch { return 0; }
  }
  // Gameplay, not trailers: a no-commentary longplay of the game, in HD whenever one exists.
  // Searches that ask for HD come first; every candidate's real resolution is checked before it's used.
  async function findGameplay(g, skipUrl = null) {
    const system = getSystemName(g.system);
    const queries = [`${g.title} ${system} longplay 1080p`, `${g.title} longplay HD`, `${g.title} ${system} longplay`,
      `${g.title} ${system} gameplay no commentary 1080p`, `${g.title} gameplay no commentary`];
    // Another game in the library whose (longer) title the video matches better gets it instead:
    // "Banjo-Kazooie: Nuts & Bolts Longplay" is not a Banjo-Kazooie video.
    const others = getGames().filter(o => o.id !== g.id && words(o.title).length > words(g.title).length);
    const fits = v => v?.id && v.duration >= 8 * 60 && matches(g.title, v.title, system) && !otherConsole(v.title, g.system, g.title) &&
      !others.some(o => matches(o.title, v.title, getSystemName(o.system))) &&
      // No trailers, reviews or talking: "no commentary" is fine, any other mention of commentary isn't.
      !/trailer|review|top \d+|reaction|explained|speedrun|tier list|commentary|let'?s play/i.test(v.title.replace(/(no|without)[- ]commentary|commentary[- ]free/ig, '')) &&
      // Cutscene compilations ("The Movie", "All Cutscenes") show no play, unless they say they're a playthrough.
      !(/cut-?scenes?|\bthe movie\b|cinematics/i.test(v.title) && !/playthrough|walkthrough|longplay|gameplay/i.test(v.title));
    const seen = new Set(), candidates = [];
    for (const query of queries) {
      let list = [];
      try { list = JSON.parse(await run(['--flat-playlist', '-J', '--no-warnings', '--', `ytsearch10:${query}`], 60 * 1000)).entries || []; } catch { continue; }
      for (const v of list) if (fits(v) && !seen.has(v.id)) { seen.add(v.id); candidates.push(v); }
      if (candidates.filter(v => HD_TITLE.test(v.title)).length >= 3) break; // enough HD-sounding ones to try
    }
    // HD-sounding titles first, then the rest; the first one that really is 1080p wins, else the sharpest.
    candidates.sort((a, b) => HD_TITLE.test(b.title) - HD_TITLE.test(a.title));
    let best = null;
    for (const v of candidates.slice(0, 6)) {
      const url = `https://www.youtube.com/watch?v=${v.id}`;
      if (url === skipUrl) continue;
      const height = await videoHeight(url);
      const pick = { url, duration: v.duration, title: v.title, height };
      if (height >= 1080) return pick;
      if (!best || height > best.height) best = pick;
    }
    return best;
  }
  async function saveClip(source, outBase) {
    const span = Math.max(0, source.duration * (CLIP_TO - CLIP_FROM) - CLIP_SECONDS);
    const from = Math.floor(source.duration * CLIP_FROM + Math.random() * span);
    const section = source.duration ? `*${from}-${from + CLIP_SECONDS}` : `*10-${10 + CLIP_SECONDS}`;
    // Downloaded under a temporary name, then swapped in: the old clip may still be open (Harbour was
    // playing it), and Windows won't overwrite a file that's in use.
    const temp = outBase + '.new.mp4';
    await fsp.rm(temp, { force: true });
    await run(['--no-playlist', '--no-progress', '--quiet', '--no-warnings', '--no-mtime', '--ffmpeg-location', ffDir,
      '-f', FORMAT, '--merge-output-format', 'mp4', '--download-sections', section, '-o', outBase + '.new.%(ext)s',
      '--force-overwrites', '--', source.url]);
    if (!fs.existsSync(temp)) throw new Error('the download finished but no clip was saved');
    for (let attempt = 0; ; attempt++) {
      try { await fsp.rm(outBase + '.mp4', { force: true }); await fsp.rename(temp, outBase + '.mp4'); break; }
      catch (e) {
        if (attempt >= 12 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) { await fsp.rm(temp, { force: true }); throw new Error('the old clip is still in use; try again in a moment'); }
        await new Promise(r => setTimeout(r, 500)); // the player lets go of it within a moment
      }
    }
    // Remember which longplay the clip came from, so "Reroll" can take another bit of the same one.
    await fsp.writeFile(outBase + '.source.json', JSON.stringify({ ...source, from, savedAt: new Date().toISOString() }, null, 1));
  }
  const sourceOf = outBase => { try { return JSON.parse(fs.readFileSync(outBase + '.source.json', 'utf8')); } catch { return null; } };

  // scope: 'library' | 'game'. mode: 'missing' (games without a video), 'reroll' (another bit of the same
  // longplay), 'new' (a different longplay). Rerolls and new picks overwrite the old clip.
  function start({ scope = 'library', gameId, mode = 'missing', replace = false } = {}) {
    if (job?.status === 'running') throw new Error('Videos are already downloading');
    if (replace && mode === 'missing') mode = 'new';
    const games = getGames().filter(g => !g.demo && (scope !== 'game' || g.id === gameId) && (mode !== 'missing' || !g.media?.video));
    if (!games.length) throw new Error(scope === 'game' ? 'This game already has a video, or its videos are off.' : 'Every game already has a video.');
    cancelled = false;
    job = { status: 'running', stage: 'Getting ready…', total: games.length, done: 0, saved: 0, noLink: 0, failed: 0, lastTitle: '', errors: [] };
    emit({ ...job });
    (async () => {
      try {
        await ensureTools();
        for (const g of games) {
          if (cancelled) break;
          update({ stage: `Video: ${g.title}`, lastTitle: g.title });
          try {
            if (!g.base || /[<>:"/\\|?*\x00-\x1f]/.test(g.base)) throw new Error('unusable file name');
            const dir = path.join(dataDir, 'media', g.system, 'videos'), outBase = path.join(dir, g.base);
            const previous = sourceOf(outBase);
            // Reroll keeps the same longplay; otherwise gameplay is searched for, and the game's official
            // link from LaunchBox (often a trailer) is only a fallback.
            let source = mode === 'reroll' && previous?.duration ? previous : await findGameplay(g, mode === 'new' ? previous?.url : null);
            if (!source) { const url = await lookup(g).catch(() => null); if (url && YOUTUBE.test(url)) source = { url, duration: 0 }; }
            if (!source) { update({ noLink: job.noLink + 1 }); continue; }
            await fsp.mkdir(dir, { recursive: true });
            await saveClip(source, outBase);
            log(`video ${g.title}: ${source.title || source.url} (${source.height || '?'}p)`);
            update({ saved: job.saved + 1 });
          } catch (e) {
            log(`video ${g.title}: ${e.message}`);
            update({ failed: job.failed + 1, errors: [...job.errors, `${g.title}: ${e.message}`].slice(-6) });
          } finally { update({ done: job.done + 1 }); }
        }
        update({ status: cancelled ? 'cancelled' : 'complete', stage: '' });
      } catch (e) {
        log('video job: ' + e.message);
        update({ status: 'failed', stage: e.message });
      }
    })();
    return { ...job };
  }
  return { start, cancel: () => { cancelled = true; }, status: () => (job ? { ...job } : null), toolsReady };
}
module.exports = { createVideoService };

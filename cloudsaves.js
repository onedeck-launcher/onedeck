// Cloud saves, through OpenSave (https://github.com/Liquid-co/OpenSave, MIT): OneDeck drives OpenSave's own background
// program (its "daemon") and command line, and shows its own simple screens instead of OpenSave's app. Saves sync
// straight between your devices (on your network, or over the internet through OpenSave's relay with a code you share,
// encrypted end to end), and optionally through a folder (a OneDrive, Dropbox or Google Drive folder on this PC) or a
// Dropbox sign-in, so devices don't have to be on at the same time.
//
// OpenSave's program is downloaded only when cloud saves are switched on: from its GitHub releases, checked against
// the checksums published with them, into data/tools/opensave. It keeps its own data in ~/.opensave, so it works
// together with the OpenSave app if you have that too (OneDeck then uses the one that's already running).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { randomInt } = require('crypto');

const REPO = 'Liquid-co/OpenSave';

function createCloudSaves({ dataDir, ghJson, downloadFile, sha256File, extract, log }) {
  const dir = path.join(dataDir, 'tools', 'opensave');
  const exe = path.join(dir, process.platform === 'win32' ? 'opensave-cli.exe' : 'opensave-cli');
  // Tests point OpenSave at a pretend home folder; everyone else uses their own.
  const home = process.env.ONEDECK_OPENSAVE_HOME || null;
  const env = home ? { ...process.env, HOME: home, USERPROFILE: home } : process.env;
  let daemon = null;  // the one OneDeck started (null when OpenSave's own app or service is the one running)

  const installed = () => fs.existsSync(exe);
  // Runs one OpenSave command with --json and gives back what it printed. Failures carry OpenSave's own message.
  function cli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      execFile(exe, [...args, '--json'], { env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let out = null;
        try { out = JSON.parse(String(stdout || '').trim() || 'null'); } catch {}
        if (out && typeof out === 'object' && !Array.isArray(out) && out.error) return reject(new Error(String(out.error)));
        if (err && !out) return reject(new Error(err.killed ? 'OpenSave took too long to answer.' : String(stdout || err.message).trim().split('\n').pop()));
        resolve(out);
      });
    });
  }

  // ---- getting OpenSave's program ----
  const ASSET = { linux: { x64: 'opensave-linux-amd64.tar.gz', arm64: 'opensave-linux-arm64.tar.gz' },
    win32: { x64: 'opensave-cli.exe' }, darwin: { x64: 'opensave-macos-amd64.tar.gz', arm64: 'opensave-macos-arm64.tar.gz' } };
  async function install(progress = () => {}) {
    const name = ASSET[process.platform]?.[process.arch];
    if (!name) throw new Error(`OpenSave has no build for this computer (${process.platform} ${process.arch}).`);
    const rel = await ghJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const asset = rel.assets?.find(a => a.name === name), sums = rel.assets?.find(a => a.name === 'SHA256SUMS');
    if (!asset || !sums) throw new Error(`OpenSave ${rel.tag_name || ''} has no ${name} with checksums. Try again later.`);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'onedeck-opensave-'));
    try {
      progress(`Getting OpenSave ${rel.tag_name}…`);
      const sumsFile = path.join(tmp, 'SHA256SUMS'), file = path.join(tmp, name);
      await downloadFile(sums.browser_download_url, sumsFile);
      await downloadFile(asset.browser_download_url, file, (got, total) => progress(`Getting OpenSave (${(got / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ''} MB)`));
      const want = (fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).find(l => l.trim().endsWith(name)) || '').split(/\s+/)[0].toLowerCase();
      if (!want || (await sha256File(file)) !== want) throw new Error("OpenSave's download doesn't match its published checksum. Nothing was installed.");
      await fsp.mkdir(dir, { recursive: true });
      if (name.endsWith('.exe')) await fsp.copyFile(file, exe);
      else {
        const out = path.join(tmp, 'x'); await fsp.mkdir(out);
        await extract(file, out);
        const found = (function find(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name === 'opensave-cli') return p;
        } return null; })(out);
        if (!found) throw new Error("OpenSave's download had no opensave-cli in it.");
        await fsp.copyFile(found, exe); await fsp.chmod(exe, 0o755);
      }
      fs.writeFileSync(path.join(dir, 'version.txt'), `${rel.tag_name}\n`);
      log(`OpenSave ${rel.tag_name} installed (${name})`);
      return rel.tag_name;
    } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }

  // ---- the background program ----
  const running = () => cli(['daemon', 'status'], 8000).then(s => !!s?.settings).catch(() => false);
  async function start() {
    if (await running()) return true;  // OpenSave's own app or service is already on: use that
    // Its usual port first (other devices on your network reach it there); any free one if that's taken.
    for (const port of [null, 'auto']) {
      const args = ['daemon', 'start', ...(port ? ['--port', port] : [])];
      daemon = spawn(exe, args, { env, stdio: 'ignore', windowsHide: true });
      daemon.once('exit', code => { log(`OpenSave stopped (${code})`); daemon = null; });
      for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if (await running()) { log('OpenSave started'); return true; } if (!daemon) break; }
      try { daemon?.kill(); } catch {}
    }
    throw new Error("OpenSave didn't start. Is another copy using its port?");
  }
  function stop() { if (daemon) { try { daemon.kill(); } catch {} daemon = null; } }

  // ---- what's going on, all in one ----
  async function status() {
    if (!installed()) return { installed: false };
    let version = ''; try { version = fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim(); } catch {}
    if (!(await running())) return { installed: true, running: false, version };
    const [st, peers, offers, conflicts, cloud, daemonSt] = await Promise.all([
      cli(['status']), cli(['peers']), cli(['offers']).catch(() => []), cli(['conflicts']).catch(() => ({})), cli(['cloud', 'status']).catch(() => null),
      cli(['daemon', 'status'], 8000).catch(() => null)]);
    const short = p => p && p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;
    const paired = Object.values(peers?.peers || {}).map(p => ({ id: p.id, name: p.name, online: p.status === 'online', overRelay: !!p.overRelay, encrypted: !!p.encrypted, fingerprint: p.fingerprint || '', lastSynced: p.lastSynced || null }));
    const pairedIds = new Set(paired.map(p => p.id));
    // Devices you could link: in the same code room, or found on this network, and not linked yet.
    const nearby = [...(peers?.wanRoom?.peers || []), ...(peers?.discoveredPeers || [])]
      .filter((p, i, all) => !pairedIds.has(p.id) && all.findIndex(q => q.id === p.id) === i)
      .map(p => ({ id: p.id, name: p.deviceName, overRelay: !!p.isWan, address: p.address, port: p.port }));
    return {
      installed: true, running: true, ours: !!daemon, version,
      device: (typeof st?.device === 'string' ? st.device : st?.device?.name) || daemonSt?.settings?.deviceName || os.hostname(),
      nodeId: daemonSt?.settings?.nodeId || '',
      paused: !!st?.syncPause?.paused,
      games: (st?.games || []).map(g => ({ id: g.id, name: g.name, path: g.savePath, shown: short(g.savePath), missing: !!g.savePathMissing, lastSyncedWith: g.lastSyncedWith || {} })),
      paired, nearby,
      requests: (peers?.pairingRequests || []).map(r => ({ id: r.peerId, name: r.deviceName, overRelay: !!r.isWan })),
      room: peers?.wanRoom?.enabled ? { code: peers.wanRoom.roomCode || '', connected: !!peers.wanRoom.connected, error: peers.wanRoom.error || null } : null,
      offers: (offers || []).map(o => ({ gameId: o.gameId, name: o.name, from: o.peerId, fromPath: o.peerPath })),
      conflicts: Object.entries(conflicts || {}).map(([gameId, c]) => ({ gameId, ...(typeof c === 'object' ? c : {}) })),
      cloud: cloud?.provider ? { provider: cloud.provider, ready: !!cloud.ready, folder: cloud.provider === 'local' ? cloud.url : '', email: cloud.tokens?.userEmail || '' } : null,
    };
  }

  // ---- each game's sync state, like Steam's ----
  // synced; syncing (moving now, or changed here with another device online to take it); waiting (changed here since it
  // last reached another device, and none is on); conflict (changed on two devices); missing (its folder isn't here);
  // alone (no other device linked yet). Five quick calls cover every game: OpenSave's activity log keeps, per game, when
  // its save last changed (a snapshot) and when it last reached another device.
  async function syncStates() {
    if (!installed() || !(await running())) return null;
    const [st, act, tr, conflicts, peers] = await Promise.all([cli(['status']), cli(['activity', '--limit', '1']).catch(() => null),
      cli(['transfers']).catch(() => null), cli(['conflicts']).catch(() => ({})), cli(['peers']).catch(() => null)]);
    const paired = Object.values(peers?.peers || {}), online = paired.some(p => p.status === 'online');
    const moving = new Set((tr?.active || []).map(t => t.gameId).filter(Boolean));
    const seen = Object.fromEntries((act?.games || []).map(a => [a.gameId, a]));
    const out = {};
    for (const g of st?.games || []) {
      const a = seen[g.id] || {}, changed = a.lastSnapshotAt || 0, synced = a.lastSyncedAt || 0;
      const state = g.savePathMissing ? 'missing' : conflicts?.[g.id] ? 'conflict' : moving.has(g.id) ? 'syncing'
        : !paired.length ? 'alone' : changed > synced + 2000 ? (online ? 'syncing' : 'waiting') : 'synced';
      out[g.id] = { state, name: g.name, at: synced || null };
    }
    return out;
  }

  // ---- linking devices with a code ----
  // A code both devices type in: easy to read out (no 0/O or 1/I), long enough nobody guesses it.
  function newCode() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', part = () => Array.from({ length: 4 }, () => abc[randomInt(abc.length)]).join('');
    return `${part()}-${part()}-${part()}`;
  }
  const normaliseCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Both devices join the same room (OpenSave keeps them in it, so they keep syncing over the internet), then the one
  // that typed the code asks each device in the room to link; the other one says yes.
  async function joinCode(code) {
    const c = normaliseCode(code);
    if (c.replace(/-/g, '').length < 8) throw new Error('That code looks too short.');
    await cli(['relay', 'join', `onedeck-${c.toLowerCase()}`]);
    return c;
  }
  const askToLink = peer => cli(['pair', peer.overRelay || !peer.address || peer.address === 'relay' ? peer.id : `${peer.address}:${peer.port}`]);

  // ---- games ----
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Where a game's saves are, from OpenSave's own scan (Steam, emulators, Proton prefixes, 20,000+ games): the folders
  // whose name matches the game's best first.
  async function suggest(title) {
    const want = slug(title).split(' ').filter(w => w.length > 2);
    const rows = (await cli(['scan'], 120000).catch(() => [])) || [];
    const score = r => { const n = slug(r.name); return want.filter(w => n.includes(w)).length / Math.max(1, want.length); };
    return rows.map(r => ({ name: r.name, path: r.path || r.savePath, files: r.fileCount, bytes: r.totalBytes, latest: r.latestMtime, score: score(r) }))
      .filter(r => r.path && r.score >= 0.5).sort((a, b) => b.score - a.score || (b.latest || 0) - (a.latest || 0)).slice(0, 6)
      .map(narrow);
  }
  // A match that's a whole program folder (an emulator or port's own folder) syncs the program too: use its save folder
  // inside when it has one; otherwise say it's the whole folder, so you can pick the right one.
  const SAVE_DIRS = ['saves', 'save', 'savedata', 'save data', 'savegames', 'memcards', 'memory cards', 'sav', 'battery'];
  function narrow(r) {
    let entries = [];
    try { entries = fs.readdirSync(r.path, { withFileTypes: true }); } catch { return r; }
    const program = entries.some(e => e.isFile() && (/\.(exe|appimage)$/i.test(e.name) || (!path.extname(e.name) && isRunnable(path.join(r.path, e.name)))));
    if (!program) return r;
    const sub = entries.find(e => e.isDirectory() && SAVE_DIRS.includes(e.name.toLowerCase()));
    return sub ? { ...r, path: path.join(r.path, sub.name), note: 'its saves folder' } : { ...r, note: 'the whole folder, program and all' };
  }
  function isRunnable(p) { try { return process.platform !== 'win32' && (fs.statSync(p).mode & 0o111) !== 0; } catch { return false; }
  }
  async function place(gameId, folder) {
    await fsp.mkdir(folder, { recursive: true });
    return cli(['offers', 'place', gameId, folder]);
  }

  return {
    installed, install, start, stop, status, syncStates, newCode, joinCode, askToLink, suggest, place,
    // OneDeck's own Emulators and Ports folders go on OpenSave's scan list, so their saves are found too.
    scanFolders: async dirs => { for (const d of dirs) if (d && fs.existsSync(d)) await cli(['scanpath', 'add', d]).catch(() => {}); },
    approve: id => cli(['pair', 'approve', id]), reject: id => cli(['pair', 'reject', id]), unlink: id => cli(['unpair', id]),
    leaveCode: () => cli(['relay', 'leave']),
    track: (name, folder) => cli(['add', name, folder]), untrack: id => cli(['remove', id]),
    decline: gameId => cli(['offers', 'decline', gameId]),
    resolve: (gameId, choice) => cli(['resolve', gameId, choice]),
    syncNow: () => cli(['sync', '--all'], 60000),
    pause: on => cli(on ? ['pause'] : ['resume']),
    useFolder: folder => cli(['cloud', 'setup', 'local', '--path', folder]),
    connectStart: provider => cli(['cloud', 'connect', provider]),
    connectFinish: (provider, code) => cli(['cloud', 'connect', provider, '--code', code], 60000),
    disconnectCloud: () => cli(['cloud', 'disconnect']),
  };
}

module.exports = { createCloudSaves };

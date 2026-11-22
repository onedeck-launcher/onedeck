// Windows-only games on Linux: started through Proton (Steam's layer for Windows games), with umu-launcher when it's
// there (it sets Proton up the way Steam would), else Proton straight from Steam's folders, else Wine. All of them
// share one Windows "prefix" (a pretend C: drive) kept in ~/.local/share/OneDeck, never on an NTFS games drive,
// where Wine's links can't be made.
const fs = require('fs');
const path = require('path');
const os = require('os');

const home = os.homedir();
const dataHome = () => process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const prefixRoot = () => path.join(dataHome(), 'OneDeck', 'windows');

function onPath(cmd) {
  for (const dir of String(process.env.PATH || '').split(':').filter(Boolean)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Steam installs (native and Flatpak) and the libraries they list (other drives).
function steamRoots() {
  const roots = [process.env.STEAM_COMPAT_CLIENT_INSTALL_PATH, path.join(dataHome(), 'Steam'), path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'), path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')];
  const seen = new Set(), out = [];
  for (const r of roots) {
    if (!r || !isDir(r)) continue;
    let real = r; try { real = fs.realpathSync(r); } catch {}
    if (!seen.has(real)) { seen.add(real); out.push(real); }
  }
  return out;
}
function libraries(root) {
  const out = [root];
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) if (!out.includes(m[1])) out.push(m[1]);
  } catch {}
  return out;
}
// Every Proton on this PC: Steam's own (in a library's steamapps/common) and custom ones like GE-Proton
// (compatibilitytools.d). Newest build first, by the date in its version file (Hotfix is Steam's for single games).
function protons() {
  const dirs = [];
  const look = dir => { try { for (const n of fs.readdirSync(dir)) if (/proton/i.test(n)) dirs.push(path.join(dir, n)); } catch {} };
  for (const root of steamRoots()) {
    look(path.join(root, 'compatibilitytools.d'));
    for (const lib of libraries(root)) look(path.join(lib, 'steamapps', 'common'));
  }
  look('/usr/share/steam/compatibilitytools.d');
  const found = [...new Set(dirs)].filter(d => fs.existsSync(path.join(d, 'proton')) && !/hotfix/i.test(path.basename(d)));
  const built = d => { try { return Number(fs.readFileSync(path.join(d, 'version'), 'utf8').trim().split(/\s+/)[0]) || 0; } catch { return 0; } };
  return found.sort((a, b) => built(b) - built(a) || path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
}

// Wine's own background service for a prefix. Stopping it ends every Windows program in that prefix: a Windows game
// runs on after the program that started it is stopped, so this is how "hold to quit" closes it.
function wineserverOf(proton) {
  for (const d of ['files', 'dist']) { const p = path.join(proton, d, 'bin', 'wineserver'); if (fs.existsSync(p)) return p; }
  return null;
}
const stopper = (wineserver, prefix, env) => () => {
  if (!wineserver) return;
  try { require('child_process').spawn(wineserver, ['-k'], { env: { ...env, WINEPREFIX: prefix }, stdio: 'ignore', detached: true }).unref(); } catch {}
};

// The command that starts a Windows program: { cmd, args, env, via, stop }. Throws with what to install when there's
// nothing.
function windowsCommand(exe, args = [], env = process.env) {
  const proton = protons()[0];
  const steam = steamRoots()[0];
  const umu = onPath('umu-run');
  if (umu) {
    const prefix = path.join(prefixRoot(), 'umu');
    fs.mkdirSync(prefix, { recursive: true });
    return { cmd: umu, args: [exe, ...args], via: 'umu', stop: stopper(proton && wineserverOf(proton), prefix, env),
      env: { ...env, WINEPREFIX: prefix, GAMEID: env.GAMEID || 'umu-default', ...(proton ? { PROTONPATH: proton } : {}) } };
  }
  if (proton && steam) {
    const compat = path.join(prefixRoot(), 'proton');
    fs.mkdirSync(compat, { recursive: true });
    return { cmd: path.join(proton, 'proton'), args: ['run', exe, ...args], via: path.basename(proton),
      stop: stopper(wineserverOf(proton), path.join(compat, 'pfx'), env),
      env: { ...env, STEAM_COMPAT_DATA_PATH: compat, STEAM_COMPAT_CLIENT_INSTALL_PATH: steam } };
  }
  const wine = onPath('wine');
  if (wine) {
    const prefix = path.join(prefixRoot(), 'wine');
    fs.mkdirSync(prefix, { recursive: true });
    return { cmd: wine, args: [exe, ...args], via: 'wine', env: { ...env, WINEPREFIX: prefix }, stop: stopper(onPath('wineserver'), prefix, env) };
  }
  throw new Error('This game is made for Windows. Install Steam (it brings Proton) or Wine to play it on Linux.');
}
const canRunWindows = () => !!(onPath('umu-run') || (protons().length && steamRoots().length) || onPath('wine'));

module.exports = { windowsCommand, canRunWindows, protons };

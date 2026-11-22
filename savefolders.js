// OneDeck's Saves folder: emulators OneDeck starts keep their saves in one place, a folder each (Saves/DuckStation,
// Saves/PCSX2 …), so cloud saves sync them all without picking games one by one. Each emulator is pointed there once
// through its own settings file (a change you make in the emulator afterwards stays), and the saves it already had are
// copied in; the originals stay where they were. Only an emulator's saves move here, not save states.
//
// Not moved: emulators that keep saves inside a whole console's storage along with installed games and system files
// (Switch, PS3, Wii U, 3DS, PSP, Xbox, Xbox 360, Dolphin's Wii), and PC ports. Those are added one at a time.
// Setting names come from each emulator's source (checked 2026-11-20).
const fs = require('fs');
const path = require('path');
const os = require('os');

const win = process.platform === 'win32';
const named = s => new RegExp(`^(${s})(?![a-z0-9])`, 'i');
const programName = exe => path.basename(String(exe || '')).replace(/\.(exe|appimage)$/i, '').toLowerCase();

function createSaveFolders({ root, setFileValues, gamesFor, marked, mark, log }) {
  const home = os.homedir();
  const appData = () => process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = () => process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const documents = () => path.join(home, 'Documents');
  const xdgConfig = () => process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const xdgData = () => process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

  // files: where its settings file can be (the first that exists). ini: [section] key. base: what a relative folder in
  // it is relative to. def: its own save folder when the setting is empty. besideRom: it saves next to the game file
  // by default, with these endings.
  const SPECS = [
    { exe: named('duckstation'), name: 'DuckStation', consoles: ['ps1'],
      files: dir => [path.join(dir, 'settings.ini'), path.join(localAppData(), 'DuckStation', 'settings.ini'), path.join(documents(), 'DuckStation', 'settings.ini'),
        path.join(xdgData(), 'duckstation', 'settings.ini')],
      ini: ['MemoryCards', 'Directory'], base: file => path.dirname(file), def: 'memcards' },
    { exe: named('pcsx2'), name: 'PCSX2', consoles: ['ps2'],
      files: dir => [path.join(dir, 'inis', 'PCSX2.ini'), path.join(documents(), 'PCSX2', 'inis', 'PCSX2.ini'), path.join(xdgConfig(), 'PCSX2', 'inis', 'PCSX2.ini')],
      ini: ['Folders', 'MemoryCards'], base: file => path.dirname(path.dirname(file)), def: 'memcards' },
    { exe: named('melonds'), name: 'melonDS', consoles: ['nds'],
      files: dir => [path.join(dir, 'melonDS.toml'), path.join(appData(), 'melonDS', 'melonDS.toml'), path.join(xdgConfig(), 'melonDS', 'melonDS.toml')],
      ini: ['Instance0', 'SaveFilePath'], quote: "'", besideRom: ['.sav'] },
    { exe: named('mgba(-qt)?'), name: 'mGBA', consoles: ['gba', 'gbc', 'gb'],
      files: dir => [path.join(dir, 'config.ini'), path.join(appData(), 'mGBA', 'config.ini'), path.join(xdgConfig(), 'mgba', 'config.ini')],
      ini: ['ports.qt', 'savegamePath'], besideRom: ['.sav'] },
    win
      ? { exe: named('snes9x(-x64)?'), name: 'Snes9x', consoles: ['snes'], files: dir => [path.join(dir, 'snes9x.conf')],
        ini: ['Settings\\Win\\Files', 'Dir:SRAM'], base: (file, exe) => path.dirname(exe), def: 'Saves' }
      : { exe: named('snes9x'), name: 'Snes9x', consoles: ['snes'], files: () => [path.join(xdgConfig(), 'snes9x', 'snes9x.conf'), path.join(home, '.snes9x', 'snes9x.conf')],
        ini: ['Files', 'SRAMDirectory'], besideRom: ['.srm'] },
    { exe: named('rmg'), name: 'RMG', consoles: ['n64'],
      files: dir => [path.join(dir, 'Config', 'mupen64plus.cfg'), path.join(xdgConfig(), 'RMG', 'mupen64plus.cfg')],
      ini: ['Core', 'SaveSRAMPath'], quote: '"', base: (file, exe) => path.dirname(exe), def: win ? path.join('Save', 'Game') : path.join(xdgData(), 'RMG', 'Save', 'Game') },
    { exe: named('mesen'), name: 'Mesen', consoles: ['nes'],
      files: dir => [path.join(dir, 'settings.json'), path.join(documents(), 'Mesen2', 'settings.json'), path.join(xdgConfig(), 'Mesen2', 'settings.json')],
      json: true, base: file => path.dirname(file), def: 'Saves' },
  ];
  const specFor = exe => SPECS.find(s => s.exe.test(programName(exe)));
  const folderName = s => `${s.name} saves (OneDeck)`;  // its name in cloud saves: the same on every device, so they match

  // The value of key in [section], without quotes or a trailing comment.
  function iniGet(text, section, key) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(l => l.trim() === `[${section}]`);
    if (start < 0) return '';
    for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
      const m = lines[i].match(/^\s*([^=]+?)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return '';
  }
  // Where its saves are now.
  function current(s, file, exe) {
    let v = '';
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (s.json) { const p = JSON.parse(text).Preferences || {}; v = p.OverrideSaveDataFolder ? p.SaveDataFolder || '' : ''; }
      else v = iniGet(text, ...s.ini);
    } catch {}
    const base = s.base ? s.base(file, exe) : path.dirname(file);
    if (v) return path.resolve(base, v);
    return s.def ? path.resolve(base, s.def) : null;
  }
  // Copies what's in from into to; a file already in to is kept.
  function copyIn(from, to) {
    let n = 0;
    let entries = [];
    try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); n += copyIn(a, b); }
      else if (e.isFile() && !fs.existsSync(b)) { fs.copyFileSync(a, b); n++; }
    }
    return n;
  }
  // A save next to its game file (game.sav beside game.gba), copied in unless there's one already.
  function copyBeside(s, rom, to) {
    let n = 0;
    for (const ext of s.besideRom) {
      const save = path.join(path.dirname(rom), path.parse(rom).name + ext), b = path.join(to, path.basename(save));
      if (fs.existsSync(save) && !fs.existsSync(b)) { fs.copyFileSync(save, b); n++; }
    }
    return n;
  }
  function copyBesideRoms(s, to) {
    let n = 0;
    for (const rom of gamesFor(s.consoles)) { try { n += copyBeside(s, rom, to); } catch {} }
    return n;
  }

  // Points an emulator's saves at its folder in Saves, once per settings file. Its settings file appears on its first
  // run, so this is tried before each game and after it closes. Gives back its folder when it's set up.
  function apply(exe, rom) {
    const s = specFor(exe);
    if (!s) return null;
    const file = s.files(path.dirname(exe)).find(f => fs.existsSync(f));
    if (!file) return null;
    const dest = path.join(root(), s.name), key = file.toLowerCase();
    const out = { name: s.name, folder: dest, cloudName: folderName(s), consoles: s.consoles };
    if (marked(key) === dest) { if (rom && s.besideRom) { try { copyBeside(s, rom, dest); } catch {} } return out; }
    try {
      fs.mkdirSync(dest, { recursive: true });
      const was = current(s, file, exe);
      let copied = 0;
      if (was && path.resolve(was) !== path.resolve(dest) && !path.resolve(dest).startsWith(path.resolve(was) + path.sep)) copied = copyIn(was, dest);
      else if (!was && s.besideRom) copied = copyBesideRoms(s, dest);
      if (s.json) {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
        cfg.Preferences = { ...(cfg.Preferences || {}), OverrideSaveDataFolder: true, SaveDataFolder: dest };
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      } else {
        const [section, k] = s.ini, q = s.quote || '';
        setFileValues(file, { [section]: { [k]: q + dest + q } });
      }
      mark(key, dest); out.fresh = true;
      log(`${s.name} now saves in ${dest}${copied ? ` (copied ${copied} save file${copied === 1 ? '' : 's'} from ${was || 'beside the games'})` : ''}`);
      return out;
    } catch (e) { log(`couldn't move ${s.name}'s saves: ${e.message}`); return null; }
  }
  // The folders in Saves that belong to an emulator, with their cloud name and consoles.
  function list() {
    return SPECS.map(s => ({ name: s.name, folder: path.join(root(), s.name), cloudName: folderName(s), consoles: s.consoles }))
      .filter(f => fs.existsSync(f.folder));
  }
  // Every emulator's cloud name and folder, there yet or not (saves offered from another device go straight in).
  const all = () => SPECS.map(s => ({ name: s.name, folder: path.join(root(), s.name), cloudName: folderName(s), consoles: s.consoles }));
  // Both devices changed an emulator's folder before they synced (a game played on each): OpenSave sees the whole
  // folder as one conflict, and its "keep both" would set this device's version aside. One folder holds many games'
  // saves, so OneDeck combines them itself: the other device's folder comes in, then this device's saves go back on
  // top: a file only here goes back, and a file both changed keeps the newer one. The older copy goes to
  // Saves/Older copies (not synced). Then it syncs, so the other device gets the combined folder.
  async function merge({ saves, id, name, folder }) {
    const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'onedeck-saves-'));
    const older = path.join(root(), 'Older copies', name.replace(/ saves \(OneDeck\)$/, ''));
    const d = new Date(), two = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}`;
    try {
      fs.cpSync(folder, keep, { recursive: true, preserveTimestamps: true });
      await saves.resolve(id, 'keep-remote');
      // Wait for the other device's folder to land.
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const st = await saves.status().catch(() => null);
        if (st && !(st.conflicts || []).some(c => c.gameId === id)) break;
      }
      await new Promise(r => setTimeout(r, 1500));
      let back = 0, aside = 0;
      const putAside = (from, rel) => {
        const p = path.parse(path.join(older, rel)), to = path.join(p.dir, `${p.name} (${stamp})${p.ext}`);
        fs.mkdirSync(p.dir, { recursive: true }); fs.copyFileSync(from, to); aside++;
      };
      (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const a = path.join(dir, e.name), r = path.join(rel, e.name), b = path.join(folder, r);
          if (e.isDirectory()) { walk(a, r); continue; }
          if (!fs.existsSync(b)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); fs.utimesSync(b, fs.statSync(a).atime, fs.statSync(a).mtime); back++; continue; }
          if (fs.readFileSync(a).equals(fs.readFileSync(b))) continue;
          if (fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs) { putAside(b, r); fs.copyFileSync(a, b); back++; }
          else putAside(a, r);
        }
      })(keep, '');
      log(`cloud saves: combined ${name} with the other device's (${back} of this device's files kept${aside ? `, ${aside} older cop${aside === 1 ? 'y' : 'ies'} in ${older}` : ''})`);
      await saves.syncNow().catch(() => {});
      return { back, aside };
    } finally { fs.rmSync(keep, { recursive: true, force: true }); }
  }
  return { apply, list, all, specFor, merge };
}

module.exports = { createSaveFolders };

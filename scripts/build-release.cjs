// Builds a ready-to-run release for the system it runs on. Usage: npm run release:build
// Windows: dist\Harbour-<version>-win64.zip, holding Harbour.exe (the Electron runtime) with Harbour's own files in
// resources\app. Linux: dist/Harbour-<version>-x86_64.AppImage, the same in one file. No Node.js needed to run either.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronDir = path.join(root, 'node_modules', 'electron', 'dist');
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
// The program's name: the folder in the zip is just this (one copy, it updates itself); the zip carries the version.
const PRODUCT = 'OneDeck';
const dist = path.join(root, 'dist');
const out = path.join(dist, PRODUCT);
const zip = path.join(dist, `${PRODUCT}-${pkg.version}-win64.zip`);

// Harbour's own files: everything the app loads, plus its licence and notices. Not data\, node_modules or dev files.
const APP_FILES = ['main.js', 'preload.js', 'artwork.js', 'launchbox.js', 'videos.js', 'emulators.js', 'compat.js', 'cloudsaves.js', 'savefolders.js', 'package.json', 'ui',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'docs'];  // docs: the README's pictures

// Downloads a build tool once, kept only when it matches its pinned checksum.
async function pinnedTool({ url, sha256 }, name) {
  const file = path.join(root, 'node_modules', '.cache', name);
  const ok = () => fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256;
  if (!ok()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${name} download failed: HTTP ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    if (!ok()) { fs.rmSync(file, { force: true }); throw new Error(`${name} download doesn't match its pinned checksum`); }
  }
  fs.chmodSync(file, 0o755);
  return file;
}
function copyApp(app) {
  for (const f of APP_FILES) fs.cpSync(path.join(root, f), path.join(app, f), { recursive: true });
  const slim = { ...pkg };
  delete slim.devDependencies;
  delete slim.scripts;
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(slim, null, 2) + '\n');
}

// Linux: an AppDir (the runtime, Harbour in resources/app, a starter script, its icon and menu entry) packed into one
// AppImage with appimagetool. --no-sandbox: Chromium's sandbox helper needs root rights an AppImage can't have.
const APPIMAGETOOL = { url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage',
  sha256: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0' };
if (process.platform === 'linux') (async () => {
  if (!fs.existsSync(path.join(electronDir, 'electron'))) throw new Error('Run npm install first (no Electron in node_modules).');
  const id = PRODUCT.toLowerCase();
  const dir = path.join(dist, `${PRODUCT}.AppDir`);
  const image = path.join(dist, `${PRODUCT}-${pkg.version}-x86_64.AppImage`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(image, { force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(electronDir, dir, { recursive: true });
  fs.renameSync(path.join(dir, 'electron'), path.join(dir, id));
  fs.rmSync(path.join(dir, 'resources', 'default_app.asar'), { force: true });
  copyApp(path.join(dir, 'resources', 'app'));
  fs.writeFileSync(path.join(dir, 'AppRun'), `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/${id}" --no-sandbox "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${PRODUCT}\nComment=Ports. ROMs. Emulators. All in one place.\nExec=${id}\nIcon=${id}\nCategories=Game;\nTerminal=false\n`);
  fs.copyFileSync(path.join(root, 'ui', 'assets', 'brand', `${id}-icon-256.png`), path.join(dir, `${id}.png`));
  fs.symlinkSync(`${id}.png`, path.join(dir, '.DirIcon'));
  execFileSync(await pinnedTool(APPIMAGETOOL, 'appimagetool-x86_64.AppImage'), ['--no-appstream', dir, image],
    { stdio: 'inherit', env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' } });
  fs.rmSync(dir, { recursive: true, force: true });
  const hash = createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  fs.writeFileSync(image + '.sha256', `${hash}  ${path.basename(image)}\n`);
  console.log(`${path.relative(root, image)}  ${(fs.statSync(image).size / 1048576).toFixed(0)} MB  sha256 ${hash}`);
})().catch(e => { console.error(e.message); process.exit(1); });
else {
if (!fs.existsSync(path.join(electronDir, 'electron.exe'))) throw new Error('Run npm install first (no Electron in node_modules).');
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(out, { recursive: true });

// The runtime, with electron.exe renamed and Electron's demo app left out.
fs.cpSync(electronDir, out, { recursive: true });
fs.renameSync(path.join(out, 'electron.exe'), path.join(out, `${PRODUCT}.exe`));
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
fs.writeFileSync(path.join(out, 'electron-version.txt'), electronVersion + '\n');  // updates check this

// Harbour's icon, name and version on Harbour.exe, with rcedit (Electron's tool for this). Its releases publish no
// checksum, so the one Harbour uses is pinned here; a download that doesn't match is refused.
const RCEDIT = { url: 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe',
  sha256: '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a' };
async function rcedit() {
  const file = path.join(root, 'node_modules', '.cache', 'rcedit-x64.exe');
  const ok = () => fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === RCEDIT.sha256;
  if (!ok()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await fetch(RCEDIT.url);
    if (!r.ok) throw new Error(`rcedit download failed: HTTP ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    if (!ok()) { fs.rmSync(file, { force: true }); throw new Error("rcedit download doesn't match its pinned checksum"); }
  }
  return file;
}

// Harbour itself.
copyApp(path.join(out, 'resources', 'app'));
fs.copyFileSync(path.join(root, 'ui', 'assets', 'brand', 'onedeck.ico'), path.join(out, `${PRODUCT}.ico`));

(async () => {
const version = `${pkg.version}.0`.split('.').slice(0, 4).join('.');
execFileSync(await rcedit(), [path.join(out, `${PRODUCT}.exe`),
  '--set-icon', path.join(root, 'ui', 'assets', 'brand', 'onedeck.ico'),
  '--set-file-version', version, '--set-product-version', version,
  '--set-version-string', 'ProductName', PRODUCT, '--set-version-string', 'FileDescription', PRODUCT,
  '--set-version-string', 'CompanyName', PRODUCT, '--set-version-string', 'OriginalFilename', `${PRODUCT}.exe`,
  '--set-version-string', 'InternalName', PRODUCT, '--set-version-string', 'LegalCopyright', 'MIT-0'], { stdio: 'inherit' });

// Zip it with the bsdtar built into Windows, and write its checksum.
execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dist, PRODUCT], { stdio: 'inherit' });
const hash = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(zip + '.sha256', `${hash}  ${path.basename(zip)}\n`);
console.log(`${path.relative(root, zip)}  ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB  sha256 ${hash}`);
})().catch(e => { console.error(e.message); process.exit(1); });
}

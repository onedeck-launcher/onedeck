// Well-known emulators Harbour can install by itself: where their builds are released, which program starts
// them, and how to start a game in them. Harbour picks the download for this system from each release (unless `asset`
// says which), checks and unpacks it into its Emulators folder, sets it up for its consoles and keeps it updated.
// `site` and `licence`: credited in OneDeck (Settings → Credits, and next to Install). `args`: {rom} is the game file. `portable`: a file that makes it keep its settings in its own folder.
// `linux`: what's different on Linux (its download, another repository, its program's name), or false when the
// emulator publishes no Linux build. Most are one AppImage; without `exe` the program is found by itself.
const CATALOG = [
  { id: 'rmg', name: 'RMG', site: 'https://github.com/Rosalie241/RMG', licence: 'GPL-3.0', consoles: ['n64'], source: { type: 'github', repo: 'Rosalie241/RMG' },
    exe: 'RMG.exe', args: '--fullscreen --quit-after-emulation {rom}',
    linux: { asset: 'Linux64.*\\.AppImage$' } },
  { id: 'duckstation', name: 'DuckStation', site: 'https://www.duckstation.org/', licence: 'CC BY-NC-ND 4.0', consoles: ['ps1'], source: { type: 'github', repo: 'stenzek/duckstation' },
    exe: 'duckstation-qt-x64-ReleaseLTCG.exe', args: '-batch -fullscreen {rom}', portable: 'portable.txt', note: 'Needs a PS1 BIOS, chosen once in its setup.',
    linux: { asset: '^DuckStation-x64\\.AppImage$' } },
  { id: 'pcsx2', name: 'PCSX2', site: 'https://pcsx2.net/', licence: 'GPL-3.0', consoles: ['ps2'], source: { type: 'github', repo: 'PCSX2/pcsx2' },
    exe: 'pcsx2-qt.exe', args: '-batch -nogui -fullscreen {rom}', portable: 'portable.txt', note: 'Needs a PS2 BIOS, chosen once in its setup.',
    linux: { asset: 'linux-appimage-x64.*\\.AppImage$' } },
  { id: 'rpcs3', name: 'RPCS3', site: 'https://rpcs3.net/', licence: 'GPL-2.0', consoles: ['ps3'], source: { type: 'github', repo: 'RPCS3/rpcs3-binaries-win' },
    exe: 'rpcs3.exe', args: '--no-gui {rom}', note: 'Needs the PS3 firmware, installed once from its File menu.',
    linux: { repo: 'RPCS3/rpcs3-binaries-linux', asset: 'linux64\\.AppImage$' } },
  { id: 'shadps4', name: 'shadPS4', site: 'https://shadps4.net/', licence: 'GPL-2.0', consoles: ['ps4'], source: { type: 'github', repo: 'shadps4-emu/shadPS4', asset: 'win64-sdl.*\\.zip$' },
    exe: 'shadPS4.exe', args: '-g {rom}', note: 'Plays PS4 games as folders (the one with eboot.bin in it).',
    linux: { asset: 'linux-sdl.*\\.zip$' } },
  { id: 'ppsspp', name: 'PPSSPP', site: 'https://www.ppsspp.org/', licence: 'GPL-2.0', consoles: ['psp'], source: { type: 'github', repo: 'hrydgard/ppsspp' },
    exe: 'PPSSPPWindows64.exe', args: '--fullscreen {rom}',
    linux: { asset: 'anylinux-x86_64\\.AppImage$' } },
  { id: 'xemu', name: 'xemu', site: 'https://xemu.app/', licence: 'GPL-2.0', consoles: ['xbox'], source: { type: 'github', repo: 'xemu-project/xemu' },
    exe: 'xemu.exe', args: '-full-screen -dvd_path {rom}', note: 'Needs Xbox system files, chosen once in its settings.',
    linux: { asset: '\\d-x86_64\\.AppImage$' } },
  { id: 'xenia-canary', name: 'Xenia Canary', site: 'https://xenia.jp/', licence: 'BSD-3-Clause', consoles: ['x360'], source: { type: 'github', repo: 'xenia-canary/xenia-canary-releases' },
    exe: 'xenia_canary.exe', args: '--fullscreen {rom}',
    linux: { asset: 'linux\\.tar_?\\.xz$', exe: 'xenia_canary' } },
  { id: 'melonds', name: 'melonDS', site: 'https://melonds.kuribo64.net/', licence: 'GPL-3.0', consoles: ['nds'], source: { type: 'github', repo: 'melonDS-emu/melonDS' },
    exe: 'melonDS.exe', args: '-f {rom}',
    linux: { asset: 'appimage-x86_64\\.zip$' } },
  { id: 'azahar', name: 'Azahar', site: 'https://azahar-emu.org/', licence: 'GPL-3.0', consoles: ['3ds'], source: { type: 'github', repo: 'azahar-emu/azahar', asset: 'windows-msvc-[\\d.]+\\.zip$' },
    exe: 'azahar.exe', args: '{rom}',
    linux: { asset: '^azahar\\.AppImage$' } },
  { id: 'azaharplus', name: 'AzaharPlus', site: 'https://github.com/AzaharPlus/AzaharPlus', licence: 'GPL-3.0', consoles: ['3ds'], source: { type: 'github', repo: 'AzaharPlus/AzaharPlus', asset: 'windows\\.zip$' },
    exe: 'azahar.exe', args: '{rom}', note: 'Azahar with extra features.',
    linux: { asset: 'linux\\.AppImage$' } },
  { id: 'mgba', name: 'mGBA', site: 'https://mgba.io/', licence: 'MPL-2.0', consoles: ['gba', 'gbc', 'gb'], source: { type: 'github', repo: 'mgba-emu/mgba', asset: 'win64\\.7z$' },
    exe: 'mGBA.exe', args: '-f {rom}',
    linux: { asset: 'appimage-x64\\.appimage$' } },
  { id: 'cemu', name: 'Cemu', site: 'https://cemu.info/', licence: 'MPL-2.0', consoles: ['wiiu'], source: { type: 'github', repo: 'cemu-project/Cemu' },
    exe: 'Cemu.exe', args: '-f -g {rom}', note: 'Needs your Wii U keys, added once in its settings.',
    linux: { asset: 'x86_64\\.AppImage$' } },
  { id: 'dolphin', name: 'Dolphin', site: 'https://dolphin-emu.org/', licence: 'GPL-2.0', consoles: ['gc', 'wii'], source: { type: 'dolphin', repo: 'dolphin-emu/dolphin' },
    exe: 'Dolphin.exe', args: '-b -C Dolphin.Display.Fullscreen=True -e {rom}', portable: 'portable.txt',
    linux: false },
  { id: 'eden', name: 'Eden', site: 'https://eden-emu.dev/', licence: 'GPL-3.0', consoles: ['switch'], source: { type: 'forgejo', host: 'git.eden-emu.dev', repo: 'eden-emu/eden' },
    exe: 'eden.exe', args: '-g {rom}', note: 'Needs your Switch keys and firmware, added once in its settings.',
    linux: { asset: 'Linux-v[\\d.]+-amd64-clang-pgo\\.AppImage$' } },
  { id: 'ryujinx', name: 'Ryujinx', site: 'https://ryujinx.app/', licence: 'MIT', consoles: ['switch'], source: { type: 'forgejo', host: 'git.ryujinx.app', repo: 'projects/Ryubing', asset: 'win_x64\\.zip$' },
    exe: 'Ryujinx.exe', args: '--fullscreen {rom}', note: 'Needs your Switch keys and firmware, added once in its settings.',
    linux: { asset: '-x64\\.AppImage$' } },
  { id: 'lichii', name: 'Lichii', site: 'https://github.com/zortos293/Lichii', licence: 'GPL-3.0', consoles: ['switch2'], source: { type: 'github', repo: 'zortos293/Lichii' },
    exe: 'lichii.exe', args: '-g {rom}', note: 'Needs your Switch 2 keys and firmware, added once in its settings.',
    linux: { asset: 'linux-x86_64-pgo\\.AppImage$' } },
  { id: 'flycast', name: 'Flycast', site: 'https://github.com/flyinghead/flycast', licence: 'GPL-2.0', consoles: ['dreamcast'], source: { type: 'github', repo: 'flyinghead/flycast' },
    exe: 'flycast.exe', args: '{rom}',
    linux: { asset: 'x86_64.*\\.AppImage$' } },
  { id: 'snes9x', name: 'Snes9x', site: 'https://www.snes9x.com/', licence: 'Snes9x licence (non-commercial)', consoles: ['snes'], source: { type: 'github', repo: 'snes9xgit/snes9x', asset: 'win32-x64\\.zip$' },
    exe: 'snes9x-x64.exe', args: '-fullscreen {rom}',
    linux: { asset: 'x86_64\\.AppImage$', note: 'Needs gtkmm3, installed once from your package manager.' } },
  { id: 'mesen', name: 'Mesen', site: 'https://www.mesen.ca/', licence: 'GPL-3.0', consoles: ['nes'], source: { type: 'github', repo: 'SourMesen/Mesen2' },
    exe: 'Mesen.exe', args: '--fullscreen {rom}', note: 'Needs the .NET 8 Desktop Runtime from Microsoft.',
    linux: { asset: 'Linux_x64\\.zip$', note: '' } },
];

// This system's version of each entry (Windows and macOS use the entries as they are).
const forLinux = c => {
  if (!c.linux) return null;
  const { repo, asset, exe, ...rest } = c.linux;
  return { ...c, ...rest, exe: exe || null, source: { ...c.source, ...(repo ? { repo } : {}), ...(asset ? { asset } : {}) }, linux: undefined };
};
module.exports = { CATALOG: process.platform === 'linux' ? CATALOG.map(forLinux).filter(Boolean) : CATALOG };

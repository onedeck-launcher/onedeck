# Third-party notices

## PyroCade

Parts of `main.js` (configuration, library scanning, launching games, the window) are based on
[PyroCade](https://github.com/Pyrodrifter/PyroCade) by Pyrodrifter, used under the MIT License:

```
MIT License

Copyright (c) 2026 Pyrodrifter

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Used at runtime (not included in this repository)

- [Electron](https://www.electronjs.org/) (MIT), installed by `npm install`.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) and [FFmpeg](https://ffmpeg.org/) (GPL build from
  [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds)), downloaded into `data/tools` the first time game
  clips are made.
- [OpenSave](https://github.com/Liquid-co/OpenSave) (MIT), for cloud saves: downloaded from its own releases into
  `data/tools/opensave` only when cloud saves are switched on, and run in the background while they are.
- Emulators you install from Harbour (RMG, PCSX2, Dolphin, melonDS and the rest in `emulators.js`) are downloaded
  from each project's own official releases into the `Emulators` folder, under their own licences. Harbour includes
  none of them.

## Data sources

Game details and artwork come from the [LaunchBox Games Database](https://gamesdb.launchbox-app.com/),
[GameTDB](https://www.gametdb.com/) and [libretro thumbnails](https://thumbnails.libretro.com/), and are downloaded to
your PC when you use Harbour. Harbour includes none of their data. Gameplay clips are cut from public YouTube videos
for your own use on your own PC.

The list of PC ports to choose from (＋ → PC port / recomp) is [Recompendium](https://recompendium.com/)'s catalogue,
licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Harbour downloads it while you use it and
shows part of it (each game, project, console, status and what it needs) unchanged; it includes none of it.

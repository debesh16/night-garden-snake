# Night Garden Snake

My Windows console Snake game, rebuilt for the web. The game rules are still written in C. They are compiled to WebAssembly with Emscripten, and the browser side (HTML, CSS, plain JavaScript) only handles input, drawing, sound and saving.

The console version (`snake.c`) still builds and plays the same, and runs on the same C core. An optional C CGI backend uses that core too, so it can re-simulate submitted runs and verify scores instead of trusting the browser.

**Play it online: https://debesh16.github.io/night-garden-snake/**

## Folder layout

```
night-garden-snake/
├── snake.c                 console game (Windows, uses core/)
├── core/                   all game rules in C, no conio.h / windows.h
│   ├── snake_core.h        public API + the documented state layout
│   ├── snake_core.c        rules, collisions, scoring, exported API
│   ├── internal.h          structures shared by the core files
│   ├── rng.c               seeded xorshift32 (never rand())
│   ├── board.c             square, torus, Möbius, portals, hex grid, tile generators
│   ├── level.c             editor levels
│   ├── replay.c            replay recording (seed + inputs)
│   └── modes/              perks.c, rewind.c, daily.c
├── tests/test_core.c       native determinism tests (gcc)
├── Makefile, build.bat     build targets (WebAssembly, tests, console)
├── web/                    the static site, ready to host as-is
│   ├── index.html
│   ├── css/style.css
│   ├── js/                 main, render, input, audio, storage, ui, editor, online, portal
│   ├── wasm/               snake.js + snake.wasm (committed build)
│   └── assets/             favicon.svg, og-image.png, fonts/
├── tools/build_portals.py  builds one upload-ready zip per game portal
└── server/                 optional online backend (C CGI + MySQL)
```

## Play it locally

`web/wasm/` already holds a compiled build, so playing needs no compiler. Browsers will not load WebAssembly from `file://`, so serve the folder with any static file server, for example Python 3:

```bash
python -m http.server 8000 --directory web
```

Then open http://localhost:8000. The Python server is only for local testing; it is not part of the game.

## How to play

| Action | Keys | Touch |
| --- | --- | --- |
| Move | Arrow keys or WASD | Swipe on the board, or the on-screen pad |
| Move on the hex board | Q ↖, W ↗, E →, D ↘, S ↙, A ← (arrow keys work too) | Swipe in any of six directions, or the six-button pad |
| Rewind (Rewind mode) | Hold R or Backspace | Hold the rewind button |
| Pick a perk card | 1, 2, 3 | Tap a card |
| Pause | P or Esc | Pause button |
| Mute | M | Speaker button |

Two quick presses inside one step are both kept, as in the console game. The game pauses by itself when the tab loses focus.

### Modes

- **Classic**: the original rules. Every fruit adds 10 points and makes you 5 ms faster, from 200 ms down to 60 ms per step.
- **Rewind**: the core keeps the last 50 steps (about 5 seconds). Hold R to play time backwards, three times per run. If you crash, you can still rewind out of it.
- **Perk cards**: every 10 fruit the game stops and the core deals three cards: Ghost body, Slow time, Twin fruit, Magnet, Trim, Golden fruit, Edge door. Sometimes one of them is cursed: Closing garden (×3 score, walls creep inward) or Fever (×2 score, permanent top speed).
- **Weird boards**: Torus (wrap on every edge), Möbius (crossing the left or right edge flips you upside down), Portals (coloured pairs), and Hex grid (six directions).
- **Rhythm**: two built-in tracks made with Web Audio oscillators, so nothing needs licensing. You move on every eighth note. Eating on a beat gives a bonus, a PERFECT popup and a growing streak.
- **Darkness**: you only see around your head. The light shrinks as you grow, and fruit glows through the dark.
- **Ice and conveyors**: on ice you keep sliding; conveyors push you along their arrows.
- **Daily seed**: the board comes from today's UTC date, so everyone gets the same one. Your first run counts. At the end you get a result to copy or share, for example `🐍 Snake Daily #281 🟩🍎🍌🍇💀 Score 40`.
- **Two players**: green uses WASD and mint uses the arrow keys. Crashing into anything ends your round; heads meeting is a draw.
- **Level editor**: paint walls, ice, conveyors and portal pairs, set the start, then play it or copy a share link. The whole level is stored in the link, so no server is needed.

### Ghosts

Every run is recorded as its seed plus the inputs, which takes a few hundred bytes. Your best run in each mode is saved, and you can race it from the menu (Race your best). After any run, "Copy ghost link" gives a URL a friend can open to race the same board against your run.

### What the game remembers

Saved in your browser (localStorage): last mode and settings, last score and when you played (shown as "Welcome back…"), best score per mode, total games, fruit eaten by type, longest snake, nickname, sound, theme, touch controls, best-run ghosts, and daily status and streak. Nothing leaves the browser unless the optional server is configured. Settings has a "Reset my data" button.

## Building from source

### Requirements

| What | Needed for | Notes |
| --- | --- | --- |
| A C99 compiler (gcc) | tests, console game | On Windows, [MinGW-w64](https://www.mingw-w64.org/) or MSYS2 |
| Windows | console game | `snake.c` uses `conio.h` and `windows.h` |
| [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) | rebuilding `web/wasm/` | only after changing `core/` |
| `make` | optional | every target also has a plain command below |

### Tests

```bash
make test
```

or without make:

```bash
gcc -std=c99 -Wall -Wextra -O2 -Icore tests/test_core.c core/snake_core.c core/rng.c core/board.c core/level.c core/replay.c core/modes/perks.c core/modes/rewind.c core/modes/daily.c -o test_core
./test_core
```

This plays bot games in every mode and board, exports each replay, re-simulates it in a second game slot and checks that the results match exactly. It also checks that the same seed and inputs always give the same run, that invalid levels are rejected, and the daily seed numbering. The output ends with a line like `156 games, ... 0 failures`, and the exit code is non-zero if anything failed.

### Console version (Windows)

```bash
make console
```

or:

```bash
gcc -std=gnu99 -Wall -Wextra -O2 -Icore snake.c core/snake_core.c core/rng.c core/board.c core/level.c core/replay.c core/modes/perks.c core/modes/rewind.c core/modes/daily.c -o snake_console.exe
./snake_console.exe
```

Move with WASD or the arrow keys, P pauses, X quits.

### Rebuild the WebAssembly

Only needed after changing `core/`:

1. Install the Emscripten SDK once:
   ```bash
   git clone https://github.com/emscripten-core/emsdk.git
   cd emsdk
   emsdk install latest
   emsdk activate latest
   ```
2. In a terminal, run `emsdk_env.bat` (Windows) or `source ./emsdk_env.sh` (macOS/Linux) from the emsdk folder so `emcc` is on `PATH`.
3. In this project folder, run `build.bat` (Windows) or `make`.

Both write `web/wasm/snake.js` and `web/wasm/snake.wasm` using `-O2 -Wall -Wextra`, `MODULARIZE=1` and `EXPORT_NAME=createSnake`.

If you change the state layout in `core/snake_core.h`, update the matching `V` table at the top of `web/js/main.js`.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It runs the tests on Linux and Windows, builds the console game, rebuilds the WebAssembly with Emscripten, and compiles the server against the MySQL client library.

## Deploy

`web/` is a complete static site with no build step, so any static host works.

**GitHub Pages:** in the repository, open Settings, then Pages, and set Source to "GitHub Actions". Then open the Actions tab, pick "Deploy to GitHub Pages" and click "Run workflow". It publishes `web/` to `https://<your-name>.github.io/<repository>/`.

**Other hosts:** Netlify (drag the `web/` folder onto the dashboard), Vercel (static project, no build command, output folder `web`) and itch.io (zip the contents of `web/` and upload it as an HTML game).

## Game portal builds

The same `web/` folder runs on CrazyGames, Poki, Yandex Games and GameDistribution. `js/portal.js` is the only file that talks to a portal SDK. It reads `data-portal` on `<html>` (`web` by default, where every ad call does nothing). If an SDK fails to load, the game keeps running without ads.

```bash
python tools/build_portals.py
```

This writes `dist/night-garden-snake-<portal>.zip` for each portal, with `index.html` at the root. The "Portal builds" GitHub Action makes the same zips on every push to `main` and rebuilds the WebAssembly first. Download them from the run's Artifacts. For GameDistribution, set `GD_GAME_ID` (a repository variable in Actions, or an environment variable locally) to the id from their dashboard.

What changes in a portal build:

- The game starts straight into a Classic round, because portals measure how many visitors actually start playing. The menu is one tap away.
- Interstitial ads only appear on the game-over screen's "Play again" and "Menu" buttons. None show in the first minute, and after that at most one every 3 minutes.
- In Rewind mode, a player who runs out of rewinds can watch a rewarded ad for one more, once per run. The core records this as replay op `0x33`, so replays and server checks stay exact.
- Ghost links, level share links and the native share sheet are hidden, because the page URL belongs to the portal. The online server is not used.
- Sound goes silent during ads, when the portal asks, and while the tab is hidden.

To try a portal locally, add `?portal=crazygames` (or `poki`, `yandex`, `gamedistribution`) to the local URL. On localhost the CrazyGames SDK shows placeholder ads.

## Optional online features

Daily top run, ranked score submission and community levels need the server in `server/`: a C CGI program that uses the same `core/` code to re-simulate every submitted replay, plus a MySQL schema. It runs on Linux with Apache. Step-by-step setup is in [server/README_SERVER.md](server/README_SERVER.md). Database credentials are passed as environment variables (Apache `SetEnv`), never stored in the code.

To connect the game, set `API_BASE` in `web/js/online.js`. With `API_BASE` empty (the default) those buttons stay hidden and everything else works.

## Limitations

- The server has not been run against a real MySQL database yet.
- Liking community levels has no rate limit, and nicknames without a password are free to create, so likes are easy to inflate.
- Rhythm mode needs Web Audio for its music. If the browser blocks audio, the snake still moves on the same beat using a timer.
- Ghost replays and the share format are tied to this version of the core. Changing the rules in `core/` can make old ghosts replay differently.
- Hex boards cannot be made in the editor; it supports walls, torus and Möbius edges.
- The rewarded rewind needs a WebAssembly build made from the current `core/`. The deploy and portal workflows rebuild it. If `web/wasm/` is older, the game simply never offers it.
- `og:image` and `og:url` in `index.html` point at the GitHub Pages address. Change them if you host the game somewhere else.

## License

All rights reserved. You may read the source and play the game, but copying, modifying, re-hosting or uploading it to game portals needs written permission. See [LICENSE](LICENSE).

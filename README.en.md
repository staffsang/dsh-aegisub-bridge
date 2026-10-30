# dsh-aegisub-bridge

Let DSH read and write **the subtitles Aegisub is currently editing, before they are saved**. No save, no restart — edits show up in Aegisub's editor and grid immediately.

Aegisub has no public API, so this plugin borrows its own automation mechanism:

```
DSH tool call
  └─ aegisub_setup / aegisub_read / aegisub_apply     (lib/index.js, ESM, zero dependencies)
       └─ PowerShell: lib/trigger.ps1                  sends WM_COMMAND to the Aegisub main window
            └─ Lua macro WHALE_BRIDGE                 <Aegisub>\\automation\\autoload\\whale_bridge.lua
                 ├─ reads workDir\\command.lua and applies ops
                 ├─ aegisub.set_undo_point("whale bridge")
                 └─ writes workDir\\{dump.json,result.json}
```

## Install

The plugin ships its own `trigger.ps1` and `whale_bridge.lua` — no build step, no npm dependencies. Pick one:

**Injector (recommended, no restart)**

```bash
dev_inject_plugin <this directory>
```

**As a profile dependency**

```bash
cd ~/.dsh/profiles/<profile>
npm install <this directory or the packaged tgz>
# then add the package name to dsh.profile.bundles
```

After installing, call `aegisub_setup` once: it detects the Aegisub installation, writes the bridge scripts into `automation/autoload`, and makes a running Aegisub rescan its scripts.

## Tools

| Tool | What it does |
|---|---|
| `aegisub_setup` | Detect Aegisub, install/update the bridge scripts, make a running Aegisub rescan. Run once on first use, on a new machine, or after upgrading the plugin |
| `aegisub_read` | Read in-memory subtitles: `count` / `sel` / `active` / `lines[]` (`n` grid row, `i` file line, `start`/`end` ms, `style`, `text`). Supports `activeOnly` or a `from`/`to` range |
| `aegisub_apply` | Edit subtitles: `set_text` (change one line's text), `set_style` (change one line's style), `replace` (global replace). Each call sets an undo point; pass `dumpAfter` to read back |

Always address lines by file line number `i` (from `aegisub_read`'s `lines[].i`), not by grid row `n`.

## Configuration

Everything is optional and auto-detected by default. Two ways to set it: plugin config or environment variables.

| Config | Env var | Default | Notes |
|---|---|---|---|
| `aegisubRoot` | `AEGISUB_ROOT` | auto-detect | Aegisub install directory, or a direct path to `aegisub.exe` |
| `workDir` | `AEGISUB_BRIDGE_DIR` | `%LOCALAPPDATA%\\dsh-aegisub-bridge` | Bridge work directory (dump.json / result.json / command.lua) |
| `macroName` | — | `WHALE_BRIDGE` | Macro name registered in Aegisub |

Auto-detection order: path of a running `aegisub.exe` → common locations under `Program Files` / `Program Files (x86)` / `%LOCALAPPDATA%` / `C:`–`F:`.

## Limitations

- Windows only: relies on PowerShell + Win32 messages, and Aegisub is a GUI application
- Aegisub must be running; reads come from the in-memory `subs` array, not from a file on disk
- Aegisub's automation feature must be available (`Options > Automation`); if `aegisub_read` reports the macro is missing right after install, restart Aegisub once
- Each trigger costs a few hundred milliseconds — good for interactive line-by-line edits; for thousands of lines prefer a single `replace`
- `_legacy/` holds an early TypeScript scaffold. It is **not** equivalent to `lib/index.js` and must not be treated as the implementation

## Verification log

- 2026-10-31: read 73 Dialogue lines; timings/styles/text of the first 5 match Aegisub's grid
- 2026-10-31: bridge actually applied 28 line edits (`result.json` → `{"ok":true,"applied":28}`)
- 2026-10-31: generic rewrite (auto-detection / bundled scripts / `aegisub_setup`)

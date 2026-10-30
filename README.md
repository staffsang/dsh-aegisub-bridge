# dsh-aegisub-bridge

让 DSH 直接读写 **Aegisub 当前正在编辑、还没保存的字幕**。不用保存、不用关 Aegisub，改完立刻在编辑器和网格里看到。

Aegisub 没有对外 API，本插件借它自己的 automation 机制：

```
DSH 工具调用
  └─ aegisub_setup / aegisub_read / aegisub_apply     (lib/index.js，ESM，零依赖)
       └─ PowerShell: lib/trigger.ps1                  给 Aegisub 主窗口发 WM_COMMAND 触发宏
            └─ Lua 宏 WHALE_BRIDGE                    <Aegisub>\automation\autoload\whale_bridge.lua
                 ├─ 读 workDir\command.lua 并应用 ops
                 ├─ aegisub.set_undo_point("whale bridge")
                 └─ 写 workDir\{dump.json,result.json}
```

## 安装

插件自带 `trigger.ps1` 和 `whale_bridge.lua`，不需要构建、没有 npm 依赖。两种装法任选：

**注入器（推荐，免重启）**

```bash
dev_inject_plugin <本目录>
```

**作为 profile 依赖**

```bash
cd ~/.dsh/profiles/<profile>
npm install <本目录或打包后的 tgz>
# 再把包名加进 dsh.profile.bundles
```

装好后调用一次 `aegisub_setup`：它会自动探测 Aegisub 安装目录、把桥脚本写进 `automation/autoload`，并让已经开着的 Aegisub 重新扫描脚本。

## 工具

| 工具 | 作用 |
|---|---|
| `aegisub_setup` | 探测 Aegisub、安装/更新桥脚本、让运行中的 Aegisub 重扫。首次使用、换机器、升级插件后跑一次 |
| `aegisub_read` | 读内存字幕：`count` / `sel` / `active` / `lines[]`（`n` 网格序号、`i` 文件行号、`start`/`end` 毫秒、`style`、`text`）。可 `activeOnly` 或 `from`/`to` 分段取 |
| `aegisub_apply` | 改字幕：`set_text`（改单行文本）、`set_style`（改样式）、`replace`（全局替换）。每次自动打 undo 点，可 `dumpAfter` 回读 |

`index` 一律用文件行号 `i`（来自 `aegisub_read` 的 `lines[].i`），不是网格序号 `n`。

## 配置

全部可省略，默认自动探测。三种写法任选：插件 config、环境变量。

| 配置项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `aegisubRoot` | `AEGISUB_ROOT` | 自动探测 | Aegisub 安装目录，也可以直接填 `aegisub.exe` 路径 |
| `workDir` | `AEGISUB_BRIDGE_DIR` | `%LOCALAPPDATA%\dsh-aegisub-bridge` | 桥的工作目录（dump.json / result.json / command.lua） |
| `macroName` | — | `WHALE_BRIDGE` | 注册到 Aegisub 的宏名 |

自动探测顺序：正在运行的 `aegisub.exe` 进程路径 → `Program Files` / `Program Files (x86)` / `%LOCALAPPDATA%` / `C:`–`F:` 常见目录。

## 限制

- 仅 Windows：依赖 PowerShell + Win32 消息，且 Aegisub 是 GUI 程序
- Aegisub 必须开着；读的是内存里的 `subs` 数组，不是磁盘文件
- 需要 Aegisub 的 automation 功能可用（`Options > Automation`）；如果装完 `aegisub_read` 报找不到宏，重启一次 Aegisub
- 每次触发有几百毫秒开销，适合交互式逐段修改；几千行批量改建议一次性用 `replace`
- `_legacy/` 是早期 scaffold 留下的 TypeScript 草稿，与 `lib/index.js` 不等价，不要作为实现使用

## 验收记录

- 2026-10-31：读 73 条 Dialogue，前 5 行时间/样式/文本与 Aegisub 网格一致
- 2026-10-31：桥链路真实应用 28 行修改（`result.json` → `{"ok":true,"applied":28}`）
- 2026-10-31：通用化改造（自动探测 / 自带脚本 / aegisub_setup）

# dsh-aegisub-bridge

让 DSH 直接读写 **Aegisub 当前正在编辑、还没保存的字幕**。不用保存、不用关 Aegisub，改完立刻在编辑器和网格里看到。

## 原理

Aegisub 没有对外 API，但它启动时会加载 `%Aegisub%\automation\autoload\*.lua`。本插件走这条路：

```
DSH 工具调用
  └─ aegisub_read / aegisub_apply      (lib/index.js，ESM，零依赖)
       └─ PowerShell: trigger.ps1       用 automation 参数拉起 Aegisub 并触发宏
            └─ Lua 宏 WHALE_BRIDGE       N:\Aegisub\automation\autoload\whale_bridge.lua
                 ├─ 读 automation\whale\command.lua 并应用 ops
                 ├─ aegisub.set_undo_point("whale bridge")
                 └─ 写 automation\whale\{dump.json,result.json}
```

## 工具

| 工具 | 作用 |
|---|---|
| `aegisub_read` | 读内存字幕：`count` / `sel` / `active` / `lines[]`（`n` 网格序号、`i` 文件行号、`start`/`end` 毫秒、`style`、`text`）。可 `activeOnly` 或 `from`/`to` 分段取 |
| `aegisub_apply` | 改字幕：`set_text`（改单行文本）、`set_style`（改样式）、`replace`（全局替换）。每次自动打 undo 点，可 `dumpAfter` 回读 |

`index` 一律用文件行号 `i`（来自 `aegisub_read` 的 `lines[].i`），不是网格序号 `n`。

## 依赖（Windows）

- Aegisub 3.x，安装在 `N:\Aegisub`
- 桥宏 `N:\Aegisub\automation\autoload\whale_bridge.lua`
- 触发脚本 `J:\鲸鱼干活区\aegisub-bridge\trigger.ps1`
- Aegisub 的 `Options > Automation` 需允许 autoload

换机器时改 `lib/index.js` 顶部的 `WHALE` / `TRIGGER` 两个常量。

## 安装

不需要构建，没有 npm 依赖，`lib/index.js` 是唯一实现：

```bash
# 注入器环境内
dev_inject_plugin F:/dsh/03-dev-infra/dsh-aegisub-bridge
```

## 已知限制

- 仅 Windows（PowerShell + 固定盘符）
- Aegisub 必须开着，且读的是内存字幕（`subs` 数组），不是磁盘文件
- 每次触发有几百毫秒开销，适合交互式逐段修改；几千行批量改建议一次性用 `replace`
- `_legacy/` 是 scaffold 留下的 TypeScript 草稿，与 `lib/index.js` 不等价，不要作为实现使用

## 验收记录

- 2026-10-31：读 73 条 Dialogue，前 5 行时间/样式/文本与 Aegisub 网格一致
- 桥链路曾真实应用 28 行修改（`result.json` → `{"ok":true,"applied":28}`）

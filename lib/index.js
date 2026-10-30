/**
 * dsh-aegisub-bridge —— Aegisub 内存字幕直连（不保存、不关闭 Aegisub 即可读写）
 *
 * 零运行时依赖：只用 node: 内置模块 + 本包自带的 trigger.ps1 / whale_bridge.lua。
 * 路径不写死：自动探测 Aegisub 安装目录；也可以用插件 config 或环境变量覆盖：
 *   config.aegisubRoot / env AEGISUB_ROOT      Aegisub 安装目录（也可直接填 aegisub.exe）
 *   config.workDir     / env AEGISUB_BRIDGE_DIR 桥工作目录（默认 %LOCALAPPDATA%\dsh-aegisub-bridge）
 *   config.macroName                            宏名（默认 WHALE_BRIDGE）
 *
 * 链路：
 *   aegisub_read / aegisub_apply
 *     → PowerShell trigger.ps1（向运行中的 Aegisub 主窗口发 WM_COMMAND 触发宏）
 *       → Lua 宏 WHALE_BRIDGE（读 command.lua → 改 subs → 写 dump.json / result.json）
 *         → Node 读回 JSON
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const PS1 = join(__dirname, 'trigger.ps1')
const LUA_TEMPLATE = join(__dirname, 'whale_bridge.lua')

export const name = 'dsh-aegisub-bridge'
export const inject = ['tools']

const DEFAULT_MACRO = 'WHALE_BRIDGE'

// ---------------------------------------------------------------------------
// 配置与路径
// ---------------------------------------------------------------------------

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    aegisubRoot: text(c.aegisubRoot) || text(process.env.AEGISUB_ROOT),
    workDir: text(c.workDir) || text(process.env.AEGISUB_BRIDGE_DIR),
    macroName: text(c.macroName) || DEFAULT_MACRO,
  }
}

function defaultWorkDir() {
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'dsh-aegisub-bridge')
  return join(homedir(), '.dsh', 'cache', 'aegisub-bridge')
}

function looksLikeAegisub(root) {
  if (!root || !existsSync(root)) return false
  if (existsSync(join(root, 'automation'))) return true
  try {
    return readdirSync(root).some((f) => /^aegisub.*\.exe$/i.test(f))
  } catch {
    return false
  }
}

const COMMON_ROOTS = [
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Aegisub'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Aegisub'),
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Aegisub') : '',
  'C:\\Aegisub',
  'D:\\Aegisub',
  'E:\\Aegisub',
  'F:\\Aegisub',
].filter((p) => p && /^[A-Za-z]:/.test(p))

/** 跑一段 PowerShell，返回 stdout（UTF-8）。 */
async function runPs(command, timeoutMs = 20000) {
  const { stdout } = await execFileP(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + command],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  )
  return stdout
}

/** 从正在运行的 aegisub.exe 进程路径推断安装目录。 */
async function detectFromProcess() {
  try {
    const out = await runPs(
      "(Get-Process aegisub -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1 -ExpandProperty Path)",
    )
    const exe = out.trim()
    if (exe && existsSync(exe)) return dirname(exe)
  } catch {
    /* 进程不存在或拒绝访问，按未找到处理 */
  }
  return null
}

async function detectRoot(cfg) {
  const explicit = cfg.aegisubRoot
  if (explicit) {
    const root = /\.exe$/i.test(explicit) ? dirname(explicit) : explicit
    if (looksLikeAegisub(root)) return root
    throw new Error(
      'aegisubRoot 指向的目录不像 Aegisub（没有 automation 目录，也没有 aegisub*.exe）：' + root,
    )
  }
  const fromProcess = await detectFromProcess()
  if (looksLikeAegisub(fromProcess)) return fromProcess
  for (const candidate of COMMON_ROOTS) {
    if (looksLikeAegisub(candidate)) return candidate
  }
  throw new Error(
    '找不到 Aegisub 安装目录。请先启动 Aegisub，或在插件配置里指定 aegisubRoot（例如 "D:\\\\Aegisub"），' +
      '也可以设环境变量 AEGISUB_ROOT。',
  )
}

let cache = null

async function resolvePaths(cfg, refresh = false) {
  if (!refresh && cache) return cache
  const root = await detectRoot(cfg)
  cache = {
    root,
    workDir: cfg.workDir || defaultWorkDir(),
    macroName: cfg.macroName || DEFAULT_MACRO,
    macroPath: join(root, 'automation', 'autoload', 'whale_bridge.lua'),
  }
  return cache
}

// ---------------------------------------------------------------------------
// Lua 桥脚本的安装
// ---------------------------------------------------------------------------

/** 生成桥脚本（把工作目录写成 Lua 字符串字面量）。 */
function macroContent(workDir) {
  const template = readFileSync(LUA_TEMPLATE, 'utf8')
  const dir = (workDir + '\\').replace(/\\/g, '\\\\')
  return template.replace('__WHALE_DIR__', dir)
}

/** 确保 automation/autoload 里有最新的桥脚本；返回是否真的写了文件。 */
function ensureMacro(paths, force = false) {
  const autoloadDir = join(paths.root, 'automation', 'autoload')
  try {
    mkdirSync(autoloadDir, { recursive: true })
    mkdirSync(paths.workDir, { recursive: true })
  } catch (e) {
    throw new Error(
      '没有权限写入 Aegisub 目录：' +
        autoloadDir +
        '。Aegisub 可能装在 Program Files，请以管理员身份启动 DSH，或在插件配置里换一个可写的 aegisubRoot。原始错误：' +
        e.message,
    )
  }
  const want = macroContent(paths.workDir)
  const same = existsSync(paths.macroPath) && readFileSync(paths.macroPath, 'utf8') === want
  if (!force && same) return false
  writeFileSync(paths.macroPath, want, 'utf8')
  return true
}

// ---------------------------------------------------------------------------
// 触发 PowerShell
// ---------------------------------------------------------------------------

class BridgeError extends Error {
  constructor(code, out) {
    super(friendlyMessage(code, out))
    this.name = 'BridgeError'
    this.code = code
    this.detail = out
  }
}

function classify(out) {
  if (out.includes('ERR:AEGISUB_NOT_RUNNING')) return 'NOT_RUNNING'
  if (out.includes('ERR:NO_MAIN_WINDOW')) return 'NO_WINDOW'
  if (out.includes('ERR:MACRO_NOT_FOUND')) return 'NO_MACRO'
  if (out.includes('ERR:TIMEOUT')) return 'TIMEOUT'
  return 'UNKNOWN'
}

function friendlyMessage(code, out) {
  switch (code) {
    case 'NOT_RUNNING':
      return 'Aegisub 没有在运行：请先打开 Aegisub 并载入要编辑的字幕。'
    case 'NO_WINDOW':
      return '找不到 Aegisub 主窗口（可能还在启动，或最小化到托盘点不开），稍后重试。'
    case 'NO_MACRO':
      return 'Aegisub 里找不到 WHALE_BRIDGE 宏：先运行 aegisub_setup 安装桥脚本；如果 Aegisub 已开着，它会自动重扫 automation 脚本。'
    case 'TIMEOUT':
      return 'Aegisub 没有在 8 秒内响应宏触发：可能有对话框挡着，或桥脚本报错（看 automation/whale/error.txt）。'
    default:
      return 'Aegisub 桥触发失败：' + (String(out || '').trim().slice(0, 400) || '未知错误')
  }
}

async function runTrigger(paths, opts = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-WhaleDir', paths.workDir, '-MacroName', paths.macroName]
  if (opts.rescan) args.push('-ForceRescan')
  if (opts.rescanOnly) args.push('-RescanOnly')
  try {
    const { stdout } = await execFileP('powershell', args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 45000,
      windowsHide: true,
    })
    return stdout
  } catch (e) {
    const out = (String(e.stdout || '') + String(e.stderr || '')).trim()
    throw new BridgeError(classify(out), out || e.message)
  }
}

/** 触发宏；如果宏不存在，重新安装桥脚本并重扫后重试一次。 */
async function triggerWithRescue(paths, opts = {}) {
  try {
    return await runTrigger(paths, opts)
  } catch (e) {
    if (e instanceof BridgeError && e.code === 'NO_MACRO') {
      ensureMacro(paths, true)
      return await runTrigger(paths, { ...opts, rescan: true })
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 工具辅助
// ---------------------------------------------------------------------------

/** Lua 字符串字面量（双引号包裹，转义 \\ " 换行 回车 tab）。 */
function luaStr(value) {
  let out = '"'
  for (const ch of String(value)) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else out += ch
  }
  return out + '"'
}

/** 把 op 数组转成 Lua 表字面量（apply_ops 内部 loadstring("return " .. cmd)）。 */
function opsToLua(ops) {
  const parts = ops.map((o) => {
    if (o.op === 'set_text') return '{op="set_text",index=' + Number(o.index) + ',text=' + luaStr(o.text) + '}'
    if (o.op === 'set_style') return '{op="set_style",index=' + Number(o.index) + ',style=' + luaStr(o.style) + '}'
    if (o.op === 'replace') return '{op="replace",find=' + luaStr(o.find) + ',repl=' + luaStr(o.repl ?? '') + '}'
    throw new Error('未知 op：' + String(o.op) + '（支持 set_text / set_style / replace）')
  })
  return '{ops={' + parts.join(',') + '}}'
}

function readJson(path) {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('桥输出不是合法 JSON（' + path + '）：' + raw.slice(0, 200))
  }
}

/** 给 dump 的每行补网格序号 n（1-based，按 lines 顺序）与文件行号 i。 */
function decorate(dump) {
  const lines = (dump.lines ?? []).map((l, idx) => ({
    n: idx + 1,
    i: l.i,
    start: l.start,
    end: l.end,
    style: l.style,
    actor: l.actor,
    text: l.text,
    ...(l.comment ? { comment: true } : {}),
  }))
  const byLine = new Map(lines.map((l) => [l.i, l]))
  const mapN = (i) => (byLine.get(i) ? byLine.get(i).n : null)
  return {
    file: dump.file ?? null,
    count: dump.count ?? lines.length,
    total: dump.total ?? null,
    sel: (dump.sel ?? []).map(mapN).filter((n) => n != null),
    selLines: dump.sel ?? [],
    active: dump.active != null ? mapN(dump.active) : null,
    activeLine: dump.active ?? null,
    lines,
  }
}

const TEXT = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }]

// ---------------------------------------------------------------------------
// 工具：aegisub_setup / aegisub_read / aegisub_apply
// ---------------------------------------------------------------------------

function setupTool(cfg) {
  return {
    name: 'aegisub_setup',
    description:
      '安装或更新 Aegisub 桥接宏并自检。自动探测 Aegisub 安装目录（也可用插件配置 aegisubRoot / 环境变量 AEGISUB_ROOT 指定），' +
      '把 whale_bridge.lua 写入其 automation/autoload，并让已经打开的 Aegisub 重新扫描脚本。首次使用、换机器、升级插件后调用一次即可。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rescan: { type: 'boolean', description: '让运行中的 Aegisub 重扫 automation 脚本（默认 true）' },
        refresh: { type: 'boolean', description: '重新探测 Aegisub 路径（默认 true）' },
        force: { type: 'boolean', description: '强制重写桥脚本（默认只在内容变化时写）' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) =>
        TEXT(
          'Aegisub 桥：root=' + value.aegisubRoot +
            '；桥脚本' + (value.macroWritten ? '已写入/更新' : '已是最新') +
            '（' + value.macroPath + '）' +
            '；工作目录=' + value.workDir +
            '；Aegisub ' + (value.running ? '运行中' : '未运行') +
            (value.rescanned ? '，已重扫脚本' : '') +
            (value.note ? '\n' + value.note : ''),
        ),
    },
    async execute(args) {
      const paths = await resolvePaths(cfg, args.refresh !== false)
      const macroWritten = ensureMacro(paths, args.force === true)
      const running = await isAegisubRunning()
      let rescanned = false
      if (running && args.rescan !== false) {
        const out = await runTrigger(paths, { rescanOnly: true })
        rescanned = out.includes('OK:RESCAN')
      }
      return {
        ok: true,
        aegisubRoot: paths.root,
        macroPath: paths.macroPath,
        macroWritten,
        workDir: paths.workDir,
        running,
        rescanned,
        config: cfg,
        note: running
          ? rescanned
            ? '桥脚本已就绪并已让 Aegisub 重扫，可以直接调用 aegisub_read。'
            : 'Aegisub 在运行但重扫没确认成功：如果 aegisub_read 报找不到宏，重启一次 Aegisub。'
          : 'Aegisub 当前没开着：桥脚本会在 Aegisub 启动时自动加载，打开后直接 aegisub_read 即可。',
      }
    },
  }
}

async function isAegisubRunning() {
  try {
    const out = await runPs('(Get-Process aegisub -ErrorAction SilentlyContinue | Measure-Object).Count')
    return Number(out.trim()) > 0
  } catch {
    return false
  }
}

/** aegisub_read —— 读当前 Aegisub 内存里的字幕（含未保存修改）。 */
function readTool(cfg) {
  return {
    name: 'aegisub_read',
    description:
      '读取 Aegisub 当前正在编辑的内存字幕（包括尚未保存的修改），不需要保存或关闭 Aegisub。' +
      '返回 count（Dialogue 条数）、sel/active（当前选中/活动行的网格序号 n）、lines[]（每行含 n 网格序号、i 文件行号、start/end 毫秒、style、text）。' +
      '可用 activeOnly 只取选中行，或 from/to 按网格序号 n 取一段。首次使用会自动安装桥脚本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        activeOnly: { type: 'boolean', description: '只返回当前选中/活动行' },
        from: { type: 'integer', description: '起始网格序号 n（含），1-based' },
        to: { type: 'integer', description: '结束网格序号 n（含），1-based' },
        rescan: { type: 'boolean', description: '先让 Aegisub 重扫 automation 脚本（改了 Lua 桥后使用）' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) =>
        TEXT(
          'Aegisub：' + value.count + ' 条 Dialogue，当前活动行 n=' + (value.active ?? '（无）') +
            (value.sel.length ? '，选中 n=' + value.sel.join(',') : '') +
            '\n' + (value.lines || []).map((l) => 'n' + l.n + ' [i' + l.i + '] ' + l.start + '-' + l.end + ' ' + l.style + ' | ' + l.text).join('\n'),
        ),
    },
    async execute(args) {
      const paths = await resolvePaths(cfg)
      ensureMacro(paths)
      await triggerWithRescue(paths, { rescan: args.rescan === true })
      const full = decorate(readJson(join(paths.workDir, 'dump.json')))
      let lines = full.lines
      if (args.activeOnly) {
        const want = new Set([...full.sel, ...(full.active != null ? [full.active] : [])])
        lines = lines.filter((l) => want.has(l.n))
      }
      if (args.from != null) lines = lines.filter((l) => l.n >= args.from)
      if (args.to != null) lines = lines.filter((l) => l.n <= args.to)
      return { ...full, lines }
    },
  }
}

/** aegisub_apply —— 批量改内存字幕（文本/样式/全局替换），自动留 undo 点。 */
function applyTool(cfg) {
  return {
    name: 'aegisub_apply',
    description:
      '直接修改 Aegisub 内存里的字幕并写入（不需要保存/关闭 Aegisub，修改会立即出现在编辑器和网格里），每次应用自动打一个 undo 点。' +
      'ops 数组元素：{op:"set_text", index: 文件行号 i, text} 改单行文本；{op:"set_style", index: 文件行号 i, style} 改样式；{op:"replace", find, repl} 全局文本替换。' +
      '文件行号 i 从 aegisub_read 的 lines[].i 取得（不是网格序号 n）。首次使用会自动安装桥脚本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ops: { type: 'array', items: { type: 'object' }, description: '操作数组，至少一项' },
        dumpAfter: { type: 'boolean', description: '应用后再读一次字幕并返回' },
      },
      required: ['ops'],
    },
    output: {
      schema: {},
      render: (_args, value) =>
        TEXT(
          'Aegisub 已应用 ' + value.applied + ' 项；result=' + JSON.stringify(value.result ?? null) +
            (value.dump ? '\n活动行 n=' + (value.dump.active ?? '（无）') + '，共 ' + value.dump.count + ' 条' : ''),
        ),
    },
    async execute(args) {
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('ops 不能为空')
      const paths = await resolvePaths(cfg)
      ensureMacro(paths)
      const cmdPath = join(paths.workDir, 'command.lua')
      writeFileSync(cmdPath, opsToLua(ops), 'utf8')
      try {
        await triggerWithRescue(paths, {})
      } finally {
        try {
          unlinkSync(cmdPath)
        } catch {
          /* 命令文件已不在也无所谓 */
        }
      }
      const result = readJson(join(paths.workDir, 'result.json'))
      if (result && result.parse_fail) throw new Error('Lua 桥解析失败：' + JSON.stringify(result))
      const out = { applied: result?.applied ?? 0, result }
      if (args.dumpAfter) out.dump = decorate(readJson(join(paths.workDir, 'dump.json')))
      return out
    },
  }
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  ctx.effect(() => ctx.tools.register(setupTool(cfg)), 'aegisub-bridge.setup')
  ctx.effect(() => ctx.tools.register(readTool(cfg)), 'aegisub-bridge.read')
  ctx.effect(() => ctx.tools.register(applyTool(cfg)), 'aegisub-bridge.apply')
}

/**
 * dsh-aegisub-bridge —— Aegisub 内存字幕直连（不保存、不关闭 Aegisub 即可读写）
 *
 * 纯 JS 实现，刻意不 import 任何 @deepseek-ai/* 包：
 * 本机 DSH 是 asar 打包桌面版，插件目录解析不到官方包；
 * 工具注册只走 Cordis 上下文服务 ctx.tools.register()，依赖仅 node: 内置模块。
 *
 * 链路：Lua 桥 N:\Aegisub\automation\autoload\whale_bridge.lua（宏 WHALE_BRIDGE）
 *      → trigger.ps1 触发宏 → dump.json / result.json
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const name = 'dsh-aegisub-bridge'
export const inject = ['tools']

const WHALE = 'N:\\Aegisub\\automation\\whale'
const TRIGGER = 'J:\\鲸鱼干活区\\aegisub-bridge\\trigger.ps1'

/** 跑一次 trigger.ps1（可选强制重扫 autoload 目录）。 */
async function runTrigger(rescan) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TRIGGER]
  if (rescan) args.push('-ForceRescan')
  try {
    return await execFileP('powershell', args, { encoding: 'utf8', timeout: 30000, windowsHide: true })
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '')
    throw new Error('Aegisub 桥触发失败：' + (out.trim() || e.message))
  }
}

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
  return JSON.parse(readFileSync(path, 'utf8'))
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

/** aegisub_read —— 读当前 Aegisub 内存里的字幕（含未保存修改）。 */
function readTool() {
  return {
    name: 'aegisub_read',
    description:
      '读取 Aegisub 当前正在编辑的内存字幕（包括尚未保存的修改），不需要保存或关闭 Aegisub。' +
      '返回 count（Dialogue 条数）、sel/active（当前选中/活动行的网格序号 n）、lines[]（每行含 n 网格序号、i 文件行号、start/end 毫秒、style、text）。' +
      '可用 activeOnly 只取选中行，或 from/to 按网格序号 n 取一段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        activeOnly: { type: 'boolean', description: '只返回当前选中/活动行' },
        from: { type: 'integer', description: '起始网格序号 n（含），1-based' },
        to: { type: 'integer', description: '结束网格序号 n（含），1-based' },
        rescan: { type: 'boolean', description: '先重扫 autoload 目录（改了 Lua 桥脚本后使用）' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) =>
        TEXT(
          'Aegisub：' + value.count + ' 条 Dialogue，当前活动行 n=' + (value.active ?? '（无）') +
          (value.sel.length ? '，选中 n=' + value.sel.join(',') : '') +
          '\n' + (value.lines || []).map((l) => 'n' + l.n + ' [i' + l.i + '] ' + l.start + '-' + l.end + ' ' + l.style + ' | ' + l.text).join('\n')
        ),
    },
    async execute(args) {
      await runTrigger(args.rescan === true)
      const full = decorate(readJson(join(WHALE, 'dump.json')))
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
function applyTool() {
  return {
    name: 'aegisub_apply',
    description:
      '直接修改 Aegisub 内存里的字幕并写入（不需要保存/关闭 Aegisub，修改会立即出现在编辑器和网格里），每次应用自动打一个 undo 点。' +
      'ops 数组元素：{op:"set_text", index: 文件行号 i, text} 改单行文本；{op:"set_style", index: 文件行号 i, style} 改样式；{op:"replace", find, repl} 全局文本替换。' +
      '文件行号 i 从 aegisub_read 的 lines[].i 取得（不是网格序号 n）。',
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
        TEXT('Aegisub 已应用 ' + value.applied + ' 项；result=' + JSON.stringify(value.result ?? null) +
          (value.dump ? '\n活动行 n=' + (value.dump.active ?? '（无）') + '，共 ' + value.dump.count + ' 条' : '')),
    },
    async execute(args) {
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('ops 不能为空')
      const cmdPath = join(WHALE, 'command.lua')
      writeFileSync(cmdPath, opsToLua(ops), 'utf8')
      try {
        await runTrigger(false)
      } finally {
        try { unlinkSync(cmdPath) } catch { /* ignore */ }
      }
      const result = readJson(join(WHALE, 'result.json'))
      if (result && result.parse_fail) throw new Error('Lua 桥解析失败：' + JSON.stringify(result))
      const out = { applied: result?.applied ?? 0, result }
      if (args.dumpAfter) out.dump = decorate(readJson(join(WHALE, 'dump.json')))
      return out
    },
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(readTool()), 'aegisub-bridge.read')
  ctx.effect(() => ctx.tools.register(applyTool()), 'aegisub-bridge.apply')
}

/**
 * @dsh-external/dsh-aegisub-bridge — Aegisub 内存字幕直连桥。
 * 读：触发 Aegisub 内的 Lua 宏导出当前内存字幕 → dump.json。
 * 写：写 command.lua → 触发宏应用 → Aegisub 内存立即变化（无需保存）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

export const name = '@dsh-external/dsh-aegisub-bridge'
export const inject = ['tools']

export interface Config {
  triggerScript: string
  whaleDir: string
}

export const Config = z.object({
  triggerScript: z.string().default('J:\\鲸鱼干活区\\aegisub-bridge\\trigger.ps1'),
  whaleDir: z.string().default('N:\\Aegisub\\automation\\whale'),
})

function luaStr(s: string): string {
  let out = '"'
  for (const ch of s) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else out += ch
  }
  return out + '"'
}

function runTrigger(script: string, rescan: boolean): Promise<string> {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
  if (rescan) args.push('-ForceRescan')
  return new Promise((resolve, reject) => {
    execFile('powershell', args, { encoding: 'utf8', timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('Aegisub bridge failed: ' + String(stderr || err.message)))
        return
      }
      resolve(stdout)
    })
  })
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aegisub_read',
    description: 'Read current in-memory Aegisub subtitles without saving (JSON)',
    parameters: {
      rescan: { type: 'boolean', required: false, description: 'force reload automation scripts' },
      onlyActive: { type: 'boolean', required: false, description: 'only the selected line' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { rescan?: boolean; onlyActive?: boolean }) {
      await runTrigger(config.triggerScript, !!args.rescan)
      const raw = readFileSync(config.whaleDir + '\\dump.json', 'utf8')
      if (args.onlyActive) {
        const d = JSON.parse(raw)
        const line = d.lines.find((l: any) => l.i === d.active) ?? null
        return JSON.stringify({ active: d.active, sel: d.sel, line })
      }
      return raw
    },
  })), 'aegisub_read')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aegisub_apply',
    description: 'Modify in-memory Aegisub subtitles without saving; opsJson = [{op:"set_text",index,text}|{op:"replace",find,repl}]',
    parameters: {
      opsJson: { type: 'string', required: true, description: 'JSON array of ops' },
      dumpAfter: { type: 'boolean', required: false, description: 'return full subtitle after apply' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { opsJson: string; dumpAfter?: boolean }) {
      const ops = JSON.parse(args.opsJson)
      if (!Array.isArray(ops) || ops.length === 0) throw new Error('opsJson must be a non-empty JSON array')
      const parts = ops.map((o: any) => {
        if (o.op === 'set_text') return '{op="set_text",index=' + Number(o.index) + ',text=' + luaStr(String(o.text)) + '}'
        if (o.op === 'replace') return '{op="replace",find=' + luaStr(String(o.find)) + ',repl=' + luaStr(String(o.repl ?? '')) + '}'
        throw new Error('unknown op: ' + String(o.op))
      })
      const cmdPath = config.whaleDir + '\\command.lua'
      writeFileSync(cmdPath, '{ops={' + parts.join(',') + '}}', 'utf8')
      try {
        await runTrigger(config.triggerScript, false)
      } finally {
        try { unlinkSync(cmdPath) } catch { /* ignore */ }
      }
      const result = readFileSync(config.whaleDir + '\\result.json', 'utf8')
      if (args.dumpAfter) {
        return JSON.stringify({ result: JSON.parse(result), dump: JSON.parse(readFileSync(config.whaleDir + '\\dump.json', 'utf8')) })
      }
      return result
    },
  })), 'aegisub_apply')
}

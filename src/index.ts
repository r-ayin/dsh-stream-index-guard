/**
 * dsh-stream-index-guard — LLM 流索引守卫（toolkit 形态）。
 *
 * 背景（2026-09-28 起实测）：chat-relay（Anthropic Messages 协议中继 → qwen3.8-max，
 * reasoningEffort=max）偶发吐出 content_block 事件序列异常，经 pi-ai → dsh-llm-pi-ai
 * 映射后产生 index 非法（undefined/-1/NaN）的 text-delta chunk，触发 dsh-llm 的
 * AssistantStreamAccumulator.safeIndex 抛
 *   TypeError: text-delta index must be a non-negative safe integer
 * 该 throw 是消费侧硬错误、绕过 pi-ai「错误走 finish 事件」设计，agent-loop 判本轮失败、
 * 已流出的文本保留 → 表现为「本轮运行失败 + 输出截断」，turn/end 记为 code:UNKNOWN
 * 不被 dsh-llm-retry 归类为可重试 → 不自动重跑。已在多个会话反复发作（5666e396 连续 8 轮等）。
 *
 * 本插件不碰任何编译产物源码：运行时对 AssistantStreamAccumulator.prototype.push 打补丁，
 * 把 index 非法的 delta chunk 钳到「该累加器实例最近一次合法 index」（无则 0），并计数+采样，
 * 把硬失败降级为「坏 chunk 归并/丢弃」。绝对 file URL import 保证补丁的是 host 用的同一
 * ESM 实例（dsh-llm 根 bundle 与 ./assistant-stream 两份都打）。卸载/热重载经 ctx.effect 还原原始 push。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

export const name = 'dsh-stream-index-guard'
export const inject = ['tools']

/** 两份含 AssistantStreamAccumulator 的 dsh-llm 模块（host 经 package exports 解析到根 bundle；types 子路径另一份）。绝对 URL 保证与 host 同一实例。 */
const ENV_TARGETS = (process.env.DSH_STREAM_GUARD_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean)

/** Derive the dsh install root from the host entry script (process.argv[1]); env override wins. Only existing files are kept. */
function discoverTargets(): string[] {
  if (ENV_TARGETS.length) return ENV_TARGETS
  const argv1 = String(process.argv[1] || '')
  const i = argv1.indexOf('node_modules')
  if (i < 0) return []
  const llmLib = argv1.slice(0, i) + 'node_modules/@deepseek-ai/dsh-llm/lib'
  return [llmLib + '/index.js', llmLib + '/types/assistant-stream.js']
    .map(p => pathToFileURL(p).href)
    .filter(href => existsSync(fileURLToPath(href)))
}

const TARGETS = discoverTargets()
const STATS_DIR = '/tmp/dsh-stream-index-guard'
const STATS_PATH = STATS_DIR + '/stats.json'
const GUARD = Symbol.for('dsh-stream-index-guard')
const DELTA_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta'])

function isValidIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0)
}

interface Sample { t: number; target: string; type: string; bad: string; fallback: number }
interface Stats {
  installedAt: string
  patched: string[]
  clamps: number
  selfTest: string
  samples: Sample[]
}

export function apply(ctx: Context): void {
  const stats: Stats = { installedAt: new Date().toISOString(), patched: [], clamps: 0, selfTest: 'pending', samples: [] }
  const restores: (() => void)[] = []

  const persist = () => {
    try { mkdirSync(STATS_DIR, { recursive: true }); writeFileSync(STATS_PATH, JSON.stringify(stats, null, 1)) } catch { /* best-effort */ }
  }

  const install = async () => {
    for (const url of TARGETS) {
      const tag = url.includes('/types/') ? 'types' : 'bundle'
      try {
        const mod = await import(url) as { AssistantStreamAccumulator?: { prototype: { push?: unknown }; new (): Acc } }
        const Cls = mod.AssistantStreamAccumulator as unknown as { prototype: { push: (v: TimedChunk) => unknown }; new (): Acc } | undefined
        if (!Cls || typeof Cls.prototype?.push !== 'function') { stats.patched.push(tag + ' SKIP(no class)'); continue }
        const proto = Cls.prototype as { push: ((v: TimedChunk) => unknown) & { [GUARD]?: boolean } }
        if (proto.push[GUARD]) { stats.patched.push(tag + ' SKIP(already)'); continue }
        const orig = proto.push
        const lastIdx = new WeakMap<object, number>()
        const wrapped = function (this: Acc, value: TimedChunk) {
          const chunk = value?.chunk as { type?: string; index?: unknown } | undefined
          if (chunk && DELTA_TYPES.has(chunk.type as string)) {
            if (isValidIndex(chunk.index)) {
              lastIdx.set(this, chunk.index)
            } else {
              const fallback = lastIdx.get(this) ?? 0
              stats.clamps++
              if (stats.samples.length < 50) stats.samples.push({ t: Date.now(), target: tag, type: chunk.type as string, bad: String(chunk.index), fallback })
              if (stats.clamps <= 5 || stats.clamps % 50 === 0) ctx.logger.warn('[stream-index-guard] clamped ' + chunk.type + ' index=' + String(chunk.index) + ' -> ' + fallback + ' (total ' + stats.clamps + ')')
              persist()
              value = { time: value.time, chunk: { ...(chunk as object), index: fallback } as TimedChunk['chunk'] }
            }
          }
          return (orig as (v: TimedChunk) => unknown).call(this, value)
        } as ((v: TimedChunk) => unknown) & { [GUARD]?: boolean }
        wrapped[GUARD] = true
        proto.push = wrapped
        restores.push(() => { if (proto.push === wrapped) proto.push = orig })
        stats.patched.push(tag + ' OK')
        // 自检：坏 index 不再 throw，且能产出记录
        try {
          const acc = new Cls()
          const t = Date.now()
          const before = stats.clamps
          const samplesBefore = stats.samples.length
          acc.push({ time: t, chunk: { type: 'block-start', index: 0, blockType: 'text' } as never })
          acc.push({ time: t + 1, chunk: { type: 'text-delta', index: 0, text: 'ok' } as never })
          acc.push({ time: t + 2, chunk: { type: 'text-delta', index: undefined, text: 'bad' } as never })
          const recs = (acc as unknown as { snapshot(): unknown[] }).snapshot()
          // 自检触发的 clamp 不计入生产统计
          stats.clamps = before
          stats.samples.length = samplesBefore
          stats.selfTest = Array.isArray(recs) && recs.length >= 1 ? 'pass' : 'pass(empty)'
        } catch (e) { stats.selfTest = 'FAIL ' + String(e) }
      } catch (e) { stats.patched.push(tag + ' ERR ' + String(e)) }
    }
    persist()
    ctx.logger.info('[stream-index-guard] install done: ' + JSON.stringify(stats.patched) + ' selfTest=' + stats.selfTest)
  }

  ctx.effect(() => {
    void install()
    return () => { while (restores.length) restores.pop()!(); persist() }
  }, 'dsh-stream-index-guard: patch push')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'stream_index_guard_stats',
    description: '流索引守卫统计：补丁目标、钳制坏 index 的 chunk 数与采样、自检结果。也可读 /tmp/dsh-stream-index-guard/stats.json',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] },
    async execute() { persist(); return JSON.stringify(stats, null, 1) },
  })), 'dsh-stream-index-guard: stats tool')
}

interface TimedChunk { time: number; chunk: unknown }
interface Acc { push(v: TimedChunk): unknown }

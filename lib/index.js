import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
export const name = 'dsh-stream-index-guard';
export const inject = ['tools'];
/** 两份含 AssistantStreamAccumulator 的 dsh-llm 模块（host 经 package exports 解析到根 bundle；types 子路径另一份）。绝对 URL 保证与 host 同一实例。 */
const ENV_TARGETS = (process.env.DSH_STREAM_GUARD_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean)

/** Derive the dsh install root from the host entry script (process.argv[1]); env override wins. Only existing files are kept. */
function discoverTargets() {
  if (ENV_TARGETS.length) return ENV_TARGETS
  const argv1 = String(process.argv[1] || '')
  const i = argv1.indexOf('node_modules')
  if (i < 0) return []
  const llmLib = argv1.slice(0, i) + 'node_modules/@deepseek-ai/dsh-llm/lib'
  return [llmLib + '/index.js', llmLib + '/types/assistant-stream.js']
    .map(p => pathToFileURL(p).href)
    .filter(href => existsSync(fileURLToPath(href)))
}

const TARGETS = discoverTargets();
const STATS_DIR = '/tmp/dsh-stream-index-guard';
const STATS_PATH = STATS_DIR + '/stats.json';
const GUARD = Symbol.for('dsh-stream-index-guard');
const DELTA_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta']);
function isValidIndex(v) {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
}
export function apply(ctx) {
    const stats = { installedAt: new Date().toISOString(), patched: [], clamps: 0, selfTest: 'pending', samples: [] };
    const restores = [];
    const persist = () => {
        try {
            mkdirSync(STATS_DIR, { recursive: true });
            writeFileSync(STATS_PATH, JSON.stringify(stats, null, 1));
        }
        catch { /* best-effort */ }
    };
    const install = async () => {
        for (const url of TARGETS) {
            const tag = url.includes('/types/') ? 'types' : 'bundle';
            try {
                const mod = await import(url);
                const Cls = mod.AssistantStreamAccumulator;
                if (!Cls || typeof Cls.prototype?.push !== 'function') {
                    stats.patched.push(tag + ' SKIP(no class)');
                    continue;
                }
                const proto = Cls.prototype;
                if (proto.push[GUARD]) {
                    stats.patched.push(tag + ' SKIP(already)');
                    continue;
                }
                const orig = proto.push;
                const lastIdx = new WeakMap();
                const wrapped = function (value) {
                    const chunk = value?.chunk;
                    if (chunk && DELTA_TYPES.has(chunk.type)) {
                        if (isValidIndex(chunk.index)) {
                            lastIdx.set(this, chunk.index);
                        }
                        else {
                            const fallback = lastIdx.get(this) ?? 0;
                            stats.clamps++;
                            if (stats.samples.length < 50)
                                stats.samples.push({ t: Date.now(), target: tag, type: chunk.type, bad: String(chunk.index), fallback });
                            if (stats.clamps <= 5 || stats.clamps % 50 === 0)
                                ctx.logger.warn('[stream-index-guard] clamped ' + chunk.type + ' index=' + String(chunk.index) + ' -> ' + fallback + ' (total ' + stats.clamps + ')');
                            persist();
                            value = { time: value.time, chunk: { ...chunk, index: fallback } };
                        }
                    }
                    return orig.call(this, value);
                };
                wrapped[GUARD] = true;
                proto.push = wrapped;
                restores.push(() => { if (proto.push === wrapped)
                    proto.push = orig; });
                stats.patched.push(tag + ' OK');
                // 自检：坏 index 不再 throw，且能产出记录
                try {
                    const acc = new Cls();
                    const t = Date.now();
                    const before = stats.clamps;
                    const samplesBefore = stats.samples.length;
                    acc.push({ time: t, chunk: { type: 'block-start', index: 0, blockType: 'text' } });
                    acc.push({ time: t + 1, chunk: { type: 'text-delta', index: 0, text: 'ok' } });
                    acc.push({ time: t + 2, chunk: { type: 'text-delta', index: undefined, text: 'bad' } });
                    const recs = acc.snapshot();
                    // 自检触发的 clamp 不计入生产统计
                    stats.clamps = before;
                    stats.samples.length = samplesBefore;
                    stats.selfTest = Array.isArray(recs) && recs.length >= 1 ? 'pass' : 'pass(empty)';
                }
                catch (e) {
                    stats.selfTest = 'FAIL ' + String(e);
                }
            }
            catch (e) {
                stats.patched.push(tag + ' ERR ' + String(e));
            }
        }
        persist();
        ctx.logger.info('[stream-index-guard] install done: ' + JSON.stringify(stats.patched) + ' selfTest=' + stats.selfTest);
    };
    ctx.effect(() => {
        void install();
        return () => { while (restores.length)
            restores.pop()(); persist(); };
    }, 'dsh-stream-index-guard: patch push');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'stream_index_guard_stats',
        description: '流索引守卫统计：补丁目标、钳制坏 index 的 chunk 数与采样、自检结果。也可读 /tmp/dsh-stream-index-guard/stats.json',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute() { persist(); return JSON.stringify(stats, null, 1); },
    })), 'dsh-stream-index-guard: stats tool');
}
//# sourceMappingURL=index.js.map
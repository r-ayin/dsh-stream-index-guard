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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-stream-index-guard";
export declare const inject: string[];
export declare function apply(ctx: Context): void;

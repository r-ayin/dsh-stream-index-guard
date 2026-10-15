# dsh-stream-index-guard

Runtime guard for the DSH LLM assistant stream.

Some upstream LLM relays occasionally emit `text-delta` / `reasoning-delta` / `tool-call-delta` chunks with an invalid `index`. Left alone, one bad chunk hard-fails the whole turn (stuck session, truncated output).

This plugin patches `AssistantStreamAccumulator.push` at runtime and clamps an illegal index to the last valid index (or 0), downgrading the hard failure into dropping/merging the bad chunk. It ships a stats tool and on-disk state.

## How it works

- On apply it discovers the host's `@deepseek-ai/dsh-llm` module files (derived from the host entry script path, so it patches the exact loaded instances), and is idempotent via `Symbol.for('dsh-stream-index-guard')`.
- Override discovery with `DSH_STREAM_GUARD_TARGETS` — comma-separated `file://` URLs of the dsh-llm modules to patch.
- Registers the `stream_index_guard_stats` tool (patch targets, clamped-chunk count, samples).
- Writes stats to `/tmp/dsh-stream-index-guard/stats.json`.

## Build

```sh
bash scripts/build.sh   # or: npm run build (tsc)
```

## Install

Install it from the **DSH Plugin Market** (Settings → Plugin Market), or add it to your profile bundle stack manually — see `cordis.patch.yml`.

## License

MIT

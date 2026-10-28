# pi-subagent-mode

Per-model sync/async control for [pi-subagents](https://www.npmjs.com/package/pi-subagents).

Decides, per call and per active model, whether `subagent` tool calls run in the foreground (the main model pauses until all children finish) or in the background. The decision is based on where the model's endpoint lives: endpoints on this machine or on your private network pause by default; public endpoints go to the background. Your own provider/model rules always beat detection, and everything can be changed live with `/subagent-mode` — no reload needed.

It also ships `bin/model-gate.mjs`, a tiny zero-dependency reverse proxy for servers that can only run one model at a time (for example Unsloth), so subagents requesting different models are released in groups instead of colliding.

## Install

```bash
pi install npm:@rShyvers/pi-subagent-mode
```

Then run `/subagent-mode` inside Pi for status and all settings.

MIT

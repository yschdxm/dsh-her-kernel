---
name: dsh-bridge-plugin
description: Write or debug a DeepSeek Harness channel bridge plugin that connects a chat protocol (OneBot/SnowLuma/NapCat/WeChat/etc.) to dsh-her-kernel. Use when the user wants to add a new channel, fix ingest/outbound/read-receipt, mount tools per character, or design a bridge package. Triggers: 桥接插件, bridge plugin, OneBot bridge, registerChannel, kernel.ingest, QQ bridge, 渠道插件.
---

# dsh-bridge-plugin

Write a **channel bridge** for DeepSeek Harness that talks to **dsh-her-kernel**.  
Do not put persona/memory/heart logic in the bridge.

## Read first

- Full guide: `docs/bridge-plugin.md` in this package (relative to the kernel repo root).  
- Reference implementation: sibling repo `dsh-her-qq-bridge-sl` (`lib/index.js`, `lib/onebot.js`, `lib/classifier.js`).  
- Layer docs: `docs/04-notify.html`, `docs/05-session.html`, `docs/07-bridge.html`.

## Hard rules

1. **Messages never enter the agent session from the bridge.** Only `kernel.ingest(msg)` → message store + notify.  
2. **Outbound** goes through `kernel.onOutbound` / kernel `sendOutbound` so the kernel can mark read and route to the right character.  
3. **Tool results must be lossless JSON** (no `undefined`, no BigInt, no raw protocol blobs unless stringified cleanly).  
4. **Do not** edit the kernel’s `cordis.patch.yml` from a bridge. Do not commit tokens.  
5. Character must claim `type` in `character.json.channels` to receive messages.

## Minimal skeleton

```js
export const name = 'dsh-my-bridge'
export const inject = ['herKernel']

export function apply(ctx) {
  const kernel = ctx.get?.('herKernel') || ctx.herKernel
  if (!kernel?.registerChannel) return

  kernel.registerChannel({
    type: 'my-im',
    notify: { dmPriority: true, injectEnabled: true, injectCooldownMinutes: 0, injectDailyCap: 0, injectRespectQuiet: false, format: '工具：{source} 有 {count} 条消息' },
    app: { pageSize: 10 },
    notes: '用 App 工具收发；正文不会自动送达。',
  })

  // inbound
  onProtocolMessage(async (m) => {
    await kernel.ingest({
      channel: 'my-im',
      target: String(m.from),
      sender: m.nick || m.from,
      content: m.text || '[图片]',
      time: m.ts || Date.now(),
      msg_id: String(m.id),
    })
  })

  kernel.onOutbound('my-im', async ({ target, text }) => {
    // classify → send
    return { ok: await send(target, text) }
  })
}
```

## Ingest payload

Required: `channel`, `target`, `content` (non-empty), `msg_id`.  
Recommended: `sender`, `sender_id`, `time`, `seq` (real sequence only), `media` (`images` / `faces` / `quote`).

Empty content is dropped. Use `[图片]` placeholders for media-only.

## After implement

1. `node --check` on changed files.  
2. Link package into Harness; restart host (not `systemctl stop` on shared hosts unless you know the blast radius).  
3. Character `channels` includes your `type`.  
4. Send a test message: log `/tmp/kernel-agent.log` for ingest; confirm `messages.db` row and panel unread.  
5. Reply via `app_send`: outbound handler runs; local unread clears; call protocol read-receipt if the client has one.  
6. Update user-facing docs if behavior changed.

## Classifier pattern (outbound only)

Keyword hard-block + optional LLM judge; return `{ ok:false, blocked:true, reason }` from outbound so the kernel can bounce a structured notice to the agent. Never block inbound.

## Package.json

```json
{
  "name": "dsh-my-bridge",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Install in Harness: `"dsh-my-bridge": "link:/path/to/dsh-my-bridge"`.

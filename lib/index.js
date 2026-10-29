// dsh-her-kernel · 统一内核主入口（多工作区角色）
//
// ⭐ 每个工作区一个角色：`<ws>/.dsh-her/character.json` 即角色。
//    角色的注入与工具只经 agent.ctx 挂到她自己的会话（dsh-scope：其他工作区的会话看不到）；
//    消息库/记忆/状态各自 storeDir，互不相通。
//    渠道消息只入库+通知，**不注入会话**；她用 App 工具（app_enter/app_fetch/app_send）
//    主动看、主动回。桥接只做协议适配+安全分类器，经 kernel-api 接入（按渠道路由到角色）。
//
// 借鉴开源项目并遵守各自协议：
//   - dsh-feiyu-mood (MIT, Yuuyuko-uu)：情绪判定/衰减/注入思路、mountFor 按会话挂载先例
//   - dsh-qq-companion (BSD-3-Clause, Geng-zy)：桥接/工具设计思路
//   - dsh-bilibili-plugin (MIT, jiuling)：渠道工具接入思路
//   - companion-awakening (MIT, Pan1127)：主动层状态驱动/双阈值
//   - proactive-nudge (MIT, Shitsuten)：主动制造对话机会/走正常链路

import { appendFileSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { loadConfig, saveConfig, channelConfig } from './config.js'
import { loadCharacter, saveCharacter, charDirOf, sessionIdForWs } from './characters.js'
import { createPersona } from './persona.js'
import { createState } from './state.js'
import { createMemory } from './memory.js'
import { createContext } from './context.js'
import { createMsgStore } from './msgstore.js'
import { createNotifier } from './notify.js'
import { createAppRouter } from './app-router.js'
import { createKernelApi } from './kernel-api.js'
import { createAgentSession } from './agent-session.js'
import { createEval } from './wake.js'
import { mediaConfig, loadRowsImages, buildSendSegments } from './media.js'

export const name = 'dsh-her-kernel'
export const inject = ['tools', 'systemPrompt', 'webServer', 'agents', 'llm', 'timer', 'workspaceRegistry', 'attachments', 'tokenMeter']

// 硬日志（与 agent-session 同惯例）：/tmp/kernel-agent.log
const logLine = (s) => { try { appendFileSync('/tmp/kernel-agent.log', new Date().toISOString() + ' ' + s + '\n') } catch (e) { /* ignore */ } }

// AI 描述：记住上次成功的 provider（下次优先，省掉失败尝试的几十秒）
let describeLastProvider = null

export function apply(ctx) {
  try {
  // 全局配置：只有数值参数 + 渠道规则（人设/状态/记忆/消息都在各角色的 .dsh-her/ 里）
  const config = loadConfig()
  const diag = (msg) => { try { ctx.logger?.info?.(`[her-kernel] ${msg}`) } catch (e) { /* ignore */ } }
  // 事件驱动评估器（无插件定时器）：ingest / turn-end / event 时冲刷
  const evalr = createEval({ config, diag })

  // ---- 角色运行时注册表：wsPath -> runtime ----
  const runtimes = new Map()
  const listChars = () => [...runtimes.values()]

  // 渠道路由：严格按角色认领（character.json.channels）。
  // 没有角色认领 = 该渠道消息不进任何角色（工作区隔离优先，不搞兜底串号）。
  function resolveChar(channel) {
    const claim = listChars().filter((rt) => (rt.char.channels || []).includes(channel))
    if (claim.length > 1) diag('警告：多角色认领渠道 ' + channel + '，取第一个 ' + claim[0].name)
    return claim.length ? claim[0] : null
  }
  // 按工作区取运行时；缺省给唯一角色（旧设置页在单角色期零改动可用）
  function rtOf(ws) {
    return (ws && runtimes.get(ws)) || (runtimes.size === 1 ? [...runtimes.values()][0] : null)
  }

  const api = createKernelApi({ config, resolveChar, listChars, diag })

  // 角色作用域配置：数值读全局（活对象，热改即时生效）；persona 读该角色的 character.json
  function charScopedConfig(char) {
    return new Proxy(config, {
      get(t, k, r) { return k === 'persona' ? char.persona : Reflect.get(t, k, r) },
    })
  }

  // ---- 按角色挂载的注入定义表（挂载发生在 agent-session.mountFor，仅她的会话）----
  function buildPromptContexts(rt) {
    const { persona, state, notifier } = rt
    return [
      { name: 'her-persona', order: 800, text: () => persona.personaText() },
      // 状态与行为（合并原 情绪/生活/主动 三段注入）
      {
        name: 'her-state', order: 840,
        text: () => {
          const parts = []
          try { parts.push(state.heartLine()) } catch (e) { /* ignore */ }
          try { parts.push(state.contextText()) } catch (e) { /* ignore */ }
          return parts.filter(Boolean).join('\n')
        },
      },
      {
        name: 'her-notify', order: 850,
        text: () => {
          const notifs = notifier.allNotifications()
          if (!notifs.length) return ''
          return '（系统通知，不是谁在说话）\n' + notifs.map((n) => n.text).join('\n')
            + '\n（消息用 App 工具看和回；会话正文不会自动发到渠道。发完可以收束，不必复述发送结果。）'
        },
      },
      // 各 App 使用注意：桥接 registerChannel 的 notes（渠道是全局数据，规则全局读）
      {
        name: 'her-channel-notes', order: 870,
        text: () => {
          const rows = Object.entries(config.channels || {})
            .filter(([, c]) => c && typeof c.notes === 'string' && c.notes.trim())
            .map(([type, c]) => `- ${type}：${c.notes.trim()}`)
          if (!rows.length) return ''
          return '（各 App 使用注意，来自桥接配置，不是谁在说话）\n' + rows.join('\n')
        },
      },
    ]
  }

  // ---- 按角色的工具定义（execute 闭包绑定该角色的层实例）----
  const textOut = (v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]
  const outObj = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textOut(v) }
  // 含图像块的工具结果：正文 JSON + 已 admit 的图像引用
  // ⚠️ 模型层读 block.attachment.attachmentId，必须先经 ctx.attachments.admitPromptContent
  const mediaOut = {
    schema: { type: 'object', additionalProperties: true },
    render: (_a, v) => {
      const { _imageBlocks, ...rest } = v || {}
      const blocks = textOut(rest)
      for (const img of (_imageBlocks || [])) {
        if (img && img.type === 'image' && img.attachment) blocks.push(img)
      }
      return blocks
    },
  }
  // 下载图片 → 附件服务 admit → 返回可进工具结果的图像块
  async function admitImageBlocks(images) {
    if (!images || !images.length) return []
    try {
      const parts = images.map((img) => ({
        type: 'image',
        data: img.b64,
        mediaType: img.mediaType,
        name: img.name || undefined,
      }))
      const admitted = await ctx.attachments.admitPromptContent(parts)
      return (admitted || []).filter((p) => p && p.type === 'image' && p.attachment)
    } catch (e) {
      logLine('图片 admit 失败：' + (e && e.message))
      diag('图片 admit 失败：' + (e && e.message))
      return []
    }
  }
  const APP_TYPES = ['qq-group', 'qq-private', 'web', 'bili']

  function toolsFor(rt) {
    const { appRouter, msgStore, state, notifier, memory, config, persona } = rt
    return [
    { name: 'app_list', description: '枚举可进入的渠道会话及未读计数。返回项含 type、id、unread。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ ok: true, current: appRouter.now(), apps: msgStore.unreadSummary().map((r) => ({ type: r.channel, id: r.target, unread: r.n })) }) },
    { name: 'app_enter', description: '进入指定渠道会话。进入后方可使用该会话的读取与发送工具；参数 app_type 为渠道类型，app_id 为目标标识。', parameters: { type: 'object', properties: { app_type: { type: 'string', enum: APP_TYPES }, app_id: { type: 'string' } }, required: ['app_type', 'app_id'], additionalProperties: false }, execute: async (a) => appRouter.enter(a.app_type, String(a.app_id)) },
    { name: 'app_exit', description: '退出当前渠道会话。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => appRouter.exit() },
    {
      name: 'app_fetch',
      description: '读取当前会话消息并标记已读。未读消息排在最前（正序），其后是最近历史。返回列表；含图片时以图像块直读进上下文。需先 app_enter。',
      parameters: { type: 'object', properties: { page: { type: 'number' } }, additionalProperties: false },
      output: mediaOut,
      execute: async (a) => {
        const cur = appRouter.now()
        const result = appRouter.fetch({ page: Number(a.page) || 0 })
        if (!result || result.ok === false) return result || { ok: false, error: '读取失败' }
        // 本地已读 → 通知桥接清 QQ 侧角标（带 msg_id，便于 mark_*_as_read）
        try {
          if (cur && api.notifyMessagesRead) {
            const ids = (result._readIds || result._rows || []).map((r) => r.msg_id || r).filter(Boolean)
            api.notifyMessagesRead(cur.type, cur.target, ids)
          }
        } catch (e) { /* ignore */ }
        const cfg = mediaConfig(config)
        const images = await loadRowsImages(result._rows || [], cfg)
        const { _rows, _readIds, ...pub } = result
        const blocks = await admitImageBlocks(images)
        pub.imageCount = blocks.length
        pub._imageBlocks = blocks
        return pub
      },
    },
    {
      name: 'app_query',
      description: '在当前会话内按发送者、时间范围、关键词检索消息。含图片时同样直读图像块。需先 app_enter。',
      parameters: { type: 'object', properties: { sender: { type: 'string' }, from_time: { type: 'string' }, to_time: { type: 'string' }, keyword: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      output: mediaOut,
      execute: async (a) => {
        const result = appRouter.query({ sender: a.sender, fromTime: parseTime(a.from_time), toTime: parseTime(a.to_time), keyword: a.keyword, limit: a.limit ? Number(a.limit) : undefined })
        if (!result || result.ok === false) return result || { ok: false, error: '检索失败' }
        const cfg = mediaConfig(config)
        const images = await loadRowsImages(result._rows || [], cfg)
        const { _rows, ...pub } = result
        const blocks = await admitImageBlocks(images)
        pub.imageCount = blocks.length
        pub._imageBlocks = blocks
        return pub
      },
    },
    { name: 'app_unread', description: '读取当前会话未读计数。需先 app_enter。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => appRouter.unread() },
    {
      name: 'app_send',
      description: '向当前渠道会话发送内容。本工具是向渠道对端送达的唯一途径；仅生成于模型回复正文中的文本不会送达至渠道。参数：text 为正文；image 为图片（http(s) URL、base64:// 或 data:image/…）；sticker 为黄脸 face id（纯数字），或 mface 表情包 JSON（先用 qq_media_list kind=custom_face 查）。text 与 image/sticker 至少一项非空。发送前经过出站安全审核。需先 app_enter。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '消息正文（可与 image/sticker 组合）' },
          image: { type: 'string', description: '图片：http(s) URL，或 base64://…，或 data:image/…' },
          sticker: { type: 'string', description: '黄脸 face id（纯数字），或 mface JSON：{"type":"mface","data":{"emoji_id":"...","emoji_package_id":"...","key":"..."}}' },
        },
        additionalProperties: false,
      },
      execute: async (a) => {
        const cur = appRouter.now()
        if (!cur) return { ok: false, error: '尚未进入任何 App，请先调用 app_enter' }
        const cfg = mediaConfig(config)
        const built = buildSendSegments({ text: a.text, image: a.image, sticker: a.sticker }, cfg)
        if (!built.ok) return { ok: false, error: built.error }
        const plain = String(a.text || '').trim()
        const r = await api.sendOutbound(cur.type, cur.target, plain ? { text: plain, segments: built.segments } : { segments: built.segments })
        const sent = !!(r && (r.ok || r.status === 'ok' || r.retcode === 0))
        if (sent) {
          try {
            const rid = 'reply-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
            const media = {}
            if (a.image) media.images = [{ url: String(a.image).startsWith('http') ? String(a.image) : '', file: String(a.image).slice(0, 200) }]
            if (a.sticker) {
              const st = String(a.sticker).trim()
              if (/^\d+$/.test(st)) media.faces = [{ id: st }]
              else {
                try {
                  const obj = st.startsWith('mface:') ? JSON.parse(st.slice(6)) : JSON.parse(st)
                  if (obj && obj.data) media.marketfaces = [obj.data]
                  else if (obj) media.marketfaces = [obj]
                } catch (e) { media.faces = [{ id: st.slice(0, 40) }] }
              }
            }
            msgStore.add({
              channel: cur.type, target: cur.target,
              sender: persona.brief().name || '她',
              content: plain || (a.sticker ? '[表情]' : '[图片]'),
              time: Date.now(), msg_id: rid,
              media: Object.keys(media).length ? media : undefined,
            })
            // 回复成功 = 已看过该会话：清掉对方未读，消除角标
            msgStore.markRead(cur.type, cur.target)
            try { if (api.notifyMessagesRead) api.notifyMessagesRead(cur.type, cur.target) } catch (e) { /* ignore */ }
          } catch (e) { /* ignore */ }
          if (cur.type === 'qq-group' || cur.type === 'qq-private') state.bump('replied', 2)
        }
        return sent
          ? { ok: true, sent: true, app: cur.type + '/' + cur.target }
          : { ok: false, error: (r && (r.reason || r.error)) || '发送失败', detail: r }
      },
    },
    {
      name: 'qq_media_list',
      description: '枚举可用于发送的 QQ 资源：kind=sticker 黄脸 face id；kind=custom_face 自定义表情包（mface，可 keyword 按名过滤）；kind=recent_image 最近收到的图片。sticker 参数可传 face id 或 mface JSON。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['sticker', 'custom_face', 'recent_image'] },
          limit: { type: 'number' },
          keyword: { type: 'string', description: '可选：按表情名称过滤，如 笑哭 / 猫' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      execute: async (a) => {
        const kind = String(a.kind || 'sticker')
        const limit = Math.min(50, Math.max(1, Number(a.limit) || 20))
        const kw = String(a.keyword || '').trim()
        if (kind === 'sticker') {
          // 常用 QQ 系统表情（去掉 92：SnowLuma 报 sysemojis cfg not found）
          let faces = [
            ['1', '微笑'], ['14', '偷笑'], ['5', '呲牙'], ['106', '打脸'], ['13', '酷'],
            ['16', '可怜'], ['18', '抓狂'], ['23', '流泪'], ['25', '惊讶'], ['29', '得意'],
            ['35', '委屈'], ['54', '拜托'], ['64', '可怜'], ['78', '机智'],
            ['109', '笑哭'], ['111', '思考'], ['166', '并不简单'], ['178', '让我看看'], ['292', '舔屏'],
          ].map(([id, name]) => ({ id, name }))
          if (kw) faces = faces.filter((f) => f.name.includes(kw) || f.id === kw)
          return { ok: true, kind, count: faces.length, items: faces.slice(0, limit), note: '部分黄脸 id 服务端可能不支持；表情包请用 kind=custom_face' }
        }
        if (kind === 'custom_face') {
          return {
            ok: false,
            error: '表情包请用工具 qq_custom_faces（或 qq_sl_api action=extended/fetch_custom_face）。拿到 data 后写入 app_send sticker 的 JSON。',
            hint: { tool: 'qq_custom_faces', keyword: kw || undefined },
          }
        }
        // 最近带图消息（按 media JSON 扫描）
        let items = []
        try {
          const rs = rt.msgStore.db.prepare(
            `SELECT msg_id, channel, target, sender, time, media FROM messages WHERE media IS NOT NULL AND media LIKE '%images%' ORDER BY time DESC LIMIT ?`
          ).all(limit)
          items = rs.map((r) => {
            let m = null
            try { m = JSON.parse(r.media) } catch (e) { m = null }
            const imgs = (m && m.images) || []
            return imgs.map((im) => ({ msgId: r.msg_id, channel: r.channel, target: r.target, sender: r.sender, time: r.time, url: im.url || '', file: im.file || '' }))
          }).flat().filter((x) => x.url || x.file).slice(0, limit)
        } catch (e) { items = [] }
        return { ok: true, kind, count: items.length, items }
      },
    },

    { name: 'her_notifications', description: '读取当前通知列表（来源与未读计数）。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ ok: true, notifications: notifier.allNotifications() }) },
    { name: 'her_mark_read', description: '将指定来源的通知与未读标记为已读。参数 channel、target。', parameters: { type: 'object', properties: { channel: { type: 'string' }, target: { type: 'string' } }, required: ['channel', 'target'], additionalProperties: false }, execute: async (a) => { notifier.markOpened(a.channel, String(a.target)); return { ok: true } } },

    { name: 'her_persona', description: '读取当前人设摘要（名称、主人、外形、自述）。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ ok: true, persona: persona.brief() }) },

    { name: 'state_now', description: '读取当前心绪（底色与十维）、日子（需求与今日活动）及开口阈值状态。若需定时自查，可使用日程类工具创建由本人设定的提醒。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { const adv = state.advance(); const H = state.getState({ persist: false }); const w = state.shouldSpeak(config.heart); return { ok: true, heart: { base: Math.round(H.base), label: state.moodLabel(H.base), emoji: state.moodEmoji(H.base), dims: Object.fromEntries(state.HEART_DIMS.map(([k, l]) => [l, Math.round(H.dims[k])])), lastReason: H.lastReason, strength: Math.round(w.strength), wantThink: w.wantThink, wantSpeak: w.wantSpeak, silenceMinutes: Number.isFinite(w.silence) ? Math.round(w.silence) : null, lastSpokeAt: H.lastSpokeAt, daily: H.daily }, life: { activity: adv.activity, needs: adv.needs, today: adv.timeline.filter((x) => x.at >= new Date().setHours(0, 0, 0, 0)).slice(-8) } } } },
    { name: 'state_note', description: '记录心绪变化：底色增量（moodDelta）与/或维度增量，与/或事件类型（mindKind），与/或主动开口记录（spoke）。', parameters: { type: 'object', properties: { moodDelta: { type: 'number', description: '底色变化 -10~10' }, reason: { type: 'string' }, confidence: { type: 'number' }, miss: { type: 'number' }, joy: { type: 'number' }, calm: { type: 'number' }, sweet: { type: 'number' }, sad: { type: 'number' }, worry: { type: 'number' }, heartache: { type: 'number' }, jealous: { type: 'number' }, tired: { type: 'number' }, curious: { type: 'number' }, mindKind: { type: 'string', enum: ['userMsg', 'replied', 'praised', 'ignored', 'busy', 'goodEvent', 'badEvent'] }, mindAmount: { type: 'number' }, spoke: { type: 'string', description: '主动开口后写入时间线的内容' } }, additionalProperties: false }, execute: async (a) => { const out = { ok: true }; if (Number.isFinite(Number(a.moodDelta)) || a.reason) { const m = state.applyDelta({ moodDelta: Number(a.moodDelta) || 0, dims: { miss: a.miss, joy: a.joy, calm: a.calm, sweet: a.sweet, sad: a.sad, worry: a.worry, heartache: a.heartache, jealous: a.jealous, tired: a.tired, curious: a.curious }, reason: a.reason, confidence: a.confidence }); state.hookEvent({ type: 'mood', moodDelta: Number(a.moodDelta) || 0 }); out.base = Math.round(m.base) } if (a.mindKind) { state.bump(a.mindKind, Number(a.mindAmount) || 4); out.dims = Object.fromEntries(state.HEART_DIMS.map(([k, l]) => [l, Math.round(state.load().heart.dims[k])])) } if (a.spoke) { state.recordSaid(String(a.spoke)); out.spokeRecorded = true } return out } },

    { name: 'life_schedule', description: '读取本人作息表（工作日/周末/特别日期）。', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ ok: true, ...state.loadSchedule() }) },
    { name: 'life_schedule_set', description: '写入本人作息表。块结构 {from:"HH:MM", to:"HH:MM", kind, label?}；可分别提交 weekday、weekend、special、note。', parameters: { type: 'object', properties: { weekday: { type: 'array', items: { type: 'object' } }, weekend: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, additionalProperties: false }, execute: async (a) => state.setSchedule(a) },

    { name: 'memory_remember', description: '写入长期记忆（事实/教训/话题等）。参数：level、content、keywords、importance(1–10)、hide_context(可选，是否把本回合原文移出上下文)。成功返回入库 importance 与 created_at。', parameters: { type: 'object', properties: { level: { type: 'string', enum: ['fact', 'lesson', 'topic', 'project', 'rules'] }, content: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, importance: { type: 'number' }, hide_context: { type: 'boolean' } }, required: ['content'], additionalProperties: false }, execute: async (a) => {
      const r = memory.remember({ level: a.level || 'fact', content: a.content, keywords: a.keywords, importance: a.importance })
      if (!r.ok) return r
      state.hookEvent({ type: 'memory' })
      const mem = config.memory || {}
      const hide = a.hide_context != null
        ? !!a.hide_context
        : (mem.rememberHideContext !== false && mem.moveOutContext !== false)
      if (hide && rt.agentSession && typeof rt.agentSession.hideLastTurnContext === 'function') {
        try {
          const h = rt.agentSession.hideLastTurnContext({ reason: '主动入记忆' })
          if (h && h.hiddenN) r.hiddenN = h.hiddenN
        } catch (e) { diag('remember 后 hide 失败：' + (e && e.message)) }
      }
      return r
    } },
    { name: 'memory_search', description: '检索长期记忆。可按关键词 query，也可只按时间范围翻（from_time/to_time，ISO 或毫秒）。结果含 importance(1–10)、created_at/created_iso、updated_at/updated_iso。', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, from_time: { type: 'string' }, to_time: { type: 'string' } }, additionalProperties: false }, execute: async (a) => ({ ok: true, results: memory.search({ query: a.query, limit: a.limit ? Number(a.limit) : undefined, fromTime: parseTime(a.from_time), toTime: parseTime(a.to_time) }) }) },
    { name: 'memory_hidden', description: '读取已移出上下文的隐藏内容。参数 limit。', parameters: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false }, execute: async (a) => ({ ok: true, hidden: memory.listHidden(a.limit ? Number(a.limit) : 20) }) },

    { name: 'her_config', description: '读取或合并写入内核全局配置。参数 patch 为部分对象；省略 patch 时仅返回当前配置。', parameters: { type: 'object', properties: { patch: { type: 'object' } }, additionalProperties: false }, execute: async (a) => { if (a.patch && typeof a.patch === 'object') { deepMergeInto(config, a.patch); saveConfig(config); return { ok: true, updated: true, config } } return { ok: true, config } } },
    ]
  }

  // 工具挂载件：该角色的工具 + 桥接晚挂工具（按渠道认领过滤）。
  // 工具可自带 output（如含图像块的 app_fetch）；未带则用通用 JSON render。
  // ⚠️ 只经 agent.ctx 注册（mountFor 里调用），绝不 ctx.tools.register 全局注册。
  function buildToolDefs(rt) {
    return [
      ...toolsFor(rt).map((t) => {
        const { output, ...rest } = t
        return { ...rest, output: output || outObj }
      }),
      ...(api && typeof api.scopedToolEntries === 'function'
        ? api.scopedToolEntries()
            .filter((e) => !e.channels || (rt.char.channels || []).some((c) => e.channels.includes(c)))
            .map((e) => e.def)
        : []),
    ]
  }

  // ---- 挂一个角色的完整运行时 ----
  function startCharRuntime(wsPath, char, sessId) {
    if (runtimes.has(wsPath)) return runtimes.get(wsPath)
    if (!char.sessionId) char.sessionId = sessionIdForWs(wsPath) // 每工作区唯一，防撞名
    const storeDir = charDirOf(wsPath)
    const scoped = charScopedConfig(char)
    const persona = createPersona({ config: scoped })
    const state = createState({ storeDir, config: scoped, diag })
    const memory = createMemory({ storeDir, config: scoped, diag })
    const context = createContext({ memory, config: scoped, diag })
    const msgStore = createMsgStore({ storeDir })
    const appRouter = createAppRouter({ msgStore, config: scoped, diag })
    const notifier = createNotifier({ msgStore, appRouter, config: scoped, diag })
    const agentSession = createAgentSession({ ctx, config: scoped, persona, state, memory, msgStore, notifier, appRouter, sessionId: sessId, cwd: wsPath, diag })
    const rt = { wsPath, char, name: char.name, sessionId: sessId, storeDir, config: scoped, persona, state, memory, context, msgStore, notifier, appRouter, agentSession }
    agentSession.setKernelApi(api)
    agentSession.setMountables({ contexts: () => buildPromptContexts(rt), tools: () => buildToolDefs(rt) })
    // 心绪规则：她任何回合结束都评估（含无出站的 kernel 回合）
    agentSession.setWakeHook(() => evalr.request(rt, 'turn-end'))
    rt.evalWake = (cause) => evalr.request(rt, cause)
    // 空闲时补一次评估：输出期间挂起的通知在 idle 时注入
    try {
      ctx.on('agent/status', (p) => {
        try {
          if (!p || p.status !== 'idle') return
          const a = rt.agentSession && rt.agentSession.agent
          if (p.agent !== a) return
          evalr.request(rt, 'idle')
        } catch (e) { /* ignore */ }
      })
    } catch (e) { /* ignore */ }
    agentSession.ensureAgent().then((a) => {
      if (a) attachCharSession(rt)
      // 启动后补一次评估：处理重启前积压的未读（不打断已在输出的回合）
      setTimeout(() => { try { evalr.request(rt, 'boot') } catch (e) { /* ignore */ } }, 2000)
    }).catch((e) => diag(`会话创建失败[${rt.name}]：` + (e && e.message)))
    // 问题4根因防御：会话被归档后，平台 archived-session-gate 会把每个回合在 pre-step
    // 拦成 blocked（唤醒注入照样烧掉、但一个 token 都不跑，静默不回复）。
    // 角色专属会话绝不能停在归档态——挂载时自动解除归档并记日志。
    try {
      const reg = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined) || ctx.workspaceRegistry
      if (reg && Array.isArray(reg.archivedSessionIds) && reg.archivedSessionIds.includes(sessId) && typeof reg.unarchiveSession === 'function') {
        Promise.resolve(reg.unarchiveSession(sessId)).then(() => {
          logLine('角色会话 ' + sessId + ' 处于归档态（唤醒会被平台拦成 blocked），已自动解除归档')
          diag('角色会话 ' + sessId + ' 之前被归档（会导致唤醒无效），已恢复')
        }).catch((e) => logLine('解除归档失败：' + (e && e.message)))
      }
    } catch (e) { /* ignore */ }
    runtimes.set(wsPath, rt)
    diag(`角色已挂载：${rt.name} @ ${wsPath}（会话 ${sessId}，渠道 ${(char.channels || []).join('/') || '无'}）`)
    logLine(`角色已挂载：${rt.name} @ ${wsPath}（会话 ${sessId}）`)
    return rt
  }

  // 供面板热挂载新角色/重启恢复
  function ensureRuntimeFor(wsPath) {
    const char = loadCharacter(wsPath)
    if (!char) return null
    return startCharRuntime(wsPath, char, char.sessionId || 'her-kernel')
  }

  // 启动扫描：workspaceRegistry 里每个有 character.json 的工作区 = 一个角色
  function scanCharacters() {
    let found = 0
    try {
      const reg = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined) || ctx.workspaceRegistry
      const items = reg && typeof reg.list === 'function' ? reg.list() : []
      for (const it of items) {
        const ws = it && it.path
        if (!ws) continue
        const char = loadCharacter(ws)
        if (char) { startCharRuntime(ws, char, char.sessionId || 'her-kernel'); found++ }
      }
    } catch (e) { diag('角色扫描失败：' + (e && e.message)) }
    diag('角色扫描完成：' + found + ' 个')
    logLine('角色扫描完成：' + found + ' 个角色运行中')
  }
  scanCharacters()

  // ── 角色专属会话自愈 tick（单会话红线，2026-10-26）──
  // 一个角色只活在它自己的一个专属会话里：人设/状态/工具/回复只经 agent-session.mountFor
  // 挂专属会话，绝不铺到工作区其它会话（铺开的后果实测过：任何会话都能替她回 QQ，回复从
  // 「别的会话」里冒出来）。本 tick 只做两件自愈，不往任何会话挂东西：
  //   1) 专属会话被归档 → 解除（否则唤醒被平台 archived-session-gate 拦成 blocked，静默不回）
  //   2) 专属会话没归属工作区 → attachSession（否则 UI 里它「跳出工作区」，看不见这条回复）
  const attachState = new Map() // sessionId -> 是否已确认归属（只在状态翻转时记日志）
  const attachErr = new Map()   // sessionId -> 上次错误（同错不重复刷日志）
  function attachCharSession(rt) {
    const sid = rt && rt.sessionId
    if (!sid) return
    try {
      const reg = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined) || ctx.workspaceRegistry
      if (!reg || typeof reg.list !== 'function') return
      const ent = (reg.list() || []).find((e) => e && e.path === rt.wsPath)
      if (!ent || typeof ent.attachSession !== 'function') return
      if (Array.isArray(ent.sessionIds) && ent.sessionIds.includes(sid)) {
        if (!attachState.get(sid)) {
          attachState.set(sid, true)
          attachErr.delete(sid)
          logLine('角色会话已归属工作区：' + sid + ' → ' + rt.wsPath)
          diag('角色会话 ' + sid + ' 在工作区 ' + rt.wsPath + ' 内')
        }
        return
      }
      Promise.resolve(ent.attachSession(sid)).then(() => {
        const nowIn = Array.isArray(ent.sessionIds) && ent.sessionIds.includes(sid)
        if (nowIn && !attachState.get(sid)) {
          logLine('角色会话已归属工作区：' + sid + ' → ' + rt.wsPath)
          diag('角色会话 ' + sid + ' 已挂入工作区 ' + rt.wsPath)
        }
        attachState.set(sid, nowIn)
        if (nowIn) attachErr.delete(sid)
      }).catch((e) => {
        const msg = String((e && e.message) || e)
        if (attachErr.get(sid) !== msg) {
          attachErr.set(sid, msg)
          logLine('attachSession 失败[' + sid + ']：' + msg)
        }
      })
    } catch (e) { /* ignore */ }
  }
  function maintainCharSessions() {
    // ① 归档自愈
    try {
      const reg = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined) || ctx.workspaceRegistry
      if (reg && Array.isArray(reg.archivedSessionIds) && typeof reg.unarchiveSession === 'function') {
        for (const rt of runtimes.values()) {
          if (rt.sessionId && reg.archivedSessionIds.includes(rt.sessionId)) {
            Promise.resolve(reg.unarchiveSession(rt.sessionId)).then(() => logLine('tick 自愈：角色会话 ' + rt.sessionId + ' 归档态已解除')).catch((e) => logLine('tick 自愈解除归档失败：' + (e && e.message)))
          }
        }
      }
    } catch (e) { /* ignore */ }
    // ② 归属自愈（启动时注册表未就绪/首挂失败的兜底）
    for (const rt of runtimes.values()) attachCharSession(rt)
  }
  maintainCharSessions()
  const wsTick = setInterval(maintainCharSessions, 5000)
  ctx.effect(() => () => clearInterval(wsTick), 'her-kernel: char-session tick')

  // 事件驱动评估已在 startCharRuntime 接线（evalr.request）；此处仅记日志
  logLine('心绪规则评估器已就绪（事件驱动，无插件定时器）')
  diag('心绪规则评估器已就绪（事件驱动）')

  // ⭐ 对外提供内核服务：桥接插件 inject: ['herKernel'] 即可拿到 kernel-api（渠道路由在 api 内部）
  try {
    ctx.provide('herKernel', api)
    diag('已 provide herKernel 服务（桥接插件可 inject 使用）')
  } catch (e) { diag('provide herKernel 失败：' + (e && e.message)) }

  // ---- 桥接入口（webServer 路由；?ws= 选角色，缺省唯一角色）----
  try {
    const readBody = (req) => new Promise((resolve) => {
      if (req.body !== undefined) return resolve(req.body || {})
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    const ok = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) }
    const fail = (res, e) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e && e.message) })) }
    const rtFromReq = (req) => { try { const u = new URL(req.url, 'http://x'); return rtOf(u.searchParams.get('ws')) } catch (e) { return rtOf(null) } }
    const needRt = (res, req) => { const rt = rtFromReq(req); if (!rt) { fail(res, new Error('没有角色（character.json）或未指定 ?ws=')); return null } return rt }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/characters',
      handler: async (req, res) => {
        try {
          let items = []
          try {
            const reg = (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined) || ctx.workspaceRegistry
            items = reg && typeof reg.list === 'function' ? reg.list() : []
          } catch (e) { /* ignore */ }
          ok(res, {
            ok: true,
            runtimes: listChars().map((rt) => ({ wsPath: rt.wsPath, name: rt.name, channels: rt.char.channels || [], sessionId: rt.sessionId })),
            workspaces: items.map((it) => ({ wsPath: it.path, title: it.title, workspaceId: it.workspaceId, hasCharacter: !!loadCharacter(it.path) })),
          })
        } catch (e) { fail(res, e) }
      },
    }))

    // 桥接页签（角色面板动态 tab）：由 registerChannel({ ui }) 聚合，内核不认识具体协议
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/channels/tabs',
      handler: async (req, res) => {
        try {
          const tabs = typeof api.listChannelTabs === 'function' ? api.listChannelTabs() : []
          ok(res, { ok: true, tabs })
        } catch (e) { fail(res, e) }
      },
    }))

    // ── 形象图资产：列表 / 上传 / 删除 / AI 描述外形（计划补充·点3）──
    const ASSET_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    const safeAssetName = (n) => {
      const b = basename(String(n || '')) // 防路径逃逸
      const ext = b.includes('.') ? b.slice(b.lastIndexOf('.')).toLowerCase() : ''
      if (!ASSET_TYPES[ext]) return ''
      return b.replace(/[^\w.-]/g, '_').slice(0, 80) || ''
    }
    const dataUrl = (file) => {
      try {
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
        const buf = readFileSync(file)
        if (buf.length > 8 * 1024 * 1024) return null
        return 'data:' + (ASSET_TYPES[ext] || 'application/octet-stream') + ';base64,' + buf.toString('base64')
      } catch (e) { return null }
    }
    // 列出：工作区根目录图片（只读，形象图通常就放这）+ .dsh-her/assets（上传，可删）
    function listAssets(wsPath) {
      const out = []
      try {
        for (const f of readdirSync(wsPath)) {
          if (!safeAssetName(f)) continue
          const src = dataUrl(join(wsPath, f))
          if (src) out.push({ name: f, src, removable: false, from: 'workspace' })
        }
      } catch (e) { /* ignore */ }
      const dir = charDirOf(wsPath) + '/assets'
      try {
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (!safeAssetName(f)) continue
            const src = dataUrl(join(dir, f))
            if (src) out.push({ name: f, src, removable: true, from: 'assets' })
          }
        }
      } catch (e) { /* ignore */ }
      return out.slice(0, 8)
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/assets',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url, 'http://x')
          const ws = u.searchParams.get('ws')
          if (!ws) return fail(res, new Error('缺 ?ws='))
          ok(res, { ok: true, files: listAssets(ws) })
        } catch (e) { fail(res, e) }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/assets/upload',
      handler: async (req, res) => {
        try {
          const b = await readBody(req)
          const ws = String(b.ws || '')
          const imgs = Array.isArray(b.images) ? b.images : []
          if (!ws || !imgs.length) return fail(res, new Error('缺 ws / images'))
          if (imgs.length > 8) return fail(res, new Error('一次最多 8 张'))
          const dir = join(charDirOf(ws), 'assets')
          mkdirSync(dir, { recursive: true })
          const saved = []
          for (const im of imgs) {
            const name = safeAssetName(im && im.name)
            if (!name) return fail(res, new Error('仅支持 png/jpg/webp/gif：' + (im && im.name)))
            const buf = Buffer.from(String((im && im.data) || ''), 'base64')
            if (!buf.length) return fail(res, new Error('空图片数据'))
            if (buf.length > 5 * 1024 * 1024) return fail(res, new Error(name + ' 超过 5MB'))
            writeFileSync(join(dir, name), buf)
            saved.push(name)
          }
          ok(res, { ok: true, saved, files: listAssets(ws) })
        } catch (e) { fail(res, e) }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/assets/remove',
      handler: async (req, res) => {
        try {
          const b = await readBody(req)
          const ws = String(b.ws || ''), name = safeAssetName(b.name)
          if (!ws || !name) return fail(res, new Error('缺 ws / name'))
          const p = join(charDirOf(ws), 'assets', name)
          if (existsSync(p)) unlinkSync(p)
          ok(res, { ok: true, files: listAssets(ws) })
        } catch (e) { fail(res, e) }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/assets/describe',
      handler: async (req, res) => {
        try {
          const b = await readBody(req)
          const ws = String(b.ws || '')
          if (!ws) return fail(res, new Error('缺 ws'))
          const files = listAssets(ws)
          if (!files.length) return fail(res, new Error('还没有可描述的图片：先上传，或把形象图放进工作区目录'))
          // 接入附件服务（canonical base64 → 持久引用）
          const content = [{ type: 'text', text: '以下是同一个角色的设定图。请客观描述角色外形：发型与发色、脸与眼睛、服饰（款式与颜色）、配饰、其他显著特征。用第三人称中文，一段 150 字以内，只输出描述本身，不要开头。' }]
          for (const f of files) {
            const b64 = f.src.slice(f.src.indexOf(',') + 1)
            const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
            content.push({ type: 'image', data: b64, mediaType: ASSET_TYPES[ext], name: f.name })
          }
          const admitted = await ctx.attachments.admitPromptContent(content)
          // provider：listProviders 是异步的（账号 id，如 deepseek-account/deepseek-official）；上次成功的优先
          let ids = []
          try { ids = ((await ctx.llm.listProviders?.()) || []).map((p) => p.id).filter(Boolean) } catch (e) { logLine('describe listProviders 失败：' + e.message) }
          const order = [...new Set([
            ...(describeLastProvider ? [describeLastProvider] : []),
            ...ids.filter((id) => /deepseek-account/i.test(id)),
            ...ids.filter((id) => /deepseek/i.test(id)),
            ...ids.filter((id) => !/deepseek/i.test(id)),
          ])].slice(0, 4)
          // 只用带 image 模态的 deepseek-flash（其他模型 text-only，图片会被投影成占位）
          const model = 'deepseek-flash'
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
          let out = ''
          let lastErr = ''
          outer:
          for (const provider of order) {
            for (let attempt = 1; attempt <= 2; attempt++) {
              let acc = ''
              try {
                for await (const chunk of ctx.llm.stream({
                  provider, model,
                  messages: [{ role: 'user', content: admitted }],
                  maxTokens: 600,
                })) {
                  if (chunk && chunk.type === 'text-delta') acc += chunk.text || ''
                  else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.failure) {
                    lastErr = provider + '：' + JSON.stringify(chunk.reason.failure).slice(0, 180)
                  }
                }
              } catch (e1) { lastErr = provider + '：' + e1.message }
              logLine('describe 尝试 ' + provider + '/' + model + (attempt > 1 ? '（重试）' : '') + ' → ' + (acc.trim() ? '成功 ' + acc.length + ' 字' : '空（' + lastErr.slice(0, 140) + '）'))
              if (acc.trim()) { out = acc.trim(); describeLastProvider = provider; break outer }
              // 空响应（无文本且无错误）或传输/超时类错误：歇 1.5s 再试一次——
              // 2026-10-27：不重试空响应会让「第一次点没反应、第二次才有」；
              // NO_ADAPTER/UNKNOWN_MODEL 等配置类错误不值得重试
              const permanent = /NO_ADAPTER|UNKNOWN_MODEL|INVALID_CREDENTIAL|MODEL_NOT_FOUND|no adapter|unknown model/i.test(lastErr)
              if (attempt === 1 && !permanent) { await sleep(1500); continue }
              break
            }
          }
          if (!out) return fail(res, new Error('模型没有返回描述（可能网络不稳，稍后再试）' + (lastErr ? '——' + lastErr : '')))
          ok(res, { ok: true, text: out })
        } catch (e) { fail(res, e) }
      },
    }))

    // 单角色读取（面板编辑器用）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/character',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url, 'http://x')
          const ws = u.searchParams.get('ws')
          if (!ws) return fail(res, new Error('缺 ?ws='))
          const rt = runtimes.get(ws)
          ok(res, { ok: true, ws, character: rt ? rt.char : loadCharacter(ws) })
        } catch (e) { fail(res, e) }
      },
    }))
    // 捏人预览：给一段 persona，返回注入文本（不落盘）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/persona-preview',
      handler: async (req, res) => {
        try {
          const b = await readBody(req)
          const p = createPersona({ config: new Proxy(config, { get: (t, k, r) => (k === 'persona' ? (b.persona || {}) : Reflect.get(t, k, r)) }) })
          ok(res, { ok: true, text: p.personaText() })
        } catch (e) { fail(res, e) }
      },
    }))
    // 角色保存/创建：捏人完成 → 写 character.json；已有运行时热生效，新工作区热挂载
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/characters/save',
      handler: async (req, res) => {
        try {
          const b = await readBody(req)
          if (!b || !b.ws || !b.character || typeof b.character !== 'object') return fail(res, new Error('缺 ws / character'))
          const rt = runtimes.get(b.ws)
          const char = {
            schemaVersion: 1,
            sessionId: (rt && rt.char.sessionId) || b.character.sessionId || sessionIdForWs(b.ws),
            name: String(b.character.name || '角色'),
            channels: Array.isArray(b.character.channels) ? b.character.channels.map(String) : [],
            enabled: b.character.enabled !== false,
            groups: Array.isArray(b.character.groups) ? b.character.groups.map(String) : [],
            persona: b.character.persona && typeof b.character.persona === 'object' ? b.character.persona : {},
            flags: (rt && rt.char.flags) || {},
            meta: { ...((rt && rt.char.meta) || {}), updatedAt: new Date().toISOString(), source: (rt && rt.char.meta && rt.char.meta.source) || 'wizard' },
          }
          const p = saveCharacter(b.ws, char)
          if (rt) {
            rt.char.name = char.name
            rt.char.channels = char.channels
            rt.char.enabled = char.enabled
            rt.char.groups = char.groups
            rt.char.persona = char.persona // 作用域配置按次读取，热生效
            rt.char.meta = char.meta
            diag('角色卡已保存（热生效）：' + char.name + ' @ ' + b.ws + (char.enabled === false ? '（已停用）' : ''))
            ok(res, { ok: true, hot: true, path: p })
          } else {
            const started = ensureRuntimeFor(b.ws)
            diag('角色已创建：' + char.name + ' @ ' + b.ws + (started ? '（已挂载）' : '（写盘成功，挂载待重启）'))
            ok(res, { ok: true, hot: !!started, path: p })
          }
        } catch (e) { fail(res, e) }
      },
    }))
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/her-kernel/state', handler: async (req, res) => { try { const rt = needRt(res, req); if (!rt) return; const H = rt.state.getState(); ok(res, { ok: true, ws: rt.wsPath, app: rt.appRouter.now(), notifications: rt.notifier.allNotifications(), mood: Math.round(H.base), heart: { base: Math.round(H.base), dims: H.dims, daily: H.daily } }) } catch (e) { fail(res, e) } } }))
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/her-kernel/config', handler: async (req, res) => { try { if (req.method === 'POST') { const b = await readBody(req); if (b.patch) { deepMergeInto(config, b.patch); saveConfig(config) } ok(res, { ok: true, updated: true, config }) } else ok(res, { ok: true, config }) } catch (e) { fail(res, e) } } }))
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/her-kernel/ingest', handler: async (req, res) => { try { const b = await readBody(req); const r = await api.ingest(b); ok(res, r) } catch (e) { fail(res, e) } } }))
    // 状态汇总（面板显示各层实时状态；?ws= 选角色）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/overview',
      handler: async (req, res) => {
        try {
          const rt = needRt(res, req); if (!rt) return
          const H = rt.state.getState(), ls = rt.state.advance()
          ok(res, {
            ok: true,
            ws: rt.wsPath, name: rt.name,
            heart: {
              base: Math.round(H.base),
              label: rt.state.moodLabel(H.base),
              emoji: rt.state.moodEmoji(H.base),
              dims: Object.fromEntries(rt.state.HEART_DIMS.map(([k, l]) => [l, Math.round(H.dims[k])])),
              lastReason: H.lastReason,
              lastSpokeAt: H.lastSpokeAt,
              daily: H.daily,
              timelineCount: (H.moodTimeline || []).length,
            },
            life: { activity: ls.activity.label, needs: ls.needs, today: ls.timeline.filter((x) => x.at >= new Date().setHours(0, 0, 0, 0)).slice(-8), schedulePath: rt.state.SCHEDULE_PATH },
            schedule: rt.state.loadSchedule(),
            memory: { dbPath: rt.memory.DB_PATH, counts: Object.fromEntries(rt.memory.TABLES.map((t) => { try { return [t, rt.memory.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE status='active'`).get().n] } catch (e) { return [t, 0] } })), hiddenCount: rt.memory.listHidden(999).length },
            notifications: rt.notifier.allNotifications(),
            app: rt.appRouter.now(),
            channels: Object.keys(config.channels),
          })
        } catch (e) { fail(res, e) }
      },
    }))
    // 记忆查看/查询/编辑/删除（?ws= / body.ws 选角色）
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/her-kernel/memory',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const b = await readBody(req)
            const rt = rtOf(b.ws) || rtOf(null)
            if (!rt) return fail(res, new Error('没有角色'))
            if (b.action === 'edit') ok(res, rt.memory.edit(b.id, b.patch || {}))
            else if (b.action === 'remove') ok(res, rt.memory.remove(b.id, { hard: !!b.hard }))
            else if (b.action === 'add') ok(res, rt.memory.remember({ level: b.level, content: b.content, keywords: b.keywords, importance: b.importance }))
            else if (b.action === 'search') ok(res, { ok: true, results: rt.memory.search({ query: b.query, limit: b.limit }) })
            else ok(res, { ok: false, error: '未知 action' })
          } else {
            const rt = needRt(res, req); if (!rt) return
            const u = new URL(req.url, 'http://x')
            const listed = rt.memory.list({ level: u.searchParams.get('level'), status: u.searchParams.get('status') || 'active', limit: Number(u.searchParams.get('limit')) || 50, offset: Number(u.searchParams.get('offset')) || 0 })
            ok(res, { ok: true, results: listed.results || listed, total: listed.total != null ? listed.total : (listed.results || listed).length, limit: listed.limit, offset: listed.offset })
          }
        } catch (e) { fail(res, e) }
      },
    }))
  } catch (e) { diag('webServer 路由注册失败：' + (e && e.message)) }

  return {
    runtimes, listChars, api, config, ensureRuntimeFor,
    registerChannel: api.registerChannel,
    ingest: api.ingest,
    onUserMessage: api.onUserMessage,
    onOutbound: api.onOutbound,
    emitEvent: api.emitEvent,
    sendOutbound: api.sendOutbound,
  }
  } catch (e) {
    // ⭐ 重启兜底：apply 抛异常时不让整个插件失败，只记日志
    try { ctx.logger?.error?.(`[her-kernel] apply 失败：${e && e.message}`) } catch (e2) { /* ignore */ }
    return { error: String(e && e.message) }
  }
}

function parseTime(v) {
  if (!v) return undefined
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const d = new Date(v)
  return Number.isFinite(d.getTime()) ? d.getTime() : undefined
}

function deepMergeInto(base, over) {
  for (const k of Object.keys(over)) {
    if (k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      deepMergeInto(base[k], over[k])
    } else {
      base[k] = over[k]
    }
  }
}

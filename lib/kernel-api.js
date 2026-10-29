// dsh-her-kernel · 桥接层统一接口（内核侧）
//
// ⭐ 桥接插件（QQ/未来微信/B站）与内核的唯一契约。桥接只做协议适配 + 安全分类器，
//    通过这些接口与内核交互。多角色架构：ingest 按渠道路由到认领该渠道的角色
//    （character.json.channels）；渠道元数据（registerChannel）与出站处理器全局共享。
//
// 消息流（多角色，不注入）：
//   渠道消息 → 桥接(分类器出站审核前提;入站不拦) → kernel.ingest(按渠道路由)
//     → 认领角色的 消息库 + 通知（不注入会话！）
//   她主动看：app_list / app_enter / app_fetch；她主动回：app_send → 出站分类器 → 渠道
//   桥接工具（qq_napcat_api 等）经 mountTool 只挂认领渠道的角色会话。

export function createKernelApi({ config, resolveChar, listChars, diag = () => {} }) {
  // 桥接插件注册的处理器（渠道级，全局共享）
  const userMessageHandlers = new Map()  // channel -> handler
  const outboundHandlers = new Map()     // channel -> handler
  const registeredChannels = new Map()
  // 桥接工具（如 qq_napcat_api）：只挂认领渠道的角色会话（agent.ctx），不全局注册
  const scopedToolList = [] // { def, channels? }

  // 注册渠道 + 该渠道的通知/App 规则/使用注意（notes）
  // ui: { tabId, tabLabel, order } —— 角色面板动态页签由桥接声明，内核只渲染
  // 注意：已存在的配置（用户在设置页改过的）优先，桥接传入的只补缺字段
  function registerChannel({ type, notify, app, notes, ui } = {}) {
    if (!type) return { ok: false, error: '缺 type' }
    const cur = config.channels[type] || {}
    config.channels[type] = {
      ...cur,
      notify: { ...(notify && typeof notify === 'object' ? notify : {}), ...(cur.notify || {}) },
      app: { ...(app && typeof app === 'object' ? app : {}), ...(cur.app || {}) },
      notes: (cur.notes !== undefined && cur.notes !== null) ? cur.notes : String(notes || ''),
    }
    if (ui && typeof ui === 'object') {
      config.channels[type].ui = {
        tabId: String(ui.tabId || type),
        tabLabel: String(ui.tabLabel || type),
        order: Number.isFinite(Number(ui.order)) ? Number(ui.order) : 100,
      }
    }
    registeredChannels.set(type, true)
    diag('渠道已注册：' + type + (config.channels[type].ui ? '（页签 ' + config.channels[type].ui.tabLabel + '）' : ''))
    return { ok: true, channel: type, config: config.channels[type] }
  }

  // 角色面板用：按桥接页签聚合渠道（tabId 相同只出现一次）
  function listChannelTabs() {
    const byId = new Map()
    for (const [type, c] of Object.entries(config.channels || {})) {
      const ui = (c && c.ui) || { tabId: type, tabLabel: type, order: 100 }
      const id = String(ui.tabId || type)
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          label: String(ui.tabLabel || type),
          order: Number(ui.order) || 100,
          channels: [type],
        })
      } else {
        byId.get(id).channels.push(type)
      }
    }
    return [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  // 渠道消息进内核（+ 通知 + 心思）→ 路由到认领该渠道的角色
  // ⭐ 设计红线：渠道消息不注入会话！只写库 + 弹通知，她自己决定要不要看
  async function ingest(msg) {
    const rt = (typeof resolveChar === 'function' && resolveChar(msg && msg.channel)) || null
    if (!rt) {
      diag('ingest：没有角色认领渠道 ' + (msg && msg.channel) + '，忽略')
      return { ok: false, error: '没有角色认领该渠道' }
    }
    // 总开关（问题8）：停用只停「活动」（唤醒/挂载）；消息照常入库，回来还能看
    if (rt.char.enabled !== false) {
      // 群聊白名单（问题5；角色.groups，留空 = 不限制）
      if (rt.char.groups && rt.char.groups.length && /group/.test(String(msg.channel)) && !rt.char.groups.includes(String(msg.target))) {
        diag('ingest：群 ' + msg.target + ' 不在 ' + rt.name + ' 的允许列表，忽略')
        return { ok: false, skipped: 'group-not-allowed' }
      }
    }
    const r = rt.notifier.onMessage(msg)
    if (msg && msg.fromUser !== false) {
      rt.state.bump('userMsg', 3)
    }
    // 事件驱动：入库后评估心绪规则/通知（无插件定时器）
    try { if (typeof rt.evalWake === 'function') rt.evalWake('ingest') } catch (e) { /* ignore */ }
    return r
  }

  function onUserMessage(channel, handler) {
    userMessageHandlers.set(channel, handler)
  }

  // 内核要发消息到某渠道时回调（主动层/回复）
  function onOutbound(channel, handler) {
    outboundHandlers.set(channel, handler)
  }

  // 本地已读 → 通知桥接（桥接可调用渠道侧「标记已读」，清掉手机端未读角标）
  const messageReadHandlers = new Set()
  function onMessagesRead(handler) {
    if (typeof handler === 'function') messageReadHandlers.add(handler)
    return () => messageReadHandlers.delete(handler)
  }
  function notifyMessagesRead(channel, target, msgIds) {
    for (const fn of messageReadHandlers) {
      try { fn({ channel, target, msgIds: Array.isArray(msgIds) ? msgIds : [] }) } catch (e) { diag('onMessagesRead 回调异常：' + (e && e.message)) }
    }
  }

  // 渠道事件上报（被夸/被骂/记忆…）→ 应用到全部角色的状态层
  function emitEvent(event) {
    if (!event || typeof event !== 'object') return
    for (const rt of (typeof listChars === 'function' ? listChars() : [])) {
      const p = rt.state
      if (event.type === 'mood') p.hookEvent(event)
      if (event.type === 'memory') p.hookEvent(event)
      if (event.type === 'praised') p.bump('praised', Number(event.amount) || 4)
      if (event.type === 'ignored') p.bump('ignored', Number(event.amount) || 4)
      try { if (typeof rt.evalWake === 'function') rt.evalWake('event') } catch (e) { /* ignore */ }
    }
  }

  // 内核要发消息到某渠道（走桥接的出站，桥接再过分类器）；处理器是渠道级全局
  async function sendOutbound(channel, target, text) {
    const h = outboundHandlers.get(channel)
    if (!h) return { ok: false, error: '该渠道没注册出站处理器' }
    return await h({ channel, target, text })
  }

  function getChannelConfig(type) {
    return config.channels[type] || null
  }

  // 注册一个「按角色挂载」的工具（桥接用）：不进全局工具表。
  // def 需完整（含 output）；opts.channels 指定只挂认领这些渠道的角色；同名覆盖。
  function mountTool(def, opts = {}) {
    if (!def || !def.name) return { ok: false, error: '缺工具定义/name' }
    const channels = Array.isArray(opts.channels) && opts.channels.length ? opts.channels.map(String) : null
    const i = scopedToolList.findIndex((d) => d.def.name === def.name)
    if (i >= 0) scopedToolList[i] = { def, channels }
    else scopedToolList.push({ def, channels })
    try {
      for (const rt of (typeof listChars === 'function' ? listChars() : [])) {
        if (channels && !(rt.char.channels || []).some((c) => channels.includes(c))) continue
        const ag = rt.agentSession && rt.agentSession.agent
        const sid = rt.agentSession && rt.agentSession.agentSid
        if (ag && sid && typeof rt.agentSession.mountFor === 'function') {
          rt.agentSession.mountFor(ag, sid) // 重挂：offs 先 dispose，再带上新工具
        }
      }
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  }
  function scopedToolEntries() {
    return scopedToolList.map((d) => ({ def: d.def, channels: d.channels }))
  }

  return {
    registerChannel, listChannelTabs, ingest, onUserMessage, onOutbound, onMessagesRead, notifyMessagesRead, emitEvent, sendOutbound, getChannelConfig,
    mountTool, scopedToolEntries,
    registeredChannels, userMessageHandlers, outboundHandlers,
    // 内核能力的少量暴露（桥接如需读全局配置）
    kernel: { config },
  }
}

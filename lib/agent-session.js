// dsh-her-kernel · agent 会话管理（单会话方案核心）
//
// 内核创建/复用一个固定会话，所有渠道消息（QQ/Web/主动）都注入它。
// 监听 turn-stopping：取本轮回复 → 消息库记录 → 分类器审核 → 出站发送。
//
// 记忆压缩（三层）：
//   A systemPrompt（人设/状态/通知）→ 永不折叠
//   B 对话历史（DSH session）→ 超预算时先归档再 ctx.compaction
//   C memory.db（hidden 原文 + topic 摘要）→ 永远可查
// LLM 精炼与会话 agentOptions 同 provider/model，无降级分支。


import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

// 内联实现（link 装不能 import @deepseek-ai/*）
function createUserMessage(input) {
  return {
    id: 'user-' + randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source || { kind: 'user' },
  }
}

const logLine = (s) => { try { appendFileSync('/tmp/kernel-agent.log', new Date().toISOString() + ' ' + s + '\n') } catch (e) { /* ignore */ } }

export function createAgentSession({ ctx, config, persona, state, memory, msgStore, notifier, appRouter, sessionId = 'her-kernel', cwd = '/mnt/nvme/agent/dsh/her', diag = () => {} }) {
  let kernelApi = null  // 后续通过 setKernelApi 设置
  let mountables = null // { contexts(), tools() }：注入与工具定义表，只挂到她的会话（agent.ctx）
  let agent = null
  let agentSid = null
  let handledSeq = 0    // turn-stopping 出站水位：只扫这之后的事件，防止重复发旧回复
  let offs = []         // 清理函数
  let wakeHook = null   // 回合结束钩子（心绪规则评估；所有回合都调，含无出站）
  // 记忆预算归档状态（每 runtime 独立）
  let lastArchiveSeq = 0
  let archiving = false
  let lastLlmRefineAt = 0
  let lastTurnTexts = [] // 本回合可 hide 的原文（P2 主动入记忆）
  let sessionAgentOptions = null // 与会话一致的 provider/model（LLM 精炼用）

  // 每个角色实例有自己的会话身份与工作区（多角色架构 Phase 2）
  const SESSION_ID = sessionId
  const SESSION_CWD = cwd
  const PRESET_ID = 'her'

  // agent 组装（对齐 api-session-controller 的做法）：
  // 1) agentOptions 给 provider/model——{{model}} 提示词变量和 LLM 请求路由都靠它，缺了整个回合直接报错；
  // 2) setup 挂 her 预设插件组——dsh-persona 会用"你是小鲸…"遮蔽全局 coding-agent 前缀，并加载 AGENTS.md。
  async function composeSetup() {
    let agentOptions = {}
    try {
      const dm = (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined) || ctx.agentDefaultModel
      if (dm && typeof dm.currentSelection === 'function') {
        const sel = dm.currentSelection()
        if (sel && sel.model) agentOptions = { provider: sel.provider, model: sel.model }
      }
    } catch (e) { /* ignore */ }
    if (!agentOptions.model) agentOptions = { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash' }
    let setup = undefined
    try {
      const presets = (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined) || ctx.agentPresets
      if (presets && typeof presets.mount === 'function') {
        const resolvedId = (await presets.resolve(PRESET_ID)).id
        setup = async (agentCtx, agent) => { await presets.mount(agentCtx, resolvedId) }
      }
    } catch (e) { logLine('presets setup FAILED: ' + e.message) }
    return { agentOptions, setup }
  }

  // 创建或复用固定会话。
  // 注意：ctx.agents.create/resume 返回 AgentHandle { agent, dispose }，要解构；
  // resume 的会话参数名是 resumeSessionId（不是 sessionId）。
  async function ensureAgent() {
    if (agent && agent.status !== 'disposed') return agent
    const meta = { cwd: SESSION_CWD, agentPreset: PRESET_ID }
    const { agentOptions, setup } = await composeSetup()
    sessionAgentOptions = agentOptions
    // 1) 本进程已有活会话（必须 cwd 匹配——sessionId 在多角色下可能撞名，绝不能挂错工作区的会话）
    try {
      const list = ctx.agents.list() || []
      const found = list.find((a) => a && a.session && a.session.id === SESSION_ID
        && a.session.header && String(a.session.header.cwd) === SESSION_CWD)
      if (found) {
        agent = found
        agentSid = SESSION_ID
        logLine('ensureAgent: found live ' + SESSION_ID + ' @ ' + SESSION_CWD)
        diag('内核会话已存在：' + agentSid)
        mountFor(agent, agentSid)
        return agent
      }
    } catch (e) {
      logLine('ensureAgent list FAILED: ' + e.message)
    }
    // 2) resume（会话文件在就走这里，保留历史；恢复后校验 cwd，防止撞名恢复到别的工作区）
    let resumeErr = null
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: SESSION_ID, agentOptions, setup })
      const resumed = handle && handle.agent ? handle.agent : handle
      const rCwd = resumed && resumed.session && resumed.session.header && String(resumed.session.header.cwd)
      if (rCwd && rCwd !== SESSION_CWD) {
        logLine('ensureAgent: resumed ' + SESSION_ID + ' 但 cwd=' + rCwd + ' ≠ ' + SESSION_CWD + '，弃用改新建')
        resumeErr = new Error('resumed session cwd mismatch: ' + rCwd)
        try { if (typeof handle.dispose === 'function') handle.dispose() } catch (e) { /* ignore */ }
      } else {
        agent = resumed
        agentSid = SESSION_ID
        logLine('ensureAgent: resumed ' + SESSION_ID + ' model=' + (agentOptions.model || '?'))
        diag('内核会话已恢复：' + agentSid)
        mountFor(agent, agentSid)
        return agent
      }
    } catch (e) {
      resumeErr = e
      logLine('ensureAgent resume FAILED: ' + e.message)
    }
    // 3) create（全新会话）
    try {
      const handle = await ctx.agents.create({ sessionId: SESSION_ID, meta, agentOptions, setup })
      agent = handle && handle.agent ? handle.agent : handle
      agentSid = SESSION_ID
      logLine('ensureAgent: created ' + SESSION_ID + ' model=' + (agentOptions.model || '?'))
      diag('内核会话已创建：' + agentSid)
      mountFor(agent, agentSid)
      return agent
    } catch (e) {
      logLine('ensureAgent create FAILED: ' + e.message)
    }
    // 4) 兜底：删档重建 —— **只有 resume 报"文件损坏"类错误才允许删！**
    // ⚠️ 2026-10-25 事故教训：HMR 重载时上下文未就绪，resume/create 因
    //    "inactive context" 失败，旧兜底把她的历史会话整个删了。
    //    上下文/服务类错误一律不删档（宁可这一轮不建会话，下次健康启动再恢复）；
    //    真要删之前先复制一份 .bak-时间戳 备份。
    const corruptRe = /json|parse|corrupt|invalid|unexpected|magic|zstd|truncated|checksum/i
    const resumeMsg = String((resumeErr && (resumeErr.message || resumeErr)) || '')
    if (!resumeErr || !corruptRe.test(resumeMsg)) {
      logLine('ensureAgent: 跳过删档重建（resume 错误不适合删档: ' + resumeMsg + '）')
      diag('内核会话本轮未就绪（不删档，等下次启动再恢复）：' + resumeMsg)
      return null
    }
    try {
      const { rmSync, copyFileSync, existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      // 平台按 cwd 编码会话目录：'--' + 去掉首斜杠的路径（斜杠→'-'）+ '--'
      const encCwd = '--' + String(SESSION_CWD).replace(/^[/\\]/, '').replace(/[/\\]/g, '-') + '--'
      const sessPath = join(process.env.HOME, '.dsh', 'sessions', encCwd, SESSION_ID)
      if (existsSync(sessPath)) {
        const bak = sessPath + '.bak-' + Date.now()
        try { copyFileSync(sessPath, bak); logLine('ensureAgent: 删档前备份 → ' + bak) } catch (e) { logLine('ensureAgent: 备份失败 ' + e.message) }
      }
      rmSync(sessPath, { recursive: true, force: true })
      logLine('ensureAgent: deleted old session ' + sessPath)
      const handle = await ctx.agents.create({ sessionId: SESSION_ID, meta, agentOptions, setup })
      agent = handle && handle.agent ? handle.agent : handle
      agentSid = SESSION_ID
      logLine('ensureAgent: created after delete ' + SESSION_ID)
      diag('内核会话已重建：' + agentSid)
      mountFor(agent, agentSid)
      return agent
    } catch (e3) {
      logLine('ensureAgent final FAILED: ' + e3.message)
      diag('创建/恢复内核会话最终失败：' + (e3 && e3.message))
      return null
    }
  }

  // 挂载 agent：turn-stopping → 取本轮回复 + 来源渠道 → 出站发送。
  // 事件载荷里融合了 agent 字段（agentEvents），按实例过滤。
  function mountFor(a, sid) {
    // 清理旧的
    for (const d of offs) { try { if (typeof d === 'function') d() } catch (e) { /* ignore */ } }
    offs = []
    // 水位推到当前会话末尾：历史回复不重发
    try { handledSeq = (a.session && a.session.seq) || 0 } catch (e) { handledSeq = 0 }
    try { lastArchiveSeq = handledSeq } catch (e) { lastArchiveSeq = 0 }

    // 这轮结束 → 取回复 → 出站
    try {
      offs.push(ctx.on('agent/turn-stopping', (payload) => {
        try {
          if (!payload || payload.agent !== a) return
          const prevSeq = handledSeq
          const { reply, outbound } = lastTurnOutcome(a.session, handledSeq)
          try { handledSeq = (a.session && a.session.seq) || handledSeq } catch (e) { /* ignore */ }
          // 本回合可 hide 原文（P2 主动入记忆用）
          try { lastTurnTexts = collectTextEvents(a.session, prevSeq, handledSeq) } catch (e2) { lastTurnTexts = [] }
          // 心绪规则评估：任何回合结束都触发（含 kernel/schedule 无出站回合）
          try { if (typeof wakeHook === 'function') wakeHook('turn-end') } catch (e2) { diag('wakeHook 失败：' + (e2 && e2.message)) }
          // 预算归档：超阈值则 hide 旧对话 + 可选 DSH 折叠（不碰 systemPrompt）
          try {
            Promise.resolve().then(() => maybeArchive(a)).catch((e2) => diag('预算归档异常：' + (e2 && e2.message)))
          } catch (e2) { diag('预算归档调度失败：' + (e2 && e2.message)) }
          if (!reply || !outbound) {
            diag('turn-stopping: 无出站（replyLen=' + (reply ? reply.length : 0) + ' outbound=' + JSON.stringify(outbound) + ')')
            return
          }
          const { channel, target } = outbound
          const isQQ = channel === 'qq-group' || channel === 'qq-private'
          if (isQQ) {
            // QQ 消息已回复 → 心思回落
            state.bump('replied', 2)
          }
          // 回复也入消息库（记成已读，不污染未读角标）
          try {
            const rid = 'reply-' + Date.now() + '-' + randomUUID().slice(0, 8)
            msgStore.add({ channel, target, sender: '小鲸', content: reply, time: Date.now(), msg_id: rid })
            msgStore.markRead(channel, target, [rid])
          } catch (e) { /* ignore */ }
          // 出站（桥接侧分类器审核：关键词快筛 + LLM）
          if (kernelApi && kernelApi.sendOutbound) {
            kernelApi.sendOutbound(channel, target, reply).then((r) => {
              if (r && r.ok) {
                diag('已发到 ' + channel + '/' + target)
                try { msgStore.markRead(channel, target) } catch (e) { /* ignore */ }
                try { if (kernelApi.notifyMessagesRead) kernelApi.notifyMessagesRead(channel, target) } catch (e) { /* ignore */ }
              } else if (r && r.blocked) {
                diag('出站被分类器拦截：' + r.reason)
                // 回流：补一条结构化 kernel 通知进她的收件箱（不唤醒，下一回合开头生效），
                // 让她知道哪句话被拦、为什么，下次自己改写或换说法。
                try {
                  const msg = createUserMessage({
                    content: [{ type: 'text', text: JSON.stringify({ type: 'send-blocked', channel, target, reason: r.reason || '', category: r.category || null }) }],
                    source: { kind: 'kernel' },
                  })
                  a.send(msg, 'next-step', false)
                } catch (e2) { diag('拦截回流注入失败：' + (e2 && e2.message)) }
              } else {
                diag('发送结果异常：' + JSON.stringify(r).slice(0, 140))
              }
            }).catch((e) => {
              diag('发送失败：' + (e && e.message))
            })
          }
        } catch (e) { diag('turn-stopping 处理失败：' + (e && e.message)) }
      }))
    } catch (e) { diag('监听 turn-stopping 失败：' + (e && e.message)) }

    // ① systemPrompt 注入：只挂这个 agent（agent.ctx，dsh-scope 隔离；register 返回销毁函数）
    if (mountables && typeof mountables.contexts === 'function' && a.ctx) {
      let m = 0
      for (const c of mountables.contexts()) {
        try { offs.push(a.ctx.systemPrompt.context({ name: c.name, order: c.order, text: c.text })); m++ }
        catch (e) { diag('挂注入失败 ' + c.name + '：' + (e && e.message)) }
      }
      if (m) logLine('挂载：' + m + ' 段注入 → ' + sid)
    }
    // ② 工具：同样只挂这个 agent（重挂前 offs 已 dispose 旧注册，不会重复）
    if (mountables && typeof mountables.tools === 'function' && a.ctx) {
      let n = 0
      for (const t of mountables.tools()) {
        try { offs.push(a.ctx.tools.register(t)); n++ }
        catch (e) { diag('挂工具失败 ' + t.name + '：' + (e && e.message)) }
      }
      if (n) { diag('已挂载 ' + n + ' 个工具到会话 ' + sid); logLine('挂载：' + n + ' 个工具 → ' + sid + '（agent.ctx，仅她可见）') }
    }

    diag('内核会话已挂载：' + sid)
  }

  // 注入与工具的挂载件（index.js apply 时装填；builder 挂载时才求值）
  function setMountables(m) { mountables = m }

  // 注入消息到会话（QQ/Web/主动）
  // 注入消息到会话（唤醒/主动用）
  // kind 模式（官方唤醒格式，参照 dsh-schedule 的 kind:'schedule'）：source={kind}，不冒充用户、无渠道字段；
  // 渠道模式（兼容旧路径）：source={kind:'user', channel...}，turn-stopping 据此把回复发回原渠道。
  async function inject({ text, source = 'qq', channel, target, sender, kind }) {
    if (!agent || agent.status === 'disposed') {
      try { await ensureAgent() } catch (e) { /* ignore */ }
    }
    if (!agent) return { ok: false, error: '内核会话未创建' }
    try {
      const msg = kind
        ? createUserMessage({ content: [{ type: 'text', text: String(text || '') }], source: { kind: String(kind) } })
        : createUserMessage({
            content: [{ type: 'text', text: String(text || '') }],
            source: { kind: 'user', channel: channel || source || 'qq', target: String(target || ''), sender: String(sender || '') },
          })
      diag('注入：' + (kind ? 'kind=' + kind : (channel || source) + '/' + target) + ' ← ' + String(text).slice(0, 40))
      try {
        // 官方唤醒入口 = followup（send next-turn + 唤醒驱动）；注入与工具都挂在这条链上
        if (typeof agent.followup === 'function') agent.followup(msg)
        else agent.send(msg, 'next-turn', true)
      } catch (e1) {
        diag('followup 失败，降级 llm.stream：' + (e1 && e1.message))
        await fallbackReply({ text, channel, target })
      }
      return { ok: true, sid: agentSid }
    } catch (e) {
      diag('注入消息失败：' + (e && e.message))
      return { ok: false, error: String(e && e.message) }
    }
  }

  // 兜底：agent.send 不可用时直接 llm.stream（降级：无工具；尽量带上 5 层状态）
  async function fallbackReply({ text, channel, target }) {
    try {
      let system = ''
      try { system += (persona ? persona.personaText() : '你是小鲸') + '\n' } catch (e) { /* ignore */ }
      try { system += (state.moodLine() || '') + '\n' } catch (e) { /* ignore */ }
      try { system += (state.contextText() || '') + '\n' } catch (e) { /* ignore */ }
      const messages = [{ role: 'user', id: 'user-' + randomUUID(), content: [{ type: 'text', text: String(text) }] }]
      // 先查可用 provider
      let providers = []
      try { providers = (ctx.llm.listProviders?.() || []).map(p => p.id) } catch (e) {}
      diag('降级 llm.stream，providers: ' + JSON.stringify(providers))
      let out = ''
      let chunkTypes = {}
      for await (const chunk of ctx.llm.stream({
        provider: providers[0] || 'deepseek', model: 'deepseek-chat',
        system,
        messages,
        maxTokens: 1000,
      })) {
        if (chunk && chunk.type) chunkTypes[chunk.type] = (chunkTypes[chunk.type] || 0) + 1
        if (chunk && chunk.type === 'text-delta') out += chunk.text
      }
      diag('降级回复生成：' + JSON.stringify(chunkTypes) + ' replyLen=' + out.length)
      // 把回复写回消息库 + 发到 QQ
      if (out) {
        try {
          const rid = 'reply-' + Date.now() + '-' + randomUUID().slice(0, 8)
          msgStore.add({ channel, target, sender: '小鲸', content: out, time: Date.now(), msg_id: rid })
          msgStore.markRead(channel, target, [rid])
        } catch (e) { /* ignore */ }
        try {
          if (kernelApi && kernelApi.sendOutbound) {
            kernelApi.sendOutbound(channel, target, out).then(r => {
              if (r && r.ok) diag('降级路径已发到 ' + channel + '/' + target)
              else diag('降级路径发送结果异常：' + JSON.stringify(r).slice(0, 100))
            }).catch(e => {
              diag('降级路径发送失败：' + e.message)
            })
          }
        } catch (e3) {
          diag('降级路径发送异常：' + e3.message)
        }
      }
    } catch (e2) {
      diag('降级 llm.stream 失败：' + e2.message)
    }
  }

  function textOfMessage(msg) {
    try {
      if (!msg || !Array.isArray(msg.content)) return ''
      return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    } catch (e) { return '' }
  }

  // 会话事件 → 可归档文本行 { id, seq, role, text, kind }
  function collectTextEvents(session, fromSeq, toSeq) {
    const out = []
    try {
      const ev = (session && session.snapshotEvents && session.snapshotEvents(fromSeq)) || []
      for (const e of ev) {
        if (!e || !e.type) continue
        if (toSeq != null && Number(e.seq) > Number(toSeq)) break
        if (e.type === 'user/message') {
          const m = e.data && e.data.message ? e.data.message : e.data
          const text = textOfMessage(m)
          if (!text) continue
          const src = (m && m.source) || (e.data && e.data.source) || {}
          const kind = String(src.kind || '')
          if (kind === 'kernel-wake' || kind === 'schedule' || kind === 'compaction' || kind === 'compact-checkpoint') continue
          out.push({
            id: String((m && m.id) || e.id || ('ev-' + e.seq)),
            seq: e.seq,
            time: Number(e.time) || Number(m && m.time) || 0,
            role: 'user',
            kind,
            text,
          })
        } else if (e.type === 'assistant/message') {
          const p = e.data
          const m = p && p.message ? p.message : p
          const text = textOfMessage(m)
          if (!text) continue
          out.push({
            id: String((m && m.id) || e.id || ('ev-' + e.seq)),
            seq: e.seq,
            time: Number(e.time) || 0,
            role: 'assistant',
            kind: 'assistant',
            text,
          })
        }
      }
    } catch (e) { diag('collectTextEvents 失败：' + (e && e.message)) }
    return out
  }

  // LLM 精炼摘要：与会话同一 provider/model（无降级分支）
  // archiveLlmProvider 非空时可覆盖 provider；model 始终与会话一致
  async function llmRefine(messages, draft) {
    const { provider, model } = sessionAgentOptions || {}
    if (!model) throw new Error('会话未配置 model，无法 LLM 精炼')
    const mem = (config && config.memory) || {}
    const providerOverride = String(mem.archiveLlmProvider || '').trim()
    let out = ''
    for await (const chunk of ctx.llm.stream({
      provider: providerOverride || provider || undefined,
      model,
      system: '把下面这段对话压成 3–6 句中文记忆摘要。保留关键事实、决定与情绪，不要列表、不要前缀标签。直接输出摘要正文。',
      messages: [{ role: 'user', content: [{ type: 'text', text: String(draft || '').slice(0, 6000) }] }],
      maxTokens: 400,
    })) {
      if (chunk && chunk.type === 'text-delta') out += chunk.text || ''
    }
    const lim = Number(mem.archiveSummaryMaxChars) || 1200
    return out.trim().slice(0, lim)
  }

  // 超预算：官方 tokenMeter（或字符兜底）→ 近 keepRecent 条外 hide+topic 归档。
  // DSH 自动 compaction 已在 her 预设关闭；systemPrompt 不在范围内。
  async function maybeArchive(a) {
    if (archiving || !a || !a.session) return
    const mem = (config && config.memory) || {}
    if (mem.hideOnOverflow === false) return
    const keepRecent = Math.max(1, Number(mem.keepRecent) || 50)
    const minMsgs = Number(mem.archiveMinMessages) || 6
    const tokenTh = Number(mem.contextTokenThreshold) || 0
    const budgetChars = Number(mem.budgetChars) || 24000

    // 官方计量：与 DSH 同一 tokenMeter 路径
    let surfaceTokens = null
    let totalTokens = null
    try {
      const meter = ctx.tokenMeter || (typeof ctx.get === 'function' ? ctx.get('tokenMeter') : null)
      if (meter && typeof meter.measure === 'function') {
        const m = meter.measure(a.session)
        surfaceTokens = Number(m && m.surfaceTokens)
        totalTokens = Number(m && m.totalTokens)
      }
    } catch (e) {
      logLine('tokenMeter.measure 失败：' + (e && e.message))
    }

    // 全量文本（按时间），排除已 hidden 的，再保留最近 keepRecent 条
    const all = collectTextEvents(a.session, 0)
      .slice()
      .sort((x, y) => (x.time || 0) - (y.time || 0) || (Number(x.seq) || 0) - (Number(y.seq) || 0))
      .filter((m) => {
        try { return !memory.hidden(m.id) } catch (e) { return true }
      })
    if (all.length < minMsgs) return
    const chars = all.reduce((s, m) => s + m.text.length, 0)
    const overTokens = tokenTh > 0 && surfaceTokens != null && surfaceTokens >= tokenTh
    const overChars = !(tokenTh > 0 && surfaceTokens != null) && chars >= budgetChars
    if (!overTokens && !overChars) return

    const toArchive = all.slice(0, Math.max(0, all.length - keepRecent))
    if (!toArchive.length) return

    archiving = true
    try {
      const draft = memory.ruleSummary
        ? memory.ruleSummary(toArchive, mem.archiveSummaryMaxChars)
        : toArchive.map((m) => m.text).join('\n').slice(0, Number(mem.archiveSummaryMaxChars) || 1200)
      const maxLlm = Number(mem.autoExtractMax)
      const coolMin = Number(mem.autoExtractCooldownMin) || 10
      let content = draft
      let source = 'auto-archive'
      if (maxLlm > 0 && Date.now() - lastLlmRefineAt >= coolMin * 60000) {
        content = await llmRefine(toArchive, draft)
        source = 'auto-archive-llm'
        lastLlmRefineAt = Date.now()
      }
      const day = new Date().toISOString().slice(0, 10)
      const arch = memory.archiveChunk({
        messages: toArchive,
        reason: overTokens ? '官方上下文 token 阈值' : '上下文字符预算',
        keywords: ['自动归档', day],
        content,
        sourceSession: source,
        importance: Number(mem.archiveTopicImportance) || 4,
      })
      const lastArchived = toArchive[toArchive.length - 1]
      if (lastArchived && lastArchived.seq != null) lastArchiveSeq = Number(lastArchived.seq)
      logLine('记忆归档：ok=' + arch.ok + ' hidden=' + arch.hiddenN
        + ' topic=' + (arch.topicId || '')
        + ' surfaceTokens=' + surfaceTokens + ' totalTokens=' + totalTokens
        + ' keepRecent=' + keepRecent + ' archived=' + toArchive.length
        + ' src=' + source)

      // 可选：归档后请求折叠（DSH 自动压缩已关；此处仅当 compact 服务可用）
      if (mem.compactEnabled !== false) {
        try {
          const engine = ctx.compaction || (typeof ctx.get === 'function' ? ctx.get('compaction') : null)
          if (engine && typeof engine.compactNow === 'function') {
            await engine.compactNow(a, AbortSignal.timeout(120000))
            try { lastArchiveSeq = (a.session && a.session.seq) || lastArchiveSeq } catch (e) { /* ignore */ }
            logLine('记忆折叠：compact 完成')
          } else {
            logLine('记忆折叠：ctx.compaction 不可用（仅归档进记忆，会话历史未折叠）')
          }
        } catch (e) {
          logLine('记忆折叠失败（不删会话）：' + (e && e.message))
        }
      }
    } finally {
      archiving = false
    }
  }

  // P2：主动 memory_remember 后 hide 本回合原文（不触发 compact）
  function hideLastTurnContext({ reason = '主动入记忆' } = {}) {
    const mem = (config && config.memory) || {}
    if (mem.moveOutContext === false) return { ok: false, hiddenN: 0, skipped: 'moveOutContext=false' }
    let hiddenN = 0
    for (const m of lastTurnTexts || []) {
      if (!m || !m.text) continue
      // 只藏主人/渠道消息与她的回复；纯 kernel 已在 collect 时滤掉
      const okH = memory.hide(m.id, m.text, m.text.slice(0, 80), reason)
      if (okH && okH.ok) hiddenN++
    }
    if (hiddenN) diag('主动入记忆已 hide 本回合 ' + hiddenN + ' 条')
    return { ok: true, hiddenN }
  }

  // 扫描 fromSeq 之后的会话事件：这轮她说的话 + 这轮用户消息的来源渠道。
  // user/message 的 data 就是消息体；assistant/message 的 data.message 才是消息体。
  function lastTurnOutcome(session, fromSeq) {
    let reply = ''
    let outbound = null
    try {
      const ev = (session && session.snapshotEvents && session.snapshotEvents(fromSeq)) || []
      for (const e of ev) {
        if (!e || !e.type) continue
        if (e.type === 'user/message') {
          const src = e.data && e.data.source
          if (src && src.channel && src.target) outbound = { channel: String(src.channel), target: String(src.target) }
        } else if (e.type === 'assistant/message') {
          const p = e.data
          const m = p && p.message ? p.message : p
          const txt = textOfMessage(m)
          if (txt) reply = reply ? reply + '\n' + txt : txt
        }
      }
    } catch (e) { diag('lastTurnOutcome 失败：' + (e && e.message)) }
    return { reply, outbound }
  }

  return {
    ensureAgent, mountFor, inject,
    hideLastTurnContext,
    runArchive: maybeArchive,
    measureContext() {
      try {
        const a = agent
        if (!a || !a.session) return { ok: false, error: '无会话' }
        const meter = ctx.tokenMeter || (typeof ctx.get === 'function' ? ctx.get('tokenMeter') : null)
        if (!meter || typeof meter.measure !== 'function') return { ok: false, error: 'tokenMeter 不可用' }
        const m = meter.measure(a.session)
        return {
          ok: true,
          surfaceTokens: m.surfaceTokens,
          totalTokens: m.totalTokens,
          baseline: m.baseline,
          nodes: (m.nodes || []).length,
        }
      } catch (e) {
        return { ok: false, error: String(e && e.message) }
      }
    },
    setKernelApi(api) { kernelApi = api },
    setMountables,
    setWakeHook(fn) { wakeHook = typeof fn === 'function' ? fn : null },
    get agent() { return agent },
    get agentSid() { return agentSid },
  }
}

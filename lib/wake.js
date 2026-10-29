// dsh-her-kernel · 事件驱动评估器（心绪规则 + 通知）
//
// ⭐ 无插件定时器：不 setInterval、不侧边 LLM 替她决定。
//    评估只在事件发生时合并冲刷（setImmediate）：
//      ingest / turn-end / event / agent-status→idle
//
// ⭐ 动态忙闲（2026-10-27）：
//    - 角色 running（正在输出）→ 不注入、不打断；未读只累加
//    - 角色 idle → 立刻注入（该渠道 inject* 闸门）
//    - 输出期间新到的未读，在下次 idle 的评估里一次带齐
//
// ⭐ 通知注入参数按渠道（每桥一份）：channels.<type>.notify.inject*
//    私聊默认：无冷却、无日上限、不受夜间静默。
//
// 流程：
//   running → 跳过注入（等 idle）
//   有可弹未读 → 按渠道闸门 → kernel-wake → return（规则让路）
//   否则 → 心绪规则 → kernel-heart（纯数值）→ recordInject

import { appendFileSync, existsSync } from 'node:fs'
import { channelConfig } from './config.js'

const logLine = (s) => { try { appendFileSync('/tmp/kernel-agent.log', new Date().toISOString() + ' ' + s + '\n') } catch (e) { /* ignore */ } }

// ── 小工具 ──
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 24 || mi < 0 || mi > 59) return null
  return (h * 60 + mi) % 1440
}
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function clockLabel(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${WEEKDAYS[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function quietHit(q, now) {
  if (!q || q.enabled === false) return false
  const f = parseHM(q.from), t = parseHM(q.to)
  if (f == null || t == null) return false
  const d = new Date(now)
  const min = d.getHours() * 60 + d.getMinutes()
  if (f <= t) return min >= f && min < t
  return min >= f || min < t // 跨夜
}
function windowHit(win, now, jitterMin, rng) {
  if (!win) return true
  let f = parseHM(win.from), t = parseHM(win.to)
  if (f == null || t == null) return true
  if (jitterMin > 0) {
    const j = Math.round(jitterMin * (2 * rng() - 1))
    f = ((f + j) % 1440 + 1440) % 1440
    t = ((t + j) % 1440 + 1440) % 1440
  }
  const d = new Date(now)
  const min = d.getHours() * 60 + d.getMinutes()
  if (f <= t) return min >= f && min < t
  return min >= f || min < t
}

export function createEval({ config, diag = () => {} }) {
  const pending = new Map() // wsPath -> Set<cause>
  let flushScheduled = false
  let evalSeq = 0
  // 已注入过的未读 msg_id：防止「注入 → 回合结束仍无已读 → 再注入」自激循环
  const offeredNotify = new Map() // wsPath -> Set<msg_id>

  function makeRng(ruleId, cause) {
    const r = config?.heart?.random || {}
    if (r.deterministic) {
      evalSeq++
      return mulberry32(hashStr(`${r.seed || 'dsh'}|${ruleId}|${cause}|${evalSeq}`))
    }
    return Math.random
  }

  function notifyPayload(rt) {
    let notifications = []
    try {
      notifications = (typeof rt.notifier.allNotifications === 'function' ? rt.notifier.allNotifications() : [])
        .map((n) => ({ channel: n.channel, target: n.target, count: n.count, text: n.text }))
    } catch (e) { /* ignore */ }
    return notifications
  }

  // 未读消息 id 列表（防重入）
  function unreadMsgIds(rt) {
    try {
      if (rt.msgStore && typeof rt.msgStore.listUnread === 'function') {
        return rt.msgStore.listUnread().map((r) => String(r.msg_id || '')).filter(Boolean)
      }
    } catch (e) { /* ignore */ }
    return []
  }

  function heartPayload(rt, rule, fired, materials) {
    const H = rt.state.getState({ persist: false })
    const dims = {}
    for (const [k] of (rt.state.HEART_DIMS || [])) dims[k] = Math.round(H.dims[k] || 0)
    const life = rt.state.advance()
    const now = Date.now()
    const intent = rule.intent === 'seek_master' || rule.intent === 'self_chore' || rule.intent === 'reflect'
      ? rule.intent
      : 'seek_master'
    const allowOutbound = intent === 'seek_master' ? true : (rule.allowOutbound === true)
    const actions = Array.isArray(rule.actions) && rule.actions.length
      ? rule.actions.map(String).slice(0, 8)
      : (intent === 'seek_master' ? ['share'] : ['quiet'])
    return {
      type: 'kernel-heart',
      rule: rule.id,
      intent,
      allowOutbound,
      actions,
      t: now,
      clock: clockLabel(now),
      base: Math.round(H.base),
      strength: rt.state.strengthOf(H),
      dims,
      silenceMin: Number.isFinite(rt.state.silenceMinutes()) ? Math.round(rt.state.silenceMinutes()) : null,
      sinceSpokeMin: Number.isFinite(rt.state.sinceSpokeMinutes()) ? Math.round(rt.state.sinceSpokeMinutes()) : null,
      unread: materials.unread,
      life: {
        kind: life.activity.kind,
        label: life.activity.label,
        energy: Math.round(life.needs.energy),
        interest: Math.round(life.needs.interest),
        company: Math.round(life.needs.company),
      },
      fired,
      daily: H.daily,
      materials,
      // 给她的约定（数据，不是话术）：
      // seek_master 可 app_send；self_chore/reflect 默认不必发 QQ，用工具做完可结束
      note: allowOutbound
        ? 'seek: 可 app_send 对主人说话'
        : 'self: 不必发 QQ，用工具完成 actions 后可结束',
    }
  }

  function matchRule(rule, ctx) {
    const when = rule.when || {}
    const H = ctx.heart
    // min：全部 ≥
    const mins = when.min || {}
    for (const [dim, thr] of Object.entries(mins)) {
      const base = Number(thr)
      if (!Number.isFinite(base)) continue
      const pct = Number(rule.jitter?.thresholdPct) || 0
      const u = ctx.rng()
      const eff = base * (1 + (pct / 100) * (2 * u - 1))
      ctx.lastFired = { dim, base, effective: Math.round(eff * 100) / 100, chance: Number(rule.jitter?.chance) ?? 1 }
      if ((H.dims[dim] || 0) < eff) return false
    }
    // max：全部 ≤
    const maxs = when.max || {}
    for (const [dim, thr] of Object.entries(maxs)) {
      const base = Number(thr)
      if (!Number.isFinite(base)) continue
      const pct = Number(rule.jitter?.thresholdPct) || 0
      const u = ctx.rng()
      const eff = base * (1 + (pct / 100) * (2 * u - 1))
      if ((H.dims[dim] || 0) > eff) return false
    }
    // any：任一组全满足
    const anys = Array.isArray(when.any) ? when.any : []
    if (anys.length) {
      let okAny = false
      for (const grp of anys) {
        let ok = true
        for (const [dim, thr] of Object.entries(grp || {})) {
          const base = Number(thr)
          const pct = Number(rule.jitter?.thresholdPct) || 0
          const u = ctx.rng()
          const eff = base * (1 + (pct / 100) * (2 * u - 1))
          if ((H.dims[dim] || 0) < eff) { ok = false; break }
        }
        if (ok) { okAny = true; break }
      }
      if (!okAny) return false
    }
    // 静默 / 距开口
    const silMin = Number(when.silenceMin)
    if (Number.isFinite(silMin) && ctx.silence < silMin) return false
    const spMin = Number(when.sinceSpokeMin)
    if (Number.isFinite(spMin) && ctx.sinceSpoke < spMin) return false
    // 时间窗（可抖动）
    const wins = Array.isArray(when.windows) ? when.windows : []
    if (wins.length) {
      const jm = Number(rule.jitter?.windowMinutes) || 0
      if (!wins.some((w) => windowHit(w, ctx.now, jm, ctx.rng))) return false
    }
    // 星期
    const wds = Array.isArray(when.weekdays) ? when.weekdays : []
    if (wds.length && !wds.includes(new Date(ctx.now).getDay())) return false
    // 忙闲
    const kind = ctx.life.activity.kind
    const ain = Array.isArray(when.activityIn) ? when.activityIn : []
    const aout = Array.isArray(when.activityOut) ? when.activityOut : []
    if (ain.length && !ain.includes(kind)) return false
    if (aout.length && aout.includes(kind)) return false
    // 未读上限
    const maxUnread = Number(when.maxUnread)
    if (Number.isFinite(maxUnread) && ctx.unread > maxUnread) return false
    // 群未读：groupUnreadMin / groupUnreadAt（素材 materials.byChannel）
    const gMin = Number(when.groupUnreadMin)
    if (Number.isFinite(gMin) && gMin > 0) {
      const by = (ctx.materials && ctx.materials.byChannel) || {}
      const g = by['qq-group'] || { total: 0, mention: 0 }
      if (Number(g.total || 0) < gMin) return false
      if (when.groupUnreadAt === true && Number(g.mention || 0) < 1) return false
      if (when.groupUnreadAt === false && Number(g.mention || 0) > 0) return false
    }
    // 距下一作息块切换（分钟）
    const near = Number(when.scheduleNearMinutes)
    if (Number.isFinite(near) && near > 0) {
      const next = ctx.materials && ctx.materials.schedule && ctx.materials.schedule.next
      if (!next || !Number.isFinite(Number(next.minutesUntil))) return false
      if (Number(next.minutesUntil) > near) return false
    }
    return true
  }

  function globalGates(rt, kind, H, ctx) {
    const heart = config?.heart || {}
    const g = heart.gates || {}
    const now = ctx.now
    // 总开关
    if (heart.enabled === false) return { ok: false, why: 'heart.enabled=false' }
    if (H.enabled === false) return { ok: false, why: 'heart.disabled' }
    // 夜间静默（仅规则路径固定生效；通知按渠道 injectRespectQuiet）
    if ((kind === 'rule' || kind === 'seek' || kind === 'self') && quietHit(g.quietHours, now)) {
      // 22:30–23:25 的 wind-down 等 self 规则：窗口在规则 when 里已限，仍尊重 quietHours
      return { ok: false, why: 'quietHours' }
    }
    const daily = H.daily || {}
    const dateStr = ymd(new Date(now))
    const day = daily.date === dateStr ? daily : { date: dateStr, notify: 0, rule: 0, self: 0 }
    if (kind === 'seek' || kind === 'rule') {
      const cap = Number(g.dailyCap)
      if (Number.isFinite(cap) && cap >= 0 && (day.rule || 0) >= cap) return { ok: false, why: 'dailyCap' }
      const cd = Number(g.cooldownMinutes)
      if (Number.isFinite(cd) && H.lastRuleInjectAt && now - H.lastRuleInjectAt < cd * 60000) return { ok: false, why: 'cooldown' }
      const ms = Number(g.minSinceSpokeMinutes)
      if (Number.isFinite(ms) && ctx.sinceSpoke < ms) return { ok: false, why: 'minSinceSpoke' }
      const sl = Number(g.minSilenceMinutes)
      if (Number.isFinite(sl) && ctx.silence < sl) return { ok: false, why: 'minSilence' }
      if (g.unansweredNoPile && H.lastUserMsgAt && H.lastOutboundAt && H.lastUserMsgAt > H.lastOutboundAt) {
        const grace = Number(g.unansweredGraceMinutes) || 180
        if (now - H.lastOutboundAt < grace * 60000) return { ok: false, why: 'unanswered' }
      }
    } else if (kind === 'self') {
      const cap = Number(g.selfDailyCap)
      if (Number.isFinite(cap) && cap >= 0 && (day.self || 0) >= cap) return { ok: false, why: 'selfDailyCap' }
      // 冷却取「全局自治冷却」与「该规则 cooldownMinutes」较大者
      const gCd = Number(g.selfCooldownMinutes) || 0
      const rCd = Number(ctx.rule && ctx.rule.cooldownMinutes) || 0
      const cd = Math.max(gCd, rCd)
      if (Number.isFinite(cd) && cd > 0 && H.lastSelfInjectAt && now - H.lastSelfInjectAt < cd * 60000) {
        return { ok: false, why: 'selfCooldown' }
      }
      const ms = Number(g.selfMinSinceSpokeMinutes)
      if (Number.isFinite(ms) && ctx.sinceSpoke < ms) return { ok: false, why: 'selfMinSinceSpoke' }
      const sl = Number(g.selfMinSilenceMinutes)
      if (Number.isFinite(sl) && ctx.silence < sl) return { ok: false, why: 'selfMinSilence' }
    } else {
      // 通知：仅总闸；细闸门走 channelNotifyGate（每渠道 inject*）
      const n = heart.notify || {}
      if (n.enabled === false) return { ok: false, why: 'notify.disabled' }
    }
    return { ok: true }
  }

  // 角色是否正在输出（回合进行中）
  function agentRunning(rt) {
    try {
      const a = rt && rt.agentSession && rt.agentSession.agent
      return !!(a && a.status === 'running')
    } catch (e) { return false }
  }

  function isDmChannel(channel) {
    try {
      const cfg = channelConfig(config, channel)
      return !!(cfg && cfg.notify && cfg.notify.dmPriority)
    } catch (e) { return false }
  }

  // 单渠道通知注入闸门（读 channels.<type>.notify.inject*，每桥一份）
  function channelNotifyGate(channel, H, now) {
    const heart = config?.heart || {}
    const n = (channelConfig(config, channel) || {}).notify || {}
    if (n.injectEnabled === false) return { ok: false, why: channel + ':inject.off' }
    const cd = Number(n.injectCooldownMinutes) || 0
    if (cd > 0) {
      const last = (H.lastNotifyAt && H.lastNotifyAt[channel]) || 0
      if (last && now - last < cd * 60000) return { ok: false, why: channel + ':cooldown' }
    }
    const cap = Number(n.injectDailyCap) || 0
    if (cap > 0) {
      const dateStr = ymd(new Date(now))
      const nc = H.notifyCount && H.notifyCount.date === dateStr ? H.notifyCount : null
      const c = nc && nc.byChannel ? (nc.byChannel[channel] || 0) : 0
      if (c >= cap) return { ok: false, why: channel + ':dailyCap' }
    }
    if (n.injectRespectQuiet && quietHit(heart.gates && heart.gates.quietHours, now)) {
      return { ok: false, why: channel + ':quiet' }
    }
    return { ok: true }
  }

  function buildMaterials(rt, rule, unread) {
    const pm = config?.heart?.payload?.materials || {}
    const rm = rule?.materials || {}
    const tlN = Number(rm.timeline ?? pm.timeline ?? 6)
    const wantDiary = rm.diary !== undefined ? !!rm.diary : !!pm.diary
    let unreadTotal = Number.isFinite(unread) ? unread : 0
    const byChannel = {}
    try {
      const sum = rt.msgStore && rt.msgStore.unreadSummary ? rt.msgStore.unreadSummary() : []
      unreadTotal = 0
      for (const row of sum) {
        const key = String(row.channel || '')
        unreadTotal += Number(row.n) || 0
        if (!byChannel[key]) byChannel[key] = { total: 0, mention: 0 }
        byChannel[key].total += Number(row.n) || 0
        if (rt.msgStore.unreadMentionCount) {
          byChannel[key].mention += Number(rt.msgStore.unreadMentionCount(row.channel, row.target)) || 0
        }
      }
    } catch (e) { /* ignore */ }
    const materials = { unread: unreadTotal, byChannel }
    if (Number.isFinite(tlN) && tlN > 0) {
      try {
        materials.timeline = (rt.state.load().heart.timeline || []).slice(-tlN)
          .map((x) => ({ at: x.at, label: String(x.text || x.label || '').slice(0, 40) }))
      } catch (e) { materials.timeline = [] }
    }
    if (wantDiary) {
      try {
        const d = new Date()
        const p = rt.state.diaryPath(ymd(d))
        materials.diary = { date: ymd(d).slice(5), exists: !!(p && existsSync(p)) }
      } catch (e) {
        materials.diary = { date: '', exists: false }
      }
    }
    // 下一作息块（交接规则用）
    try {
      const now = Date.now()
      const sched = rt.state.loadSchedule ? rt.state.loadSchedule() : null
      const blocks = (sched && sched.weekday) || []
      // 简化：找今天内下一个 from
      let next = null
      let best = Infinity
      for (const b of blocks) {
        const [hh, mm] = String(b.from || '00:00').split(':').map(Number)
        if (!Number.isFinite(hh)) continue
        const t0 = new Date(now); t0.setHours(hh, mm || 0, 0, 0)
        let delta = t0.getTime() - now
        if (delta < 0) delta += 24 * 3600000
        if (delta < best) {
          best = delta
          next = { from: b.from, to: b.to, kind: b.kind, label: b.label || b.kind, minutesUntil: Math.round(delta / 60000) }
        }
      }
      if (next) materials.schedule = { next }
    } catch (e) { /* ignore */ }
    return materials
  }

  function flushOne(rt, causes) {
    try {
      if (rt.char && rt.char.enabled === false) return
      if (!rt.agentSession || typeof rt.agentSession.inject !== 'function') return
      const heart = config?.heart || {}
      if (heart.enabled === false) return

      const now = Date.now()
      // 惰性衰减 + 生活推进（每次评估先算账）
      let H
      try { H = rt.state.decay() } catch (e) { H = rt.state.getState({ persist: false }) }
      try { rt.state.advance() } catch (e) { /* ignore */ }

      const unread = notifyPayload(rt)
      const silence = rt.state.silenceMinutes()
      const sinceSpoke = rt.state.sinceSpokeMinutes()
      const life = rt.state.load().life

      // ── 忙闲门控：正在输出则不打断（未读累加，idle 时一次带齐）──
      if (agentRunning(rt)) {
        if (unread.length) {
          logLine(`eval[${rt.name}] 输出中，通知挂起 unread=${unread.length}`)
          diag(`eval[${rt.name}] 正在输出，通知延至空闲`)
        }
        return
      }

      // ── 通知优先 ──
      if (unread.length) {
        // 防自激：同一批未读只注入一次；新消息（新 msg_id）才再注入
        const ids = unreadMsgIds(rt)
        let set = offeredNotify.get(rt.wsPath)
        if (!set) { set = new Set(); offeredNotify.set(rt.wsPath, set) }
        // 清掉已读/消失的 id，避免集合无限膨胀
        if (ids.length) {
          for (const id of [...set]) { if (!ids.includes(id)) set.delete(id) }
        }
        const fresh = ids.length ? ids.filter((id) => !set.has(id)) : []
        if (ids.length && !fresh.length) {
          logLine(`eval[${rt.name}] 通知已注入过，跳过（${ids.length} 条未读无新消息）`)
          return
        }
        // 无 id 信息时退化为：距上次注入 <3s 则跳过（防 agent/status 风暴）
        if (!ids.length) {
          const last = H.lastNotifyInjectAt || 0
          if (last && now - last < 3000) return
        }

        const primary = unread.find((n) => isDmChannel(n.channel)) || unread[0]
        const gate = channelNotifyGate(primary.channel, H, now)
        const master = globalGates(rt, 'notify', H, { now, heart: H, silence, sinceSpoke, life, unread: unread.length })
        if (master.ok && gate.ok) {
          // 同步标记已提供，避免 inject→idle→再评估 的竞态重复注入
          for (const id of fresh) set.add(id)
          if (!ids.length) set.add(`__ts_${now}`)
          const text = JSON.stringify({ type: 'kernel-wake', notifications: unread })
          const chForCount = primary.channel
          try { rt.state.recordInject({ kind: 'notify', channel: chForCount }) } catch (e) { /* ignore */ }
          rt.agentSession.inject({ text, kind: 'kernel' })
            .then(() => {
              // 注入成功 = 内容已进她上下文：本地标已读，避免「一发消息整段历史又像未读」
              try {
                for (const n of unread) {
                  if (n && n.channel && n.target != null && rt.msgStore) {
                    rt.msgStore.markRead(n.channel, String(n.target))
                  }
                }
              } catch (e) { /* ignore */ }
            })
            .catch((e) => diag('通知注入失败：' + (e && e.message)))
          logLine(`eval[${rt.name}] 通知注入 unread=${unread.length} channel=${chForCount} fresh=${fresh.length}`)
          diag(`eval[${rt.name}] 有未读，注入通知（${chForCount}）`)
          return
        }
        const why = !master.ok ? master.why : gate.why
        logLine(`eval[${rt.name}] 通知被闸跳过（${why}）unread=${unread.length}`)
        return
      }

      // ── 心绪规则 ──
      const rules = Array.isArray(heart.rules) ? heart.rules : []
      for (const rule of rules) {
        if (!rule || rule.enabled === false) continue
        const rng = makeRng(rule.id || 'r', [...causes][0] || 'x')
        let materials = null
        try { materials = buildMaterials(rt, rule, 0) } catch (e) { materials = { unread: 0 } }
        const ctx = { now, heart: H, silence, sinceSpoke, life, unread: materials.unread || 0, rng, lastFired: null, materials, rule }
        let matched = false
        try { matched = matchRule(rule, ctx) } catch (e) {
          logLine(`eval[${rt.name}] 规则${rule.id} 匹配异常：${e.message}`)
          continue
        }
        if (!matched) {
          if (ctx.lastFired) {
            logLine(`eval[${rt.name}] 规则${rule.id} 未命中 ${ctx.lastFired.dim}=${H.dims[ctx.lastFired.dim]} < 有效${ctx.lastFired.effective}`)
          }
          continue
        }
        const gateKind = rule.intent === 'self_chore' || rule.intent === 'reflect' ? 'self' : 'seek'
        const gate = globalGates(rt, gateKind, H, ctx)
        if (!gate.ok) {
          logLine(`eval[${rt.name}] 规则${rule.id} 过闸失败（${gate.why}）`)
          continue
        }
        const chance = Number(rule.jitter?.chance)
        const p = Number.isFinite(chance) ? chance : 1
        if (rng() > p) {
          logLine(`eval[${rt.name}] 规则${rule.id} 概率未过 chance=${p}`)
          continue
        }
        // 命中 → 注入纯 JSON
        const fired = ctx.lastFired || { dim: null, base: null, effective: null, chance: p }
        if (config?.heart?.payload?.materials?.fired !== false) materials.fired = fired
        const payload = heartPayload(rt, rule, fired, materials)
        const text = JSON.stringify(payload)
        // 扫描：载荷不得含话术词（白名单外的祈使句不应出现）
        if (/[要不要|去找|主人|念头|起念|想你|该不该]/.test(text) && !text.includes('"label"')) {
          // label 可能来自时间线短标签；仅告警不拦截数据字段
          diag(`eval 载荷含疑似话术词，rule=${rule.id}`)
        }
        rt.agentSession.inject({ text, kind: 'kernel' }).then(() => {
          try {
            rt.state.recordInject({
              kind: gateKind === 'self' ? 'self' : 'rule',
              ruleId: rule.id,
            })
          } catch (e) { /* ignore */ }
        }).catch((e) => diag('心绪注入失败：' + (e && e.message)))
        logLine(`eval[${rt.name}] 规则${rule.id}（${rule.name || ''}）命中注入 fired=${JSON.stringify(fired)}`)
        diag(`eval[${rt.name}] 规则命中：${rule.name || rule.id}`)
        return // 一次评估最多一条
      }
      try { rt.state.noteEval() } catch (e) { /* ignore */ }
    } catch (e) {
      logLine(`eval[${rt && rt.name}] flush 异常：${e && e.message}`)
      diag('eval 异常：' + (e && e.message))
    }
  }

  function flush() {
    flushScheduled = false
    for (const [wsPath, causes] of [...pending.entries()]) {
      pending.delete(wsPath)
      const rt = rtCache.get(wsPath)
      if (rt) flushOne(rt, causes)
    }
  }

  const rtCache = new Map() // wsPath -> rt（request 时写入）

  function request(rt, cause = 'event') {
    if (!rt || !rt.wsPath) return
    rtCache.set(rt.wsPath, rt)
    let set = pending.get(rt.wsPath)
    if (!set) { set = new Set(); pending.set(rt.wsPath, set) }
    set.add(String(cause || 'event'))
    if (!flushScheduled) {
      flushScheduled = true
      setImmediate(() => {
        try { flush() } catch (e) { logLine('eval flush 失败：' + e.message) }
      })
    }
  }

  return { request }
}

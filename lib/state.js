// dsh-her-kernel · 状态与行为层（心绪 + 日子）
//
// ⭐ 心绪层（v3）：原心情 7 维 + 心思 5 维合并为一层 10 维 + 底色。
//    主动触发、情绪表达、面板、注入、state_now/state_note 全部只读这一层。
//    心思与心情不再是两套账。
// ⭐ 日子层：作息表 / 精力兴致 / 日记提醒 —— 回答「她在做什么」，不并进心绪。
//    作息由角色自己用 life_schedule_set 排，内核不硬编码。
//
// 事件驱动规则触发见 wake.js（createEval）：无插件定时器。
// state.json = { v: 3, heart: {...}, life: {...} }
// 作息仍单独存 life-schedule.json。
// 自迁移：v2（mood+mind）→ v3 heart；旧 mood.json/proactive.json 组装路径保留。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ══════════ 心绪 10 维 ══════════
// 原心情：happy calm sweet heartache worry sad jealous
// 原心思：miss joy curious tired down
// 合并：happy∪joy→joy；sad∪down→sad
export const HEART_DIMS = [
  ['miss', '思念'],
  ['joy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜蜜'],
  ['sad', '难过'],
  ['worry', '担心'],
  ['heartache', '心疼'],
  ['jealous', '吃醋'],
  ['tired', '疲惫'],
  ['curious', '好奇'],
]
// 系数默认在 DEFAULT_CONFIG.mood / DEFAULT_CONFIG.life；state 内只做 fallback
const FALLBACK_NEED_STEP = {
  sleep: { energy: +0.55, interest: -0.02, company: -0.01 },
  sleepy: { energy: -0.15, interest: -0.05, company: +0.03 },
  wake: { energy: +0.05, interest: +0.05, company: +0.02 },
  tidy: { energy: -0.08, interest: +0.04, company: -0.02 },
  bowl: { energy: +0.40, interest: 0, company: +0.01 },
  schedule: { energy: -0.04, interest: +0.02, company: 0 },
  bili: { energy: -0.03, interest: +0.12, company: -0.01 },
  wait: { energy: -0.02, interest: -0.02, company: +0.12 },
  chat: { energy: -0.03, interest: +0.05, company: -0.08 },
  anime: { energy: -0.04, interest: +0.10, company: 0 },
  music: { energy: -0.02, interest: +0.06, company: +0.01 },
  stars: { energy: -0.03, interest: +0.05, company: +0.02 },
  game: { energy: -0.07, interest: +0.10, company: 0 },
  night: { energy: -0.06, interest: +0.06, company: +0.02 },
  out: { energy: -0.08, interest: +0.08, company: +0.02 },
  home: { energy: -0.03, interest: +0.03, company: +0.01 },
  gap: { energy: -0.02, interest: 0, company: +0.01 },
}

// ══════════ 日子段 ══════════
const KINDS = ['sleep', 'wake', 'tidy', 'bowl', 'schedule', 'bili', 'wait', 'chat', 'anime', 'music', 'stars', 'game', 'night', 'out', 'home', 'gap']
const NEUTRAL_STEP = { energy: -0.02, interest: 0, company: +0.01 }

// ══════════ 通用小工具 ══════════
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)) }
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function pad(n) { return String(n).padStart(2, '0') }
function hhmm(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 24 || mi < 0 || mi > 59) return null
  return (h * 60 + mi) % 1440
}
function normBlockList(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const b of list) {
    const from = parseHM(b?.from), to = parseHM(b?.to)
    const kind = String(b?.kind || '').trim()
    if (from == null || to == null || !kind) return null
    const o = { from: String(b.from).trim(), to: String(b.to).trim(), kind }
    if (typeof b.label === 'string' && b.label.trim()) o.label = b.label.trim().slice(0, 60)
    out.push(o)
  }
  return out.length ? out : null
}
function normSchedule(raw) {
  return {
    version: 1,
    note: String(raw?.note || ''),
    weekday: Array.isArray(raw?.weekday) ? (normBlockList(raw.weekday) || []) : [],
    weekend: Array.isArray(raw?.weekend) ? (normBlockList(raw.weekend) || []) : [],
    special: (raw?.special && typeof raw.special === 'object') ? raw.special : {},
  }
}
function blockFor(ts, sched) {
  const d = new Date(ts)
  const dateStr = ymd(d)
  const day = d.getDay()
  const min = d.getHours() * 60 + d.getMinutes()
  const list = sched.special[dateStr] || ((day === 0 || day === 6) ? sched.weekend : sched.weekday)
  for (const b of (Array.isArray(list) ? list : [])) {
    const f = parseHM(b.from), t = parseHM(b.to)
    if (f == null || t == null) continue
    if (f <= t) { if (min >= f && min < t) return b }
    else { if (min >= f || min < t) return b }
  }
  return { kind: 'chat', label: '待着' }
}

// ══════════ 心绪空值 / 规范化 / 迁移 ══════════
function blankHeart(base, now = Date.now()) {
  const dims = {}
  for (const [k] of HEART_DIMS) dims[k] = 0
  return {
    version: 3,
    base,
    dims,
    updatedAt: now,
    injectedFor: 0,
    lastReason: '',
    lastConfidence: 0,
    lastTickAt: now,
    lastSpokeAt: 0,
    lastUserMsgAt: 0,
    lastOutboundAt: 0,
    moodTimeline: [],
    timeline: [],
    saidAt: [],
    daily: { date: '', notify: 0, rule: 0, self: 0 },
    lastNotifyInjectAt: 0,
    lastRuleInjectAt: 0,
    lastSelfInjectAt: 0,
    lastEvalAt: 0,
    enabled: true,
  }
}
function normHeart(raw, base, now = Date.now()) {
  const s = blankHeart(base, now)
  if (!raw || typeof raw !== 'object') return s
  const b = Number(raw.base)
  if (Number.isFinite(b)) s.base = clamp(Math.round(b), 0, 100)
  if (raw.dims && typeof raw.dims === 'object') {
    for (const [k] of HEART_DIMS) {
      const v = Number(raw.dims[k])
      if (Number.isFinite(v)) s.dims[k] = clamp(Math.round(v), 0, 100)
    }
  }
  for (const k of ['updatedAt', 'injectedFor', 'lastConfidence', 'lastTickAt', 'lastSpokeAt', 'lastUserMsgAt', 'lastOutboundAt', 'lastNotifyInjectAt', 'lastRuleInjectAt', 'lastSelfInjectAt', 'lastEvalAt']) {
    const v = Number(raw[k]); if (Number.isFinite(v)) s[k] = v
  }
  if (typeof raw.lastReason === 'string') s.lastReason = raw.lastReason
  if (Array.isArray(raw.moodTimeline)) s.moodTimeline = raw.moodTimeline.slice(-200)
  if (Array.isArray(raw.timeline)) s.timeline = raw.timeline.slice(-50)
  if (Array.isArray(raw.saidAt)) s.saidAt = raw.saidAt.slice(-100)
  if (raw.daily && typeof raw.daily === 'object') {
    s.daily = {
      date: String(raw.daily.date || ''),
      notify: Number(raw.daily.notify) || 0,
      rule: Number(raw.daily.rule) || 0,
      self: Number(raw.daily.self) || 0,
    }
  }
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled
  return s
}

// v2 {mood, mind} → v3 {heart}
function migrateV2toV3(raw, base, now) {
  const mood = raw?.mood && typeof raw.mood === 'object' ? raw.mood : null
  const mind = raw?.mind && typeof raw.mind === 'object' ? raw.mind : null
  const h = blankHeart(base, now)
  if (mood) {
    if (Number.isFinite(Number(mood.mood))) h.base = clamp(Math.round(Number(mood.mood)), 0, 100)
    const md = mood.dims || {}
    // 心情维度平移（happy→joy 已在 max 里合并）
    const map = { calm: 'calm', sweet: 'sweet', heartache: 'heartache', worry: 'worry', sad: 'sad', jealous: 'jealous', happy: 'joy' }
    for (const [from, to] of Object.entries(map)) {
      const v = Number(md[from])
      if (Number.isFinite(v)) h.dims[to] = Math.max(h.dims[to], clamp(Math.round(v), 0, 100))
    }
    if (Number.isFinite(Number(mood.updatedAt))) h.updatedAt = Number(mood.updatedAt)
    if (Number.isFinite(Number(mood.injectedFor))) h.injectedFor = Number(mood.injectedFor)
    if (Number.isFinite(Number(mood.lastConfidence))) h.lastConfidence = Number(mood.lastConfidence)
    if (typeof mood.lastReason === 'string') h.lastReason = mood.lastReason
    if (Array.isArray(mood.timeline)) h.moodTimeline = mood.timeline.slice(-200)
    if (Array.isArray(mood.saidAt)) h.saidAt = mood.saidAt.slice(-100)
  }
  if (mind) {
    const pd = mind.dims || {}
    const map = { miss: 'miss', joy: 'joy', curious: 'curious', tired: 'tired', down: 'sad' }
    for (const [from, to] of Object.entries(map)) {
      const v = Number(pd[from])
      if (Number.isFinite(v)) h.dims[to] = Math.max(h.dims[to], clamp(Math.round(v), 0, 100))
    }
    if (Number.isFinite(Number(mind.lastTickAt))) h.lastTickAt = Number(mind.lastTickAt)
    if (Number.isFinite(Number(mind.lastSpokeAt))) {
      h.lastSpokeAt = Number(mind.lastSpokeAt)
      h.lastOutboundAt = Number(mind.lastSpokeAt) // 保守初值
    }
    if (Number.isFinite(Number(mind.lastUserMsgAt))) h.lastUserMsgAt = Number(mind.lastUserMsgAt)
    if (Array.isArray(mind.timeline)) h.timeline = mind.timeline.slice(-50)
    if (typeof mind.enabled === 'boolean') h.enabled = mind.enabled
  }
  return {
    v: 3,
    heart: h,
    life: normLife(raw?.life, now),
  }
}

function blankLife(now) {
  return {
    version: 1,
    needs: { energy: 72, interest: 58, company: 46 },
    activity: { kind: 'chat', label: '待着', since: now - 5 * 60 * 1000 },
    timeline: [],
    lastAdvanceAt: now - 5 * 60 * 1000,
    lastInjectAt: 0,
    lastInjectSig: '',
    diary: { lastPromptedDate: '' },
  }
}
function normLife(raw, now) {
  const s = blankLife(now)
  if (!raw || typeof raw !== 'object') return s
  if (raw.needs && typeof raw.needs === 'object') {
    for (const k of ['energy', 'interest', 'company']) { const v = Number(raw.needs[k]); if (Number.isFinite(v)) s.needs[k] = clamp(Math.round(v), 0, 100) }
  }
  if (raw.activity && typeof raw.activity === 'object' && raw.activity.kind) {
    s.activity = { kind: String(raw.activity.kind), label: String(raw.activity.label || '待着'), since: Number(raw.activity.since) || now }
  }
  if (Array.isArray(raw.timeline)) s.timeline = raw.timeline.slice(-200)
  for (const k of ['lastAdvanceAt', 'lastInjectAt']) { const v = Number(raw[k]); if (Number.isFinite(v)) s[k] = v }
  if (typeof raw.lastInjectSig === 'string') s.lastInjectSig = raw.lastInjectSig
  if (raw.diary && typeof raw.diary === 'object') s.diary = { lastPromptedDate: String(raw.diary.lastPromptedDate || '') }
  return s
}

export function createState({ storeDir, config, diag = () => {} }) {
  const STATE_PATH = join(storeDir, 'state.json')
  const SCHEDULE_PATH = join(storeDir, 'life-schedule.json')
  const moodBase = () => config.mood?.base ?? 70
  const moodFloor = () => config.mood?.floor ?? 0
  const moodHalfHours = () => config.mood?.decayHalfHours ?? 12
  const moodStepDivisor = () => Math.max(1, Number(config.mood?.stepDivisor) || 3)
  const dimDecayPerHour = () => Number(config.mood?.dimDecayPerHour) || 0.06
  const dimDecayCap = () => Number(config.mood?.dimDecayCap) || 0.4
  const missPerSilenceHour = () => Number(config.mood?.missPerSilenceHour) || 1.2
  const missSilenceCap = () => Number(config.mood?.missSilenceCap) || 25
  const lifeStepMs = () => Math.max(60000, (Number(config.life?.stepMinutes) || 5) * 60000)
  const lifeGapFoldMs = () => Math.max(3600000, (Number(config.life?.gapFoldHours) || 48) * 3600000)
  const lifeGapReset = () => {
    const r = config.life?.gapReset || {}
    return {
      energy: Number.isFinite(Number(r.energy)) ? Number(r.energy) : 68,
      interest: Number.isFinite(Number(r.interest)) ? Number(r.interest) : 55,
      company: Number.isFinite(Number(r.company)) ? Number(r.company) : 44,
    }
  }
  const lifeStepEffect = (kind) => {
    const t = config.life?.stepEffects && config.life.stepEffects[kind]
    if (t && typeof t === 'object') {
      return {
        energy: Number.isFinite(Number(t.energy)) ? Number(t.energy) : 0,
        interest: Number.isFinite(Number(t.interest)) ? Number(t.interest) : 0,
        company: Number.isFinite(Number(t.company)) ? Number(t.company) : 0,
      }
    }
    return FALLBACK_NEED_STEP[kind] || NEUTRAL_STEP
  }
  const heartBaselines = () => {
    const b = config.heart?.baselines || {}
    const out = {}
    for (const [k] of HEART_DIMS) out[k] = Number.isFinite(Number(b[k])) ? Number(b[k]) : 0
    // 缺省回落到设计默认
    const def = { miss: 30, joy: 30, curious: 30, tired: 20, sad: 10 }
    for (const [k, v] of Object.entries(def)) if (!Number.isFinite(Number(b[k]))) out[k] = v
    return out
  }

  function loadLegacy() {
    const now = Date.now()
    const read = (name) => { try { return JSON.parse(readFileSync(join(storeDir, name), 'utf8')) } catch { return null } }
    return migrateV2toV3({ mood: read('mood.json'), mind: read('proactive.json'), life: read('life.json') }, moodBase(), now)
  }
  function load() {
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
      const now = Date.now()
      if (raw && raw.v >= 3 && raw.heart) {
        return {
          v: 3,
          heart: normHeart(raw.heart, moodBase(), now),
          life: normLife(raw.life, now),
        }
      }
      // v2 或旧结构 → v3，备份后写回
      const migrated = migrateV2toV3(raw, moodBase(), now)
      try {
        if (existsSync(STATE_PATH)) copyFileSync(STATE_PATH, STATE_PATH + '.bak-v2')
      } catch (e) { /* ignore */ }
      save(migrated)
      diag('state.json 已迁移到心绪 v3')
      return migrated
    } catch {
      const s = loadLegacy()
      save(s)
      diag('state.json 缺失/损坏，已组装' + (existsSync(join(storeDir, 'mood.json')) ? '（来自旧文件）' : '（空状态起步）'))
      return s
    }
  }
  function save(s) {
    try {
      mkdirSync(storeDir, { recursive: true })
      const tmp = STATE_PATH + '.tmp'
      writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
      renameSync(tmp, STATE_PATH)
    } catch (e) { diag('状态保存失败：' + (e && e.message)) }
  }

  // ══════════ 心绪 API ══════════
  function decayHeartPart(s, now = Date.now()) {
    const H = s.heart
    const hours = (now - H.lastTickAt) / 3600000
    if (hours <= 0) return s
    const bl = heartBaselines()
    // 底色半衰期
    const halflife = moodHalfHours()
    const k = Math.pow(0.5, hours / halflife)
    H.base = clamp(moodBase() + (H.base - moodBase()) * k, moodFloor(), 100)
    // 10 维往基线回归：d += (base[k]-d) × min(Δt小时 × dimDecayPerHour, dimDecayCap)
    const rate = dimDecayPerHour()
    const cap = dimDecayCap()
    for (const [d] of HEART_DIMS) {
      H.dims[d] = clamp(H.dims[d] + (bl[d] - H.dims[d]) * Math.min(hours * rate, cap), 0, 100)
    }
    // 静默驱动思念：Δt>0.5h 后 miss += min(Δt小时 × missPerSilenceHour, missSilenceCap)
    const silenceH = H.lastUserMsgAt ? (now - H.lastUserMsgAt) / 3600000 : 0
    if (silenceH > 0.5) {
      H.dims.miss = clamp(H.dims.miss + Math.min(silenceH * missPerSilenceHour(), missSilenceCap()), 0, 100)
    }
    H.lastTickAt = now
    return s
  }

  function getState({ persist = true } = {}) {
    const s = decayHeartPart(load())
    if (persist) save(s)
    return s.heart
  }
  // 兼容旧名：部分调用方仍叫 getState；返回 heart 形状
  function getHeart(opts) { return getState(opts) }

  function applyDelta(delta, { minor = false } = {}) {
    const s = decayHeartPart(load())
    const H = s.heart
    const step = Math.round((Number(delta.moodDelta) || 0) / moodStepDivisor())
    H.base = clamp(H.base + step, moodFloor(), 100)
    for (const [d] of HEART_DIMS) {
      const v = Number(delta.dims?.[d]) || 0
      if (v) H.dims[d] = clamp(H.dims[d] + v, 0, 100)
    }
    H.updatedAt = Date.now()
    H.lastReason = delta.reason || ''
    H.lastConfidence = Number(delta.confidence) || 0
    if (!minor) {
      H.moodTimeline.push({ at: H.updatedAt, mood: Math.round(H.base), delta: step, reason: H.lastReason, conf: H.lastConfidence })
      if (H.moodTimeline.length > 200) H.moodTimeline = H.moodTimeline.slice(-200)
    }
    save(s)
    return H
  }
  function moodLabel(v) {
    if (v >= 85) return '很开心'
    if (v >= 70) return '不错'
    if (v >= 55) return '一般'
    if (v >= 40) return '有点闷'
    return '不太开心'
  }
  function moodEmoji(v) {
    if (v >= 85) return '✧(≧▽≦)'
    if (v >= 70) return '(＾▽＾)'
    if (v >= 55) return '(・ω・)'
    if (v >= 40) return '(´-ω-`)'
    return '(；ω；)'
  }
  function heartLine(mode = '') {
    const H = getState({ persist: false })
    const strongest = HEART_DIMS.map(([k, label]) => ({ key: k, label, v: H.dims[k] })).sort((a, b) => b.v - a.v)[0]
    let line = `（我这会儿的心绪）底色${moodLabel(H.base)}（${Math.round(H.base)}）`
    if (strongest && strongest.v >= 3) line += `，${strongest.label} ${Math.round(strongest.v)}`
    if (H.lastReason && H.injectedFor !== H.updatedAt && H.lastConfidence >= (config.mood?.injectConfidence ?? 60)) {
      line += `。${H.lastReason}`
    }
    return line
  }
  // 兼容旧名
  function moodLine(mode = '') { return heartLine(mode) }

  function markInjected() {
    const s = load()
    s.heart.injectedFor = s.heart.updatedAt
    s.heart.saidAt = [...(s.heart.saidAt || []), Date.now()].slice(-100)
    save(s)
  }

  // ══════════ 日子 API ══════════
  function loadSchedule() {
    try { return normSchedule(JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'))) }
    catch {
      const sc = normSchedule(null)
      try { saveSchedule(sc) } catch (e) { /* ignore */ }
      return sc
    }
  }
  function saveSchedule(sched) {
    try {
      mkdirSync(storeDir, { recursive: true })
      const tmp = SCHEDULE_PATH + '.tmp'
      writeFileSync(tmp, JSON.stringify(sched, null, 2), 'utf8')
      renameSync(tmp, SCHEDULE_PATH)
    } catch (e) { diag('作息保存失败：' + (e && e.message)) }
  }
  function advance(now = Date.now()) {
    const s = load()
    const L = s.life
    const sched = loadSchedule()
    const stepMs = lifeStepMs()
    let t = Number(L.lastAdvanceAt) || (now - stepMs)
    if (now - t > lifeGapFoldMs()) {
      L.timeline.push({ at: now, kind: 'gap', label: '离开了一段时间，日子照常过着' })
      L.needs = { ...lifeGapReset() }
      L.lastAdvanceAt = now - 10 * 60 * 1000
      t = L.lastAdvanceAt
    }
    let guard = 0
    while (t + stepMs <= now && guard < 5000) {
      t += stepMs
      guard++
      const b = blockFor(t, sched)
      if (b.kind !== L.activity.kind || (b.label && b.label !== L.activity.label)) {
        L.activity = { kind: b.kind, label: b.label || b.kind, since: t }
        L.timeline.push({ at: t, kind: b.kind, label: b.label || b.kind })
      }
      const step = b.effect || lifeStepEffect(b.kind)
      for (const k of ['energy', 'interest', 'company']) {
        if (Number.isFinite(step[k])) L.needs[k] = clamp(L.needs[k] + step[k], 0, 100)
      }
    }
    if (L.timeline.length > 200) L.timeline = L.timeline.slice(-200)
    L.lastAdvanceAt = Math.max(t, L.lastAdvanceAt)
    save(s)
    return L
  }
  function diaryPath(dateStr) {
    const ws = (config.life && config.life.lifeWorkspace) || resolve(storeDir, '..')
    if (!ws) return ''
    return join(ws, '日记', dateStr + '.md')
  }
  function contextText(now = Date.now()) {
    const L = advance(now)
    const d = new Date(now)
    const dateStr = ymd(d)
    const timeStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]} ${hhmm(now)}`
    const lines = []
    lines.push(`（我的日子）现在 ${timeStr}。${L.activity.label}。`)
    const sched = loadSchedule()
    const emptySched = !(sched.weekday && sched.weekday.length) && !(sched.weekend && sched.weekend.length) && !Object.keys(sched.special || {}).length
    if (emptySched) lines.push('（作息还没排。想排可以用 life_schedule_set。）')
    lines.push(`精力 ${Math.round(L.needs.energy)}，兴致 ${Math.round(L.needs.interest)}，想黏人的程度 ${Math.round(L.needs.company)}。`)
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0)
    const recent = L.timeline.filter((x) => x.at >= startOfToday.getTime()).slice(-5)
    if (recent.length) lines.push('今天：' + recent.map((x) => `${hhmm(x.at)} ${x.label}`).join('；') + '。')
    const dp = diaryPath(dateStr)
    const shouldNudge = dp && !existsSync(dp) && d.getHours() >= (config.life?.diaryNudgeAfterHour ?? 20) && L.diary.lastPromptedDate !== dateStr
    if (shouldNudge && dp) {
      lines.push(`今天还没写日记。想写就写到 ${dp}，不必特地再说一声。`)
      const full = load()
      full.life.diary.lastPromptedDate = dateStr
      save(full)
    }
    return lines.join('\n')
  }
  function setSchedule(patch) {
    const cur = loadSchedule()
    const next = { ...cur }
    if (patch && typeof patch === 'object') {
      if (patch.note != null) next.note = String(patch.note).slice(0, 200)
      const wd = normBlockList(patch.weekday), we = normBlockList(patch.weekend)
      if (patch.weekday != null && !wd) return { ok: false, error: 'weekday 不是合法的块列表' }
      if (patch.weekend != null && !we) return { ok: false, error: 'weekend 不是合法的块列表' }
      if (wd) next.weekday = wd
      if (we) next.weekend = we
      if (patch.special && typeof patch.special === 'object') next.special = patch.special
    }
    saveSchedule(next)
    return { ok: true, schedule: next }
  }

  // ══════════ 心绪事件 ══════════
  function bump(kind, amount = 4) {
    const s = load()
    const H = s.heart
    const now = Date.now()
    const a = amount
    switch (kind) {
      case 'userMsg':
        H.dims.miss = clamp(H.dims.miss - a * 2, 0, 100)
        H.lastUserMsgAt = now
        break
      case 'replied':
        H.dims.miss = clamp(H.dims.miss - a, 0, 100)
        H.lastOutboundAt = now
        break
      case 'praised':
        H.dims.joy = clamp(H.dims.joy + a * 2, 0, 100)
        break
      case 'ignored':
        H.dims.miss = clamp(H.dims.miss + a, 0, 100)
        H.dims.sad = clamp(H.dims.sad + a / 2, 0, 100)
        break
      case 'busy':
        H.dims.tired = clamp(H.dims.tired + a / 2, 0, 100)
        break
      case 'goodEvent':
        H.dims.joy = clamp(H.dims.joy + a * 2, 0, 100)
        H.dims.curious = clamp(H.dims.curious + a, 0, 100)
        break
      case 'badEvent':
        H.dims.sad = clamp(H.dims.sad + a, 0, 100)
        break
    }
    save(s)
  }
  function decay(now = Date.now()) {
    const s = decayHeartPart(load(), now)
    save(s)
    return s.heart
  }
  function silenceMinutes(now = Date.now()) {
    const s = load()
    return s.heart.lastUserMsgAt ? (now - s.heart.lastUserMsgAt) / 60000 : Infinity
  }
  function sinceSpokeMinutes(now = Date.now()) {
    const s = load()
    return s.heart.lastSpokeAt ? (now - s.heart.lastSpokeAt) / 60000 : Infinity
  }
  function strengthOf(H) {
    let m = 0
    for (const [k] of HEART_DIMS) m = Math.max(m, H.dims[k] || 0)
    return m
  }
  // 展示用双阈值（真正触发由 wake.js 规则引擎决定）
  function shouldSpeak(cfg) {
    const H = decay()
    const strength = strengthOf(H)
    const silence = silenceMinutes()
    const g = cfg?.gates || cfg || {}
    const think = (g.thinkThreshold ?? 35) / 100
    const speak = (g.speakThreshold ?? 72) / 100
    const sinceSpoke = sinceSpokeMinutes()
    const quietOk = silence > (g.minSilenceMinutes ?? 30)
    const sinceSpokeOk = sinceSpoke > (g.minSinceSpokeMinutes ?? 60)
    const score = strength / 100
    return {
      strength,
      silence,
      score,
      wantThink: score >= think,
      wantSpeak: score >= speak && quietOk && sinceSpokeOk,
      quietOk,
      sinceSpokeOk,
    }
  }
  function recordSaid(text) {
    const s = load()
    s.heart.lastSpokeAt = Date.now()
    s.heart.timeline.push({ at: Date.now(), text, proactive: true, self_initiated: true })
    if (s.heart.timeline.length > 50) s.heart.timeline = s.heart.timeline.slice(-50)
    save(s)
    return s.heart
  }
  // 规则/通知注入记账：冷却、每日上限、防自循环
  function recordInject({ kind = 'rule', ruleId = '', channel = '' } = {}) {
    const s = load()
    const H = s.heart
    const now = Date.now()
    const dateStr = ymd(new Date(now))
    if (H.daily?.date !== dateStr) {
      H.daily = { date: dateStr, notify: 0, rule: 0, self: 0 }
    }
    if (!H.daily.self) H.daily.self = 0
    if (kind === 'notify') {
      H.daily.notify = (H.daily.notify || 0) + 1
      H.lastNotifyInjectAt = now
      // 每渠道注入统计（冷却/日上限按渠道读取）
      if (!H.notifyCount || H.notifyCount.date !== dateStr) {
        H.notifyCount = { date: dateStr, byChannel: {} }
      }
      const ch = String(channel || '*')
      H.notifyCount.byChannel[ch] = (H.notifyCount.byChannel[ch] || 0) + 1
      if (!H.lastNotifyAt || typeof H.lastNotifyAt !== 'object') H.lastNotifyAt = {}
      H.lastNotifyAt[ch] = now
      // ⚠️ 通知注入 ≠ 她开口：不更新 lastSpokeAt（否则规则 minSinceSpoke 被每条消息重置）
    } else if (kind === 'self') {
      H.daily.self = (H.daily.self || 0) + 1
      H.lastSelfInjectAt = now
      H.lastEvalAt = now
      H.timeline.push({ at: now, text: `[inject:self:${ruleId || kind}]`, proactive: true, self_initiated: true })
      if (H.timeline.length > 50) H.timeline = H.timeline.slice(-50)
    } else {
      H.daily.rule = (H.daily.rule || 0) + 1
      H.lastRuleInjectAt = now
      H.lastSpokeAt = now
      H.timeline.push({ at: now, text: `[inject:${ruleId || kind}]`, proactive: true, self_initiated: true })
      if (H.timeline.length > 50) H.timeline = H.timeline.slice(-50)
    }
    H.lastEvalAt = now
    save(s)
    return H
  }
  function noteEval() {
    const s = load()
    s.heart.lastEvalAt = Date.now()
    save(s)
  }
  function hookEvent(event) {
    if (!event || typeof event !== 'object') return
    const { type, moodDelta, amount = 3 } = event
    if (type === 'mood' && Number.isFinite(Number(moodDelta))) {
      const d = Number(moodDelta)
      const s = load()
      if (d > 0) {
        s.heart.dims.joy = clamp(s.heart.dims.joy + d, 0, 100)
        s.heart.dims.miss = clamp(s.heart.dims.miss - d / 2, 0, 100)
      } else if (d < 0) {
        s.heart.dims.sad = clamp(s.heart.dims.sad + Math.abs(d), 0, 100)
        s.heart.dims.miss = clamp(s.heart.dims.miss + Math.abs(d) / 2, 0, 100)
      }
      save(s)
    } else if (type === 'memory') {
      const s = load()
      s.heart.dims.curious = clamp(s.heart.dims.curious + amount / 2, 0, 100)
      save(s)
    }
  }

  return {
    // 心绪
    getState, getHeart, applyDelta, heartLine, moodLine, markInjected, moodLabel, moodEmoji, HEART_DIMS,
    strengthOf, sinceSpokeMinutes, recordInject, noteEval,
    // 日子
    advance, contextText, loadSchedule, setSchedule, KINDS, SCHEDULE_PATH, diaryPath,
    // 事件
    bump, decay, silenceMinutes, shouldSpeak, recordSaid, hookEvent,
    // 底层
    load, save, STATE_PATH,
  }
}

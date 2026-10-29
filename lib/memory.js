// dsh-her-kernel · 记忆层（参考 meow-memory；独立重写，单会话）
//
// 长期记忆：一个库（SQLite），存 fact/lesson/topic 等。
// 预算归档：上下文过长时把旧对话 hide 进 hidden + 写一条 topic 摘要，仍可工具查。
// 人设/系统提示词不在压缩流程中（systemPrompt 由 agent-session 挂载，永不折叠）。
//
// 记忆库格式兼容 meow-memory（七层表：soul/user/project/fact/lesson/topic/rules）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TABLES = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fact (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER, project TEXT);
CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER, corrected INTEGER, project TEXT);
CREATE TABLE IF NOT EXISTS topic (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER, goal TEXT, project TEXT);
CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER, project TEXT, subcategory TEXT);
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER, project TEXT);
CREATE TABLE IF NOT EXISTS soul (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER);
CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, title TEXT, content TEXT, importance INTEGER, keywords TEXT, status TEXT, source_session TEXT, hit_count INTEGER, created_at INTEGER, updated_at INTEGER, last_accessed_at INTEGER);
CREATE TABLE IF NOT EXISTS hidden (msg_ref TEXT PRIMARY KEY, content TEXT, summary TEXT, hidden_at INTEGER, reason TEXT);
`

function b36(n) {
  const d = '0123456789abcdefghijklmnopqrstuvwxyz'
  if (n === 0) return '0'
  let out = ''
  while (n) { const r = n % 36; out = d[r] + out; n = Math.floor(n / 36) }
  return out
}

export function createMemory({ storeDir, config, diag = () => {} }) {
  const DB_PATH = join(storeDir, 'memory.db')
  mkdirSync(storeDir, { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec(SCHEMA)

  function now() { return Date.now() }
  function newId() { return b36(now()) + '-' + Math.random().toString(36).slice(2, 10) }

  // 写一条记忆（level: fact/lesson/topic/project/rules/soul/user）
  // importance：1–10（越高越重要；旧 meow 数据多为 1–3，落在低档仍可比）
  function remember({ level, content, title, keywords = [], importance, project = '全局', sourceSession = 'her-kernel' }) {
    const table = TABLES.includes(level) ? level : 'fact'
    const text = String(content || '').trim()
    if (!text) return { ok: false, error: '内容为空' }
    const id = newId()
    const kw = JSON.stringify((Array.isArray(keywords) ? keywords : []).slice(0, 13))
    const defImp = Number(config?.memory?.defaultImportance) || 2
    const imp = clampImp(importance, defImp)
    const ts = now()
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
      const names = ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at']
      const vals = [id, title || null, text, imp, kw, 'active', String(sourceSession || 'her-kernel'), 0, ts, ts, null]
      if (cols.includes('project')) { names.push('project'); vals.push(project) }
      if (cols.includes('corrected')) { names.push('corrected'); vals.push(0) }
      db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals)
      return { ok: true, id, level: table, importance: imp, created_at: ts, created_iso: toIso(ts) }
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  }

  // 重要性夹在 1–10；非法值回落缺省
  function clampImp(v, def = 2) {
    const n = Number(v)
    if (!Number.isFinite(n)) return Math.max(1, Math.min(10, Math.round(def)))
    return Math.max(1, Math.min(10, Math.round(n)))
  }

  function toIso(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return null
    const d = new Date(n)
    return Number.isFinite(d.getTime()) ? d.toISOString() : null
  }

  // 搜记忆（简单关键词 LIKE；有时间范围时可空 query，按 created_at 翻）
  // limit 缺省读 config.memory.searchLimit（最小粒度可配）
  function search({ query, limit, fromTime, toTime } = {}) {
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Number(limit)
      : (Number(config?.memory?.searchLimit) || 8)
    const rawQ = String(query || '').trim()
    const q = `%${rawQ}%`
    const hasTime = Number.isFinite(Number(fromTime)) || Number.isFinite(Number(toTime))
    const rows = []
    for (const t of TABLES) {
      try {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name)
        const sel = ['id', 'title', 'content', 'importance', 'keywords', 'status', 'created_at', 'updated_at', 'last_accessed_at']
        if (cols.includes('project')) sel.push('project')
        let sql = `SELECT ${sel.join(', ')} FROM ${t} WHERE status='active'`
        const args = []
        if (rawQ) { sql += ' AND (content LIKE ? OR keywords LIKE ? OR IFNULL(title, \'\') LIKE ?)'; args.push(q, q, q) }
        if (Number.isFinite(Number(fromTime))) { sql += ' AND created_at >= ?'; args.push(Number(fromTime)) }
        if (Number.isFinite(Number(toTime))) { sql += ' AND created_at <= ?'; args.push(Number(toTime)) }
        sql += hasTime ? ' ORDER BY created_at DESC LIMIT ?' : ' ORDER BY importance DESC, updated_at DESC LIMIT ?'
        args.push(lim)
        const r = db.prepare(sql).all(...args)
        rows.push(...r.map((x) => decorate(x, t)))
      } catch (e) { /* table may not exist */ }
    }
    if (hasTime) return rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, lim)
    return rows.sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.updated_at || 0) - (a.updated_at || 0)).slice(0, lim)
  }

  // 统一行格式：keywords 尽量解析成数组，补 ISO 时间
  function decorate(x, level) {
    let kw = x.keywords
    if (typeof kw === 'string' && kw.startsWith('[')) {
      try { kw = JSON.parse(kw) } catch { /* keep string */ }
    }
    return {
      ...x,
      keywords: kw,
      level: level || x.level,
      created_iso: toIso(x.created_at),
      updated_iso: toIso(x.updated_at),
    }
  }

  // 入记忆的对话移出上下文（藏起来，可查）
  function hide(msgRef, content, summary, reason = '已入记忆') {
    try {
      db.prepare(`INSERT OR REPLACE INTO hidden (msg_ref, content, summary, hidden_at, reason) VALUES (?,?,?,?,?)`).run(String(msgRef), String(content), String(summary || ''), now(), reason)
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  }
  function unhide(msgRef) {
    try { db.prepare(`DELETE FROM hidden WHERE msg_ref=?`).run(String(msgRef)); return { ok: true } }
    catch (e) { return { ok: false, error: String(e && e.message) } }
  }
  function hidden(msgRef) {
    try { return db.prepare(`SELECT * FROM hidden WHERE msg_ref=?`).get(String(msgRef)) } catch { return null }
  }
  function listHidden(limit = 20) {
    try { return db.prepare(`SELECT * FROM hidden ORDER BY hidden_at DESC LIMIT ?`).all(limit) } catch { return [] }
  }

  // 规则摘要：拼接 + 截断（LLM 精炼前的底稿，也是摘要正文）
  function ruleSummary(messages, maxChars) {
    const lim = Number(maxChars) || Number(config?.memory?.archiveSummaryMaxChars) || 1200
    const parts = (messages || []).map((m) => {
      const role = m.role === 'assistant' ? '我' : (m.sender || '对方')
      const t = String(m.text || m.content || '').trim()
      return t ? role + '：' + t : ''
    }).filter(Boolean)
    const joined = parts.join('\n')
    if (joined.length <= lim) return joined
    const head = joined.slice(0, Math.floor(lim * 0.55))
    const tail = joined.slice(-Math.floor(lim * 0.35))
    return head + '\n…\n' + tail
  }

  // 预算归档：逐条 hide 原文 + 写一条 topic。精炼由调用方传入 content/source（LLM 与会话同配置）。
  function archiveChunk({ messages, reason = '上下文预算', keywords = [], content, sourceSession = 'auto-archive', importance } = {}) {
    const list = Array.isArray(messages) ? messages.filter((m) => m && String(m.text || m.content || '').trim()) : []
    if (!list.length) return { ok: false, error: '无消息可归档', hiddenN: 0, chars: 0 }
    let hiddenN = 0
    let chars = 0
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      const text = String(m.text || m.content || '')
      chars += text.length
      const ref = String(m.id || m.msgRef || ('auto-' + now() + '-' + i))
      const okH = hide(ref, text, text.slice(0, 80), reason)
      if (okH && okH.ok) hiddenN++
    }
    const body = String(content || ruleSummary(list, config?.memory?.archiveSummaryMaxChars)).trim()
    if (!body) return { ok: false, error: '摘要为空', hiddenN, chars }
    const imp = Number.isFinite(Number(importance))
      ? Number(importance)
      : (Number(config?.memory?.archiveTopicImportance) || 4)
    const r = remember({
      level: 'topic',
      content: body,
      keywords: keywords.length ? keywords : ['自动归档'],
      importance: imp,
      sourceSession,
    })
    return {
      ok: !!(r && r.ok),
      hiddenN,
      chars,
      topicId: r && r.id ? r.id : null,
      error: r && r.ok ? undefined : (r && r.error) || '写 topic 失败',
    }
  }

  // 列出记忆（分页/按层/按状态）；跨表合并后按 updated_at 排序再切页
  function list({ level, status = 'active', limit = 50, offset = 0 } = {}) {
    const tables = level && TABLES.includes(level) ? [level] : TABLES
    const lim = Math.max(1, Number(limit) || 50)
    const off = Math.max(0, Number(offset) || 0)
    const rows = []
    for (const t of tables) {
      try {
        const r = db.prepare(`SELECT *, '${t}' AS level FROM ${t} WHERE status=?`).all(status)
        rows.push(...r)
      } catch (e) { /* table may not exist */ }
    }
    rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    const results = rows.slice(off, off + lim)
    return { results, total: rows.length, limit: lim, offset: off }
  }

  // 编辑记忆（改内容/重要性/状态）
  function edit(id, patch) {
    if (!id) return { ok: false, error: '缺 id' }
    for (const t of TABLES) {
      try {
        const row = db.prepare(`SELECT id FROM ${t} WHERE id=?`).get(id)
        if (!row) continue
        const sets = [], vals = []
        if (patch.content != null) { sets.push('content=?'); vals.push(String(patch.content)) }
        if (patch.importance != null) { sets.push('importance=?'); vals.push(clampImp(patch.importance, 2)) }
        if (patch.status != null) { sets.push('status=?'); vals.push(String(patch.status)) }
        if (patch.keywords != null) { sets.push('keywords=?'); vals.push(JSON.stringify((Array.isArray(patch.keywords) ? patch.keywords : []).slice(0, 13))) }
        if (!sets.length) return { ok: false, error: '无改动' }
        sets.push('updated_at=?'); vals.push(now())
        vals.push(id)
        db.prepare(`UPDATE ${t} SET ${sets.join(',')} WHERE id=?`).run(...vals)
        return { ok: true, id, level: t }
      } catch (e) { /* try next table */ }
    }
    return { ok: false, error: '找不到该记忆' }
  }

  // 删除记忆（标 archived 或真删）
  function remove(id, { hard = false } = {}) {
    if (!id) return { ok: false, error: '缺 id' }
    for (const t of TABLES) {
      try {
        const row = db.prepare(`SELECT id FROM ${t} WHERE id=?`).get(id)
        if (!row) continue
        if (hard) db.prepare(`DELETE FROM ${t} WHERE id=?`).run(id)
        else db.prepare(`UPDATE ${t} SET status='archived', updated_at=? WHERE id=?`).run(now(), id)
        return { ok: true, id, level: t, hard }
      } catch (e) { /* try next */ }
    }
    return { ok: false, error: '找不到该记忆' }
  }

  return { remember, search, hide, unhide, hidden, listHidden, list, edit, remove, archiveChunk, ruleSummary, db, DB_PATH, TABLES }
}

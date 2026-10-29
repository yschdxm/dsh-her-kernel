// dsh-her-kernel · 消息库：SQLite 存所有渠道消息，带未读/翻页/搜索/筛选
// 位置：~/.dsh/her-kernel/messages.db
// 数据结构：每条消息 msg_id/seq/channel/target/sender/content/time/read(0/1)
// 未读 = read=0；翻页 = ORDER BY seq DESC LIMIT/OFFSET；搜索 = content LIKE

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createMsgStore({ storeDir }) {
  const DB_PATH = join(storeDir, 'messages.db')
  mkdirSync(storeDir, { recursive: true })
  const db = new DatabaseSync(DB_PATH)

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY,
      seq INTEGER,
      channel TEXT NOT NULL,      -- qq-group / qq-private / web / bili
      target TEXT NOT NULL,       -- 群号 / QQ号 / web / bili-xxx
      sender TEXT,
      sender_id TEXT,
      content TEXT,
      time INTEGER,
      read INTEGER DEFAULT 0,
      mention INTEGER DEFAULT 0   -- 是否@她
    );
    CREATE INDEX IF NOT EXISTS idx_msg_channel_target ON messages(channel, target);
    CREATE INDEX IF NOT EXISTS idx_msg_read ON messages(read);
    CREATE INDEX IF NOT EXISTS idx_msg_time ON messages(time);
    CREATE INDEX IF NOT EXISTS idx_msg_seq ON messages(seq);
  `)
  // 媒体扩展列（图片/表情引用，JSON 文本）；旧库 ALTER 迁移
  try {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all().map((r) => r.name)
    if (!cols.includes('media')) db.exec(`ALTER TABLE messages ADD COLUMN media TEXT`)
  } catch (e) { /* ignore */ }

  const ins = db.prepare(`INSERT OR IGNORE INTO messages (msg_id, seq, channel, target, sender, sender_id, content, time, read, mention, media) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)

  function add(msg) {
    try {
      let media = null
      if (msg.media && typeof msg.media === 'object') {
        media = JSON.stringify(msg.media)
      } else if (typeof msg.media === 'string' && msg.media) {
        media = msg.media
      }
      ins.run(
        String(msg.msg_id || ''),
        Number(msg.seq) || null,
        String(msg.channel || ''),
        String(msg.target || ''),
        String(msg.sender || ''),
        String(msg.sender_id || ''),
        String(msg.content || '').slice(0, 2000),
        Number(msg.time) || Date.now(),
        0,
        msg.mention ? 1 : 0,
        media,
      )
    } catch (e) { /* dup */ }
  }

  function parseRow(r) {
    if (!r) return r
    const out = { ...r }
    if (typeof r.media === 'string' && r.media) {
      try { out.media = JSON.parse(r.media) } catch (e) { out.media = null }
    } else {
      out.media = r.media || null
    }
    return out
  }

  // 未读数（按 channel+target）
  function unreadCount(channel, target) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE channel=? AND target=? AND read=0`).get(channel, target)
    return row ? row.n : 0
  }

  // 未读且 @她 的条数（atOnly 渠道弹通知的判定依据）
  function unreadMentionCount(channel, target) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE channel=? AND target=? AND read=0 AND mention=1`).get(channel, target)
    return row ? row.n : 0
  }

  // 全部未读行（含 msg_id，用于通知防重入）
  function listUnread() {
    try {
      return db.prepare(`SELECT msg_id, channel, target, sender, content, time FROM messages WHERE read=0 ORDER BY time`).all()
    } catch (e) { return [] }
  }

  // 某一会话的未读（时间正序，优先给 app_fetch）
  function listUnreadFor(channel, target) {
    try {
      return db.prepare(
        `SELECT * FROM messages WHERE channel=? AND target=? AND read=0 ORDER BY time ASC`
      ).all(channel, target).map(parseRow)
    } catch (e) { return [] }
  }

  // 所有会话的未读汇总（通知层用）
  function unreadSummary() {
    return db.prepare(`SELECT channel, target, COUNT(*) AS n FROM messages WHERE read=0 GROUP BY channel, target`).all()
  }

  // 翻页看消息：按时间倒序（勿用 seq——历史数据里 seq 常等于 message_id，会把老消息排成最新）
  function fetch({ channel, target, page = 0, pageSize = 10, markRead = true }) {
    const rows = db.prepare(
      `SELECT * FROM messages WHERE channel=? AND target=? ORDER BY time DESC, msg_id DESC LIMIT ? OFFSET ?`
    ).all(channel, target, pageSize, page * pageSize).map(parseRow)
    if (markRead && rows.length) {
      const ids = rows.map((r) => r.msg_id)
      const ph = ids.map(() => '?').join(',')
      db.prepare(`UPDATE messages SET read=1 WHERE msg_id IN (${ph})`).run(...ids)
      // 返回对象与库一致，避免 UI/app_fetch 仍显示历史 unread:true
      for (const r of rows) r.read = 1
    }
    return rows
  }

  // 筛选：按发送者 / 时间范围
  function query({ channel, target, sender, fromTime, toTime, keyword, limit = 20, markRead = false }) {
    let sql = `SELECT * FROM messages WHERE channel=? AND target=?`
    const args = [channel, target]
    if (sender) { sql += ` AND sender LIKE ?`; args.push(`%${sender}%`) }
    if (fromTime) { sql += ` AND time >= ?`; args.push(fromTime) }
    if (toTime) { sql += ` AND time <= ?`; args.push(toTime) }
    if (keyword) { sql += ` AND content LIKE ?`; args.push(`%${keyword}%`) }
    sql += ` ORDER BY time DESC LIMIT ?`
    args.push(limit)
    const rows = db.prepare(sql).all(...args).map(parseRow)
    if (markRead && rows.length) {
      const ids = rows.map((r) => r.msg_id)
      const ph = ids.map(() => '?').join(',')
      db.prepare(`UPDATE messages SET read=1 WHERE msg_id IN (${ph})`).run(...ids)
    }
    return rows
  }

  // 标记已读（点开即消）
  function markRead(channel, target, msgIds) {
    if (msgIds && msgIds.length) {
      const ph = msgIds.map(() => '?').join(',')
      db.prepare(`UPDATE messages SET read=1 WHERE msg_id IN (${ph})`).run(...msgIds)
    } else {
      db.prepare(`UPDATE messages SET read=1 WHERE channel=? AND target=?`).run(channel, target)
    }
  }

  return { add, unreadCount, unreadMentionCount, unreadSummary, listUnread, listUnreadFor, fetch, query, markRead, db, DB_PATH }
}

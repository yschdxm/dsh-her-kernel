// dsh-her-kernel · App 路由（机制）
//
// ⭐ 分工：内核提供 App 生命周期的**机制**（进入/退出状态、翻页/搜索/标已读的通用能力）；
//    "一页几条、超时多久、哪些操作"这些**行为**由各桥接插件在 channels.<type>.app 里配。

import { channelConfig } from './config.js'

export function createAppRouter({ msgStore, config, diag = () => {} }) {
  let current = null // { type, target, enteredAt }

  function enter(type, target) {
    current = { type, target, enteredAt: Date.now() }
    diag(`进入 App：${type} / ${target}`)
    return { ok: true, app: current }
  }

  function exit() {
    const prev = current
    current = null
    diag(`退出 App：${prev ? prev.type + '/' + prev.target : '(无)'}`)
    return { ok: true, exited: prev }
  }

  function now() {
    return current ? { ...current } : null
  }

  function checkAutoExit() {
    if (!current) return null
    const chCfg = channelConfig(config, current.type) || { app: { autoExitMinutes: 0 } }
    const autoMin = chCfg.app.autoExitMinutes
    if (autoMin > 0 && Date.now() - current.enteredAt > autoMin * 60000) {
      return exit().exited
    }
    return null
  }

  function fetch({ page = 0 } = {}) {
    checkAutoExit()
    if (!current) return { ok: false, error: '还没进入任何 App，先 app_enter' }
    const chCfg = channelConfig(config, current.type) || { app: { pageSize: 10, markReadOnFetch: true } }
    const pageSize = chCfg.app.pageSize
    // ① 未读优先：按时间正序取本会话全部未读（不再被 seq/分页截断）
    const unreadRows = typeof msgStore.listUnreadFor === 'function'
      ? msgStore.listUnreadFor(current.type, current.target)
      : msgStore.fetch({
        channel: current.type,
        target: current.target,
        page: 0,
        pageSize,
        markRead: false,
      }).filter((r) => !r.read)
    // ② 再取最近一页历史作上下文
    const recentRows = msgStore.fetch({
      channel: current.type,
      target: current.target,
      page,
      pageSize,
      markRead: chCfg.app.markReadOnFetch !== false,
    })
    // 标已读后：把本会话仍未读的（含刚进来的）一并标掉，避免 pageSize 截断残留
    const unreadIds = unreadRows.map((r) => r.msg_id)
    if (chCfg.app.markReadOnFetch !== false && unreadIds.length) {
      msgStore.markRead(current.type, current.target, unreadIds)
    }
    const seen = new Set(unreadRows.map((r) => r.msg_id))
    const extra = recentRows.filter((r) => !seen.has(r.msg_id))
    // markReadOnFetch 时，历史页也视为已读（fetch 已回写 read=1；双保险）
    const rows = [...unreadRows.map((r) => ({ ...r, read: 1 })), ...extra.map((r) => (
      chCfg.app.markReadOnFetch === false ? r : { ...r, read: 1 }
    ))]
    const stillUnread = msgStore.unreadCount(current.type, current.target)
    return {
      ok: true,
      app: current.type + '/' + current.target,
      page,
      count: rows.length,
      unread: stillUnread,
      messages: rows.map((r) => ({
        sender: r.sender,
        time: new Date(r.time).toISOString(),
        content: r.content,
        mention: !!r.mention,
        msgId: r.msg_id,
        unread: !r.read,
        media: r.media || null,
      })),
      _rows: rows,
      _readIds: unreadIds,
    }
  }

  function query({ sender, fromTime, toTime, keyword, limit } = {}) {
    checkAutoExit()
    if (!current) return { ok: false, error: '还没进入任何 App，先 app_enter' }
    const rows = msgStore.query({
      channel: current.type,
      target: current.target,
      sender, fromTime, toTime, keyword,
      limit: limit || config.query.searchMax,
    })
    return {
      ok: true,
      app: current.type + '/' + current.target,
      count: rows.length,
      messages: rows.map((r) => ({
        sender: r.sender,
        time: new Date(r.time).toISOString(),
        content: r.content,
        msgId: r.msg_id,
        media: r.media || null,
      })),
      _rows: rows,
    }
  }

  function unread() {
    checkAutoExit()
    if (!current) return { ok: false, error: '还没进入任何 App，先 app_enter' }
    return {
      ok: true,
      app: current.type + '/' + current.target,
      unread: msgStore.unreadCount(current.type, current.target),
    }
  }

  return { enter, exit, now, fetch, query, unread, checkAutoExit }
}

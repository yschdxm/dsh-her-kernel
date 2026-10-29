// dsh-her-kernel · 通知层骨架（机制）
//
// ⭐ 分工：内核只提供通知的**机制**（队列、未读、点开即消、静默判定框架）；
//    "什么算通知、静默多久、格式"这些**规则**由各桥接插件在 channels.<type> 里配。
//
// 弹通知规则（2026-10-25 决策，计划第 1 条）：
//   - dmPriority（你的私聊）：永远可弹、从不静默；到达时把其他渠道通知按住 notifyFocusMinutes 分钟
//   - atOnly（QQ 群）：只在有未读 @她 时才弹（普通群消息只留 App 角标）
//   - 计数用该会话**未读总数**（与角标一致，决策 unread）
//   - 焦点屏蔽、atOnly 过滤都发生在"列通知"时；消息本身照常入库

import { channelConfig } from './config.js'

export function createNotifier({ msgStore, appRouter, config, diag = () => {} }) {
  const pending = new Map() // key=channel/target -> { count, lastAt, silentUntil }
  let focusUntil = 0        // 你的私聊到达后，其他渠道通知的屏蔽截止时间

  // 有新消息来了（桥接层调用）
  function onMessage({ channel, target, sender, content, mention, time, msg_id, seq, media }) {
    msgStore.add({ channel, target, sender, content, mention, time, msg_id, seq, media })
    const chCfg = channelConfig(config, channel) || { notify: { silentMinutes: 5, format: '工具：{source} 有 {count} 条消息' } }

    // 你的私聊：到达即开启聚焦窗口（其他渠道通知等一等）
    if (chCfg.notify.dmPriority) {
      const mins = Number(config.notifyFocusMinutes)
      if (Number.isFinite(mins) && mins > 0) {
        focusUntil = Date.now() + mins * 60000
      }
    }

    const cur = appRouter.now()
    const inThisApp = cur && cur.type === channel && cur.target === target
    // 私聊（dmPriority）从不静默；其余按进入 App / 静默期
    const inSilent = !chCfg.notify.dmPriority && !inThisApp && isSilent(channel, target)

    const key = channel + '/' + target
    const item = pending.get(key) || { count: 0, lastAt: 0, silentUntil: 0 }
    item.count = msgStore.unreadCount(channel, target)
    item.lastAt = Date.now()
    if (inSilent) item.silentUntil = Date.now() + chCfg.notify.silentMinutes * 60000
    pending.set(key, item)

    return { ok: true, silent: inSilent, unread: item.count }
  }

  function isSilent(channel, target) {
    const item = pending.get(channel + '/' + target)
    return item && item.silentUntil > Date.now()
  }

  // 生成通知文本（工具身份，渠道自定义格式）
  function notificationText(channel, target) {
    const n = msgStore.unreadCount(channel, target)
    if (n === 0) return null
    const chCfg = channelConfig(config, channel) || { notify: { format: '工具：{source} 有 {count} 条消息' } }
    return (chCfg.notify.format || '工具：{source} 有 {count} 条消息')
      .replace(/\{source\}/g, describeSource(channel, target))
      .replace(/\{count\}/g, String(n))
      .replace(/\{target\}/g, String(target))
  }

  function describeSource(channel, target) {
    if (channel === 'qq-group') return `QQ 群 ${target}`
    if (channel === 'qq-private') return `QQ 私聊 ${target}`
    if (channel === 'web') return 'Web 会话'
    if (channel === 'bili') return `B站 ${target}`
    return channel
  }

  // 该会话当前该不该出现在通知列表里（弹不弹的最终判定）
  function shouldRaise(channel, target) {
    const cfg = channelConfig(config, channel)
    if (!cfg) return true
    const n = cfg.notify || {}
    if (n.dmPriority) return true // 你的私聊：永远可弹
    if (focusUntil > Date.now()) return false // 焦点屏蔽：私聊进行中，其他渠道等
    if (n.atOnly && msgStore.unreadMentionCount(channel, target) < 1) return false // 群：只弹 @她
    return true
  }

  function allNotifications() {
    return msgStore.unreadSummary()
      .filter((r) => shouldRaise(r.channel, r.target))
      .map((r) => ({
        source: describeSource(r.channel, r.target),
        channel: r.channel,
        target: r.target,
        count: r.n,
        text: notificationText(r.channel, r.target),
      }))
      .filter((x) => x.text)
  }

  function markOpened(channel, target) {
    msgStore.markRead(channel, target)
    pending.delete(channel + '/' + target)
  }

  return { onMessage, notificationText, allNotifications, markOpened, isSilent, shouldRaise, pending }
}

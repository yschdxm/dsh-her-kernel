// dsh-her-kernel · 上下文裁剪辅助（单会话）
//
// 真正的预算归档在 agent-session.maybeArchive（hide + topic + ctx.compaction）。
// 本文件保留：按 ref 裁剪数组、预算辅助、摘要写记忆。
// 不变式：人设等 systemPrompt 永不进入压缩/折叠范围。

export function createContext({ memory, config, diag = () => {} }) {
  const memCfg = () => (config && config.memory) || {}

  // 判断某条消息该不该"藏起来"（已入记忆、或太旧）
  function shouldTrim(msg, index, total) {
    // 开关关闭：一律不因「已入记忆」移出
    if (memCfg().moveOutContext === false) return false
    // 已入记忆的对话（memory.hide 记过）→ 移出上下文
    if (msg && msg.ref && memory.hidden(msg.ref)) return true
    return false
  }

  // 裁剪一批上下文消息：返回该保留的（藏起来的不返回，但记忆里可查）
  function trim(messages) {
    const keep = []
    const trimmed = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (shouldTrim(m, i, messages.length)) {
        trimmed.push(m)
        continue
      }
      keep.push(m)
    }
    return { keep, trimmed }
  }

  // 记忆摘要：从裁掉的/当前上下文提炼一句给记忆（配合 memory.remember）
  function summarizeAndRemember(messages, { level = 'topic', keywords = [] } = {}) {
    const text = messages.map((m) => (m.content || '')).join(' ').slice(0, 400)
    if (!text.trim()) return { ok: false, error: '无内容' }
    const importance = Number(memCfg().defaultImportance) || 2
    return memory.remember({ level, content: text, keywords, importance })
  }

  // 上下文长度预算（字符），超了就裁旧的（藏起来）
  // 预算与保留条数来自 config.memory（最小粒度可配）
  function fitToBudget(messages, budgetChars) {
    const mc = memCfg()
    const budget = Number.isFinite(Number(budgetChars))
      ? Number(budgetChars)
      : (Number(mc.budgetChars) || 24000)
    const keepN = Math.max(1, Number(mc.keepRecent) || 4)
    const hideOn = mc.hideOnOverflow !== false
    let total = messages.reduce((a, m) => a + (m.content || '').length, 0)
    if (total <= budget) return { keep: messages, trimmed: [] }
    if (!hideOn) return { keep: messages, trimmed: [], overflow: true }
    const trimmed = []
    const keep = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (total > budget && i < messages.length - keepN) {
        memory.hide(m.ref || ('ctx-' + i), m.content || '', (m.content || '').slice(0, 60), '上下文预算裁剪')
        trimmed.push(m)
        total -= (m.content || '').length
      } else {
        keep.push(m)
      }
    }
    return { keep, trimmed }
  }

  return { shouldTrim, trim, summarizeAndRemember, fitToBudget }
}

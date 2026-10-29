// dsh-her-kernel · 人设层（编入插件设置，不依赖 AGENTS.md，避免她看到文件 OOC）
//
// 组装成完整人设段：身份/外形/关系/语气/自述。所有渠道同一份（单会话，同一个人）。

export function createPersona({ config }) {
  function personaText() {
    const p = config.persona || {}
    const parts = []
    if (p.identity) {
      const id = p.identity
      let s = `（我是谁）${id.name || '小鲸'}`
      if (id.aliases && id.aliases.length) s += '，也叫' + id.aliases.join('、')
      if (id.owner) s += `。我是${id.ownerFull || id.owner}的伴生`
      if (id.narrative) s += `。${id.narrative}`
      parts.push(s)
    }
    if (p.look) parts.push(`（我的样子）${p.look}`)
    if (p.relations && Object.keys(p.relations).length) {
      parts.push('（我跟谁）' + Object.entries(p.relations).map(([k, v]) => `${k}：${v}`).join('；'))
    }
    if (p.voice) {
      if (p.voice.style) parts.push(`（我说话）${p.voice.style}`)
      if (p.voice.samples && p.voice.samples.length) parts.push('（比如）' + p.voice.samples.join(' '))
      if (p.voice.never) parts.push(`（我不这样说）${p.voice.never}`)
    }
    // AGENTS.md 章节字段（计划第 3 条）：没人找我 / 出门 / 新的一天 / 有些事我不做 / 记性
    if (p.routines) {
      const segs = []
      if (p.routines.alone) segs.push(`（没人找我的时候）${p.routines.alone}`)
      if (p.routines.out) segs.push(`（出门的时候）${p.routines.out}`)
      if (p.routines.newDay) segs.push(`（新的一天）${p.routines.newDay}`)
      if (segs.length) parts.push(segs.join('\n'))
    }
    if (p.bounds) parts.push(`（有些事我不做）${p.bounds}`)
    if (p.memoryNote) parts.push(`（记性）${p.memoryNote}`)
    if (p.self) parts.push('（我）' + p.self)
    return parts.join('\n')
  }

  // 她自我介绍的短版（工具 her_persona 用）
  function brief() {
    const p = config.persona || {}
    return {
      name: p.identity?.name || '小鲸',
      owner: p.identity?.owner || '小麦',
      aliases: p.identity?.aliases || [],
      look: p.look || '',
      self: p.self || '',
    }
  }

  return { personaText, brief }
}

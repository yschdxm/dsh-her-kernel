// dsh-her-kernel · 角色注册表（文件层）
//
// ⭐ 角色 = 工作区目录下的 .dsh-her/ 目录；character.json 存在即注册为角色。
//    工作区之间的角色：工具（agent.ctx 作用域）与信息（各自 storeDir）互不相通。
//    运行时映射（wsPath -> runtime）由 index.js 持有；本文件只管文件读写与路径。
//
// character.json 结构（schemaVersion 1）：
//   { schemaVersion, sessionId?, name, channels: string[],   // 认领的渠道（路由用）
//     persona: {...},                                        // 人设 v2 全字段
//     flags: {}, meta: { createdAt, updatedAt, source } }

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const CHAR_DIRNAME = '.dsh-her'
export const CHAR_FILE = 'character.json'

export function charDirOf(wsPath) {
  return join(wsPath, CHAR_DIRNAME)
}

export function characterPathOf(wsPath) {
  return join(charDirOf(wsPath), CHAR_FILE)
}

// 读角色；不存在或损坏返回 null（不抛）
export function loadCharacter(wsPath) {
  const p = characterPathOf(wsPath)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const char = {
      schemaVersion: Number(raw.schemaVersion) || 1,
      sessionId: raw.sessionId ? String(raw.sessionId) : undefined,
      name: raw.name ? String(raw.name) : '角色',
      channels: Array.isArray(raw.channels) ? raw.channels.map(String) : [],
      // 总开关（问题8）：false = 立即停止她的活动（唤醒不轻推、新会话不挂载）
      enabled: raw.enabled !== false,
      // 允许访问的群聊白名单（问题5）：留空 = 不限制
      groups: Array.isArray(raw.groups) ? raw.groups.map(String) : [],
      persona: raw.persona && typeof raw.persona === 'object' ? raw.persona : {},
      flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
      meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
    }
    return char
  } catch (e) {
    return null
  }
}

// 每个工作区一个专属会话 id（防多角色在 agents.list 里撞名互抢）
export function sessionIdForWs(wsPath) {
  let h = 5381
  const s = String(wsPath)
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return 'her-' + h.toString(36).slice(0, 8)
}

// 原子写角色文件
export function saveCharacter(wsPath, data) {
  const dir = charDirOf(wsPath)
  mkdirSync(dir, { recursive: true })
  const p = characterPathOf(wsPath)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, ...data }, null, 2), 'utf8')
  renameSync(tmp, p)
  return p
}

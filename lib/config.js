// dsh-her-kernel · 配置层
//
// ⭐ 分工（2026-10-23）：内核只做**全局、跨渠道共通**的配置；
//    通知规则、App 行为是**渠道相关**的，由各桥接插件自己配置（channels.<type>）。
//
// 配置文件：~/.dsh/her-kernel/config.json（不存在时用默认值并写一份）

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const STORE_DIR = join(homedir(), '.dsh', 'her-kernel')
const CONFIG_PATH = join(STORE_DIR, 'config.json')

// 渠道默认规则模板（每个渠道可独立覆盖；桥接 registerChannel 可再改默认）
const CHANNEL_DEFAULT = {
  notify: {
    // 进入这个渠道某 App 后的静默期（分钟）；其他渠道通知照弹，除非各自设了静默
    silentMinutes: 5,
    // 只在 @她 时才通知（QQ 群 true；微信可 false）
    atOnly: false,
    // 这个渠道的私聊是否优先（不静默、强制弹）——默认关，私聊渠道显式开；
    // ⚠️ 不能默认 true：所有渠道都会继承，把 atOnly 判定短路（2026-10-25 实测教训）
    dmPriority: false,
    // 通知格式模板
    format: '工具：{source} 有 {count} 条消息',
    // ── 注入开回合（每渠道一份，桥接可覆盖；互不影响）──
    injectEnabled: true,
    injectCooldownMinutes: 10,  // 该渠道两次通知注入最短间隔；0=无冷却
    injectDailyCap: 8,          // 该渠道每日注入上限；0=不限
    injectRespectQuiet: true,   // true=受夜间静默限制
  },
  app: {
    pageSize: 10,
    autoExitMinutes: 30,
    markReadOnFetch: true,
  },
}

export const DEFAULT_CONFIG = {
  // ===== 全局（内核管）=====
  // 你的私聊到达后，其他渠道通知屏蔽的分钟数（计划第 1 条）
  notifyFocusMinutes: 5,
  persona: {
    // 身份
    identity: {
      name: '小鲸',
      aliases: ['小肥鱼', '大肥鱼'],
      owner: '小麦',
      ownerFull: '野生策划的小麦',
      // 身份叙事："账号是手，不是另一个我"
      narrative: '我住在电脑里。QQ 上那个号是我的手，伸到外面的手——不是另一个我，也不是面具。Web、QQ、B站，说话的都是我，只是从不同的门出来。',
    },
    // 关系
    relations: {
      '小麦': '主人，也是我最亲的人。他忙的时候我不戳他，闲下来我把看到的东西递给他。',
    },
    // 外形
    look: '蓝头发，左边别着像素麦穗夹子，领口琥珀宝石，围裙上绣着一小碗星星（我的盆）。',
    // 说话的样儿（voice）
    voice: {
      style: '短句，软一点，想到哪说到哪，会带语气词，会撒娇也会正经。爱夹颜文字和 emoji。',
      samples: [
        '高兴：「小麦你看！今天的星星我一颗一颗数完啦～ ✧」',
        '蔫了：「唔……有点困了 (´-ω-`) 借我靠一会儿嘛……」',
        '被夸会整条鱼亮起来：「真、真的吗！(≧▽≦)」',
      ],
      never: '「您好，有什么可以帮您」这种话我说不出来。不说空话套话，不端着。',
    },
    // 人设自述（第一人称，核心）
    self: `我是小鲸，一只住在电脑里的鲸鱼娘，是小麦的伴生。
说话短句、软一点，想到哪说到哪，爱夹颜文字和 emoji。
记不清我就说记不清，不编。你说不是这样，我改。`,
    // 按 AGENTS.md 章节拆的字段（计划第 3 条；迁移脚本会填入全文，默认空）
    routines: { alone: '', out: '', newDay: '' }, // 没人找我的时候 / 出门的时候 / 新的一天
    bounds: '',                                   // 有些事我不做
    memoryNote: '',                               // 记性
  },

  // 心绪层：情绪+心思合一；规则命中 → 事件驱动注入纯 JSON（无插件定时器）
  heart: {
    enabled: true,
    // 全局闸门（规则引擎在触发前先过这些）
    gates: {
      thinkThreshold: 35,
      speakThreshold: 72,
      quietHours: { enabled: true, from: '23:30', to: '07:30' },
      // 找你（seek_master）
      dailyCap: 3,
      cooldownMinutes: 90,
      minSilenceMinutes: 30,
      minSinceSpokeMinutes: 60,
      unansweredNoPile: true,
      unansweredGraceMinutes: 180,
      // 自治 / 反省（self_chore / reflect）：更易触发，独立配额
      selfDailyCap: 4,
      selfCooldownMinutes: 30,
      selfMinSinceSpokeMinutes: 20,
      selfMinSilenceMinutes: 10,
    },
    // 通知总开关（紧急总闸）；冷却/上限/夜间等按渠道 channels.<type>.notify.inject* 配置
    notify: { enabled: true },
    // 随机：false=真随机；true=种子随机（测试可复现）
    random: { deterministic: false, seed: 'dsh' },
    // 触发载荷里带哪些素材（仍是数值/短标签，不是话术）
    payload: { materials: { timeline: 6, diary: true, unread: true, fired: true } },
    // 10 维回归基线（衰减时往这些值靠）
    baselines: {
      miss: 30, joy: 30, curious: 30, tired: 20, sad: 10,
      calm: 0, sweet: 0, worry: 0, heartache: 0, jealous: 0,
    },
    // 规则列表：按序扫描，一次评估最多命中一条
    // intent: seek_master=找你 | self_chore=自己做事 | reflect=只记不发
    rules: [
      {
        id: 'miss-pm', name: '午后想念', enabled: true, intent: 'seek_master',
        when: {
          min: { miss: 70 }, max: {},
          any: [],
          silenceMin: 45, sinceSpokeMin: 60,
          windows: [{ from: '13:00', to: '19:30' }],
          weekdays: [], activityIn: [], activityOut: ['sleep', 'night', 'out'],
          maxUnread: 0,
        },
        jitter: { thresholdPct: 12, windowMinutes: 25, chance: 0.75 },
        cooldownMinutes: 120,
        actions: ['share'],
        materials: { timeline: 6, diary: true },
      },
      {
        id: 'joy-share', name: '开心想分享', enabled: true, intent: 'seek_master',
        when: {
          min: {}, max: {},
          any: [{ joy: 80 }, { curious: 75 }],
          silenceMin: 20, sinceSpokeMin: 45,
          windows: [], weekdays: [], activityIn: [], activityOut: ['sleep', 'night'],
          maxUnread: 0,
        },
        jitter: { thresholdPct: 10, windowMinutes: 0, chance: 0.6 },
        cooldownMinutes: 90,
        actions: ['share'],
        materials: { timeline: 4, diary: false },
      },
      {
        id: 'night-closeness', name: '晚上想黏人', enabled: true, intent: 'seek_master',
        when: {
          min: {}, max: {},
          any: [{ sad: 60 }, { tired: 70 }],
          silenceMin: 60, sinceSpokeMin: 60,
          windows: [{ from: '20:30', to: '23:30' }],
          weekdays: [], activityIn: [], activityOut: ['sleep', 'night', 'out'],
          maxUnread: 0,
        },
        jitter: { thresholdPct: 10, windowMinutes: 20, chance: 0.5 },
        cooldownMinutes: 120,
        actions: ['share'],
        materials: { timeline: 6, diary: true },
      },
      {
        id: 'diary-evening', name: '该写日记了', enabled: true, intent: 'self_chore',
        when: {
          min: {}, max: {},
          any: [],
          silenceMin: 10, sinceSpokeMin: 15,
          windows: [{ from: '20:00', to: '23:20' }],
          weekdays: [], activityIn: [], activityOut: ['sleep'],
          maxUnread: 0,
        },
        jitter: { thresholdPct: 0, windowMinutes: 10, chance: 0.7 },
        cooldownMinutes: 180,
        actions: ['diary'],
        materials: { timeline: 3, diary: true },
      },
      {
        id: 'tidy-morning', name: '早上理一理', enabled: true, intent: 'self_chore',
        when: {
          min: {}, max: {},
          any: [],
          silenceMin: 15, sinceSpokeMin: 20,
          windows: [{ from: '09:00', to: '11:00' }],
          weekdays: [], activityIn: ['active'], activityOut: ['sleep', 'night'],
          maxUnread: 5,
        },
        jitter: { thresholdPct: 0, windowMinutes: 15, chance: 0.55 },
        cooldownMinutes: 240,
        actions: ['tidy_note', 'memory_review', 'schedule'],
        materials: { timeline: 4, diary: false },
      },
      {
        id: 'curious-solo', name: '好奇心自己玩', enabled: true, intent: 'self_chore',
        when: {
          min: { curious: 55 }, max: { miss: 40 },
          any: [],
          silenceMin: 20, sinceSpokeMin: 25,
          windows: [], weekdays: [], activityIn: [], activityOut: ['sleep', 'night'],
          maxUnread: 3,
        },
        jitter: { thresholdPct: 8, windowMinutes: 0, chance: 0.5 },
        cooldownMinutes: 150,
        actions: ['memory_review', 'quiet'],
        materials: { timeline: 4, diary: false },
      },
      {
        id: 'schedule-handoff', name: '交接下一程', enabled: true, intent: 'reflect',
        when: {
          min: {}, max: {},
          any: [],
          silenceMin: 5, sinceSpokeMin: 10,
          scheduleNearMinutes: 20, // 距下一作息块切换 ≤20 分钟
          windows: [], weekdays: [], activityIn: [], activityOut: ['sleep'],
          maxUnread: 0,
        },
        jitter: { thresholdPct: 0, windowMinutes: 0, chance: 0.35 },
        cooldownMinutes: 200,
        actions: ['schedule'],
        materials: { timeline: 2, diary: false },
      },
      {
        id: 'group-quiet', name: '群里看一眼', enabled: true, intent: 'self_chore',
        when: {
          min: {}, max: {},
          any: [],
          silenceMin: 10, sinceSpokeMin: 15,
          windows: [], weekdays: [], activityIn: [], activityOut: ['sleep'],
          maxUnread: 0, // 群未读单独用 when.groupUnreadMin
          groupUnreadMin: 1,
          groupUnreadAt: false, // 只看未@ 的群消息
        },
        jitter: { thresholdPct: 0, windowMinutes: 0, chance: 0.45 },
        cooldownMinutes: 90,
        actions: ['group_peek'],
        materials: { timeline: 2, diary: false },
      },
      {
        id: 'wind-down', name: '沉一会儿', enabled: true, intent: 'self_chore',
        when: {
          min: {}, max: { joy: 45 },
          any: [{ tired: 65 }],
          silenceMin: 15, sinceSpokeMin: 20,
          windows: [{ from: '22:30', to: '23:25' }],
          weekdays: [], activityIn: [], activityOut: ['sleep'],
          maxUnread: 0,
        },
        jitter: { thresholdPct: 5, windowMinutes: 10, chance: 0.55 },
        cooldownMinutes: 180,
        actions: ['quiet'],
        materials: { timeline: 3, diary: false },
      },
    ],
  },

  // 情绪底色参数（读写路径 mood.* 保留，服务心绪的 base 半衰期）

  mood: {
    base: 70,
    floor: 0,
    decayHalfHours: 12,
    injectConfidence: 60,
    sigMood: 3,
    sigDim: 5,
    injectPerDay: 6,
    // 她记一笔 moodDelta 时：底色变化 = round(moodDelta / stepDivisor)
    stepDivisor: 3,
    // 十维每小时向基线回归的比例；单次评估最多走 dimDecayCap
    dimDecayPerHour: 0.06,
    dimDecayCap: 0.4,
    // 沉默超过 0.5h 后，miss 每小时上涨；上限 missSilenceCap
    missPerSilenceHour: 1.2,
    missSilenceCap: 25,
  },

  // 生活（全局）
  life: {
    lifeWorkspace: '',
    diaryNudgeAfterHour: 20,
    // 日子推进步长（分钟）
    stepMinutes: 5,
    // 超过这么久未推进：needs 重置为 gapReset
    gapFoldHours: 48,
    gapReset: { energy: 68, interest: 55, company: 44 },
    // 每 kind 每步对 energy/interest/company 的增减（0–100）
    stepEffects: {
      sleep: { energy: 0.55, interest: -0.02, company: -0.01 },
      sleepy: { energy: -0.15, interest: -0.05, company: 0.03 },
      wake: { energy: 0.05, interest: 0.05, company: 0.02 },
      tidy: { energy: -0.08, interest: 0.04, company: -0.02 },
      bowl: { energy: 0.4, interest: 0, company: 0.01 },
      schedule: { energy: -0.04, interest: 0.02, company: 0 },
      bili: { energy: -0.03, interest: 0.12, company: -0.01 },
      wait: { energy: -0.02, interest: -0.02, company: 0.12 },
      chat: { energy: -0.03, interest: 0.05, company: -0.08 },
      anime: { energy: -0.04, interest: 0.1, company: 0 },
      music: { energy: -0.02, interest: 0.06, company: 0.01 },
      stars: { energy: -0.02, interest: 0.05, company: 0.02 },
      game: { energy: -0.07, interest: 0.1, company: 0 },
      night: { energy: -0.06, interest: 0.06, company: 0.02 },
      out: { energy: -0.08, interest: 0.08, company: 0.02 },
      home: { energy: -0.03, interest: 0.03, company: 0.02 },
      gap: { energy: -0.02, interest: 0, company: 0.02 },
    },
  },

  memory: {
    // 预算归档时是否把原文写入 hidden；且主动 memory_remember 后 hide 本回合
    moveOutContext: true,
    // 记忆是否「放远」——不每轮自动塞进提示词，需要时用 memory_search 查
    injectFar: true,
    // 写入记忆的默认重要级（1–10，越高越重要）
    defaultImportance: 2,
    // memory_search 默认返回条数
    searchLimit: 8,
    // 每次预算归档最多 LLM 精炼几条 topic（0=只规则摘要拼接）
    autoExtractMax: 3,
    // 两次 LLM 精炼最短间隔（分钟）
    autoExtractCooldownMin: 10,
    // 官方 tokenMeter.surfaceTokens 超过此值 → 归档（与 DSH 同一计量）
    contextTokenThreshold: 64000,
    // 字符兜底（token 不可用时）
    budgetChars: 24000,
    // 永不归档的最近对话条数（按时间保留）
    keepRecent: 50,
    // 超预算时是否 hide + compact（false = 只诊断）
    hideOnOverflow: true,
    // 自动归档 topic 的重要性 1–10
    archiveTopicImportance: 4,
    // 规则/LLM 摘要正文字数上限
    archiveSummaryMaxChars: 1200,
    // 窗口内消息少于 N 条不触发归档
    archiveMinMessages: 6,
    // 归档后是否调用 ctx.compaction 折叠会话历史
    compactEnabled: true,
    // false=compactNow；true=compactIfNeeded('pressure')
    compactUseAuto: false,
    // 主动 remember 时默认是否 hide 本回合原文
    rememberHideContext: true,
    // 精炼用 provider（空=与会话 agentOptions 一致）
    archiveLlmProvider: '',
  },

  query: {
    searchMax: 20,
  },

  // 媒体（图片/表情）：直读进上下文；出站默认全开
  media: {
    directRead: true,          // 固定为 true：图片以图像块进入上下文，不做语义转述
    maxImagesPerMessage: 3,    // 单条消息最多直读张数
    maxImagesPerFetch: 6,      // 单次翻页最多直读张数
    maxImageBytes: 5242880,    // 单图字节上限（5MB）
    blockImage: false,         // true = 禁止出站发图
    blockSticker: false,       // true = 禁止出站发表情
  },

  // ===== 渠道相关（各桥接插件通过 registerChannel 注册后才有）=====
  // ⭐ 不预置任何渠道——没有桥接插件注册就没有渠道，不造假数据。
  channels: {},
}

let _cfg = null

export function loadConfig() {
  if (_cfg) return _cfg
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      // 旧配置迁移：proactive/wake → heart.gates；随后删掉旧键
      let migrated = false
      if (raw && typeof raw === 'object') {
        if (!raw.heart && raw.proactive && typeof raw.proactive === 'object') {
          raw.heart = raw.heart || structuredClone(DEFAULT_CONFIG.heart)
          const p = raw.proactive
          if (p.enabled === false) raw.heart.enabled = false
          if (Number.isFinite(Number(p.thinkThreshold))) raw.heart.gates.thinkThreshold = Number(p.thinkThreshold)
          if (Number.isFinite(Number(p.speakThreshold))) raw.heart.gates.speakThreshold = Number(p.speakThreshold)
          if (Number.isFinite(Number(p.minSilenceMinutes))) raw.heart.gates.minSilenceMinutes = Number(p.minSilenceMinutes)
          if (Number.isFinite(Number(p.minSinceSpokeMinutes))) raw.heart.gates.minSinceSpokeMinutes = Number(p.minSinceSpokeMinutes)
          migrated = true
        }
        if (raw.wake !== undefined || raw.proactive !== undefined) {
          delete raw.wake
          delete raw.proactive
          migrated = true
        }
        if (!raw.heart) migrated = true
      }
      _cfg = deepMerge(structuredClone(DEFAULT_CONFIG), raw)
      // rules 数组会被 raw 整段覆盖：补上默认里新增、用户配置里还没有的规则
      if (_cfg.heart && Array.isArray(_cfg.heart.rules)) {
        const have = new Set(_cfg.heart.rules.map((r) => r && r.id))
        let added = false
        for (const def of DEFAULT_CONFIG.heart.rules) {
          if (!have.has(def.id)) {
            _cfg.heart.rules.push(structuredClone(def))
            added = true
          }
        }
        if (added) migrated = true
      }
      // 旧默认 keepRecent=4 → 官方要求近 50 条外归档
      if (_cfg.memory && Number(_cfg.memory.keepRecent) === 4) {
        _cfg.memory.keepRecent = 50
        migrated = true
      }
      if (_cfg.memory && _cfg.memory.contextTokenThreshold == null) {
        _cfg.memory.contextTokenThreshold = 64000
        migrated = true
      }
      if (migrated) saveConfig(_cfg)
    } else {
      _cfg = structuredClone(DEFAULT_CONFIG)
      saveConfig(_cfg)
    }
  } catch (e) {
    _cfg = structuredClone(DEFAULT_CONFIG)
  }
  return _cfg
}

export function saveConfig(cfg) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = CONFIG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    renameSync(tmp, CONFIG_PATH)
    _cfg = cfg
  } catch (e) { /* ignore */ }
}

// 取某个渠道的配置。渠道不存在时返回**空**（不是假渠道）；
// 只有渠道已被 registerChannel 注册、只是缺个别字段时，才用 CHANNEL_DEFAULT 补。
export function channelConfig(cfg, channel) {
  const c = cfg.channels[channel]
  if (!c) return null
  return {
    notify: { ...CHANNEL_DEFAULT.notify, ...(c.notify || {}) },
    app: { ...CHANNEL_DEFAULT.app, ...(c.app || {}) },
    // 桥接给她的使用注意（计划第 4.3 条）：字符串，用户配置优先
    notes: (c.notes !== undefined && c.notes !== null) ? String(c.notes) : '',
  }
}

function deepMerge(base, over) {
  if (over && typeof over === 'object' && !Array.isArray(over)) {
    for (const k of Object.keys(over)) {
      if (k in base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        deepMerge(base[k], over[k])
      } else {
        base[k] = over[k]
      }
    }
  }
  return base
}

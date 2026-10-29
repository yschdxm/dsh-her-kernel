<div align="center">

# dsh-her-kernel

DeepSeek Harness 角色统一内核：让 AI 伙伴作为**同一个人**在所有渠道连贯存在。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![平台](https://img.shields.io/badge/宿主-DeepSeek%20Harness-blue)](https://github.com/deepseek-ai/dsh)
[![爱发电](https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%AF%B7%E6%88%91%E5%96%9D%E6%9D%B5%E9%B2%B8%E9%B1%BC-7e5fd9?logo=afdian&logoColor=white)](https://ifdian.net/a/yschdxm)

<a href="https://whale-star.whale-star.workers.dev/">
  <img src="https://whale-star.whale-star.workers.dev/?repo=yschdxm/dsh-her-kernel" alt="给个 Star 吧～" width="720">
</a>

> 🐳 顶部应援图来自 **[whale-star](https://github.com/yschdxm/whale-star)**——
> 按 GitHub Star 数自动升档的大肥鱼 README 应援图服务

</div>

单会话方案：人设、心绪、日子、记忆、消息库、通知、App 工具路由都在内核；渠道桥接只做**协议适配 + 出站安全分类器**，经 `kernel-api` 接入。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/00-overview.html](docs/00-overview.html) | 分层总览与数据流 |
| [docs/01-heart.html](docs/01-heart.html) | 心绪：十维、衰减公式、可调参数 |
| [docs/02-life.html](docs/02-life.html) | 日子：作息与 needs 推进 |
| [docs/03-memory.html](docs/03-memory.html) | 记忆：写入 / 检索 / 预算归档 |
| [docs/04-notify.html](docs/04-notify.html) | 通知与消息库（入库不注入） |
| [docs/05-session.html](docs/05-session.html) | 单会话与出站 |
| [docs/06-rules.html](docs/06-rules.html) | 心绪规则触发 |
| [docs/07-bridge.html](docs/07-bridge.html) | QQ 桥接要点 |
| [docs/bridge-plugin.md](docs/bridge-plugin.md) | **桥接插件开发指南** |

浏览器直接打开 `docs/*.html`（图示依赖 jsDelivr 上的 mermaid）。

## 架构

```
dsh-her-kernel/
├── lib/
│   ├── index.js           插件入口：角色运行时、工具、注入、HTTP
│   ├── characters.js      角色注册表（<ws>/.dsh-her/character.json）
│   ├── persona.js         人设（第一人称，编入 systemPrompt）
│   ├── state.js           心绪 10 维 + 日子 needs（可调系数）
│   ├── memory.js          长期记忆 SQLite（fact/lesson/topic… + hidden）
│   ├── context.js         上下文预算辅助
│   ├── msgstore.js        渠道消息库（未读/翻页/搜索）
│   ├── notify.js          手机式通知（点开即消）
│   ├── app-router.js      App 进入/翻页/标已读
│   ├── agent-session.js   会话生命周期、注入、出站、预算归档
│   ├── wake.js            事件驱动评估（通知 + 心绪规则）
│   ├── kernel-api.js      桥接统一接口
│   ├── media.js           图片/表情出站段
│   └── config.js          全局数值配置（~/.dsh/her-kernel/config.json）
├── client.js              角色面板（右侧栏）
├── docs/                  分层文档 + 桥接开发
└── .claude/skills/        Claude Code 技能（桥接开发）
```

## 单会话模型

- **一个角色 = 一个专属会话**；消息库 / 记忆 / 状态按工作区隔离。  
- **渠道消息不注入会话**：只 `ingest` 入库 + 弹通知；她用 `app_enter` / `app_fetch` / `app_send` 主动看、主动回。  
- **人设**走 `systemPrompt.context`，不进历史压缩。  
- **系统提示词永不折叠**；对话超预算时先归档进记忆，再由平台 compaction 折叠历史（若可用）。

## 角色数据目录

```
<工作区>/.dsh-her/
  character.json     角色卡（人设 / 渠道认领）
  state.json         心绪 + 日子
  life-schedule.json 作息表
  memory.db          记忆库
  messages.db        渠道消息库
```

全局数值：`~/.dsh/her-kernel/config.json`（面板「状态 / 设置」可改）。

## 安装（DeepSeek Harness）

在 Harness 配置中以 `link:` 引用本目录，例如：

```json
"dsh-her-kernel": "link:/path/to/dsh-her-kernel"
```

改插件代码后重启宿主（或按你们的 HMR 流程）；**不要**在未理解影响的情况下随意改会触发全量 HMR 的补丁文件。

## 与桥接的关系

桥接插件实现协议（NapCat / SnowLuma / 其它 OneBot 实现等），调用：

- `kernel.registerChannel({ type, notify, app, notes, ui })`
- `kernel.ingest(msg)` — 消息入库 + 通知
- `kernel.onOutbound(type, handler)` — 出站发送
- `kernel.mountTool(def, { channels })` — 按角色挂工具
- `kernel.onMessagesRead` / `notifyMessagesRead` — 本地已读 ↔ 渠道已读

完整步骤见 [docs/bridge-plugin.md](docs/bridge-plugin.md)。  
参考实现：[dsh-her-qq-bridge-sl](https://github.com/yschdxm/dsh-her-qq-bridge-sl)（SnowLuma / OneBot v11）。

## 工具一览（挂到角色会话）

| 类别 | 工具 |
|------|------|
| App | `app_list` `app_enter` `app_exit` `app_fetch` `app_query` `app_unread` `app_send` |
| 通知 | `her_notifications` `her_mark_read` |
| 人设 | `her_persona` |
| 状态 | `state_now` `state_note` |
| 生活 | `life_state` `life_schedule` `life_schedule_set` |
| 记忆 | `memory_remember` `memory_search` `memory_hidden` |
| 配置 | `her_config` |

## 心绪公式（摘要）

详见 [docs/01-heart.html](docs/01-heart.html)。底色按半衰期向基线回归；十维按 `dimDecayPerHour` 靠近基线；沉默抬 `miss`。  
**通知注入不更新 `lastSpokeAt`**；仅规则注入或她真实开口才更新。

## License

MIT。详见 [LICENSE](./LICENSE)。

借鉴并遵守各自协议：`dsh-feiyu-mood` (MIT)、`dsh-qq-companion` (BSD-3)、`dsh-bilibili-plugin` (MIT)、`companion-awakening` (MIT)、`proactive-nudge` (MIT)。

## 赞助

如果这个内核让你的「她」更像一个人，欢迎请我喝杯奶茶：

[![爱发电](https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E7%82%B9%E8%BF%99%E9%87%8C-7e5fd9?logo=afdian&logoColor=white)](https://ifdian.net/a/yschdxm)

也欢迎给仓库点 Star，让顶部大肥鱼长大一点 🐳

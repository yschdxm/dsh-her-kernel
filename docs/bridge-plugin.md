# 桥接插件开发指南（DeepSeek Harness · her-kernel）

桥接插件负责**一种聊天协议**（NapCat、SnowLuma、其它 OneBot 实现、未来微信等），把消息交给内核，把内核出站送回协议侧。

内核不碰协议；桥接不碰心绪/记忆业务逻辑。

## 职责边界

| 层 | 做什么 | 不做什么 |
|----|--------|----------|
| **桥接** | 协议收发、消息段解析、出站安全分类器、渠道面板 UI | 不写记忆、不判心绪、不直接 `agent.followup` 塞消息 |
| **内核** | 入库、通知、App 工具、出站路由、按角色挂工具 | 不解析 OneBot/微信私有协议 |

## 接入清单

1. `package.json` 声明 `dsh.bundle.patch`（如需面板样式/设置）。  
2. `export const name`、`export const inject`（通常需要 `herKernel` 或等待内核服务）。  
3. `apply(ctx)` 里拿到 `kernel`（内核会把 `kernel-api` 交给桥接）。  
4. 调用下表接口；工具输出必须是 **lossless JSON**（纯 string/number/boolean/null，禁止 `undefined` 与循环引用）。

## kernel-api

### 注册渠道

```js
kernel.registerChannel({
  type: 'qq-private',           // 唯一类型 id，角色用它认领
  notify: {
    dmPriority: true,           // 主人私聊：不静默、优先弹
    injectEnabled: true,
    injectCooldownMinutes: 0,
    injectDailyCap: 0,          // 0 = 不限
    injectRespectQuiet: false,
    format: '工具：QQ 私聊 {target} 有 {count} 条消息',
  },
  app: { pageSize: 10 },        // app_fetch 每页条数
  notes: '给她的使用说明（会进 systemPrompt 渠道注意）',
  ui: { tabId: 'qq', tabLabel: 'QQ', order: 10 },
})
```

角色在 `character.json.channels` 里写上 `type` 才会收到该渠道消息。

### 入站消息

```js
await kernel.ingest({
  channel: 'qq-private',
  target: '896062936',      // 好友号 / 群号
  sender: '野生策划的小麦',
  sender_id: '896062936',
  content: '你好',
  time: Date.now(),
  msg_id: '360397941',      // 协议侧唯一 id，字符串
  seq: 52829,               // 可选；勿用 message_id 冒充 seq
  mention: false,
  media: {                  // 可选
    images: [{ url, file }],
    faces: [{ id: '14' }],
    quote: { id, content, sender },
  },
})
```

- **空 content 会被跳过**；图片-only 消息请给占位如 `[图片]`。  
- 内核：入库（未读）→ 通知评估 → 事件驱动唤醒；**不会**直接把原文塞进她的对话。  
- 建议在 ingest 后向协议侧报已读（SnowLuma 用 `_mark_all_as_read` / `mark_msg_as_read`），清手机角标。

### 出站

```js
kernel.onOutbound('qq-private', async ({ channel, target, text }) => {
  // text 为 string 或 { text, segments: OneBot 段数组 }
  // 在这里做分类器审核 → 协议发送
  return { ok: true }
})
```

内核在 `app_send` / 回复成功后会：本地全量已读 + `notifyMessagesRead`（清渠道已读）。桥接应再调协议已读接口。

### 按角色挂工具

```js
kernel.mountTool({
  name: 'qq_custom_faces',
  description: '……',
  parameters: { type: 'object', properties: { /* … */ }, additionalProperties: false },
  execute: async (args) => ({ ok: true, items: [] }), // 纯 JSON
  output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
}, { channels: ['qq-private', 'qq-group'] })
```

只挂认领了这些渠道的角色会话。

### 已读同步

```js
kernel.onMessagesRead(({ channel, target, msgIds }) => {
  // 她 app_fetch 标本地已读后 → 向协议报已读
})
```

## 安全

- **出站分类器**：建议在桥接侧对 `app_send`/出站文本做关键词 + 可选 LLM 审核（参考 sl 的 `lib/classifier.js`）。  
- **入站不拦**（决策：只管她发出去的话）。  
- **只读白名单**：给她的查询类 OneBot/协议 API 应白名单，禁止直接发送/改设置。

## 面板 UI

- `ui.tabId` / `tabLabel` 注册进角色面板侧栏分组「渠道」。  
- 客户端可用 `client.js`（`window.__ModuleLoader__`）扩展设置页；样式跟 `data-hk-*` 体系。  
- 面板里不要放密钥明文；token 放配置文件或宿主安全存储。

## 参考实现

| 仓库 | 说明 |
|------|------|
| [dsh-her-qq-bridge-sl](https://github.com/yschdxm/dsh-her-qq-bridge-sl) | SnowLuma / OneBot v11，含分类器、表情、已读回执 |
| [dsh-her-qq-bridge-nc](本地) | NapCat 版（备份，功能以 sl 为准） |

## 调试

- 内核硬日志：`/tmp/kernel-agent.log`  
- 桥接 `diag()` 会写入该日志。  
- 渠道是否注册：角色面板 → 渠道页签 / `GET /qq-bridge/status`（若桥接提供）。  
- 消息是否入库：`messages.db` 或面板消息页。

## License

桥接插件版权归各自作者所有；与内核对接时请遵守内核 LICENSE 中的借鉴声明。

// dsh-her-kernel · 媒体直读（图片进上下文，不做语义摘要）
//
// 约定（2026-10-27 确认）：
//   - 图片按正常上下文处理：以图像块进入工具结果 / 模型上下文
//   - 必须直读，不走「先描述再转述」的旁路
//   - 出站表情与图片默认全部允许（block 开关可关）

const DEFAULTS = {
  directRead: true,
  maxImagesPerMessage: 3,
  maxImagesPerFetch: 6,
  maxImageBytes: 5 * 1024 * 1024,
  blockImage: false,
  blockSticker: false,
}

export function mediaConfig(config) {
  const m = (config && config.media) || {}
  return {
    ...DEFAULTS,
    ...m,
    // 直读为既定行为，不允许通过配置关成「只给占位符」
    directRead: true,
  }
}

function mediaTypeOf(contentType, name) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/')) return ct
  const ext = String(name || '').toLowerCase()
  if (ext.endsWith('.png')) return 'image/png'
  if (ext.endsWith('.webp')) return 'image/webp'
  if (ext.endsWith('.gif')) return 'image/gif'
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg'
  return 'image/jpeg'
}

// 下载单张图片 → { b64, mediaType, bytes } | null
export async function fetchImageBlock(ref, { maxBytes = DEFAULTS.maxImageBytes, timeoutMs = 8000 } = {}) {
  if (!ref || typeof ref !== 'object') return null
  const url = String(ref.url || '').trim()
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; dsh-her-kernel/1.0)',
        accept: 'image/*,*/*',
      },
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > maxBytes) return null
    // 快速魔数校验：必须像图片
    const head = buf[0]
    const isImg = (
      (buf[0] === 0x89 && buf[1] === 0x50) || // PNG
      (buf[0] === 0xff && buf[1] === 0xd8) || // JPEG
      (buf[0] === 0x47 && buf[1] === 0x49) || // GIF
      (buf[0] === 0x52 && buf[1] === 0x49) || // RIFF/WEBP
      (buf[0] === 0x3c) // 可能是错误页 HTML
    )
    if (!isImg) return null
    if (head === 0x3c && buf[1] !== 0x21) return null // HTML 错误页
    return {
      b64: buf.toString('base64'),
      mediaType: mediaTypeOf(res.headers.get('content-type'), ref.file),
      bytes: buf.length,
      name: String(ref.file || 'image').slice(0, 80),
    }
  } catch (e) {
    return null
  }
}

// 一条消息的 media → 最多 N 个图像块
export async function loadMessageImages(media, cfg) {
  if (!media || !Array.isArray(media.images) || !media.images.length) return []
  const maxN = Number(cfg.maxImagesPerMessage) || 3
  const out = []
  for (const ref of media.images.slice(0, maxN)) {
    const block = await fetchImageBlock(ref, { maxBytes: cfg.maxImageBytes })
    if (block) out.push(block)
  }
  return out
}

// 一批消息 → 压缩后的图像块列表（跨消息总数上限）
export async function loadRowsImages(rows, cfg) {
  const maxTotal = Number(cfg.maxImagesPerFetch) || 6
  const out = []
  for (const r of rows) {
    if (out.length >= maxTotal) break
    const blocks = await loadMessageImages(r.media, cfg)
    for (const b of blocks) {
      if (out.length >= maxTotal) break
      out.push({ ...b, msgId: r.msg_id, sender: r.sender, time: r.time })
    }
  }
  return out
}

// 组装出站 OneBot 段
// sticker：纯数字 = 黄脸 face id；JSON / mface:{...} = 商城表情 mface
export function buildSendSegments({ text, image, sticker }, cfg) {
  const segments = []
  const t = String(text || '').trim()
  if (t) segments.push({ type: 'text', data: { text: t } })
  if (image) {
    if (cfg.blockImage) return { ok: false, error: '出站发图已被策略关闭（media.blockImage）' }
    const s = String(image).trim()
    if (/^https?:\/\//i.test(s)) segments.push({ type: 'image', data: { url: s, file: s } })
    else if (s.startsWith('base64://') || s.startsWith('data:image/')) {
      const b64 = s.startsWith('data:image/') ? s.slice(s.indexOf(',') + 1) : s.slice('base64://'.length)
      segments.push({ type: 'image', data: { file: 'base64://' + b64 } })
    } else segments.push({ type: 'image', data: { file: s } })
  }
  if (sticker) {
    if (cfg.blockSticker) return { ok: false, error: '出站发表情已被策略关闭（media.blockSticker）' }
    const seg = parseStickerSegment(sticker)
    if (!seg) return { ok: false, error: '无法解析 sticker：支持纯数字 face id，或 mface JSON（{"type":"mface","data":{...}}）' }
    segments.push(seg)
  }
  if (!segments.length) return { ok: false, error: '缺少 text / image / sticker' }
  return { ok: true, segments }
}

// sticker 字符串 → OneBot 段；失败返回 null
export function parseStickerSegment(sticker) {
  let raw = typeof sticker === 'object' && sticker ? sticker : String(sticker || '').trim()
  if (!raw) return null
  if (typeof raw === 'string' && raw.startsWith('mface:')) {
    try { raw = JSON.parse(raw.slice(6)) } catch (e) { return null }
  } else if (typeof raw === 'string' && raw.startsWith('{')) {
    try { raw = JSON.parse(raw) } catch (e) { return null }
  }
  if (raw && typeof raw === 'object' && raw.type && raw.data) {
    const ty = String(raw.type)
    if (ty === 'mface' || ty === 'market_face' || ty === 'marketface') {
      return { type: ty === 'marketface' ? 'market_face' : ty, data: { ...raw.data } }
    }
    if (ty === 'face') return { type: 'face', data: { id: String(raw.data.id ?? raw.data.face_id ?? '') } }
  }
  // 纯数字 / 数字串 → 黄脸
  if (raw && typeof raw !== 'object' && /^\d+$/.test(String(raw))) {
    return { type: 'face', data: { id: String(raw) } }
  }
  // 对象但无 type：常见 mface 字段
  if (raw && typeof raw === 'object' && (raw.emoji_id || raw.emoji_package_id || raw.key)) {
    return { type: 'mface', data: { ...raw } }
  }
  return null
}

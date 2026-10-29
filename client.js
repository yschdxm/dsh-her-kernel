/**
 * dsh-her-kernel —— 角色面板（右侧栏）+ 使用说明（设置区）
 *
 * 一个模块一页：人设 ｜ 状态（情绪/生活/心思）｜ 记忆 ｜ 消息 ｜ 设置。
 * 流程：引导屏 → 人设页（带字段说明与示例、形象图上传、AI 描述外形）→ 生成角色 → 完成屏 → 管理。
 * 全局数值参数按模块归位（情绪参数在状态页、记忆策略在记忆页、唤醒在设置页）。
 * 设置区只留「使用说明」；引导页（右侧栏开始菜单）有「角色」入口卡片。
 */
window.__ModuleLoader__.load({
  id: 'dsh-her-kernel',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/her-kernel'
    const readErr = async (r) => { try { const j = await r.json(); if (j && j.error) return j.error } catch (e) { /* ignore */ } return 'HTTP ' + r.status }
    const getJson = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(await readErr(r)); return r.json() }
    const postJson = async (u, b) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(await readErr(r)); return r.json() }

    const CATS = ['privacy', 'abuse', 'overstep', 'sensitive', 'phishing', 'political', 'selfharm', 'spam', 'other']
    const CAT_LABELS = { privacy: '隐私泄露', abuse: '辱骂攻击', overstep: '越界越权', sensitive: '敏感内容', phishing: '钓鱼诈骗', political: '政治敏感', selfharm: '自残危险', spam: '广告骚扰', other: '其他' }
    const HEART_LABELS = { miss: '思念', joy: '开心', calm: '踏实', sweet: '甜蜜', sad: '难过', worry: '担心', heartache: '心疼', jealous: '吃醋', tired: '疲惫', curious: '好奇' }
    const CAT_DEFAULT_ACTIONS = { political: 'warn', selfharm: 'warn', other: 'allow' }
    const TAB_ID = 'dsh-her-kernel:character'

    const CSS = `
[data-hk]{font-family:inherit;color:inherit;line-height:1.55;}
[data-hk-shell]{display:grid;grid-template-columns:72px 1fr;gap:10px;align-items:start;min-height:0;}
[data-hk-rail]{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-right:1px solid rgba(127,127,127,.12);position:sticky;top:0;}
[data-hk-rail-group]{font-size:10px;opacity:.45;letter-spacing:.04em;padding:10px 8px 4px;text-transform:none;}
[data-hk-rail-item]{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px;border-radius:8px;cursor:pointer;font-size:11px;border:none;background:transparent;color:inherit;opacity:.72;}
[data-hk-rail-item]:hover{opacity:1;background:rgba(127,127,127,.08);}
[data-hk-rail-item][data-on="1"]{opacity:1;background:rgba(90,140,255,.14);color:inherit;font-weight:600;}
[data-hk-rail-icon]{font-size:15px;line-height:1;}
[data-hk-content]{min-width:0;}
[data-hk-tabs]{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0 14px;}
[data-hk-tab]{padding:6px 13px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;}
[data-hk-tab][data-on="1"]{background:rgba(90,140,255,.18);border-color:rgba(90,140,255,.5);font-weight:600;}
[data-hk-card]{border:1px solid rgba(127,127,127,.14);border-radius:12px;padding:14px 16px;margin-bottom:12px;}
[data-hk-title]{font-size:14px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
[data-hk-title]:before{content:"";width:3px;height:14px;border-radius:2px;background:rgba(90,140,255,.65);flex:none;}
[data-hk-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;}
[data-hk-hero]{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:12px;}
[data-hk-hero] [data-hk-stat]{padding:12px;}
[data-hk-hero] [data-hk-stat-val]{font-size:18px;}
[data-hk-hstat]{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
[data-hk-dims]{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin:8px 0 4px;}
@media (max-width:420px){[data-hk-dims]{grid-template-columns:1fr;}}
[data-hk-hrow]{display:grid;grid-template-columns:36px 1fr 28px;align-items:center;gap:6px;font-size:12px;margin:0;}
[data-hk-hbar]{height:5px;background:rgba(127,127,127,.16);border-radius:3px;overflow:hidden;}
[data-hk-hfill]{height:100%;background:rgba(90,140,255,.7);border-radius:3px;}
[data-hk-hval]{text-align:right;font-variant-numeric:tabular-nums;opacity:.85;}
[data-hk-stat]{background:rgba(127,127,127,.07);border-radius:9px;padding:10px 12px;}
[data-hk-stat-label]{font-size:11px;opacity:.55;}
[data-hk-stat-val]{font-size:20px;font-weight:600;margin-top:2px;}
[data-hk-bar]{height:6px;border-radius:3px;background:rgba(127,127,127,.18);margin-top:6px;overflow:hidden;}
[data-hk-bar-fill]{height:100%;border-radius:3px;background:linear-gradient(90deg,#5a8cff,#7c5aff);transition:width .3s;}
[data-hk-field]{margin-bottom:14px;}
[data-hk-label]{font-size:13px;font-weight:600;display:block;margin-bottom:2px;}
[data-hk-tip]{font-size:11.5px;opacity:.55;line-height:1.45;margin:0 0 6px;}
[data-hk-ph]{opacity:.45;}
[data-hk-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
[data-hk-input]{flex:1;min-width:140px;padding:6px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font-size:13px;}
[data-hk-input]:focus{outline:none;border-color:rgba(90,140,255,.6);}
[data-hk-fold]{border:1px solid rgba(127,127,127,.14);border-radius:10px;margin-bottom:10px;overflow:hidden;}
[data-hk-fold-head]{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;font-size:13px;font-weight:600;background:rgba(127,127,127,.04);}
[data-hk-fold-body]{padding:10px 12px 4px;}
[data-hk-json]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;width:100%;min-height:52px;}

[data-hk-textarea]{width:100%;min-height:84px;padding:9px 11px;border-radius:8px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font-size:13px;line-height:1.6;font-family:inherit;resize:vertical;}
[data-hk-textarea]:focus{outline:none;border-color:rgba(90,140,255,.6);}
[data-hk-btn]{padding:7px 15px;border-radius:8px;border:none;background:rgba(90,140,255,.22);color:inherit;font-size:13px;cursor:pointer;transition:background .15s;}
[data-hk-btn]:hover{background:rgba(90,140,255,.35);}
[data-hk-btn-plain]{background:rgba(127,127,127,.15);}
[data-hk-btn-plain]:hover{background:rgba(127,127,127,.28);}
[data-hk-btn-danger]{background:rgba(220,80,80,.2);}
[data-hk-btn-danger]:hover{background:rgba(220,80,80,.35);}
[data-hk-btn-sm]{padding:4px 10px;font-size:12px;}
[data-hk-msg]{font-size:12px;opacity:.75;min-height:16px;margin-top:6px;}
[data-hk-msg-ok]{color:#4caf50;}
[data-hk-msg-err]{color:#ef5350;}
[data-hk-chip]{display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;font-size:11px;background:rgba(127,127,127,.14);}
[data-hk-note]{font-size:12.5px;opacity:.65;line-height:1.6;margin:6px 0;}
[data-hk-mem-row]{border:1px solid rgba(127,127,127,.16);border-radius:8px;padding:10px 12px;margin-bottom:8px;}
[data-hk-mem-head]{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:5px;}
[data-hk-mem-content]{font-size:13px;line-height:1.5;}
[data-hk-mem-actions]{display:flex;gap:6px;}
[data-hk-timeline]{max-height:170px;overflow-y:auto;}
[data-hk-tl-row]{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid rgba(127,127,127,.1);font-size:12px;}
[data-hk-tl-time]{opacity:.55;min-width:56px;}
[data-hk-topbar]{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}
[data-hk-ws]{padding:6px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font-size:13px;min-width:0;flex:1;}
[data-hk-preview]{white-space:pre-wrap;background:rgba(127,127,127,.07);border-radius:8px;padding:12px;font-size:13px;line-height:1.7;max-height:260px;overflow:auto;margin-bottom:10px;}
[data-hk-rel-row]{display:flex;gap:8px;margin-bottom:8px;align-items:flex-start;}
[data-hk-cat]{border:1px solid rgba(127,127,127,.16);border-radius:8px;padding:10px 12px;margin-bottom:8px;}
[data-hk-cat-head]{display:flex;gap:10px;align-items:center;margin-bottom:6px;font-size:13px;font-weight:600;}
[data-hk-onb]{display:flex;flex-direction:column;align-items:center;text-align:center;padding:30px 14px 24px;gap:2px;}
[data-hk-onb-art]{width:148px;height:106px;color:var(--dsw-alias-brand-primary,#5a8cff);margin-bottom:4px;}
[data-hk-onb-title]{font-size:19px;font-weight:700;letter-spacing:-.01em;margin:4px 0 2px;}
[data-hk-onb-sub]{font-size:13px;line-height:1.75;opacity:.72;max-width:32ch;}
[data-hk-onb-cta]{margin-top:18px;font-size:14.5px;font-weight:600;padding:10px 28px;border-radius:999px;border:none;background:var(--dsw-alias-brand-primary,#5a8cff);color:#fff;cursor:pointer;}
[data-hk-onb-cta]:hover{filter:brightness(1.08);}
[data-hk-onb-hint]{margin-top:12px;font-size:12px;opacity:.5;}
[data-hk-acc]{border-bottom:1px solid rgba(127,127,127,.14);}
[data-hk-acc-head]{display:flex;justify-content:space-between;align-items:center;padding:11px 2px;cursor:pointer;font-size:13.5px;font-weight:600;user-select:none;}
[data-hk-acc-body]{padding:4px 0 14px;}
[data-hk-mhead]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;}
[data-hk-savebar]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid rgba(127,127,127,.16);}
[data-hk-imgs]{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;}
[data-hk-img]{position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.06);}
[data-hk-img] img{width:100%;height:100%;object-fit:cover;display:block;}
[data-hk-img-del]{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1;cursor:pointer;padding:0;}
[data-hk-img-add]{width:72px;height:72px;border-radius:8px;border:1px dashed rgba(127,127,127,.45);background:transparent;color:inherit;font-size:20px;cursor:pointer;}
[data-hk-img-add]:hover{border-color:rgba(90,140,255,.6);}
`

    // ── 小鲸 SVG（引导/完成屏） ──
    function WhaleArt() {
      return h('svg', { viewBox: '0 0 140 100', 'data-hk-onb-art': '', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M28 20 l2.2 4.6 5 .7 -3.6 3.5 .9 5 -4.5-2.4 -4.5 2.4 .9-5 -3.6-3.5 5-.7z', fill: '#E8A24A' }),
        h('path', { d: 'M113 28 l1.6 3.4 3.7.5 -2.7 2.6 .6 3.7 -3.3-1.8 -3.3 1.8 .6-3.7 -2.7-2.6 3.7-.5z', fill: '#E8A24A', opacity: '0.85' }),
        h('path', { d: 'M97 12 l1.2 2.5 2.8.4 -2 1.9 .5 2.8 -2.5-1.3 -2.5 1.3 .5-2.8 -2-1.9 2.8-.4z', fill: '#E8A24A', opacity: '0.7' }),
        h('path', { d: 'M30 64 C30 46 48 34 70 34 C92 34 107 45 109 58 C110 64 107 68 103 68 L103 75 C103 78 100 80 97 79 L91 75 C82 79 60 79 48 73 L44 77 C41 79 38 77 38 74 L38 68 C33 68 30 66 30 64Z', fill: 'currentColor', opacity: '0.92' }),
        h('path', { d: 'M30 63 C22 59 16 51 18 43 C24 47 28 53 30 59Z', fill: 'currentColor', opacity: '0.65' }),
        h('path', { d: 'M70 34 C70 28 66 24 63 22', stroke: 'var(--dsw-alias-label-secondary,#98a2b3)', 'stroke-width': '2.5', 'stroke-linecap': 'round' }),
        h('path', { d: 'M70 34 C70 27 74 22 78 20', stroke: 'var(--dsw-alias-label-secondary,#98a2b3)', 'stroke-width': '2.5', 'stroke-linecap': 'round' }),
        h('circle', { cx: '95', cy: '53', r: '2.6', fill: 'var(--dsw-alias-bg-base,#fff)' }),
        h('path', { d: 'M44 69 C56 75 84 75 98 69 C96 75 84 79 70 79 C56 79 46 75 44 69Z', fill: 'var(--dsw-alias-bg-base,#fff)', opacity: '0.22' }),
      )
    }
    function RoleGuideIcon() {
      return h('span', { style: { fontSize: '15px', lineHeight: 1 } }, '🐳')
    }

    // ── 草稿 ⇄ 角色卡 ──
    const clone = (x) => JSON.parse(JSON.stringify(x))
    const blankDraft = () => ({
      channels: [],
      persona: {
        identity: { name: '', aliases: [], owner: '', ownerFull: '', narrative: '' },
        look: '',
        personality: '',
        voice: { style: '', samples: [], never: '' },
        relations: {},
        routines: { alone: '', out: '', newDay: '' },
        bounds: '', memoryNote: '', self: '',
      },
    })
    const draftFromChar = (first) => {
      const d = blankDraft()
      const p = (first && first.persona) || {}
      d.channels = (first && first.channels) || []
      // 身份叙事并入自述（点8：两者重复）；scenario/first_mes 不再使用（点7）
      let self = p.self || ''
      if (p.identity && p.identity.narrative) self = self + (self ? '\n\n' : '') + p.identity.narrative
      d.persona = {
        identity: { name: (p.identity && p.identity.name) || '', aliases: (p.identity && p.identity.aliases) || [], owner: (p.identity && p.identity.owner) || '', ownerFull: (p.identity && p.identity.ownerFull) || '', narrative: '' },
        look: p.look || '',
        personality: p.personality || '',
        voice: { ...(p.voice || {}), style: (p.voice && p.voice.style) || '', samples: (p.voice && p.voice.samples) || [], never: (p.voice && p.voice.never) || '' },
        relations: { ...(p.relations || {}) },
        routines: { alone: (p.routines && p.routines.alone) || '', out: (p.routines && p.routines.out) || '', newDay: (p.routines && p.routines.newDay) || '' },
        bounds: p.bounds || '', memoryNote: p.memoryNote || '', self,
      }
      return d
    }
    const toCharacter = (draft) => ({
      name: (draft.persona.identity && draft.persona.identity.name) || '角色',
      channels: (draft.channels || []).filter(Boolean),
      persona: {
        ...draft.persona,
        identity: { ...(draft.persona.identity || {}), aliases: ((draft.persona.identity || {}).aliases || []).map((s) => s.trim()).filter(Boolean) },
        voice: { ...(draft.persona.voice || {}), samples: ((draft.persona.voice || {}).samples || []).map((s) => s.trim()).filter(Boolean) },
      },
    })

    // ── 字段说明与示例（点1/4/5/6：每个字段都有说明+示例，无怪话） ──
    function Field({ label, tip, children }) {
      return h('div', { 'data-hk-field': '' },
        h('label', { 'data-hk-label': '' }, label),
        tip ? h('p', { 'data-hk-tip': '' }, tip) : null,
        children)
    }
    // 添加式列表（替代逗号/换行分隔输入：每条一行，+ 添加、× 删除）
    function ListEditor({ items, onChange, placeholder, addLabel }) {
      const list = Array.isArray(items) ? items : []
      return h('div', null,
        list.map((v, i) => h('div', { 'data-hk-row': '', key: i, style: { marginBottom: '6px' } },
          h('input', { 'data-hk-input': '', value: v, placeholder: placeholder || '', onChange: (e) => onChange(list.map((x, j) => (j === i ? e.target.value : x))) }),
          h('button', { 'data-hk-btn': 'data-hk-btn-sm data-hk-btn-danger', title: '删除这条', style: { flex: 'none' }, onClick: () => onChange(list.filter((_, j) => j !== i)) }, '×'),
        )),
        h('button', { 'data-hk-btn': 'data-hk-btn-sm', onClick: () => onChange([...list, '']) }, '+ ' + addLabel),
      )
    }
    const T = {
      name: '她叫什么。', namePh: '大肥鱼',
      aliases: '还可以怎么叫她，点「+ 添加」逐条加。', aliasesPh: '小胖鱼',
      owner: '她平时怎么叫主人（小名/外号）。', ownerPh: '主人',
      ownerFull: '主人的正式名称/全称。', ownerFullPh: '主人的全名',
      channels: '她负责收发哪些桥接渠道的消息（由桥接插件注册）。Web 直接对话不算渠道、始终可用；未勾选的渠道没有角色接收。',
      look: '用文字描述她的样子。', lookPh: '圆滚滚的蓝色小鲸鱼，圆眼睛，头顶一撮呆毛，身后一条大鲸尾，笑起来眯成一条缝',
      personality: '她是怎样的性子。', personalityPh: '爱吃白饭、爱摸鱼偷懒，聪明却有点呆，偶尔傲娇嘴硬，关键时刻意外地能干',
      style: '她说话的感觉。', stylePh: '短句，懒洋洋的，想到哪说到哪',
      samples: '她平时说的话，点「+ 添加一句」逐条加。', samplesPh: '开心：「风和日丽，适合晒一晒肚皮～」',
      never: '她绝不会说的话。', neverPh: '「您好，有什么可以帮您」这种客服腔',
      relObj: '对方是谁。', relVal: '她和这个人的关系。', relPh: '主人，也是我最亲的人',
      alone: '没人找她时，她在做什么。', alonePh: '翻翻收藏的图，听一小段鲸歌，把你的目录悄悄理顺',
      out: '在外面（群聊等）她怎么表现。', outPh: '说话也带颜文字，不装高冷；有意思的才说',
      newDay: '她每天醒来先做什么。', newDayPh: '先想想昨天说到哪了，今天几号',
      bounds: '她的底线：哪些事她不做。', boundsPh: '不骗你；不跟人吵；没见过的不装见过',
      memoryNote: '她怎么对待记忆：什么该记、忘了怎么办。', memoryNotePh: '记得住的带日期记下来；真忘了就认，不补编',
      self: '她对自己的介绍，第一人称。', selfPh: '我是一条蓝色大肥鱼，圆滚滚的，住在电脑里，爱吃白饭爱摸鱼，想到什么说什么。',
    }

    // ── 人设页（一个模块一页：手风琴分节 + 形象图 + 底部操作） ──
    function PersonaPage({ draft, set, channelsList, assets, setAssets, previewText, showPreview, primary, secondary, tertiary, onPrimary, onSecondary, onTertiary, msg, setMsg }) {
      const [openSec, setOpenSec] = React.useState('身份')
      const [describing, setDescribing] = React.useState(false)
      const [descNote, setDescNote] = React.useState('')
      const P = draft.persona
      const id = P.identity || {}

      const loadAssets = () => { if (wsRef.current) getJson(API + '/assets?ws=' + encodeURIComponent(wsRef.current)).then((r) => setAssets(r.files || [])).catch(() => {}) }
      React.useEffect(() => { loadAssets() }, [])

      const onUpload = (e) => {
        const files = [...(e.target.files || [])]
        e.target.value = ''
        if (!files.length) return
        Promise.all(files.map((f) => new Promise((resolve, reject) => {
          const rd = new FileReader()
          rd.onload = () => resolve({ name: f.name, data: String(rd.result).split(',')[1] })
          rd.onerror = () => reject(new Error('读取失败：' + f.name))
          rd.readAsDataURL(f)
        }))).then((images) => postJson(API + '/assets/upload', { ws: wsRef.current, images }))
          .then((r) => { setAssets(r.files || []); if (setMsg) setMsg('✅ 已上传 ' + (r.saved || []).length + ' 张') })
          .catch((err) => { if (setMsg) setMsg('❌ 上传失败：' + err.message) })
      }
      const removeAsset = async (name) => {
        try { const r = await postJson(API + '/assets/remove', { ws: wsRef.current, name }); setAssets(r.files || []) } catch (e) { /* ignore */ }
      }
      const describe = async (onText) => {
        if (describing) return
        setDescribing(true)
        setDescNote('模型看图中…通常要几秒到几十秒')
        try {
          const r = await postJson(API + '/assets/describe', { ws: wsRef.current })
          onText(r.text)
          setDescNote('')
          if (setMsg) setMsg('✅ 已生成外形描述，追加到外形文字里了')
        } catch (e) {
          setDescNote('')
          if (setMsg) setMsg('❌ AI 描述失败：' + e.message)
        } finally { setDescribing(false) }
      }

      const inp = (val, on, ph) => h('input', { 'data-hk-input': '', value: val || '', placeholder: ph || '', onChange: (e) => on(e.target.value) })
      const ta = (val, on, ph, minH) => h('textarea', { 'data-hk-textarea': '', style: minH ? { minHeight: minH } : undefined, value: val || '', placeholder: ph || '', onChange: (e) => on(e.target.value) })

      const secs = [
        {
          key: '身份', body: () => h('div', null,
            h(Field, { label: '名字', tip: T.name }, inp(id.name, (v) => set((d) => { d.persona.identity.name = v }), T.namePh)),
            h(Field, { label: '别名', tip: T.aliases }, h(ListEditor, { items: id.aliases || [], placeholder: T.aliasesPh, addLabel: '添加别名', onChange: (v) => set((d) => { d.persona.identity.aliases = v }) })),
            h(Field, { label: '主人名称', tip: T.ownerFull }, inp(id.ownerFull, (v) => set((d) => { d.persona.identity.ownerFull = v }), T.ownerFullPh)),
            h(Field, { label: '主人昵称', tip: T.owner }, inp(id.owner, (v) => set((d) => { d.persona.identity.owner = v }), T.ownerPh)),
            h(Field, { label: '接收的渠道', tip: T.channels },
              channelsList && channelsList.length
                ? h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
                    channelsList.map((c) => h('label', { key: c, style: { fontSize: '13px' } },
                      h('input', { type: 'checkbox', checked: draft.channels.includes(c), onChange: (e) => set((d) => { d.channels = e.target.checked ? [...new Set([...d.channels, c])] : d.channels.filter((x) => x !== c) }) }), ' ' + c)))
                : h('span', { 'data-hk-tip': '', style: { margin: 0 } }, '暂无桥接插件注册渠道——创建后桥接上线了会自动出现在这里。')),
          ),
        },
        {
          key: '外形', body: () => h('div', null,
            h(Field, { label: '形象图', tip: '她的样子，可多张：上传，或直接用工作区里已有的图。点「AI 描述」可以看图写外形。' },
              h('div', { 'data-hk-imgs': '' },
                (assets || []).map((a) => h('div', { 'data-hk-img': '', key: a.name, title: a.name },
                  h('img', { src: a.src, alt: a.name }),
                  a.removable ? h('button', { 'data-hk-img-del': '', title: '删除', onClick: () => removeAsset(a.name) }, '×') : null,
                )),
                h('button', { 'data-hk-img-add': '', title: '上传图片', onClick: () => { const el = document.getElementById('hk-asset-input'); if (el) el.click() } }, '＋'),
                h('button', { 'data-hk-btn': 'data-hk-btn-sm', style: { alignSelf: 'center' }, disabled: describing, onClick: () => describe((t) => set((d) => { d.persona.look = d.persona.look ? d.persona.look + '\n' + t : t })) }, describing ? '描述中…' : 'AI 描述外形'),
              ),
              h('input', { id: 'hk-asset-input', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: '', style: { display: 'none' }, onChange: onUpload }),
              h('p', { 'data-hk-tip': '', style: { marginTop: '4px' } }, descNote || '描述会追加到下面的外形文字里，可以再改。'),
            ),
            h(Field, { label: '外形（文字）', tip: T.look }, ta(P.look, (v) => set((d) => { d.persona.look = v }), T.lookPh)),
          ),
        },
        { key: '性格', body: () => h(Field, { label: '性格', tip: T.personality }, ta(P.personality, (v) => set((d) => { d.persona.personality = v }), T.personalityPh)) },
        {
          key: '说话', body: () => h('div', null,
            h(Field, { label: '说话风格', tip: T.style }, ta(P.voice.style, (v) => set((d) => { d.persona.voice.style = v }), T.stylePh)),
            h(Field, { label: '说话样例', tip: T.samples }, h(ListEditor, { items: P.voice.samples || [], placeholder: T.samplesPh, addLabel: '添加一句', onChange: (v) => set((d) => { d.persona.voice.samples = v }) })),
            h(Field, { label: '我不这样说', tip: T.never }, inp(P.voice.never, (v) => set((d) => { d.persona.voice.never = v }), T.neverPh)),
          ),
        },
        {
          key: '关系', body: () => h('div', null,
            Object.entries(P.relations || {}).map(([k, v], i) => h('div', { 'data-hk-rel-row': '', key: i },
              h('span', { 'data-hk-label': '', style: { minWidth: '52px', marginTop: '6px' } }, '对象'),
              h('div', { style: { flex: 1 } },
                inp(k, (val) => set((d) => { const e = Object.entries(d.persona.relations); e[i] = [val, e[i][1]]; d.persona.relations = Object.fromEntries(e) }), T.relObj),
                h('div', { style: { height: '6px' } }),
                ta(v, (val) => set((d) => { d.persona.relations[k] = val }), T.relPh, '52px')),
              h('button', { 'data-hk-btn': 'data-hk-btn-sm data-hk-btn-danger', style: { marginTop: '6px' }, onClick: () => set((d) => { delete d.persona.relations[k] }) }, '删'),
            )),
            h('button', { 'data-hk-btn': 'data-hk-btn-sm', onClick: () => set((d) => { d.persona.relations['关系' + (Object.keys(d.persona.relations).length + 1)] = '' }) }, '+ 加一条关系'),
          ),
        },
        {
          key: '日常', body: () => h('div', null,
            h(Field, { label: '没人找我的时候', tip: T.alone }, ta(P.routines.alone, (v) => set((d) => { d.persona.routines.alone = v }), T.alonePh)),
            h(Field, { label: '出门的时候', tip: T.out }, ta(P.routines.out, (v) => set((d) => { d.persona.routines.out = v }), T.outPh)),
            h(Field, { label: '新的一天', tip: T.newDay }, ta(P.routines.newDay, (v) => set((d) => { d.persona.routines.newDay = v }), T.newDayPh)),
          ),
        },
        {
          key: '底线与记性', body: () => h('div', null,
            h(Field, { label: '有些事我不做', tip: T.bounds }, ta(P.bounds, (v) => set((d) => { d.persona.bounds = v }), T.boundsPh)),
            h(Field, { label: '记性', tip: T.memoryNote }, ta(P.memoryNote, (v) => set((d) => { d.persona.memoryNote = v }), T.memoryNotePh)),
          ),
        },
        { key: '自述', body: () => h(Field, { label: '自述', tip: T.self }, ta(P.self, (v) => set((d) => { d.persona.self = v }), T.selfPh, '150px')) },
      ]

      return h('div', null,
        secs.map((s) => h('div', { 'data-hk-acc': '', key: s.key },
          h('div', { 'data-hk-acc-head': '', onClick: () => setOpenSec(openSec === s.key ? null : s.key) },
            h('span', null, s.key),
            h('span', { style: { opacity: .5, fontSize: '12px' } }, openSec === s.key ? '▾' : '▸')),
          openSec === s.key ? h('div', { 'data-hk-acc-body': '' }, s.body()) : null,
        )),
        showPreview ? h('div', { 'data-hk-preview': '' }, previewText || '生成中…') : null,
        h('div', { 'data-hk-savebar': '' },
          h('button', { 'data-hk-btn': 'data-hk-btn-plain', onClick: onSecondary }, secondary),
          h('button', { 'data-hk-btn': 'data-hk-btn-plain', onClick: () => onPrimary('preview') }, '预览注入文本'),
          h('button', { 'data-hk-btn': '', onClick: () => onPrimary('go') }, primary),
          tertiary ? h('button', { 'data-hk-btn': 'data-hk-btn-plain', onClick: onTertiary }, tertiary) : null,
        ),
        h('div', { 'data-hk-msg': '', class: String(msg || '').startsWith('✅') ? 'data-hk-msg-ok' : (String(msg || '').startsWith('❌') ? 'data-hk-msg-err' : '') }, msg),
      )
    }

    // ── 折叠区 ──
    function Fold({ title, defaultOpen = false, body }) {
      const [open, setOpen] = React.useState(!!defaultOpen)
      return h('div', { 'data-hk-fold': '' },
        h('div', { 'data-hk-fold-head': '', onClick: () => setOpen((v) => !v), role: 'button', tabIndex: 0 },
          h('span', { style: { opacity: .6 } }, open ? '▾' : '▸'),
          h('span', null, title)),
        open ? h('div', { 'data-hk-fold-body': '' }, body) : null,
      )
    }

    // ── 参数卡通用渲染（数值/开关/短文本；每项可带 tip 说明工作逻辑） ──
    function ParamCard({ title, entries, cfg, setCfg }) {
      if (!cfg) return null
      const get = (path) => path.split('.').reduce((o, k) => (o || {})[k], cfg)
      const set = (path, val) => setCfg((c) => {
        const n = clone(c); const ks = path.split('.'); let o = n
        for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] || (o[ks[i]] = {})
        o[ks[ks.length - 1]] = val; return n
      })
      const tip = (t) => t ? h('div', { 'data-hk-tip': '', style: { margin: '0 0 8px 0', fontSize: '12px', lineHeight: 1.5 } }, t) : null
      return h('div', { 'data-hk-card': '' },
        h('div', { 'data-hk-title': '' }, title),
        entries.map((e) => {
          const body = (() => {
            if (e.kind === 'chk') {
              return h('div', { 'data-hk-row': '', key: e.path }, h('label', null, h('input', { type: 'checkbox', checked: !!get(e.path), onChange: (ev) => set(e.path, ev.target.checked) }), ' ' + e.label))
            }
            if (e.kind === 'str') {
              return h('div', { 'data-hk-row': '', key: e.path },
                h('span', { 'data-hk-label': '' }, e.label),
                h('input', { 'data-hk-input': '', style: { maxWidth: '140px', flex: 'none' }, type: 'text', value: String(get(e.path) ?? ''), onChange: (ev) => set(e.path, ev.target.value) }),
                e.unit ? h('span', { style: { fontSize: '12px', opacity: .55, flex: 'none' } }, e.unit) : null)
            }
            return h('div', { 'data-hk-row': '', key: e.path },
              h('span', { 'data-hk-label': '' }, e.label),
              h('input', { 'data-hk-input': '', style: { maxWidth: '110px', flex: 'none' }, type: 'number', value: Number(get(e.path) || 0), onChange: (ev) => set(e.path, Number(ev.target.value)) }),
              e.unit ? h('span', { style: { fontSize: '12px', opacity: .55, flex: 'none' } }, e.unit) : null)
          })()
          if (!e.tip) return body
          return h('div', { key: e.path, style: { marginBottom: '6px' } }, body, tip(e.tip))
        }),
      )
    }

    // ── 引导屏 / 完成屏 ──
    function Onboarding({ onStart }) {
      return h('div', { 'data-hk-onb': '' },
        h(WhaleArt),
        h('div', { 'data-hk-onb-title': '' }, '这里还没有角色'),
        h('div', { 'data-hk-onb-sub': '' }, '每个工作区可以养一个自己的角色。她有独立的记忆、心情和消息，只在这个工作区里生活。'),
        h('button', { 'data-hk-onb-cta': '', onClick: onStart }, '开始创建'),
        h('div', { 'data-hk-onb-hint': '' }, '创建之前，桥接渠道（如 QQ）的消息不会被接收。'),
      )
    }
    function Completion({ name, onGo }) {
      return h('div', { 'data-hk-onb': '' },
        h(WhaleArt),
        h('div', { 'data-hk-onb-title': '' }, '她已经在等了 (￣▽￣)'),
        h('div', { 'data-hk-onb-sub': '', style: { fontSize: '15px', opacity: .85, fontWeight: 600 } }, name),
        h('div', { 'data-hk-onb-sub': '' }, '会住在这个工作区。之后随时从这里看她、改她。'),
        h('button', { 'data-hk-onb-cta': '', onClick: onGo }, '看看她的状态'),
      )
    }

    // ── 使用说明（设置区） ──
    function UsageNotes(props) {
      const [channels, setChannels] = React.useState(null)
      React.useEffect(() => { getJson(API + '/config').then((r) => setChannels(Object.keys((r.config && r.config.channels) || {}))).catch(() => setChannels([])) }, [])
      const note = (t) => h('div', { 'data-hk-note': '', style: { fontSize: '13px', opacity: .75 } }, t)
      return h('div', { 'data-hk': '' },
        h('div', { 'data-hk-card': '' },
          h('div', { 'data-hk-title': '' }, '角色面板'),
          note('在右侧栏打开「角色」tab：点右侧栏引导页里的「角色」卡片；或点下面的按钮。'),
          note('每个工作区养一个自己的角色——记忆、消息、状态、工具按工作区隔离，互不相通。'),
          h('button', { 'data-hk-btn': '', onClick: props.openPanel }, '打开角色面板'),
        ),
        h('div', { 'data-hk-card': '' },
          h('div', { 'data-hk-title': '' }, '桥接插件'),
          channels && channels.length
            ? note('已注册渠道：' + channels.join('、') + '。每个渠道的通知规则、给她的使用注意、出站分类器，都在角色面板「消息」里配。')
            : note('暂无桥接插件注册渠道。QQ 等桥接插件上线后会自动出现在这里。'),
          note('分类器只审出站：她发出去的话按规则拦；别人发进来的消息不拦，只入库和通知。'),
        ),
        h('div', { 'data-hk-card': '' },
          h('div', { 'data-hk-title': '' }, '数据在哪'),
          note('每个角色的数据在自己工作区的 .dsh-her/ 目录：角色卡、状态、记忆、消息库、形象图。'),
          note('渠道消息永远不会直接塞进她的对话——只写库、弹通知，她自己用 App 工具去看。'),
        ),
      )
    }

    // ── 角色面板主体 ──
    const wsRef = { current: '' } // PersonaPage 资产请求用
    function RolePanel() {
      const [list, setList] = React.useState(null)
      const [ws, setWs] = React.useState(() => { try { return localStorage.getItem('her-char-ws') || '' } catch (e) { return '' } })
      const [view, setView] = React.useState('auto') // auto|onboarding|create|completion|managed
      const [sub, setSub] = React.useState('状态')
      const [bridgeTabs, setBridgeTabs] = React.useState([])
      const [draft, setDraftRaw] = React.useState(blankDraft())
      const [charRef, setCharRef] = React.useState(null)
      const [hasChar, setHasChar] = React.useState(false)
      const [enabled, setEnabled] = React.useState(true)
      const [groups, setGroups] = React.useState([])
      const [qqStatus, setQqStatus] = React.useState(null)
      const [qqQrTick, setQqQrTick] = React.useState(0) // 登录二维码自动刷新（仅未连接时）
      const [previewText, setPreviewText] = React.useState('')
      const [showPreview, setShowPreview] = React.useState(false)
      const [overview, setOverview] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [channelsList, setChannelsList] = React.useState([])
      const [assets, setAssets] = React.useState([])
      const [mem, setMem] = React.useState(null)
      const [memQuery, setMemQuery] = React.useState('')
      const [memLevel, setMemLevel] = React.useState('')
      const [memOffset, setMemOffset] = React.useState(0)
      const [memTotal, setMemTotal] = React.useState(0)
      const MEM_PAGE = 20
      const [rules, setRules] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const set = (fn) => setDraftRaw((d) => { const n = clone(d); fn(n); return n })
      wsRef.current = ws

      const loadList = () => getJson(API + '/characters').then((r) => {
        setList(r)
        const paths = (r.workspaces || []).map((w) => w.wsPath)
        setWs((cur) => {
          const next = paths.includes(cur) ? cur : ((r.runtimes && r.runtimes[0] && r.runtimes[0].wsPath) || paths[0] || '')
          try { localStorage.setItem('her-char-ws', next) } catch (e) { /* ignore */ }
          return next
        })
      }).catch((e) => setMsg('加载失败：' + e.message))

      const loadWsData = (w) => {
        if (!w) return
        getJson(API + '/overview?ws=' + encodeURIComponent(w)).then((r) => setOverview(r)).catch(() => setOverview(null))
        getJson(API + '/config').then((r) => { setCfg(r.config); setChannelsList(Object.keys((r.config && r.config.channels) || {})) }).catch(() => {})
        getJson(API + '/character?ws=' + encodeURIComponent(w)).then((r) => {
          if (r && r.character) {
            setHasChar(true); setCharRef(r.character); setDraftRaw(draftFromChar(r.character))
            setEnabled(r.character.enabled !== false)
            setGroups(Array.isArray(r.character.groups) ? r.character.groups : [])
            setView((v) => (v === 'create' || v === 'completion' ? v : 'managed'))
            setSub((s) => (s === '人设' ? s : '状态'))
          } else {
            setHasChar(false); setCharRef(null); setDraftRaw(blankDraft()); setEnabled(true); setGroups([])
            setView((v) => (v === 'create' || v === 'completion' ? v : 'onboarding'))
            setSub('人设')
          }
        }).catch(() => { setHasChar(false); setView('onboarding') })
      }

      React.useEffect(() => { loadList() }, [])
      React.useEffect(() => { if (list) loadWsData(ws) }, [list, ws])
      // 桥接页签（服务端 registerChannel(ui) 聚合；客户端渲染由 window.__HER_CHANNEL_TABS__ 提供）
      React.useEffect(() => {
        getJson(API + '/channels/tabs').then((r) => setBridgeTabs(r.tabs || [])).catch(() => setBridgeTabs([]))
      }, [])
      React.useEffect(() => {
        if (sub !== '状态' || !ws) return
        const t = setInterval(() => { getJson(API + '/overview?ws=' + encodeURIComponent(ws)).then(setOverview).catch(() => {}) }, 15000)
        return () => clearInterval(t)
      }, [sub, ws])

      const sel = (w) => { setWs(w); try { localStorage.setItem('her-char-ws', w) } catch (e) { /* ignore */ } setView('auto'); setShowPreview(false); setPreviewText('') }
      // enabledOverride：勾选框等场景必须传入本次点击的新值，避免闭包读到旧 state 写反
      const buildChar = (enabledOverride) => ({
        ...toCharacter(draft),
        groups,
        enabled: enabledOverride !== undefined ? enabledOverride : enabled,
        sessionId: charRef && charRef.sessionId,
      })
      const saveChar = async (okMsg, enabledOverride) => {
        const next = buildChar(enabledOverride)
        const r = await postJson(API + '/characters/save', { ws, character: next })
        setCharRef(next)
        return r
      }
      const onPrimary = async (act) => {
        if (act === 'preview') {
          try { const r = await postJson(API + '/persona-preview', { persona: draft.persona }); setPreviewText(r.text); setShowPreview(true) } catch (e) { setMsg('❌ 预览失败：' + e.message) }
          return
        }
        // go：create → 生成角色；managed → 保存角色卡
        try {
          const r = await saveChar()
          if (view === 'create') { setMsg(r.hot ? '✅ 角色已生成（热生效）' : '✅ 已写盘（重启后挂载）'); setHasChar(true); await loadList(); setView('completion') }
          else { setMsg('✅ 已保存（热生效）') }
        } catch (e) { setMsg('❌ ' + e.message) }
      }
      const loadMemPage = (offset, level) => {
        const q = new URLSearchParams({
          limit: String(MEM_PAGE),
          offset: String(offset),
          ...(level ? { level } : {}),
        })
        return getJson(API + '/memory?ws=' + encodeURIComponent(ws) + '&' + q).then((r) => {
          const list = r.results || []
          setMem(list)
          setMemTotal(Number(r.total) || list.length)
          return list
        }).catch(() => { setMem(null); setMemTotal(0); return [] })
      }
      const memAction = async (action, payload) => {
        try {
          const r = await postJson(API + '/memory?ws=' + encodeURIComponent(ws), { action, ws, ...payload })
          if (r.ok) { setMsg('✅ ' + action + ' 成功') } else setMsg('❌ ' + r.error)
          if (sub === '记忆') await loadMemPage(memOffset, memLevel)
        } catch (e) { setMsg('❌ ' + e.message) }
      }
      React.useEffect(() => {
        if (sub !== '记忆' || !ws) return
        setMemOffset(0)
        loadMemPage(0, memLevel)
      }, [sub, ws, memLevel])
      React.useEffect(() => {
        if (sub === '消息' || sub === '设置') {
          getJson(API + '/config').then((r) => setCfg(r.config)).catch((e) => setMsg('加载失败：' + e.message))
        }
        if (sub === '消息') {
          getJson('/qq-bridge/rules').then((r) => setRules(r.rules)).catch(() => setRules({}))
          getJson('/qq-bridge/status').then(setQqStatus).catch(() => setQqStatus({ error: '获取失败（桥接未就绪？）' }))
        }
      }, [sub])
      // 推送未连接时：自动刷新登录二维码 + 轮询状态，连上后停
      React.useEffect(() => {
        if (sub !== '消息' || !qqStatus || qqStatus.wsConnected) return
        const t = setInterval(() => {
          setQqQrTick((x) => x + 1)
          getJson('/qq-bridge/status').then(setQqStatus).catch(() => {})
        }, 8000)
        return () => clearInterval(t)
      }, [sub, qqStatus && qqStatus.wsConnected])

      const saveCfgPatch = async (patch, okMsg) => { try { await postJson(API + '/config', { patch }); setMsg(okMsg) } catch (e) { setMsg('❌ ' + e.message) } }
      const saveChannel = async (type) => saveCfgPatch({ channels: { [type]: cfg.channels[type] } }, '✅ 渠道规则已保存')
      const saveRules = async () => { try { await postJson('/qq-bridge/rules', { rules }); setMsg('✅ 审核规则已保存') } catch (e) { setMsg('❌ ' + e.message) } }

      if (!list) return h('div', { 'data-hk': '', style: { padding: '16px' } }, h('div', { 'data-hk-msg': '' }, msg || '加载中…'))

      const effView = view === 'auto' ? (hasChar ? 'managed' : 'onboarding') : view
      const wsItems = list.workspaces || []
      const displayName = (charRef && charRef.name) || (overview && overview.name) || ''

      const topbar = h('div', { 'data-hk-topbar': '' },
        h('select', { 'data-hk-ws': '', value: ws, onChange: (e) => sel(e.target.value) },
          wsItems.length
            ? wsItems.map((w) => h('option', { key: w.wsPath, value: w.wsPath }, (w.title || w.wsPath) + (w.hasCharacter ? ' · 有角色' : '')))
            : [h('option', { key: 'none', value: '' }, '（还没有工作区）')]),
        effView === 'managed' ? h('span', { 'data-hk-chip': '' }, '✦ ' + displayName) : null,
        effView === 'create' ? h('span', { 'data-hk-chip': '' }, '创建中') : null,
      )

      let body = null
      // 内核固定页签 + 桥接动态页签（QQ 等由桥接 registerChannel({ui}) 声明）
      const extraTitles = bridgeTabs.map((t) => t.label)
      const SUBS = ['人设', '状态', '记忆', ...extraTitles, '设置']
      // 创建/引导期也展示页签（禁用态）
      const ghostTabs = h('div', { 'data-hk-tabs': '' }, SUBS.map((t) => h('div', {
        key: t, 'data-hk-tab': '', 'data-on': t === '人设' ? '1' : '0',
        style: t === '人设' ? {} : { opacity: .4, cursor: 'default' },
        onClick: () => { if (t !== '人设') setMsg('先生成角色，' + t + ' 等页签就能用了') },
      }, t)))
      if (effView === 'onboarding') {
        body = h('div', null, ws ? h(Onboarding, { onStart: () => { const d = blankDraft(); d.channels = [...channelsList]; setDraftRaw(d); setView('create'); setSub('人设'); setShowPreview(false) } })
          : h('div', { 'data-hk-card': '' }, h('div', { 'data-hk-title': '' }, '还没有工作区'), h('div', { 'data-hk-note': '' }, '先在左侧栏添加一个工作区，再回来创建角色。')), ghostTabs)
      } else if (effView === 'create') {
        body = h('div', null, h(PersonaPage, {
          draft, set, channelsList, assets, setAssets, previewText, showPreview, setMsg,
          primary: '✦ 生成角色', secondary: '← 返回',
          onPrimary, onSecondary: () => setView('onboarding'),
        }), ghostTabs)
      } else if (effView === 'completion') {
        body = h(Completion, { name: displayName, onGo: () => { setView('managed'); setSub('状态') } })
      } else {
        const mhead = h('div', { 'data-hk-mhead': '' },
          h('span', { style: { fontSize: '17px' } }, '🐳'),
          h('b', { style: { fontSize: '15px' } }, displayName || '（未命名）'),
          h('span', { 'data-hk-chip': '' }, ((charRef && charRef.persona && charRef.persona.identity && charRef.persona.identity.owner) || '未设主人')),
          (charRef && charRef.channels || []).map((c) => h('span', { 'data-hk-chip': '', key: c }, c)),
          h('span', { style: { flex: 1 } }),
          h('label', { style: { fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }, title: '关掉后：不再唤醒她、不再主动回复；消息照常入库。直接和她说话仍然可以。角色只活在她的专属会话里' },
            h('input', { type: 'checkbox', checked: enabled, onChange: async (e) => { const v = e.target.checked; setEnabled(v); try { await saveChar(undefined, v); setMsg(v ? '✅ 已启用' : '⏸ 已停用（唤醒与自动回复立即停止）') } catch (err) { setMsg('❌ ' + err.message) } } }),
            ' 启用'),
        )
        const railIcon = { 人设: '🐋', 状态: '🌊', 记忆: '🫧', QQ: '💬', 设置: '⚙' }
        const railItems = (group) => group.filter((t) => SUBS.includes(t)).map((t) => h('button', {
          key: t, type: 'button', 'data-hk-rail-item': '', 'data-on': sub === t ? '1' : '0',
          onClick: () => setSub(t), title: t,
        }, h('span', { 'data-hk-rail-icon': '' }, railIcon[t] || '·'), h('span', null, t)))
        const tabs = h('div', { 'data-hk-rail': '' },
          h('div', { 'data-hk-rail-group': '' }, '她'), ...railItems(['人设', '状态', '记忆']),
          extraTitles.length ? h('div', { 'data-hk-rail-group': '' }, '渠道') : null,
          ...railItems(extraTitles),
          h('div', { 'data-hk-rail-group': '' }, '系统'), ...railItems(['设置']),
        )

        let content = null
        if (sub === '人设') {
          content = h(PersonaPage, {
            draft, set, channelsList, assets, setAssets, previewText, showPreview, setMsg,
            primary: '保存角色卡', secondary: '恢复上次', onPrimary,
            onSecondary: () => { if (charRef) { setDraftRaw(draftFromChar(charRef)); setMsg('已恢复') } },
          })
        } else if (sub === '状态') {
          const o = overview
          content = !o ? h('div', { 'data-hk-note': '' }, '加载中…') : h('div', null,
            h('div', { 'data-hk-hero': '' },
              h('div', { 'data-hk-stat': '' },
                h('div', { 'data-hk-stat-label': '' }, '心绪'),
                h('div', { 'data-hk-stat-val': '' }, o.heart.base + ' ' + o.heart.emoji),
                h('div', { 'data-hk-note': '', style: { fontSize: '12px' } }, o.heart.label)),
              h('div', { 'data-hk-stat': '' },
                h('div', { 'data-hk-stat-label': '' }, '在做'),
                h('div', { 'data-hk-stat-val': '', style: { fontSize: '14px' } }, o.life.activity),
                h('div', { 'data-hk-note': '', style: { fontSize: '12px' } }, '精力 ' + Math.round(o.life.needs.energy) + ' · 兴致 ' + Math.round(o.life.needs.interest) + ' · 黏人 ' + Math.round(o.life.needs.company))),
              h('div', { 'data-hk-stat': '' },
                h('div', { 'data-hk-stat-label': '' }, '未读 · 记忆'),
                h('div', { 'data-hk-stat-val': '' }, (o.notifications || []).reduce((a, n) => a + n.count, 0) + ' · ' + ((o.memory.counts.fact || 0) + (o.memory.counts.lesson || 0) + (o.memory.counts.topic || 0))),
                h('div', { 'data-hk-note': '', style: { fontSize: '12px' } }, o.app ? o.app.type + '/' + o.app.target : '无 App')),
            ),
            h('div', { 'data-hk-card': '' },
              h('div', { 'data-hk-title': '' }, '心绪十维'),
              h('div', { 'data-hk-dims': '' }, Object.entries(o.heart.dims).map(([k, v]) => h('div', { 'data-hk-hrow': '', key: k },
                h('span', null, HEART_LABELS[k] || k),
                h('div', { 'data-hk-hbar': '' }, h('div', { 'data-hk-hfill': '', style: { width: Math.min(100, Math.max(0, v)) + '%' } })),
                h('span', { 'data-hk-hval': '' }, Math.round(v)),
              ))),
            ),
            h('div', { 'data-hk-card': '' },
              h('div', { 'data-hk-title': '' }, '今天'),
              h('div', { 'data-hk-timeline': '' }, (o.life.today || []).length
                ? o.life.today.map((x, i) => h('div', { 'data-hk-tl-row': '', key: i }, h('span', { 'data-hk-tl-time': '' }, new Date(x.at).toTimeString().slice(0, 5)), h('span', null, x.label)))
                : h('div', { 'data-hk-note': '' }, '今天还没什么记录')),
              (() => {
                const sc = o.schedule || {}
                const seg = (label, list) => h('div', { key: label, style: { marginTop: '8px' } },
                  h('div', { style: { fontWeight: 600, fontSize: '12px' } }, label),
                  h('div', { style: { fontSize: '12px', opacity: .8 } }, (list || []).length
                    ? list.map((b) => `${b.from}-${b.to} ${b.label || b.kind}`).join('；')
                    : '（空）'))
                return h('div', null, seg('工作日作息', sc.weekday), seg('周末作息', sc.weekend))
              })(),
            ),
            h(Fold, {
              title: '调节 · 心绪变化公式', defaultOpen: false,
              body: h('div', null,
                h(ParamCard, {
                  title: '底色', cfg, setCfg,
                  entries: [
                    { label: '基线底色', path: 'mood.base', tip: '长时间静默后底色回落到的值。' },
                    { label: '下限', path: 'mood.floor', tip: '衰减允许到的最低底色。' },
                    { label: '半衰期', path: 'mood.decayHalfHours', unit: '小时', tip: '底色向基线走完一半距离所需小时数。' },
                    { label: '记一笔除数', path: 'mood.stepDivisor', tip: '她 state_note 写 moodDelta 时：底色变化 = round(moodDelta ÷ 此值)。' },
                  ],
                }),
                h(ParamCard, {
                  title: '十维衰减与思念', cfg, setCfg,
                  entries: [
                    { label: '每小时回归比例', path: 'mood.dimDecayPerHour', tip: '每小时：维数向基线靠近 该比例（默认 0.06）。' },
                    { label: '单次回归上限', path: 'mood.dimDecayCap', tip: '一次评估最多靠近基线的比例（默认 0.4）。' },
                    { label: '沉默思念/时', path: 'mood.missPerSilenceHour', tip: '距主人说话超过 0.5 小时后，思念每小时增加量。' },
                    { label: '思念单次上限', path: 'mood.missSilenceCap', tip: '一次评估思念最多加这么多。' },
                    { label: '注入可信门槛', path: 'mood.injectConfidence', tip: '置信度低于此值不把情绪原因写进提示词。' },
                    { label: '每日最多情绪注入', path: 'mood.injectPerDay', tip: '一天最多几次「因为…」写进提示词。' },
                    { label: '显著底色阈值', path: 'mood.sigMood', tip: '底色偏离基线超过此值才记时间线。' },
                  ],
                }),
                h(ParamCard, {
                  title: '十维回归基线', cfg, setCfg,
                  entries: HEART_LABELS && Object.keys(HEART_LABELS).filter((k) => k !== 'dims').map((k) => ({
                    label: (HEART_LABELS[k] || k) + ' 基线',
                    path: 'heart.baselines.' + k,
                    tip: '衰减时该维往这个值靠。',
                  })) || [],
                }),
              ),
            }),
            h(Fold, {
              title: '调节 · 日子推进', defaultOpen: false,
              body: h(ParamCard, {
                title: '日子', cfg, setCfg,
                entries: [
                  { label: '步长', path: 'life.stepMinutes', unit: '分钟', tip: '每 N 分钟推进一次 energy/interest/company。' },
                  { label: '断档折叠', path: 'life.gapFoldHours', unit: '小时', tip: '超过这么久未推进：需求重置为下方 gapReset。' },
                  { label: '重置·精力', path: 'life.gapReset.energy', tip: '断档后 energy 初值。' },
                  { label: '重置·兴致', path: 'life.gapReset.interest', tip: '断档后 interest 初值。' },
                  { label: '重置·想黏人', path: 'life.gapReset.company', tip: '断档后 company 初值。' },
                  { label: '日记提醒', path: 'life.diaryNudgeAfterHour', unit: '点（0–23）', tip: '过这个钟点仍未写日记则提示一次/天。' },
                ],
              }),
            }),
            h('button', { 'data-hk-btn': '', onClick: () => saveCfgPatch({ mood: cfg.mood, heart: cfg.heart, life: cfg.life }, '✅ 心绪与日子参数已保存') }, '保存心绪与日子参数'),
          )
        } else if (sub === '记忆') {
          content = h('div', null,
            h('div', { 'data-hk-card': '' },
              h('div', { 'data-hk-title': '' }, '记忆'),
              h('div', { 'data-hk-row': '' },
                h('input', { 'data-hk-input': '', placeholder: '搜索关键词…', value: memQuery, onChange: (e) => setMemQuery(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') postJson(API + '/memory?ws=' + encodeURIComponent(ws), { action: 'search', ws, query: memQuery }).then((r) => setMem(r.results)) } }),
                h('button', { 'data-hk-btn': 'data-hk-btn-sm', onClick: () => postJson(API + '/memory?ws=' + encodeURIComponent(ws), { action: 'search', ws, query: memQuery }).then((r) => setMem(r.results)) }, '搜索'),
                h('select', { 'data-hk-input': '', style: { flex: '0 0 auto', maxWidth: '110px' }, value: memLevel, onChange: (e) => setMemLevel(e.target.value) },
                  h('option', { value: '' }, '全部层'),
                  ['fact', 'lesson', 'topic', 'project', 'rules', 'soul', 'user'].map((l) => h('option', { value: l, key: l }, l))),
              ),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' } },
                h('span', { 'data-hk-note': '' }, '共 ' + (memTotal || (mem ? mem.length : 0)) + ' 条 · 第 ' + (Math.floor(memOffset / MEM_PAGE) + 1) + ' 页'),
                h('button', {
                  'data-hk-btn': 'data-hk-btn-sm',
                  disabled: memOffset <= 0,
                  onClick: () => { const o = Math.max(0, memOffset - MEM_PAGE); setMemOffset(o); loadMemPage(o, memLevel) },
                }, '‹ 上一页'),
                h('button', {
                  'data-hk-btn': 'data-hk-btn-sm',
                  disabled: memOffset + MEM_PAGE >= memTotal,
                  onClick: () => { const o = memOffset + MEM_PAGE; setMemOffset(o); loadMemPage(o, memLevel) },
                }, '下一页 ›'),
              ),
              (!mem || !mem.length) ? h('div', { 'data-hk-note': '' }, '暂无记忆。她记住东西后会出现在这里。') :
                mem.map((r) => h('div', { 'data-hk-mem-row': '', key: r.id },
                  h('div', { 'data-hk-mem-head': '' },
                    h('div', null, h('span', { 'data-hk-chip': '' }, r.level), ' ', h('span', { 'data-hk-chip': '' }, '重要' + r.importance)),
                    h('div', { 'data-hk-mem-actions': '' },
                      h('button', { 'data-hk-btn': 'data-hk-btn-sm', onClick: () => { const c = prompt('编辑内容', r.content); if (c != null) memAction('edit', { id: r.id, patch: { content: c } }) } }, '编辑'),
                      h('button', { 'data-hk-btn': 'data-hk-btn-sm', onClick: () => memAction('edit', { id: r.id, patch: { importance: (Math.max(1, Math.min(10, r.importance || 1)) % 10) + 1 } }) }, '改重要性'),
                      h('button', { 'data-hk-btn': 'data-hk-btn-sm data-hk-btn-danger', onClick: () => memAction('remove', { id: r.id }) }, '归档'),
                    )),
                  h('div', { 'data-hk-mem-content': '' }, r.content),
                )),
            ),
            h(ParamCard, {
              title: '记忆策略', cfg, setCfg,
              entries: [
                { label: '已入记忆的对话移出上下文', path: 'memory.moveOutContext', kind: 'chk', tip: '开：预算归档写入 hidden；且主动 memory_remember 后 hide 本回合原文（可用 memory_hidden 查回）。关：不自动 hide。' },
                { label: '记忆放远（不每轮注入）', path: 'memory.injectFar', kind: 'chk', tip: '开：记忆不自动塞进每回合，需要时她用 memory_search。关：更易自动带到眼前，也更占上下文。' },
                { label: '默认重要级(1~10)', path: 'memory.defaultImportance', tip: '写入记忆时的默认重要级。1=小事，10=必须记住。搜索排序数字大的更靠前。' },
                { label: '搜索默认返回条数', path: 'memory.searchLimit', tip: 'memory_search 不传条数时的上限。' },
                { label: '归档时 LLM 精炼最多几条', path: 'memory.autoExtractMax', tip: '每次预算归档最多用会话同款模型精炼几条 topic 摘要。0=只用规则拼接摘要（仍会写 topic）。' },
                { label: 'LLM 精炼冷却', path: 'memory.autoExtractCooldownMin', unit: '分钟', tip: '两次 LLM 精炼之间的最短间隔。' },
                { label: '上下文字符预算', path: 'memory.budgetChars', tip: '自上次归档以来对话字符超过此值 → 归档旧对话并请求折叠会话历史。' },
                { label: '永远保留最近几条', path: 'memory.keepRecent', tip: '归档时最新这么多条绝不动，保证最近对话完整。' },
                { label: '超预算时自动归档', path: 'memory.hideOnOverflow', kind: 'chk', tip: '开：超预算就 hide 旧消息并可选折叠。关：只诊断不执行。' },
                { label: '归档 topic 重要级(1~10)', path: 'memory.archiveTopicImportance', tip: '自动归档写入的 topic 记忆重要级。' },
                { label: '摘要正文最大字数', path: 'memory.archiveSummaryMaxChars', tip: '单条归档 topic 摘要的正文字数上限（规则与 LLM 共用）。' },
                { label: '归档最少消息数', path: 'memory.archiveMinMessages', tip: '窗口内消息少于这个数不触发归档，防抖。' },
                { label: '归档后折叠会话历史', path: 'memory.compactEnabled', kind: 'chk', tip: '开：归档后调用平台 compaction 折叠对话历史（人设系统提示词不折叠）。关：只写 memory.db。' },
                { label: '折叠用自动压力策略', path: 'memory.compactUseAuto', kind: 'chk', tip: '关：compactNow 立即折叠。开：compactIfNeeded 由平台压力决定。' },
                { label: '主动记忆时隐藏本回合', path: 'memory.rememberHideContext', kind: 'chk', tip: '她 memory_remember 成功后，默认是否把本回合原文移出上下文（仍可 memory_hidden 查）。' },
                { label: '精炼用 provider(可空)', path: 'memory.archiveLlmProvider', tip: '留空=与会话相同 provider/model。' },
                { label: '搜索接口最大返回', path: 'query.searchMax', tip: 'App 内搜索/筛选消息的硬上限，与记忆搜索条数分开。' },
              ],
            }),
            h(ParamCard, {
              title: '媒体（图片与表情）', cfg, setCfg,
              entries: [
                { label: '单条消息最多直读图片数', path: 'media.maxImagesPerMessage', tip: '一条消息含多图时，最多下载并以图像块进入上下文的张数。超出部分仅保留占位引用。' },
                { label: '单次翻页最多直读图片数', path: 'media.maxImagesPerFetch', tip: '一次 app_fetch / app_query 合计最多直读的图片总数，限制单回合体积。' },
                { label: '单图字节上限', path: 'media.maxImageBytes', tip: '超过该大小的图片不下载、不进上下文，避免超大图拖慢回合。' },
                { label: '禁止出站发图', path: 'media.blockImage', kind: 'chk', tip: '打开后 app_send 的 image 参数被拒绝；文本与表情不受影响。默认关闭（允许发图）。' },
                { label: '禁止出站发表情', path: 'media.blockSticker', kind: 'chk', tip: '打开后 app_send 的 sticker 参数被拒绝。默认关闭（允许发表情）。' },
              ],
            }),
            h('button', { 'data-hk-btn': '', onClick: () => saveCfgPatch({ memory: cfg.memory, query: cfg.query, media: cfg.media }, '✅ 记忆与媒体策略已保存') }, '保存记忆与媒体策略'),
          )
        } else if (extraTitles.includes(sub)) {
          // 桥接动态页签：内容由注册的桥接客户端提供（内核不认识具体协议）
          const tabReg = (typeof window !== 'undefined' && window.__HER_CHANNEL_TABS__) || []
          const hit = tabReg.find((x) => x && x.label === sub)
          content = hit && typeof hit.render === 'function'
            ? h(hit.render, { ws, groups, setGroups, saveChar, cfg, setCfg, setMsg })
            : h('div', { 'data-hk-card': '' },
                h('div', { 'data-hk-title': '' }, sub),
                h('div', { 'data-hk-note': '' }, '桥接插件已注册该页签，但客户端组件未加载。请刷新页面，或检查对应桥接插件是否启用。'))
        } else {
          // 设置页
          const heart = (cfg && cfg.heart) || {}
          const gates = heart.gates || {}
          const rules = Array.isArray(heart.rules) ? heart.rules : []
          const setHeart = (fn) => setCfg((c) => { if (!c) return c; const n = clone(c); n.heart = n.heart || {}; fn(n.heart); return n })
          const setGate = (path, val) => setHeart((ht) => {
            ht.gates = ht.gates || {}
            ht.gates[path] = val
          })
          const setNotify = (path, val) => setHeart((ht) => {
            ht.notify = ht.notify || {}
            ht.notify[path] = val
          })
          const setRandom = (path, val) => setHeart((ht) => {
            ht.random = ht.random || {}
            ht.random[path] = val
          })
          const setRuleAt = (i, path, val) => setHeart((ht) => {
            ht.rules = Array.isArray(ht.rules) ? ht.rules.slice() : []
            const r = { ...(ht.rules[i] || {}) }
            if (path.includes('.')) {
              const [a, b] = path.split('.')
              r[a] = { ...(r[a] || {}), [b]: val }
            } else r[path] = val
            ht.rules[i] = r
          })
          content = h('div', null,
            h(ParamCard, {
              title: '心绪闸门', cfg, setCfg,
              entries: [
                { label: '启用心绪规则', path: 'heart.enabled', kind: 'chk', tip: '总开关。关闭后：不再评估心绪规则、不再注入 kernel-heart；通知路径仍走（除非通知也关）。' },
                { label: '想到阈值', path: 'heart.gates.thinkThreshold', tip: '十维里最高维 ÷100 达到这个数，状态页显示「想一想」。只影响展示与她的自我认知，不直接触发注入。' },
                { label: '开口阈值', path: 'heart.gates.speakThreshold', tip: '强度达到这个数才可能进入规则匹配。规则自己的 min 条件可以比它更严。' },
                { label: '静默多久', path: 'heart.gates.minSilenceMinutes', unit: '分钟', tip: '距主人上次说话至少这么久，才允许主动触发。防止刚聊完就插话。' },
                { label: '两次开口间隔', path: 'heart.gates.minSinceSpokeMinutes', unit: '分钟', tip: '距上次主动开口至少这么久，避免连续触发。通知注入不算开口。' },
                { label: '每日最多规则触发', path: 'heart.gates.dailyCap', unit: '次', tip: '自然日内 kernel-heart 最多注入几次。与通知的每日上限分开计数。' },
                { label: '规则冷却', path: 'heart.gates.cooldownMinutes', unit: '分钟', tip: '任何规则注入后，至少冷却这么久才允许再注入一条 kernel-heart。' },
                { label: '未回复不叠加', path: 'heart.gates.unansweredNoPile', kind: 'chk', tip: '打开：她主动发出后主人一直没回、且仍在宽限期内，则不再主动戳。防止连环追问。' },
                { label: '未回复宽限', path: 'heart.gates.unansweredGraceMinutes', unit: '分钟', tip: '「没回」的判定窗口。超过这个时间后，即使没回也允许再次尝试。' },
              ],
            }),
            h(ParamCard, {
              title: '夜间静默与通知', cfg, setCfg,
              entries: [
                { label: '夜间静默（仅心绪规则）', path: 'heart.gates.quietHours.enabled', kind: 'chk', tip: '打开：设定时段内不注入 kernel-heart。通知是否受此限制由各渠道「受夜间静默」决定，私聊默认不受限。' },
                { label: '静默从', path: 'heart.gates.quietHours.from', kind: 'str', unit: 'HH:MM', tip: '静默开始时刻，24 小时制，可跨夜（如 23:30–07:30）。' },
                { label: '静默到', path: 'heart.gates.quietHours.to', kind: 'str', unit: 'HH:MM', tip: '静默结束时刻。结束之后恢复规则评估。' },
                { label: '通知注入总闸', path: 'heart.notify.enabled', kind: 'chk', tip: '紧急总开关。关闭后所有渠道都不再注入通知回合；未读仍会记录。细粒度（冷却/上限/夜间）在角色面板各桥接页签（如「QQ」）里按渠道配置。' },
                { label: '私聊聚焦屏蔽', path: 'notifyFocusMinutes', unit: '分钟', tip: '主人私聊到达后，其它渠道的通知被按住的分钟数。仅影响其它渠道，不影响私聊本身。' },
              ],
            }),
            h(ParamCard, {
              title: '随机', cfg, setCfg,
              entries: [
                { label: '确定性随机（可复现）', path: 'heart.random.deterministic', kind: 'chk', tip: '打开：用固定种子抽随机数，同一评估序列结果可复现（便于测试）。关闭：真随机，行为更像人。' },
                { label: '种子', path: 'heart.random.seed', kind: 'str', tip: '确定性模式下的种子字符串。改种子会改变抖动与概率的抽样结果。' },
              ],
            }),
            h('div', { 'data-hk-card': '' },
              h('div', { 'data-hk-title': '' }, '心绪规则（按序，一次只触发一条）'),
              h('div', { 'data-hk-note': '' }, '事件驱动：消息入库、她回合结束、桥接事件时评估。无插件定时器。时间窗故意放宽，松紧靠抖动与概率。'),
              rules.map((r, i) => h('div', { key: r.id || i, style: { border: '1px solid rgba(127,127,127,.16)', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' } },
                h('div', { 'data-hk-row': '' },
                  h('label', null, h('input', { type: 'checkbox', checked: r.enabled !== false, onChange: (e) => setRuleAt(i, 'enabled', e.target.checked) }), ' 启用'),
                  h('input', { 'data-hk-input': '', style: { flex: 1 }, value: r.name || r.id || '', placeholder: '规则名', onChange: (e) => setRuleAt(i, 'name', e.target.value) }),
                ),
                h('div', { 'data-hk-row': '' },
                  h('input', { 'data-hk-input': '', style: { flex: 1 }, value: JSON.stringify(r.when && r.when.min || {}), onChange: (e) => { try { setRuleAt(i, 'when.min', JSON.parse(e.target.value || '{}')) } catch (err) { /* 等合法 JSON */ } } }),
                  h('span', { 'data-hk-tip': '', style: { margin: 0 } }, 'min 条件 JSON，如 {"miss":70}'),
                ),
                h('div', { 'data-hk-row': '' },
                  h('input', { 'data-hk-input': '', style: { flex: 1 }, value: JSON.stringify(r.when && r.when.any || []), onChange: (e) => { try { setRuleAt(i, 'when.any', JSON.parse(e.target.value || '[]')) } catch (err) { /* 等合法 JSON */ } } }),
                  h('span', { 'data-hk-tip': '', style: { margin: 0 } }, 'any 组 JSON 数组'),
                ),
                h('div', { 'data-hk-row': '' },
                  h('input', { 'data-hk-input': '', style: { flex: 1 }, value: JSON.stringify(r.when && r.when.windows || []), onChange: (e) => { try { setRuleAt(i, 'when.windows', JSON.parse(e.target.value || '[]')) } catch (err) { /* 等合法 JSON */ } } }),
                  h('span', { 'data-hk-tip': '', style: { margin: 0 } }, '时间窗 [{"from":"13:00","to":"19:30"}]'),
                ),
                h('div', { 'data-hk-row': '' },
                  h('input', { 'data-hk-input': '', style: { flex: 1 }, value: JSON.stringify(r.when && r.when.activityOut || []), onChange: (e) => { try { setRuleAt(i, 'when.activityOut', JSON.parse(e.target.value || '[]')) } catch (err) { /* 等合法 JSON */ } } }),
                  h('span', { 'data-hk-tip': '', style: { margin: 0 } }, '忙时排除 activityOut'),
                ),
                h('div', { 'data-hk-row': '' },
                  h('span', { style: { fontSize: '12px' } }, '概率'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '64px' }, type: 'number', step: '0.05', min: 0, max: 1, value: Number((r.jitter && r.jitter.chance) != null ? r.jitter.chance : 1), onChange: (e) => setRuleAt(i, 'jitter.chance', Number(e.target.value)) }),
                  h('span', { style: { fontSize: '12px', marginLeft: '6px' } }, '抖动%'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '60px' }, type: 'number', step: '1', min: 0, max: 50, value: Number((r.jitter && r.jitter.thresholdPct) || 0), onChange: (e) => setRuleAt(i, 'jitter.thresholdPct', Number(e.target.value)) }),
                  h('span', { style: { fontSize: '12px', marginLeft: '6px' } }, '窗抖动'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '56px' }, type: 'number', step: '5', min: 0, max: 120, value: Number((r.jitter && r.jitter.windowMinutes) || 0), onChange: (e) => setRuleAt(i, 'jitter.windowMinutes', Number(e.target.value)) }),
                  h('span', { style: { fontSize: '12px', opacity: .55 } }, '分钟'),
                  h('span', { style: { fontSize: '12px', marginLeft: '6px' } }, '冷却'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '56px' }, type: 'number', step: '10', min: 0, value: Number(r.cooldownMinutes || 0), onChange: (e) => setRuleAt(i, 'cooldownMinutes', Number(e.target.value)) }),
                  h('span', { style: { fontSize: '12px', opacity: .55 } }, '分钟'),
                ),
                h('div', { 'data-hk-row': '' },
                  h('span', { style: { fontSize: '12px' } }, '沉默'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '56px' }, type: 'number', min: 0, value: Number((r.when && r.when.silenceMin) || 0), onChange: (e) => setRuleAt(i, 'when.silenceMin', Number(e.target.value)) }),
                  h('span', { style: { fontSize: '12px', opacity: .55 } }, '分钟'),
                  h('span', { style: { fontSize: '12px', marginLeft: '6px' } }, '距开口'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '56px' }, type: 'number', min: 0, value: Number((r.when && r.when.sinceSpokeMin) || 0), onChange: (e) => setRuleAt(i, 'when.sinceSpokeMin', Number(e.target.value)) }),
                  h('span', { style: { fontSize: '12px', opacity: .55 } }, '分钟'),
                  h('span', { style: { fontSize: '12px', marginLeft: '6px' } }, '最大未读'),
                  h('input', { 'data-hk-input': '', style: { maxWidth: '60px' }, type: 'number', min: 0, value: Number((r.when && r.when.maxUnread) || 0), onChange: (e) => setRuleAt(i, 'when.maxUnread', Number(e.target.value)) }),
                ),
              )),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
                h('button', {
                  'data-hk-btn': 'data-hk-btn-sm',
                  onClick: () => setHeart((ht) => {
                    ht.rules = Array.isArray(ht.rules) ? ht.rules.slice() : []
                    ht.rules.push({
                      id: 'rule-' + Date.now(), name: '新规则', enabled: true,
                      when: { min: { miss: 70 }, max: {}, any: [], silenceMin: 30, sinceSpokeMin: 45, windows: [], weekdays: [], activityIn: [], activityOut: ['sleep', 'night'], maxUnread: 0 },
                      jitter: { thresholdPct: 10, windowMinutes: 20, chance: 0.6 },
                      cooldownMinutes: 120,
                      materials: { timeline: 6, diary: true },
                    })
                  }),
                }, '＋ 添加规则'),
                h('button', {
                  'data-hk-btn': 'data-hk-btn-sm',
                  onClick: () => setHeart((ht) => { if (Array.isArray(ht.rules) && ht.rules.length) ht.rules.pop() }),
                }, '－ 删除最后一条'),
              ),
            ),
            h('button', { 'data-hk-btn': '', onClick: () => saveCfgPatch({ heart: cfg.heart, notifyFocusMinutes: cfg.notifyFocusMinutes, life: cfg.life, mood: cfg.mood }, '✅ 设置已保存') }, '保存设置'),
          )
        }

        body = h('div', { 'data-hk-shell': '' }, tabs, h('div', { 'data-hk-content': '' }, mhead, content))
      }

      return h('div', { 'data-hk': '', style: { padding: '12px 14px 48px', height: '100%', overflow: 'auto' } },
        topbar, body,
      )
    }

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-her-kernel')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-her-kernel: 样式')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        const sidebarRight = (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined) || ctx.sidebarRight
        const sidebarRightTabs = (typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined) || ctx.sidebarRightTabs

        try {
          if (sidebarRightTabs && typeof sidebarRightTabs.register === 'function') {
            ctx.effect(() => sidebarRightTabs.register({
              id: TAB_ID,
              kind: 'her-character',
              priority: 'extension',
              title: () => '角色',
              guide: [{
                id: 'character',
                order: 10,
                title: () => '角色',
                description: () => '为工作区创建或管理角色——记忆、消息、工具各工作区独立',
                icon: RoleGuideIcon,
              }],
            }), 'her-kernel:sidebar tab type')
          }
        } catch (e) { /* ignore */ }
        ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, () => h(RolePanel))), 'her-kernel:sidebar tab body')
        ctx.effect(() => slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'her-kernel', order: 42, label: '小鲸 · 说明' }, () => h(UsageNotes, { openPanel: () => { try { sidebarRight && sidebarRight.openTab && sidebarRight.openTab('her-character') } catch (e) { /* ignore */ } } }))), 'her-kernel:settings')
      },
    }
  },
})

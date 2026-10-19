// UUMit 远程访问 · DSH 浏览器端（dsh.client）。手写的加载器工厂格式，不需要构建：
// 外层 window.__ModuleLoader__.load({ id, factory })，react / react-dom 由 DSH 页面经 require 提供。
// 入口注册到侧栏底部 sidebar.footer.action（设置按钮旁），点击在 DSH 页面内弹出管理面板，不另开窗口。
// 管理面板是原生 DOM（mountManager），独立兜底页 /uumit-remote/ 复用同一份代码。
window.__ModuleLoader__.load({
  id: '@uumit-ai/dsh-uumit-remote',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }

    var API = '/uumit-remote/api'
    var STYLE_ID = 'uumit-remote-style'

    var LIGHT = '--urm-line:#e6eaf0;--urm-card:#fbfcfe;--urm-surface:var(--dsw-alias-bg-layer-2,#fff);--urm-accent:#2563eb;--urm-accent-fill:#2563eb;--urm-accent-soft:#eff5ff;--urm-accent-line:#c7d9fd;--urm-title:#1e3a8a;--urm-ok:#16a34a;--urm-ok-soft:#e7f7ed;--urm-warn:#b45309;--urm-warn-soft:#fff6e5;--urm-bad:#dc2626;--urm-bad-fill:#dc2626;--urm-bad-soft:#fff5f5;--urm-bad-line:#fad4d4;--urm-hover:rgba(15,23,42,.04);--urm-radio-dot:#fff'
    var DARK = '--urm-line:rgba(255,255,255,.1);--urm-card:rgba(255,255,255,.03);--urm-accent:#60a5fa;--urm-accent-fill:#3b82f6;--urm-accent-soft:rgba(96,165,250,.12);--urm-accent-line:rgba(96,165,250,.45);--urm-title:#93c5fd;--urm-ok:#4ade80;--urm-ok-soft:rgba(74,222,128,.12);--urm-warn:#fbbf24;--urm-warn-soft:rgba(251,191,36,.1);--urm-bad:#f87171;--urm-bad-fill:#ef4444;--urm-bad-soft:rgba(248,113,113,.07);--urm-bad-line:rgba(248,113,113,.3);--urm-hover:rgba(255,255,255,.06);--urm-radio-dot:var(--dsw-alias-bg-layer-2,#1b1f27)'

    var CSS = [
      // 颜色变量：文字沿用 DSH 的语义变量；品牌蓝、状态色是 UUMit 自己的，深色模式跟随 DSH 的 body[data-ds-dark-theme]
      '.urm,.urm-panel,.urm-standalone{--urm-fg:var(--dsw-alias-label-primary,#1f2328);--urm-muted:var(--dsw-alias-label-secondary,#667085);--urm-faint:var(--dsw-alias-label-tertiary,#98a2b3);' + LIGHT + '}',
      'body[data-ds-dark-theme] .urm,body[data-ds-dark-theme] .urm-panel,body[data-ds-dark-theme] .urm-standalone{' + DARK + '}',
      '.urm{color:var(--urm-fg);font-size:14px;line-height:22px;position:relative}',
      '.urm *{box-sizing:border-box}',
      '.urm p{margin:0}',
      '.urm .urm-muted{color:var(--urm-muted);font-size:13px;line-height:20px}',
      '.urm .urm-card{background:var(--urm-card);border:1px solid var(--urm-line);border-radius:16px;padding:18px 20px;margin-top:16px}',
      '.urm .urm-card:first-child{margin-top:0}',
      '.urm .urm-card h2{font-size:16px;font-weight:600;line-height:24px;margin:0}',
      '.urm .urm-card h2+.urm-muted{margin-top:2px}',
      '.urm h3{font-size:13px;font-weight:600;line-height:20px;margin:18px 0 8px}',
      '.urm .urm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.urm .urm-mt{margin-top:14px}',
      '.urm .urm-spread{display:flex;justify-content:space-between;align-items:center;gap:12px}',
      // 按钮：描边（刷新、复制）、品牌蓝实心、危险红实心
      '.urm .urm-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border:1px solid var(--urm-line);border-radius:10px;background-color:var(--urm-surface);color:var(--urm-fg);font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background-color 120ms ease,border-color 120ms ease,opacity 120ms ease}',
      '.urm .urm-btn:hover:not(:disabled){background-image:linear-gradient(var(--urm-hover),var(--urm-hover));border-color:var(--urm-accent-line)}',
      '.urm .urm-btn:focus-visible,.urm .urm-tier:focus-within{outline:2px solid var(--urm-accent);outline-offset:2px}',
      '.urm .urm-btn svg{flex:none}',
      '.urm .urm-btn .urm-ico-accent{color:var(--urm-accent)}',
      '.urm .urm-btn.urm-copied{color:var(--urm-ok)}',
      '.urm .urm-btn.urm-primary{background-color:var(--urm-accent-fill);border-color:transparent;color:#fff}',
      '.urm .urm-btn.urm-danger-fill{background-color:var(--urm-bad-fill);border-color:transparent;color:#fff}',
      '.urm .urm-btn.urm-primary:hover:not(:disabled),.urm .urm-btn.urm-danger-fill:hover:not(:disabled){background-image:linear-gradient(rgba(0,0,0,.1),rgba(0,0,0,.1));border-color:transparent}',
      '.urm .urm-btn.urm-lg{height:40px;padding:0 24px;border-radius:999px;font-size:14px}',
      '.urm .urm-btn.urm-danger{color:var(--urm-bad)}',
      '.urm .urm-btn:disabled{opacity:.5;cursor:default}',
      '.urm .urm-link{color:inherit;text-decoration:none;word-break:break-all}',
      '.urm .urm-link:hover{color:var(--urm-accent);text-decoration:underline;text-underline-offset:3px}',
      // 状态胶囊与圆点
      '.urm .urm-pill{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 12px;border-radius:999px;font-size:13px;font-weight:500;background:var(--urm-hover);color:var(--urm-muted)}',
      '.urm .urm-pill.ok{background:var(--urm-ok-soft);color:var(--urm-ok)}.urm .urm-pill.warn{background:var(--urm-warn-soft);color:var(--urm-warn)}.urm .urm-pill.bad{background:var(--urm-bad-soft);color:var(--urm-bad)}',
      '.urm .urm-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--urm-faint)}',
      '.urm .urm-dot.ok{background:var(--urm-ok)}.urm .urm-dot.warn{background:var(--urm-warn)}.urm .urm-dot.bad{background:var(--urm-bad)}',
      // 电脑信息：左侧图标块，右侧名称与地址、通道、应用网址
      '.urm .urm-device{display:grid;grid-template-columns:56px minmax(0,1fr);column-gap:20px;margin-top:14px}',
      '.urm .urm-device-flush{margin-top:0}',
      '.urm .urm-tile{width:56px;height:56px;border-radius:14px;background:var(--urm-accent-soft);color:var(--urm-accent);display:flex;align-items:center;justify-content:center}',
      '.urm .urm-cap{color:var(--urm-muted);font-size:13px;line-height:20px}',
      '.urm .urm-name{font-size:16px;font-weight:600;line-height:24px;margin-top:2px;word-break:break-all}',
      // 已连接卡片：头部一行（图标、名称、状态、刷新），主体是应用网址，其余收进「更多信息」
      '.urm .urm-head-row{display:flex;align-items:center;gap:12px}',
      '.urm .urm-tile.urm-tile-sm{width:40px;height:40px;border-radius:12px}',
      '.urm .urm-head-text{flex:1;min-width:0}',
      '.urm .urm-title{font-size:15px;font-weight:600;line-height:22px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.urm .urm-status{display:flex;align-items:center;gap:6px;margin-top:1px;min-width:0;font-size:12.5px;line-height:18px;color:var(--urm-muted)}',
      '.urm .urm-status>b{font-weight:500;color:var(--urm-fg)}',
      '.urm .urm-status>b.ok{color:var(--urm-ok)}.urm .urm-status>b.warn{color:var(--urm-warn)}.urm .urm-status>b.bad{color:var(--urm-bad)}',
      '.urm .urm-status>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.urm .urm-btn.urm-icon-btn{width:32px;padding:0}',
      '.urm .urm-field-label{margin:16px 0 6px;font-size:12.5px;line-height:18px;color:var(--urm-muted)}',
      '.urm .urm-linkbox{display:flex;align-items:center;gap:6px;padding:4px 4px 4px 12px;border:1px solid var(--urm-line);border-radius:12px;background:var(--urm-surface)}',
      '.urm .urm-linkbox .urm-link{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;word-break:normal;font:500 13px/20px var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}',
      '.urm .urm-linkbox .urm-btn{height:30px}',
      '.urm .urm-hint{margin-top:8px;font-size:12.5px;line-height:18px;color:var(--urm-muted)}',
      '.urm .urm-hint.warn{color:var(--urm-warn)}',
      '.urm .urm-more{margin-top:12px}',
      '.urm .urm-more>summary{display:inline-flex;align-items:center;gap:6px;list-style:none;cursor:pointer;user-select:none;font-size:12.5px;line-height:18px;color:var(--urm-muted)}',
      '.urm .urm-more>summary::-webkit-details-marker{display:none}',
      '.urm .urm-more>summary::before{content:"";width:5px;height:5px;margin:0 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform 120ms ease}',
      '.urm .urm-more[open]>summary::before{transform:rotate(45deg)}',
      '.urm .urm-more>summary:hover{color:var(--urm-fg)}',
      '.urm .urm-more-body{margin-top:8px;padding:2px 4px 2px 12px;border-radius:12px;background:var(--urm-hover)}',
      '.urm .urm-mini-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;align-items:center;column-gap:8px;min-height:36px;font-size:12.5px}',
      '.urm .urm-mini-row>span:first-child{color:var(--urm-muted)}',
      '.urm .urm-mini-row .urm-link{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;word-break:normal}',
      '.urm .urm-mini-row .urm-btn{height:28px;width:28px;padding:0;background-color:transparent;border-color:transparent}',
      // 谁能用：整行可点的选项卡片
      '.urm .urm-tiers{display:grid;gap:10px;margin-top:14px}',
      '.urm .urm-tier{position:relative;display:flex;gap:14px;align-items:center;border:1px solid var(--urm-line);border-radius:14px;padding:12px 16px;background:var(--urm-surface);cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease}',
      '.urm .urm-tier:hover{border-color:var(--urm-accent-line)}',
      '.urm .urm-tier.on{background:var(--urm-accent-soft);border-color:var(--urm-accent-line)}',
      '.urm .urm-tier input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}',
      '.urm .urm-radio{flex:none;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--urm-faint);background:var(--urm-surface);transition:border 120ms ease}',
      '.urm .urm-tier.on .urm-radio{border:5px solid var(--urm-accent);background:var(--urm-radio-dot)}',
      '.urm .urm-tier-text{min-width:0}',
      '.urm .urm-tier b{display:block;font-size:14px;font-weight:500;line-height:22px}',
      '.urm .urm-tier small{display:block;margin-top:1px;color:var(--urm-muted);font-size:12.5px;line-height:18px}',
      '.urm .urm-tier[data-disabled]{cursor:default;opacity:.6}',
      // 断开：浅红卡片
      '.urm .urm-card.urm-danger-card{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;background:var(--urm-bad-soft);border-color:var(--urm-bad-line)}',
      '.urm .urm-danger-card h2{color:var(--urm-bad)}',
      '.urm .urm-danger-card .urm-danger-text{flex:1 1 260px;min-width:0}',
      '.urm .urm-code-label{margin:16px 0 6px;font-size:12.5px;line-height:18px;color:var(--urm-muted)}',
      '.urm .urm-code{font:700 30px/1.2 var(--dsw-font-mono,ui-monospace,Menlo,monospace);letter-spacing:.18em;text-align:center;color:var(--urm-title);background:var(--urm-accent-soft);border-radius:12px;padding:14px;font-variant-numeric:tabular-nums}',
      '.urm .urm-code-sep{margin:0 .04em 0 -.06em;color:var(--urm-faint);font-weight:500;user-select:none}',
      '.urm .urm-code+.urm-hint{margin:8px 0 16px}',
      '.urm input[type=text],.urm input[type=tel],.urm input[type=number]{height:32px;font:inherit;font-size:13px;color:var(--urm-fg);background:var(--urm-surface);border:1px solid var(--urm-line);border-radius:10px;padding:0 10px;outline:none}',
      '.urm input[type=text]:focus,.urm input[type=tel]:focus,.urm input[type=number]:focus{border-color:var(--urm-accent)}',
      '.urm input[type=number]{width:4.5em}',
      '.urm .urm-list{list-style:none;padding:0;margin:0;border:1px solid var(--urm-line);border-radius:12px;background:var(--urm-surface)}',
      '.urm .urm-list li{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-top:1px solid var(--urm-line);align-items:center;flex-wrap:wrap;font-size:13px}',
      '.urm .urm-list li:first-child{border-top:none}',
      '.urm .urm-notice{border-radius:12px;padding:10px 14px;margin:0 0 16px;font-size:13px;line-height:20px;background:var(--urm-accent-soft);color:var(--urm-fg);word-break:break-all}',
      '.urm .urm-card .urm-notice{margin:14px 0 0}',
      '.urm .urm-notice.bad{background:var(--urm-bad-soft);color:var(--urm-bad)}.urm .urm-notice.warn{background:var(--urm-warn-soft);color:var(--urm-warn)}.urm .urm-notice.ok{background:var(--urm-ok-soft);color:var(--urm-ok)}',
      '.urm .urm-foot{color:var(--urm-muted);font-size:12px;margin-top:16px;word-break:break-all}',
      '.urm .urm-confirm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.25));border-radius:16px;z-index:2}',
      '.urm .urm-confirm-box{background:var(--urm-surface);border:1px solid var(--urm-line);border-radius:16px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.18));padding:20px 22px;max-width:380px;margin:16px}',
      '.urm .urm-confirm-box h2{font-size:16px;font-weight:600;margin:0 0 6px}',
      '.urm .urm-confirm-box .urm-row{justify-content:flex-end}',
      '.urm [hidden]{display:none!important}',
      // DSH 全局把圆角画成超椭圆（corner-shape），圆点、单选圈、胶囊按钮要和 DSH 自己的圆形控件一样改回正圆
      '.urm .urm-radio,.urm .urm-dot,.urm .urm-pill,.urm .urm-btn.urm-lg,.urm-trigger,.urm-trigger .urm-badge,.urm-close{corner-shape:round}',
      '@media (max-width:520px){.urm .urm-device{grid-template-columns:44px minmax(0,1fr);column-gap:14px}.urm .urm-tile{width:44px;height:44px;border-radius:12px}.urm .urm-card{padding:16px}}',
      // 侧栏入口与弹窗外壳（与参考插件和官方设置弹窗同一套几何与变量）
      '.urm-trigger{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:none;border-radius:50%;padding:0;background:transparent;color:var(--dsw-alias-label-secondary,#656d76);cursor:pointer;transition:background-color 120ms ease,color 120ms ease,box-shadow 120ms ease}',
      '.urm-trigger[data-wide=wide]{flex:1 1 auto;justify-content:flex-start;width:auto;min-width:0;border-radius:999px;gap:8px;padding:0 10px;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.urm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2328)}',
      '.urm-trigger:active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08))}',
      '.urm-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2,#fff),0 0 0 4px var(--dsw-alias-brand-primary,#0969da)}',
      '.urm-trigger .urm-badge{position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#1a7f37);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1,#f6f8fa)}',
      '.urm-trigger[data-wide=wide] .urm-badge{left:21px;right:auto;top:8px}',
      '.urm-trigger .urm-label{font-size:14px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.urm-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}',
      '.urm-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.3));backdrop-filter:var(--dsw-mask-blur,none)}',
      '.urm-panel{position:relative;z-index:1;display:flex;flex-direction:column;width:680px;max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);border-radius:20px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv3,0 16px 40px rgba(15,23,42,.18));color:var(--urm-fg)}',
      '.urm-head{display:flex;align-items:flex-start;gap:12px;padding:26px 28px 18px}',
      '.urm-titles{flex:1;min-width:0}',
      '.urm-head h1,.urm-standalone h1{margin:0;font-size:24px;font-weight:700;line-height:32px;letter-spacing:-.01em;color:var(--urm-title)}',
      '.urm-head p,.urm-standalone .sub{margin:4px 0 0;color:var(--urm-muted);font-size:14px;line-height:22px;font-weight:400}',
      '.urm-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:none;border-radius:50%;padding:0;background:transparent;color:var(--urm-muted);cursor:pointer}',
      '.urm-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--urm-fg)}',
      '.urm-body{overflow:auto;padding:0 28px 24px}',
      '.urm-standalone{max-width:680px;margin:40px auto;padding:32px 32px 24px;border-radius:20px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(15,23,42,.06);color:var(--urm-fg)}',
      '.urm-standalone .sub{margin-bottom:22px}',
      '@media (max-width:520px){.urm-head{padding:20px 18px 14px}.urm-body{padding:0 18px 18px}.urm-standalone{margin:0;border-radius:0;padding:24px 16px}}',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      // 加载器卸载插件时会移除带自己 data-plugin 的样式
      tag.dataset.plugin = '@uumit-ai/dsh-uumit-remote'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    var TIER = {
      private: ['仅自己', '只有你登录 UUMit 后能打开'],
      granted: ['我和我邀请的人', '你和接受邀请、被你授权的人能打开'],
      public: ['所有人', '任何拿到网址的人都能打开，并以你的身份完整操作这个 DSH（终端、文件、设置）'],
      disabled: ['关闭', '谁都打不开'],
    }
    var TUNNEL = {
      online: ['ok', '在线'],
      connecting: ['warn', '正在连接'],
      offline: ['warn', '暂时离线'],
      revoked: ['bad', '已被移除'],
      stopped: ['', '未开启'],
    }
    var TUNNEL_REASON = {
      network_unavailable: '连不上 UUMit 通道，请检查网络',
      wrong_node: '正在切换通道节点',
      rejected: '通道拒绝了这台电脑，稍后自动重试',
      disconnected: '连接中断，正在重连',
      device_revoked: '这台电脑已在 UUMit 上被移除',
    }
    var ERROR_TEXT = {
      NETWORK_UNAVAILABLE: '连不上 UUMit，请检查网络后重试。',
      FEATURE_REQUIRED: '平台还没有开放在电脑上管理，请到 UUMit 网页管理。',
      VERIFICATION_REQUIRED: '需要先完成实名认证才能这样设置。',
      VISIBILITY_NOT_ALLOWED: '这个应用不允许设为这个范围。',
      SERVICE_NOT_PUBLISHED: '应用已在 UUMit 上被删除或停用。',
      DEVICE_REVOKED: '这台电脑已在 UUMit 上被移除，需要重新连接。',
      PAIRING_DENIED: '你在网页上选择了「不是我」，本次连接已取消。',
      PAIRING_EXPIRED: '确认请求已过期，请重新连接。',
      PAIR_CODE_INVALID: '配对码无效或已过期，请在网页重新生成。',
      PAIR_CODE_FORMAT: '配对码是 8 位字母或数字。',
      RATE_LIMITED: '操作太频繁，请稍后再试。',
      LOCAL_OWNER_REQUIRED: '只能在这台电脑上、已打开 DSH 的浏览器里操作。',
    }

    function el(tag, attrs) {
      var node = document.createElement(tag)
      var a = attrs || {}
      Object.keys(a).forEach(function (k) {
        var v = a[k]
        if (v === undefined || v === null || v === false) return
        if (k === 'text') node.textContent = v
        else if (k === 'class') node.className = v
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v)
        else if (v === true) node.setAttribute(k, '')
        else node.setAttribute(k, v)
      })
      for (var i = 2; i < arguments.length; i++) {
        var c = arguments[i]
        if (c === null || c === undefined || c === false) continue
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
      }
      return node
    }

    var SVG_NS = 'http://www.w3.org/2000/svg'
    var ICONS = {
      refresh: ['M20 11a8 8 0 0 0-14.6-4.5', 'M5 3.5v4h4', 'M4 13a8 8 0 0 0 14.6 4.5', 'M19 20.5v-4h-4'],
      copy: ['M9.5 9h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 19.5v-9A1.5 1.5 0 0 1 9.5 9Z', 'M16 9V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8'],
      laptop: ['M5.5 5h13A1.5 1.5 0 0 1 20 6.5V15H4V6.5A1.5 1.5 0 0 1 5.5 5Z', 'M2.5 18.5h19'],
      globe: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z', 'M3 12h18', 'M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9', 'M12 3c-2.4 2.6-3.6 5.6-3.6 9s1.2 6.4 3.6 9'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
    }

    function icon(name, size, cls) {
      var svg = document.createElementNS(SVG_NS, 'svg')
      var attrs = { width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }
      Object.keys(attrs).forEach(function (k) { svg.setAttribute(k, String(attrs[k])) })
      if (cls) svg.setAttribute('class', cls)
      ICONS[name].forEach(function (d) {
        var path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
      })
      return svg
    }

    /** 连接码：优先 user_code（与客户端、网页一致），只保留字母数字；没有时退回 confirm_code。 */
    function pairingCode(p) {
      var raw = String((p && (p.user_code || p.confirm_code)) || '')
      return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
    }

    function errorText(err) {
      if (!err) return ''
      return ERROR_TEXT[err.error_code] || err.message || '操作没有成功，请稍后再试。'
    }

    function api(method, path, body) {
      var opts = { method: method, headers: { accept: 'application/json' }, credentials: 'same-origin' }
      if (method === 'POST') {
        opts.headers['content-type'] = 'application/json'
        opts.headers['x-uumit-remote-ui'] = '1'
        opts.body = JSON.stringify(body || {})
      }
      return fetch(API + path, opts).then(function (r) {
        return r.json().catch(function () {
          return { ok: false, error: { error_code: 'HTTP_' + r.status, message: '请求失败（' + r.status + '）' } }
        })
      }, function () {
        return { ok: false, error: { error_code: 'NETWORK_UNAVAILABLE', message: '' } }
      })
    }

    /**
     * 把管理界面挂到 root 下（全部数据经 textContent 写入，不拼接 HTML）。
     * @param {HTMLElement} root
     * @param {{onStatus?: (s: object) => void}} [opts]
     * @returns {() => void} 卸载：停止轮询并清空
     */
    function mountManager(root, opts) {
      ensureStyle()
      var o = opts || {}
      var state = { status: null, management: null, managementError: null, busy: false, message: null, lookup: null, invite: null, moreOpen: false }
      var pollTimer = null
      var disposed = false
      var lastRendered = ''
      var wrap = el('div', { class: 'urm' })
      var view = el('div')
      var foot = el('div', { class: 'urm-foot' })
      wrap.appendChild(view)
      wrap.appendChild(foot)
      root.appendChild(wrap)

      function webLink(path, text) {
        var base = state.status && state.status.web_base
        if (!base) return null
        return el('a', { class: 'urm-link', href: base + path, target: '_blank', rel: 'noopener', text: text })
      }

      function act(method, path, body, after) {
        if (state.busy) return
        state.busy = true
        state.message = null
        render(true)
        return api(method, path, body).then(function (r) {
          state.busy = false
          if (!r.ok) state.message = { kind: 'bad', text: errorText(r.error), error: r.error }
          if (r.ok && after) after(r.data)
          return refresh(true)
        })
      }

      function confirmDialog(title, body, okText, danger) {
        return new Promise(function (resolve) {
          var done = function (yes) {
            layer.remove()
            resolve(yes)
          }
          var layer = el('div', { class: 'urm-confirm', role: 'dialog', 'aria-modal': 'true' },
            el('div', { class: 'urm-confirm-box' },
              el('h2', { text: title }),
              el('p', { class: 'urm-muted', text: body }),
              el('div', { class: 'urm-row urm-mt' },
                el('button', { type: 'button', class: 'urm-btn', text: '取消', onclick: function () { done(false) } }),
                el('button', { type: 'button', class: 'urm-btn ' + (danger ? 'urm-danger-fill' : 'urm-primary'), text: okText || '确定', onclick: function () { done(true) } }))))
          wrap.appendChild(layer)
        })
      }

      function copy(text, btn, label) {
        if (!navigator.clipboard) return
        navigator.clipboard.writeText(text).then(function () {
          var span = btn && btn.querySelector('span')
          if (!span) {
            state.message = { kind: 'ok', text: '已复制' }
            render(true)
            return
          }
          span.textContent = '已复制'
          setTimeout(function () { span.textContent = label || '复制' }, 1500)
        })
      }

      function copyButton(text, label) {
        var btn = el('button', { type: 'button', class: 'urm-btn' }, icon('copy', 15), el('span', { text: label || '复制' }))
        btn.addEventListener('click', function () { copy(text, btn, label) })
        return btn
      }

      function card(cls) {
        var node = el('div', { class: 'urm-card' + (cls ? ' ' + cls : '') })
        for (var i = 1; i < arguments.length; i++) {
          var c = arguments[i]
          if (c) node.appendChild(c)
        }
        return node
      }

      function iconButton(name, label, onclick) {
        return el('button', { type: 'button', class: 'urm-btn urm-icon-btn', title: label, 'aria-label': label, onclick: onclick }, icon(name, 15))
      }

      function iconCopy(text, label) {
        var btn = iconButton('copy', label, function () {
          if (!navigator.clipboard) return
          navigator.clipboard.writeText(text).then(function () {
            btn.title = '已复制'
            btn.classList.add('urm-copied')
            setTimeout(function () { btn.title = label; btn.classList.remove('urm-copied') }, 1500)
          })
        })
        return btn
      }

      function noticeView() {
        var m = state.message
        var s = state.status
        var nodes = []
        if (m) {
          var extra = null
          if (m.error && m.error.error_code === 'FEATURE_REQUIRED') extra = webLink('/address/services', '到网页管理')
          if (m.error && m.error.error_code === 'VERIFICATION_REQUIRED') extra = webLink('/settings/verification', '去实名认证')
          nodes.push(el('div', { class: 'urm-notice ' + (m.kind || '') }, m.text, extra ? ' ' : null, extra))
        }
        if (s && s.revoked && s.state === 'unpaired') nodes.push(el('div', { class: 'urm-notice bad', text: ERROR_TEXT.DEVICE_REVOKED }))
        else if (s && s.last_error && !m && s.state !== 'paired') nodes.push(el('div', { class: 'urm-notice warn', text: errorText(s.last_error) }))
        return nodes
      }

      function unpairedView() {
        var codeInput = el('input', { type: 'text', placeholder: '例如 K7QX-M2PA', maxlength: '9', autocomplete: 'off', 'aria-label': '配对码' })
        var codeRow = el('div', { class: 'urm-row urm-mt', hidden: true }, codeInput,
          el('button', { type: 'button', class: 'urm-btn', text: '用配对码连接', onclick: function () { act('POST', '/pair/code', { code: codeInput.value }) } }))
        return card('',
          el('div', { class: 'urm-device urm-device-flush' },
            el('div', { class: 'urm-tile' }, icon('globe', 28)),
            el('div', null,
              el('h2', { text: '把这台电脑连到 UUMit' }),
              el('p', { class: 'urm-muted', text: '连接后，DeepSeek Harness 会作为一个应用出现在你的 UUMit 地址里。默认只有你自己能打开，可以随时改成邀请别人或关闭。' }),
              el('div', { class: 'urm-row urm-mt' },
                el('button', { type: 'button', class: 'urm-btn urm-primary urm-lg', disabled: state.busy, text: '连接到 UUMit', onclick: function () { act('POST', '/pair/start') } }),
                el('button', { type: 'button', class: 'urm-btn urm-lg', text: '使用配对码', onclick: function () { codeRow.hidden = false; codeInput.focus() } })),
              codeRow)))
      }

      // 连接码与客户端一致：用 user_code（网页上可直接输入，确认页显示同一个码），8 位按 4-4 分组；
      // 短横线只用于阅读，手动选中复制时去掉
      function codeView(code) {
        var node = code.length === 8
          ? el('div', { class: 'urm-code' }, code.slice(0, 4), el('span', { class: 'urm-code-sep', 'aria-hidden': 'true', text: '-' }), code.slice(4))
          : el('div', { class: 'urm-code', text: code || '— — — —' })
        node.addEventListener('copy', function (e) {
          var sel = window.getSelection()
          if (!sel || !node.contains(sel.anchorNode) || !node.contains(sel.focusNode)) return
          e.preventDefault()
          e.clipboardData.setData('text/plain', sel.toString().replace(/[\s-]+/g, ''))
        })
        return node
      }

      function pairingView(p) {
        var expires = new Date(p.expires_at)
        var code = pairingCode(p)
        return card('',
          el('span', { class: 'urm-pill warn' }, el('span', { class: 'urm-dot warn' }), '等待确认'),
          el('div', { class: 'urm-device' },
            el('div', { class: 'urm-tile' }, icon('laptop', 28)),
            el('div', null,
              el('h2', { text: '在浏览器里确认这是你的电脑' }),
              el('p', { class: 'urm-muted', text: '打开确认页并登录 UUMit，核对网页上的连接码与这里一致后点「是我」。确认后这里会自动更新。' }),
              el('div', { class: 'urm-code-label', text: '连接码' }),
              codeView(code),
              el('p', { class: 'urm-hint', text: '网页上显示的连接码应与这里一致；也可以在网页上输入它来连接' }),
              el('div', { class: 'urm-row' },
                el('a', { class: 'urm-btn urm-primary', href: p.verification_url, target: '_blank', rel: 'noopener' }, icon('external', 15), '打开确认页'),
                code ? copyButton(code, '复制连接码') : null,
                copyButton(p.verification_url, '复制链接'),
                el('button', { type: 'button', class: 'urm-btn', text: '取消', onclick: function () { act('POST', '/pair/cancel') } })),
              el('p', { class: 'urm-muted urm-mt', text: '连接码在 ' + expires.toLocaleTimeString() + ' 前有效，过期会自动换一个。' }))))
      }

      // 显示用：去掉协议与末尾斜杠，过长时保留开头和域名结尾，中间省略；复制、打开仍用完整网址
      function shortURL(url) {
        var host = String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
        return host.length > 56 ? host.slice(0, 30) + '…' + host.slice(-22) : host
      }

      // 把「电脑已连接」和「通道状态」合成一个对外状态：颜色、短词、补充说明
      function connectionStatus(s) {
        var t = s.tunnel || {}
        var svc = s.service
        if (s.paused) return ['warn', '已暂停', '地址已在 UUMit 上暂停']
        if (!svc) return ['warn', '正在登记', s.issue === 'limit_reached' ? '地址的应用数量已满，请到网页删除不用的应用' : s.issue === 'feature_unavailable' ? '平台暂未开放登记这类应用' : '正在把 DSH 登记到 UUMit']
        if (svc.tier === 'disabled') return ['', '已关闭', '「谁能用」选了关闭，谁都打不开']
        var proxy = s.device ? (t.proxies || {})[s.device.handle + '--' + svc.name] : null
        if (proxy && proxy.state === 'rejected') return ['bad', '被拒绝', '通道拒绝了这个应用：' + proxy.reason]
        var meta = TUNNEL[t.state || 'stopped'] || TUNNEL.stopped
        if ((t.state || 'stopped') === 'online') return ['ok', '在线', '手机或其他电脑现在可以打开']
        return [meta[0], meta[1], TUNNEL_REASON[t.reason] || '']
      }

      function addressSection(s) {
        var d = s.device || {}
        var svc = s.service
        var t = s.tunnel || {}
        var st = connectionStatus(s)
        var head = el('div', { class: 'urm-head-row' },
          el('div', { class: 'urm-tile urm-tile-sm' }, icon('laptop', 22)),
          el('div', { class: 'urm-head-text' },
            el('div', { class: 'urm-title', title: d.device_name || '', text: d.device_name || '这台电脑' }),
            el('div', { class: 'urm-status' }, el('span', { class: 'urm-dot ' + st[0] }), el('b', { class: st[0], text: st[1] }), st[2] ? el('span', { title: st[2], text: '· ' + st[2] }) : null)),
          iconButton('refresh', '刷新', function () { act('POST', '/reconnect') }))

        var body = []
        if (svc && svc.entry_url) {
          body.push(el('div', { class: 'urm-field-label', text: '应用网址 · 在手机或其他电脑上用它打开' }))
          body.push(el('div', { class: 'urm-linkbox' },
            el('a', { class: 'urm-link', href: svc.entry_url, target: '_blank', rel: 'noopener', title: svc.entry_url, text: shortURL(svc.entry_url) }),
            copyButton(svc.entry_url, '复制链接'),
            el('a', { class: 'urm-btn urm-icon-btn', href: svc.entry_url, target: '_blank', rel: 'noopener', title: '在新窗口打开', 'aria-label': '在新窗口打开' }, icon('external', 15))))
          if (!svc.full_access) body.push(el('p', { class: 'urm-hint warn', text: '这是旧路径形式的网址，DSH 需要独立网址才能完整使用，请到 UUMit 网页为这个应用开启独立网址。' }))
        }

        var more = el('details', { class: 'urm-more', open: state.moreOpen },
          el('summary', { text: '更多信息' }),
          el('div', { class: 'urm-more-body' },
            el('div', { class: 'urm-mini-row' }, el('span', { text: 'UUMit 地址' }),
              d.address ? el('a', { class: 'urm-link', href: d.address, target: '_blank', rel: 'noopener', title: d.address, text: shortURL(d.address) }) : el('span', { text: '—' }),
              d.address ? iconCopy(d.address, '复制地址') : el('span')),
            el('div', { class: 'urm-mini-row' }, el('span', { text: '连接方式' }),
              el('span', { text: t.state === 'online' ? (t.transport === 'wss' ? '经 443 端口（网络限制时自动切换）' : '加密直连') : '—' }), el('span')),
            el('div', { class: 'urm-mini-row' }, el('span', { text: '应用名' }), el('span', { text: svc ? svc.name : '—' }), el('span'))))
        more.addEventListener('toggle', function () { state.moreOpen = more.open })

        var c = card('', head)
        body.forEach(function (n) { c.appendChild(n) })
        c.appendChild(more)
        return c
      }

      function tierSection(s) {
        var svc = s.service
        if (!svc) return null
        var list = el('div', { class: 'urm-tiers', role: 'radiogroup', 'aria-label': '谁能用' })
        ;['private', 'granted', 'public', 'disabled'].forEach(function (tier) {
          var on = svc.tier === tier
          var input = el('input', { type: 'radio', name: 'urm-tier', value: tier, checked: on, disabled: state.busy })
          var label = el('label', { class: 'urm-tier' + (on ? ' on' : ''), 'data-disabled': state.busy && !on },
            input, el('span', { class: 'urm-radio', 'aria-hidden': 'true' }),
            el('span', { class: 'urm-tier-text' }, el('b', { text: TIER[tier][0] }), el('small', { text: TIER[tier][1] })))
          input.addEventListener('change', function () {
            if (tier === 'public') {
              confirmDialog('让所有人都能打开？', '任何拿到网址的人都能以你的身份使用这个 DSH，包括终端、文件和设置。只在你清楚风险时选择。', '仍然选择所有人', true).then(function (yes) {
                if (yes) act('POST', '/exposure', { tier: 'public', confirm: true })
                else render(true)
              })
              return
            }
            act('POST', '/exposure', { tier: tier })
          })
          list.appendChild(label)
        })
        return card('', el('h2', { text: '谁能用' }), el('p', { class: 'urm-muted', text: '设置谁可以通过这个链接打开你的 DSH' }), list)
      }

      function sharingSection(s) {
        var svc = s.service
        if (!svc || svc.tier !== 'granted') return null
        var m = state.management
        if (state.managementError) {
          var link = state.managementError.error_code === 'FEATURE_REQUIRED' ? webLink('/address/grants', '到网页管理邀请与授权') : null
          return card('', el('h2', { text: '邀请与授权' }), el('p', { class: 'urm-muted' }, errorText(state.managementError), link ? ' ' : null, link))
        }
        if (!m) return card('', el('h2', { text: '邀请与授权' }), el('p', { class: 'urm-muted', text: '正在读取…' }))
        var defs = m.invite_defaults || { expires_in_days: 7, max_expires_in_days: 30, max_uses: 1, max_uses_cap: 10 }
        var days = el('input', { type: 'number', min: '1', max: String(defs.max_expires_in_days), value: String(defs.expires_in_days), 'aria-label': '有效天数' })
        var uses = el('input', { type: 'number', min: '1', max: String(defs.max_uses_cap), value: String(defs.max_uses), 'aria-label': '可用次数' })
        var inviteBox = el('div', null,
          el('h3', { text: '邀请链接' }),
          el('div', { class: 'urm-row' }, '有效', days, '天，可用', uses, '次',
            el('button', { type: 'button', class: 'urm-btn urm-primary', disabled: state.busy, text: '生成邀请链接', onclick: function () {
              act('POST', '/invites', { expires_in_days: Number(days.value), max_uses: Number(uses.value) }, function (data) { state.invite = data })
            } })))
        if (state.invite && state.invite.invite_url) {
          inviteBox.appendChild(el('div', { class: 'urm-notice urm-mt' }, '把这个链接发给对方，对方登录 UUMit 后接受即可：',
            el('div', { class: 'urm-row urm-mt' }, el('span', { class: 'urm-link', text: state.invite.invite_url }), copyButton(state.invite.invite_url))))
        }
        var invites = el('ul', { class: 'urm-list' })
        ;(m.invites || []).filter(function (i) { return i.status === 'active' || i.status === 'pending' }).forEach(function (i) {
          invites.appendChild(el('li', null,
            el('span', null, (i.service_name ? '本应用' : '整个地址') + ' · 已用 ' + i.used_count + '/' + i.max_uses + ' · ' + new Date(i.expires_at).toLocaleDateString() + ' 到期'),
            i.service_name ? el('button', { class: 'urm-btn urm-danger', text: '撤销', onclick: function () { act('POST', '/invites/revoke', { invite_id: i.invite_id }) } }) : el('span', { class: 'urm-muted', text: '到网页撤销' })))
        })
        var grants = el('ul', { class: 'urm-list' })
        ;(m.grants || []).filter(function (g) { return g.status === 'active' }).forEach(function (g) {
          var p = g.grantee || {}
          grants.appendChild(el('li', null,
            el('span', null, (p.nickname || p.masked_phone || g.grantee_user_id) + (g.service_name ? '' : ' · 整个地址')),
            g.service_name ? el('button', { class: 'urm-btn urm-danger', text: '撤销授权', onclick: function () {
              confirmDialog('撤销授权？', '对方的下一次访问就会被拒绝。', '撤销', true).then(function (yes) { if (yes) act('POST', '/grants/revoke', { grant_id: g.grant_id }) })
            } }) : el('span', { class: 'urm-muted', text: '到网页撤销' })))
        })
        var byPhone = null
        if (m.features && m.features.grant_by_contact) {
          var phone = el('input', { type: 'tel', placeholder: '对方手机号', 'aria-label': '手机号' })
          var found = state.lookup
          byPhone = el('div', null, el('h3', { text: '按手机号授权' }),
            el('div', { class: 'urm-row' }, phone, el('button', { class: 'urm-btn', text: '查找', onclick: function () {
              act('POST', '/members/lookup', { phone: phone.value }, function (data) { state.lookup = data })
            } })),
            found ? (found.found && !found.is_self && found.person
              ? el('div', { class: 'urm-row urm-mt' }, (found.person.nickname || '') + ' ' + (found.person.masked_phone || ''),
                el('button', { class: 'urm-btn urm-primary', text: '授权使用', onclick: function () {
                  act('POST', '/grants', { user_id: found.person.user_id }, function () { state.lookup = null })
                } }))
              : el('p', { class: 'urm-muted urm-mt', text: found.is_self ? '这是你自己的账号。' : '没有找到这个手机号的 UUMit 账号，可以改用邀请链接。' })) : null)
        }
        return card('', el('h2', { text: '邀请与授权' }), el('p', { class: 'urm-muted', text: '把这个应用分给指定的人：发邀请链接，或按手机号直接授权。' }), inviteBox,
          el('h3', { text: '有效的邀请' }), invites.childNodes.length ? invites : el('p', { class: 'urm-muted', text: '暂无' }),
          byPhone,
          el('h3', { text: '已授权的人' }), grants.childNodes.length ? grants : el('p', { class: 'urm-muted', text: '暂无' }))
      }

      function dangerSection() {
        return card('urm-danger-card',
          el('div', { class: 'urm-danger-text' }, el('h2', { text: '断开这台电脑' }),
            el('p', { class: 'urm-muted', text: '断开后，这台电脑会从你的 UUMit 设备中移除，所有人都无法再经 UUMit 打开这个 DSH。' })),
          el('button', { type: 'button', class: 'urm-btn urm-danger-fill urm-lg', disabled: state.busy, text: '断开这台电脑', onclick: function () {
            confirmDialog('断开这台电脑？', '之后需要重新连接才能远程使用。', '断开', true).then(function (yes) { if (yes) act('POST', '/unpair') })
          } }))
      }

      // 轮询结果与上次相同就不重画；用户正在输入时推迟，避免清掉手机号、天数等输入
      function render(force) {
        if (disposed) return
        var key = JSON.stringify([state.status, state.management, state.managementError, state.busy, state.message, state.lookup, state.invite])
        if (!force && key === lastRendered) return
        var active = document.activeElement
        if (!force && active && wrap.contains(active) && active.tagName === 'INPUT' && active.type !== 'radio') return
        lastRendered = key
        var s = state.status
        view.replaceChildren()
        if (!s) {
          view.appendChild(card('', el('p', { class: 'urm-muted', text: '正在读取状态…' })))
          return
        }
        noticeView().forEach(function (n) { view.appendChild(n) })
        if (s.state === 'unpaired') view.appendChild(unpairedView())
        else if (s.state === 'pairing') view.appendChild(pairingView(s.pairing))
        else {
          view.appendChild(addressSection(s))
          var t = tierSection(s)
          if (t) view.appendChild(t)
          var sh = sharingSection(s)
          if (sh) view.appendChild(sh)
          view.appendChild(dangerSection())
        }
        foot.textContent = '插件 ' + s.plugin_version + ' · 平台 ' + s.api_base
      }

      function loadManagement() {
        var s = state.status
        if (!s || s.state !== 'paired' || !s.service || s.service.tier !== 'granted') {
          state.management = null
          state.managementError = null
          return Promise.resolve()
        }
        return api('GET', '/management').then(function (r) {
          state.management = r.ok ? r.data : null
          state.managementError = r.ok ? null : r.error
        })
      }

      function refresh(force) {
        return api('GET', '/status').then(function (r) {
          if (disposed) return
          if (!r.ok) {
            state.message = { kind: 'bad', text: errorText(r.error), error: r.error }
            render(force)
            return
          }
          var prevTier = state.status && state.status.service && state.status.service.tier
          state.status = r.data
          if (o.onStatus) o.onStatus(r.data)
          var tier = r.data.service && r.data.service.tier
          var p = tier === 'granted' && (force || prevTier !== 'granted' || !state.management) ? loadManagement() : Promise.resolve()
          if (tier !== 'granted') {
            state.management = null
            state.managementError = null
          }
          return p.then(function () { render(force) })
        })
      }

      function schedule() {
        if (disposed) return
        clearTimeout(pollTimer)
        var s = state.status
        var fast = s && (s.state === 'pairing' || (s.tunnel && s.tunnel.state === 'connecting') || (s.state === 'paired' && !s.service))
        pollTimer = setTimeout(function () {
          if (document.visibilityState === 'visible') refresh(false).then(schedule)
          else schedule()
        }, fast ? 2000 : 10000)
      }

      render(true)
      refresh(true).then(schedule)
      return function dispose() {
        disposed = true
        clearTimeout(pollTimer)
        wrap.remove()
      }
    }

    // --- DSH 页面内的入口与弹窗 ---

    function isLocalPage(loc) {
      var h = String((loc && loc.hostname) || '').replace(/^\[|\]$/g, '')
      return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
    }

    var ICON_PATH = 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Zm0 0c1.6 1.7 2.4 3.9 2.4 6.4S9.6 12.7 8 14.4M8 1.6C6.4 3.3 5.6 5.5 5.6 8s.8 4.7 2.4 6.4M2 6h12M2 10h12'

    function createEntry(React, ReactDOM) {
      var h = React.createElement

      function Icon(props) {
        return h('svg', { width: props.size, height: props.size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: ICON_PATH, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }

      function CloseIcon() {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
      }

      function Panel(props) {
        var bodyRef = React.useRef(null)
        React.useEffect(function () {
          if (!bodyRef.current) return undefined
          return mountManager(bodyRef.current, { onStatus: props.onStatus })
        }, [])
        React.useEffect(function () {
          var onKey = function (e) {
            if (e.key === 'Escape') props.onClose()
          }
          window.addEventListener('keydown', onKey)
          return function () { window.removeEventListener('keydown', onKey) }
        }, [props.onClose])
        return h('div', { className: 'urm-overlay', role: 'presentation' },
          h('div', { className: 'urm-mask', 'aria-hidden': 'true', onClick: props.onClose }),
          h('div', { className: 'urm-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'UUMit 远程访问' },
            h('div', { className: 'urm-head' },
              h('div', { className: 'urm-titles' }, h('h1', null, 'UUMit 远程访问'), h('p', null, '在手机或其他电脑上打开这个 DeepSeek Harness')),
              h('button', { type: 'button', className: 'urm-close', 'aria-label': '关闭', onClick: props.onClose }, h(CloseIcon))),
            h('div', { className: 'urm-body', ref: bodyRef })))
      }

      return function UumitRemoteEntry(props) {
        var wide = !!(props && props.wide)
        var s = React.useState(false)
        var open = s[0]
        var setOpen = s[1]
        var o = React.useState(false)
        var online = o[0]
        var setOnline = o[1]
        var close = React.useCallback(function () { setOpen(false) }, [])
        var onStatus = React.useCallback(function (st) {
          setOnline(!!(st && st.state === 'paired' && st.tunnel && st.tunnel.state === 'online' && st.service && st.service.tier !== 'disabled'))
        }, [])
        React.useEffect(function () {
          // 只读一次状态给入口加「在线」小圆点；面板打开后由面板自己轮询
          api('GET', '/status').then(function (r) { if (r.ok) onStatus(r.data) })
        }, [])
        return h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: 'urm-trigger',
            'data-wide': wide ? 'wide' : 'rail',
            title: online ? 'UUMit 远程访问（在线）' : 'UUMit 远程访问',
            'aria-label': 'UUMit 远程访问',
            'aria-expanded': open,
            onClick: function () { setOpen(true) },
          }, h(Icon, { size: wide ? 16 : 18 }), wide ? h('span', { className: 'urm-label' }, '远程访问') : null, online ? h('span', { className: 'urm-badge', 'aria-hidden': 'true' }) : null),
          open ? ReactDOM.createPortal(h(Panel, { onClose: close, onStatus: onStatus }), document.body) : null)
      }
    }

    // cordis 插件（浏览器端）：只在本机地址显示入口；经 UUMit 打开的远程页面不显示
    module.exports.name = 'uumit-remote'
    module.exports.inject = ['slots']
    module.exports.apply = function apply(ctx) {
      if (!isLocalPage(window.location)) return
      ensureStyle()
      var Entry = createEntry(require('react'), require('react-dom'))
      ctx.slots.inject('sidebar.footer.action', function () {
        try {
          return ctx.slots.register({ name: 'sidebar.footer.action', id: 'uumit-remote' }, Entry)
        } catch (e) {
          return function () {}
        }
      })
    }
    module.exports.mountManager = mountManager
    module.exports.isLocalPage = isLocalPage
    module.exports.pairingCode = pairingCode
    return module.exports
  },
})

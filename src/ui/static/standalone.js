// 独立兜底页：复用 DSH 浏览器端的 client.js。这里没有 DSH 的模块加载器，用一个最小垫片接住工厂，只挂管理界面。
;(function () {
  'use strict'
  // 深色模式沿用 DSH 的 body 标记，样式与 DSH 页面内的面板共用一份
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  function applyTheme() {
    if (dark && dark.matches) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }
  applyTheme()
  if (dark && dark.addEventListener) dark.addEventListener('change', applyTheme)

  window.__ModuleLoader__ = {
    load: function (entry) {
      var mod = entry.factory(function (name) {
        throw new Error('module ' + name + ' is not available on the standalone page')
      })
      mod.mountManager(document.getElementById('view'))
    },
  }
})()

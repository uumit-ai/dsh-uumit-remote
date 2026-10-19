import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
// vm 上下文里创建的对象原型不同，按值比较
const plain = (v) => JSON.parse(JSON.stringify(v))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

// 按 DSH 浏览器端加载器的方式执行：脚本只登记工厂，工厂拿到 require 后返回 cordis 插件导出
function load(hostname, requireFn = () => ({})) {
  let registered = null
  const window = {
    location: { hostname },
    __ModuleLoader__: { load: (entry) => { registered = entry } },
  }
  vm.runInNewContext(source, { window })
  const requested = []
  const exports = registered.factory((name) => {
    requested.push(name)
    return requireFn(name)
  })
  return { registered, exports, window, requested }
}

test('client.js 是 DSH 加载器认的工厂格式，id 与包名一致，顶层不取任何模块', () => {
  const { registered, exports, requested } = load('127.0.0.1')
  assert.equal(registered.id, pkg.name)
  assert.equal(typeof registered.factory, 'function')
  assert.deepEqual(plain(exports.inject), ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.mountManager, 'function')
  assert.deepEqual(requested, [], 'standalone page shim relies on no top-level require')
})

test('package.json 声明浏览器端：dsh.client 与 ./client 导出', () => {
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(pkg.files.includes('client.js'))
})

test('只在本机地址注册侧栏入口；经 UUMit 打开的远程页面不注册', () => {
  const { exports } = load('127.0.0.1')
  assert.ok(exports.isLocalPage({ hostname: '127.0.0.1' }))
  assert.ok(exports.isLocalPage({ hostname: 'localhost' }))
  assert.ok(exports.isLocalPage({ hostname: '[::1]' }))
  assert.ok(!exports.isLocalPage({ hostname: 'dsh--my-mac.uumit.cn' }))

  const remote = load('dsh--my-mac.uumit.cn')
  let injected = 0
  remote.exports.apply({ slots: { inject: () => injected++, register: () => () => {} } })
  assert.equal(injected, 0)
})

test('本机页面把入口注册到 sidebar.footer.action', () => {
  const calls = []
  const fakeReact = { createElement: () => null, useState: (v) => [v, () => {}], useRef: () => ({}), useEffect: () => {}, useCallback: (f) => f, Fragment: 'f' }
  const local = load('127.0.0.1', (name) => (name === 'react' ? fakeReact : { createPortal: () => null }))
  // vm 上下文里没有 document，ensureStyle 直接跳过
  local.exports.apply({
      slots: {
        inject: (name, fn) => {
          calls.push(['inject', name])
          fn()
        },
        register: (spec, comp) => {
          calls.push(['register', spec, typeof comp])
          return () => {}
        },
      },
  })
  assert.deepEqual(plain(calls[0]), ['inject', 'sidebar.footer.action'])
  assert.deepEqual(plain(calls[1]), ['register', { name: 'sidebar.footer.action', id: 'uumit-remote' }, 'function'])
  assert.deepEqual(local.requested, ['react', 'react-dom'])
})

test('面板连接码取 user_code（与客户端、网页一致），只保留字母数字，没有时退回确认码', () => {
  const { exports } = load('127.0.0.1')
  assert.equal(exports.pairingCode({ user_code: 'k7qx-m2pa', confirm_code: 'AB12' }), 'K7QXM2PA')
  assert.equal(exports.pairingCode({ confirm_code: 'ab12' }), 'AB12')
  assert.equal(exports.pairingCode(null), '')
})

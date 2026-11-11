/**
 * 节点延迟测试脚本（仅测速，不查地理）—— 链条第 2 步
 *
 * 单进程 + mihomo API 并发测速，确认不通的节点才舍弃，通过的节点保留原名。
 * 支持缓存：成功测速的节点结果缓存，失败不缓存，命中缓存直接跳过重测。
 *
 * 无法开始测速时（内核缺失、端口被别的服务占住、实例未通过身份校验）一律保留全部
 * 未测节点并报错，不做"猜测性丢弃" —— 测速失败不等于节点不通。
 *
 * 参数说明:
 * - [mihomo_path]       mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [api_port]          External Controller 首选端口，默认: 9191
 *                        被占用时自动改用系统分配的空闲端口
 * - [proxy_port]        mihomo 混合代理首选端口，默认: 14000，同上
 * - [test_url]          延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]      延迟测试超时(毫秒)，默认: 5000
 * - [test_count]        每节点采样次数，取最小值；有一次成功即判定可用，全部失败才舍弃，默认: 3
 * - [delay_concurrency] 并发数，默认: 10
 * - [cache_enabled]     是否启用缓存，默认: true
 * - [cache_ttl]         缓存有效期(毫秒)，默认: 3600000（1小时）
 */

// ─── 进程级全局缓存（Node.js 原生，跨调用复用）────────────────────────────────
if (!global.__latencyCache) {
  global.__latencyCache = new Map() // key => { delay, expireAt }
}
const _cache = global.__latencyCache

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  if (typeof require !== 'function' || typeof process === 'undefined' || typeof ProxyUtils === 'undefined') {
    throw new Error('[latency] 本脚本依赖 Sub-Store 后端(Node)环境：需要 require / process / ProxyUtils 来启动 mihomo 内核')
  }

  const { spawn, spawnSync } = require('child_process')
  const { promises: fs } = require('fs')
  const net              = require('net')
  const path             = require('path')
  const os               = require('os')
  const http             = require('http')

  const num = (raw, def, min = 0, max = Infinity) => {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= min && n <= max ? n : def
  }

  const TEST_URL          = String($arguments.test_url || 'http://www.gstatic.com/generate_204').trim()
  const TEST_TIMEOUT      = num($arguments.test_timeout,      5000, 500)
  const TEST_COUNT        = num($arguments.test_count,           3, 1)
  const DELAY_CONCURRENCY = num($arguments.delay_concurrency,   10, 1)
  const API_PORT_PREF     = num($arguments.api_port,          9191, 1, 65535)
  const PROXY_PORT_PREF   = num($arguments.proxy_port,       14000, 1, 65535)

  // ─── 缓存参数 ──────────────────────────────────────────────────────────────
  const CACHE_ENABLED = ($arguments.cache_enabled ?? 'true') !== 'false'
  const CACHE_TTL     = num($arguments.cache_ttl, 3600000, 1)

  const IS_WINDOWS = os.platform() === 'win32'
  const BIN_NAME   = IS_WINDOWS ? 'mihomo.exe' : 'mihomo'
  const CWD        = process.cwd()

  const DEFAULT_PATHS = [
    path.join(CWD, BIN_NAME),
    path.join(os.homedir(), BIN_NAME),
    path.join(os.homedir(), 'mihomo', BIN_NAME),
    ...(IS_WINDOWS ? [] : [path.join(os.homedir(), '.local', 'bin', 'mihomo'), '/usr/local/bin/mihomo']),
  ]
  if (process.env.MIHOMO_PATH) DEFAULT_PATHS.push(process.env.MIHOMO_PATH)
  for (const dir of String(process.env.PATH || '').split(IS_WINDOWS ? ';' : ':')) {
    if (dir) DEFAULT_PATHS.push(path.join(dir, BIN_NAME))
  }

  let MIHOMO_PATH = $arguments.mihomo_path || ''
  if (!MIHOMO_PATH) {
    for (const p of DEFAULT_PATHS) {
      try { await fs.access(p); MIHOMO_PATH = p; break } catch (_) {}
    }
  }
  if (!MIHOMO_PATH) {
    throw new Error(
      `[latency] 未找到 mihomo 内核。\n` +
      `请通过参数指定路径: mihomo_path=<绝对路径>\n` +
      `或将二进制放置于: ${DEFAULT_PATHS[0]}`
    )
  }
  if (!IS_WINDOWS) {
    try { await fs.chmod(MIHOMO_PATH, 0o755) } catch (_) {}
  }

  // ─── 端口分配 ──────────────────────────────────────────────────────────────
  // 固定端口会和正在运行的其它 mihomo/代理客户端撞车，而撞车时 mihomo 只打日志不退出
  // （实测），API 照常应答但属于别的进程 —— 宁可自动换端口也不冒串台的风险。

  function isPortFree(port) {
    return new Promise(resolve => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(port, '127.0.0.1')
    })
  }

  const takenPorts = new Set()
  async function pickPort(preferred, label) {
    if (preferred > 0 && !takenPorts.has(preferred) && await isPortFree(preferred)) {
      takenPorts.add(preferred)
      return preferred
    }
    for (let i = 0; i < 20; i++) {
      const port = await new Promise(resolve => {
        const srv = net.createServer()
        srv.once('error', () => resolve(0))
        srv.once('listening', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
        srv.listen(0, '127.0.0.1')
      })
      if (port > 0 && !takenPorts.has(port)) {
        takenPorts.add(port)
        $.info(`[latency] ${label} 首选端口 ${preferred} 已被占用，改用 ${port}`)
        return port
      }
    }
    throw new Error(`[latency] 无法为 ${label} 分配空闲端口`)
  }

  $.info(`[latency] mihomo: ${MIHOMO_PATH}`)
  $.info(`[latency] 缓存: ${CACHE_ENABLED ? `启用 (TTL=${CACHE_TTL}ms / ${(CACHE_TTL/3600000).toFixed(2)}h)` : '禁用'}`)
  $.info(`[latency] 共 ${proxies.length} 个节点，并发: ${DELAY_CONCURRENCY}，采样: ${TEST_COUNT} 次`)

  // ─── 缓存 key：以 类型+服务器+端口 作为唯一标识 ────────────────────────────
  function cacheKey(proxy) {
    return `${proxy.type}|${proxy.server}|${proxy.port}`
  }

  function getCache(proxy) {
    if (!CACHE_ENABLED) return null
    const entry = _cache.get(cacheKey(proxy))
    if (!entry) return null
    if (Date.now() > entry.expireAt) {
      _cache.delete(cacheKey(proxy))
      return null
    }
    return entry.delay
  }

  function setCache(proxy, delay) {
    if (!CACHE_ENABLED) return
    _cache.set(cacheKey(proxy), { delay, expireAt: Date.now() + CACHE_TTL })
  }

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted   = []  // 需要实际测速的节点
  const cachedPass  = []  // 命中缓存且通过的节点

  proxies.forEach((proxy, index) => {
    const cached = getCache(proxy)
    if (cached !== null) {
      $.info(`[latency] [${proxy.name}] ✓ ${cached}ms (缓存)`)
      cachedPass.push(proxy)
      return
    }

    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        // 用 proxy_N 而不是原名：原名可能带空格/emoji/重名，会破坏 /proxies/{name}/delay 这种 API 路径
        node.name = `proxy_${index}`
        converted.push({ proxy, node })
      } else {
        $.error(`[latency] [${proxy.name}] 无法转换为 mihomo 格式，跳过`)
      }
    } catch (e) {
      $.error(`[latency] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[latency] 缓存命中: ${cachedPass.length}，待测速: ${converted.length}/${proxies.length}`)
  proxies.forEach(p => { p._remove = true })
  // 缓存命中的先标记保留
  cachedPass.forEach(p => { p._remove = false })

  // 如果全部命中缓存，无需启动 mihomo
  if (converted.length > 0) {
    // ─── 写配置，启动单个 mihomo ────────────────────────────────────────────────

    const API_PORT   = await pickPort(API_PORT_PREF,   'API')
    const PROXY_PORT = await pickPort(PROXY_PORT_PREF, '代理')

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'lat-'))
    const configPath = path.join(tmpDir, 'config.yaml')

    const proxyLines = converted.map(i => '  - ' + nodeToYaml(i.node)).join('\n')
    const proxyNames = converted.map(i => `      - "${i.node.name}"`).join('\n')
    await fs.writeFile(configPath, [
      `mixed-port: ${PROXY_PORT}`,
      'log-level: warning',
      `external-controller: 127.0.0.1:${API_PORT}`,
      '',
      'proxies:',
      proxyLines,
      '',
      'proxy-groups:',
      '  - name: PROXY',
      '    type: select',
      '    proxies:',
      proxyNames,
      '',
      'rules:',
      '  - MATCH,PROXY',
    ].join('\n'), 'utf8')

    let proc = null
    try {
      proc = spawnMihomo(tmpDir, configPath)

      // 只看端口能否连上是不够的：端口被别的服务占着时 mihomo 不退出，应答的是别人的 API，
      // 于是每个节点都"超时"，整条订阅会被误杀。必须确认分组节点表就是自己写入的那份。
      const expected = converted.map(i => i.node.name)
      const check = await waitForInstance(API_PORT, 'PROXY', expected, 15000, proc)
      if (!check.ok) {
        $.error(`[latency] ${check.reason}` + (check.log.length ? `\n${check.log.join('\n')}` : ''))
        // 测速根本没跑起来，不能据此判定节点不通 —— 保留全部未测节点
        converted.forEach(({ proxy }) => { proxy._remove = false })
        $.info(`[latency] 本次未测速，保留全部 ${converted.length} 个未测节点`)
      } else {
        $.info(`[latency] mihomo 就绪 (API ${API_PORT} / 代理 ${PROXY_PORT})，开始测速（${converted.length} 个节点，每批 ${DELAY_CONCURRENCY} 个，采样 ${TEST_COUNT} 次取最小值）...`)

        // ─── 并发测速 ─────────────────────────────────────────────────────────────

        const results = new Array(converted.length).fill(null)
        await runConcurrent(
          converted.map((item, i) => async () => {
            // 有一次成功就算通：单次探测失败不等于节点不通（实测同一节点会偶发失败）。
            // 若要求"采样全对"，采样次数越多越容易误杀。
            const samples = []
            for (let n = 0; n < TEST_COUNT; n++) {
              const d = await queryDelay(API_PORT, item.node.name).catch(() => null)
              if (typeof d === 'number' && d > 0) samples.push(d)
              else if (samples.length) break   // 已确认能通，不必再为抖动数字多等一轮
            }
            results[i] = samples.length ? Math.min(...samples) : null
          }),
          DELAY_CONCURRENCY
        )

        // ─── 处理结果，逐条打印日志 ───────────────────────────────────────────────

        let passCount = 0
        let failCount = 0
        results.forEach((r, i) => {
          const { proxy } = converted[i]
          if (typeof r === 'number' && r > 0) {
            $.info(`[latency] [${proxy.name}] ✓ ${r}ms`)
            proxy._remove = false
            setCache(proxy, r)  // ✅ 成功才写缓存
            passCount++
          } else {
            $.info(`[latency] [${proxy.name}] ✗ 超时或不通`)
            // ❌ 失败不写缓存
            failCount++
          }
        })

        $.info(`[latency] 完成 — 通过: ${passCount}，舍弃: ${failCount}，共: ${converted.length}`)
      }

    } finally {
      await killProc(proc)   // 等进程真退出：下游 3-geo_rename.js 会复用同类端口
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  proxies = proxies.filter(p => !p._remove)
  proxies.forEach(p => { delete p._remove })
  $.info(`[latency] 剩余节点: ${proxies.length}（含缓存命中: ${cachedPass.filter(p => proxies.includes(p)).length}）`)
  return proxies

  // ─── 调用 mihomo API 测单节点延迟 ─────────────────────────────────────────────

  function queryDelay(apiPort, nodeName) {
    const apiPath = `/proxies/${encodeURIComponent(nodeName)}/delay?url=${encodeURIComponent(TEST_URL)}&timeout=${TEST_TIMEOUT}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, TEST_TIMEOUT + 2000)
      const req = http.request(
        { host: '127.0.0.1', port: apiPort, method: 'GET', path: apiPath },
        res => {
          let raw = ''
          res.on('data', d => (raw += d))
          res.on('end', () => {
            clearTimeout(timer)
            try {
              const json = JSON.parse(raw)
              resolve(typeof json.delay === 'number' && json.delay > 0 ? json.delay : null)
            } catch (_) { resolve(null) }
          })
        }
      )
      req.on('error', e => { clearTimeout(timer); reject(e) })
      req.end()
    })
  }

  // ─── 工具函数 ─────────────────────────────────────────────────────────────────

  function spawnMihomo(tmpDir, configPath) {
    const proc = spawn(MIHOMO_PATH, ['-d', tmpDir, '-f', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: false,
    })
    proc.__exitCode = null
    proc.__log      = []
    proc.__exited   = new Promise(resolve => proc.once('exit', code => resolve(code)))

    const onData = chunk => {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line) continue
        if (/level=(error|fatal)/.test(line)) {
          proc.__log.push(line)
          if (proc.__log.length > 8) proc.__log.shift()
          $.error(`[mihomo:${proc.pid}] ${line}`)
        }
      }
    }
    // mihomo 的 error/fatal 全部写在 stdout，stderr 是空的，只监听 stderr 等于什么都没看
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)

    proc.on('exit', code => { proc.__exitCode = code })
    proc.on('error', e => { proc.__log.push(`spawn 失败: ${e.message}`); $.error(`[latency] spawn 失败: ${e.message}`) })
    return proc
  }

  // 必须等到进程真的退出：链条里下一个脚本会复用同类端口，
  // 半死不活的旧实例会让新实例静默绑不上端口。
  async function killProc(proc) {
    if (!proc || proc.__exitCode !== null) return
    try {
      if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' })
      else proc.kill('SIGTERM')
    } catch (_) {}

    const grace = ms => new Promise(resolve => { const t = setTimeout(() => resolve(false), ms); if (t.unref) t.unref() })
    const raced = await Promise.race([proc.__exited.then(() => true), grace(3000)])
    if (!raced) {
      try { proc.kill('SIGKILL') } catch (_) {}
      await Promise.race([proc.__exited.then(() => true), grace(1000)])
    }
  }

  // 轮询直到确认：应答的这个 API 端口上，跑的确实是我们刚起的那个实例。
  async function waitForInstance(port, group, expectedNames, maxMs = 15000, proc = null) {
    const deadline = Date.now() + maxMs
    const expect   = [...expectedNames].sort().join('|')
    let last       = '无响应'

    while (Date.now() < deadline) {
      if (proc && proc.__exitCode !== null) {
        return { ok: false, reason: `mihomo 启动后立即退出 (code=${proc.__exitCode})`, log: proc.__log }
      }
      const r = await httpGetJson(port, `/proxies/${encodeURIComponent(group)}`)
      last = r.status ? `HTTP ${r.status}` : (r.error || '无响应')
      if (r.status === 200 && r.json && Array.isArray(r.json.all)) {
        if ([...r.json.all].sort().join('|') === expect) return { ok: true }
        return {
          ok: false,
          reason: `端口 ${port} 上的 mihomo 分组 [${group}] 节点表与本任务不一致，判定为其它进程的内核，放弃本次测速`,
          log: proc ? proc.__log : [],
        }
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    return { ok: false, reason: `等待 ${maxMs}ms 后 API ${port} 仍无分组 [${group}]（最后状态: ${last}）`, log: proc ? proc.__log : [] }
  }

  function httpGetJson(port, path) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { req.destroy(); resolve({ error: 'TIMEOUT' }) }, 3000)
      const req   = http.request({ host: '127.0.0.1', port, method: 'GET', path }, res => {
        let raw = ''
        res.on('data', d => (raw += d))
        res.on('end', () => {
          clearTimeout(timer)
          try { resolve({ status: res.statusCode, json: JSON.parse(raw) }) }
          catch (_) { resolve({ status: res.statusCode, json: null }) }
        })
      })
      req.on('error', e => { clearTimeout(timer); resolve({ error: e.code || e.message }) })
      req.end()
    })
  }

  function nodeToYaml(node) {
    const parts = []
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        const items = v.map(i => typeof i === 'object' ? JSON.stringify(i) : String(i)).join(', ')
        parts.push(`${k}: [${items}]`)
      } else if (typeof v === 'object') {
        parts.push(`${k}: ${JSON.stringify(v)}`)
      } else if (typeof v === 'boolean' || typeof v === 'number') {
        parts.push(`${k}: ${v}`)
      } else {
        parts.push(`${k}: "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      }
    }
    return parts.join('\n    ')
  }

  function runConcurrent(tasks, concurrency) {
    return new Promise(resolve => {
      let index = 0, running = 0, done = 0
      const total = tasks.length
      if (total === 0) return resolve()
      function next() {
        while (running < concurrency && index < total) {
          const task = tasks[index++]
          running++
          task().catch(() => {}).finally(() => {
            running--; done++
            if (done === total) resolve(); else next()
          })
        }
      }
      next()
    })
  }
}

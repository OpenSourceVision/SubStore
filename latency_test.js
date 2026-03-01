/**
 * 节点延迟测试脚本（仅测速，不查地理）
 *
 * 单进程 + mihomo API 并发测速，不通的节点直接舍弃，通过的节点保留原名。
 *
 * 参数说明:
 * - [mihomo_path]       mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [api_port]          External Controller 端口，默认: 9090
 * - [proxy_port]        mihomo 混合代理端口，默认: 14000
 * - [test_url]          延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]      延迟测试超时(毫秒)，默认: 5000
 * - [test_count]        每节点采样次数，取最小值，默认: 3
 * - [delay_concurrency] 并发数，默认: 10
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { spawn }        = require('child_process')
  const { promises: fs } = require('fs')
  const net              = require('net')
  const path             = require('path')
  const os               = require('os')
  const http             = require('http')

  const TEST_URL          = $arguments.test_url          || 'http://www.gstatic.com/generate_204'
  const TEST_TIMEOUT      = parseInt($arguments.test_timeout      || 5000)
  const TEST_COUNT        = parseInt($arguments.test_count        || 3)
  const DELAY_CONCURRENCY = parseInt($arguments.delay_concurrency || 10)
  const API_PORT          = parseInt($arguments.api_port          || 9090)
  const PROXY_PORT        = parseInt($arguments.proxy_port        || 14000)

  const IS_WINDOWS = os.platform() === 'win32'
  const BIN_NAME   = IS_WINDOWS ? 'mihomo.exe' : 'mihomo'
  const CWD        = process.cwd()

  const DEFAULT_PATHS = IS_WINDOWS
    ? [
        path.join(CWD, BIN_NAME),
        path.join(os.homedir(), BIN_NAME),
        path.join(os.homedir(), 'mihomo', BIN_NAME),
        `C:\\mihomo\\${BIN_NAME}`,
      ]
    : [
        path.join(CWD, BIN_NAME),
        path.join(os.homedir(), BIN_NAME),
        '/usr/local/bin/mihomo',
        path.join(os.homedir(), '.local', 'bin', 'mihomo'),
      ]

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

  $.info(`[latency] mihomo: ${MIHOMO_PATH}`)
  $.info(`[latency] 共 ${proxies.length} 个节点，并发: ${DELAY_CONCURRENCY}，采样: ${TEST_COUNT} 次`)

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        node.name = `proxy_${index}`
        converted.push({ proxy, node })
      } else {
        $.error(`[latency] [${proxy.name}] 无法转换为 mihomo 格式，跳过`)
      }
    } catch (e) {
      $.error(`[latency] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[latency] 可检测节点: ${converted.length}/${proxies.length}`)
  proxies.forEach(p => { p._remove = true })

  // ─── 写配置，启动单个 mihomo ──────────────────────────────────────────────────

  const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'lat-'))
  const configPath = path.join(tmpDir, 'config.yaml')

  const proxyLines = converted.map(i => '  - ' + nodeToYaml(i.node)).join('\n')
  const proxyNames = converted.map(i => `      - "${i.node.name}"`).join('\n')
  await fs.writeFile(configPath, [
    `mixed-port: ${PROXY_PORT}`,
    'allow-lan: false',
    'log-level: warning',
    'ipv6: false',
    `external-controller: 127.0.0.1:${API_PORT}`,
    "external-controller-cors-allow-origins: ['*']",
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

    const ready = await waitForPort(API_PORT, 12000)
    if (!ready) {
      $.error(`[latency] mihomo API 端口 ${API_PORT} 未就绪，终止`)
      return proxies.filter(p => !p._remove)
    }
    $.info(`[latency] mihomo 就绪，开始测速（${converted.length} 个节点，每批 ${DELAY_CONCURRENCY} 个，采样 ${TEST_COUNT} 次取最小值）...`)

    // ─── 并发测速 ───────────────────────────────────────────────────────────────

    const results = new Array(converted.length).fill(null)
    await runConcurrent(
      converted.map((item, i) => async () => {
        const samples = []
        for (let n = 0; n < TEST_COUNT; n++) {
          const d = await queryDelay(item.node.name).catch(() => null)
          if (typeof d === 'number' && d > 0) samples.push(d)
          else break
        }
        results[i] = samples.length === TEST_COUNT ? Math.min(...samples) : null
      }),
      DELAY_CONCURRENCY
    )

    // ─── 处理结果，逐条打印日志 ─────────────────────────────────────────────────

    let passCount = 0
    let failCount = 0
    results.forEach((r, i) => {
      const { proxy } = converted[i]
      if (typeof r === 'number' && r > 0) {
        $.info(`[latency] [${proxy.name}] ✓ ${r}ms`)
        proxy._remove = false
        passCount++
      } else {
        $.info(`[latency] [${proxy.name}] ✗ 超时或不通`)
        failCount++
      }
    })

    $.info(`[latency] 完成 — 通过: ${passCount}，舍弃: ${failCount}，共: ${converted.length}`)

  } finally {
    killProc(proc)
    try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }

  proxies = proxies.filter(p => !p._remove)
  proxies.forEach(p => { delete p._remove })
  $.info(`[latency] 剩余节点: ${proxies.length}`)
  return proxies

  // ─── 调用 mihomo API 测单节点延迟 ─────────────────────────────────────────────

  function queryDelay(nodeName) {
    const apiPath = `/proxies/${encodeURIComponent(nodeName)}/delay?url=${encodeURIComponent(TEST_URL)}&timeout=${TEST_TIMEOUT}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, TEST_TIMEOUT + 2000)
      const req = http.request(
        { host: '127.0.0.1', port: API_PORT, method: 'GET', path: apiPath },
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
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      shell: false,
    })
    proc.stderr.on('data', d => {
      const lines = d.toString().trim().split('\n')
      for (const line of lines) {
        if (!line) continue
        if (line.includes('level=error') || line.includes('level=fatal')) {
          $.error(`[mihomo:${proc.pid}] ${line}`)
        }
      }
    })
    proc.on('error', e => $.error(`[latency] spawn 失败: ${e.message}`))
    return proc
  }

  function killProc(proc) {
    if (!proc) return
    try {
      if (IS_WINDOWS) {
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore', shell: false })
      } else {
        proc.kill('SIGTERM')
      }
    } catch (_) {}
  }

  function waitForPort(port, maxMs = 8000, interval = 200) {
    return new Promise(resolve => {
      const deadline = Date.now() + maxMs
      function attempt() {
        const sock = new net.Socket()
        sock.setTimeout(interval)
        sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true) })
        sock.on('error', () => {
          sock.destroy()
          if (Date.now() < deadline) setTimeout(attempt, interval)
          else resolve(false)
        })
        sock.on('timeout', () => {
          sock.destroy()
          if (Date.now() < deadline) setTimeout(attempt, interval)
          else resolve(false)
        })
      }
      attempt()
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

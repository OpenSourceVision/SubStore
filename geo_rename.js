/**
 * 节点落地地理位置重命名脚本（含延迟测试）
 *
 * 通过 mihomo 内核将请求从节点自身发出，同时完成:
 *   1. 延迟测试 — 不通的节点直接舍弃
 *   2. 地理位置查询 — 按"国家 序号 ISP"格式重命名
 * 例如: 美国 01 Cloudflare, 日本 02 NTT
 *
 * 前置条件:
 * 下载 mihomo 内核: https://github.com/MetaCubeX/mihomo/releases
 * Windows: 将 mihomo.exe 放在 Sub-Store 同目录
 * Linux/macOS: 将 mihomo 放在 Sub-Store 同目录
 *
 * 参数说明:
 * - [mihomo_path]    mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [test_url]       延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]   延迟测试超时(毫秒)，默认: 5000
 * - [api]           地理查询 API，默认: http://ip-api.com/json?fields=country,isp,org&lang=zh-CN
 * - [concurrency]   并发节点数，默认: 5
 * - [geo_timeout]   地理查询超时(毫秒)，默认: 10000
 * - [start_port]    本地代理起始端口，默认: 14000
 * - [cache]         启用缓存，默认: true
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cache = scriptResourceCache
  const { spawn }        = require('child_process')
  const { promises: fs } = require('fs')
  const net              = require('net')
  const path             = require('path')
  const os               = require('os')

  const TEST_URL      = $arguments.test_url || 'http://www.gstatic.com/generate_204'
  const TEST_TIMEOUT  = parseInt($arguments.test_timeout || 5000)
  const API_URL       = $arguments.api || 'http://ip-api.com/json?fields=country,isp,org&lang=zh-CN'
  const GEO_TIMEOUT   = parseInt($arguments.geo_timeout || 10000)
  const CONCURRENCY   = parseInt($arguments.concurrency || 5)
  const START_PORT    = parseInt($arguments.start_port || 14000)
  const CACHE_ENABLED = $arguments.cache !== false && $arguments.cache !== 'false'

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
      `[geo-rename] 未找到 mihomo 内核。\n` +
      `请通过参数指定路径: mihomo_path=<绝对路径>\n` +
      `或将二进制放置于: ${DEFAULT_PATHS[0]}`
    )
  }
  if (!IS_WINDOWS) {
    try { await fs.chmod(MIHOMO_PATH, 0o755) } catch (_) {}
  }

  $.info(`[geo-rename] mihomo: ${MIHOMO_PATH}`)
  $.info(`[geo-rename] 共 ${proxies.length} 个节点，并发数: ${CONCURRENCY}`)

  // 转换节点格式
  const converted = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        converted.push({ index, proxy, node })
      } else {
        $.error(`[geo-rename] [${proxy.name}] 无法转换为 mihomo 格式，跳过`)
      }
    } catch (e) {
      $.error(`[geo-rename] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[geo-rename] 可检测节点: ${converted.length}/${proxies.length}`)

  // 标记所有节点为待删除，检测通过后取消标记
  proxies.forEach(p => { p._remove = true })

  await runConcurrent(
    converted.map((item, i) => () => detectProxy(item, START_PORT + i % 900)),
    CONCURRENCY
  )

  // 舍弃延迟测试不通的节点
  const before = proxies.length
  proxies = proxies.filter(p => !p._remove)
  const removed = before - proxies.length
  if (removed > 0) $.info(`[geo-rename] 舍弃不通节点: ${removed} 个`)

  // 按国家分组编号，生成最终名称
  const countryIndex = {}
  for (const proxy of proxies) {
    const country = proxy._geo?.country || '未知'
    if (!countryIndex[country]) countryIndex[country] = 1
    const num = String(countryIndex[country]++).padStart(2, '0')
    const isp = proxy._geo?.isp || proxy._geo?.org || ''
    proxy.name = isp ? `${country} ${num} ${isp}` : `${country} ${num}`
    delete proxy._geo
    delete proxy._remove
  }

  $.info(`[geo-rename] 完成，剩余节点: ${proxies.length}`)
  return proxies

  // ─── 检测单个节点：启动 mihomo → 延迟测试 → 地理查询 ─────────────────────────

  async function detectProxy({ index, proxy, node }, port) {
    // 地理信息缓存 key（节点配置唯一标识）
    const geoCacheKey = `geo-egress:${node.server}:${node.port}:${node.type}`
    let cachedGeo = null
    if (CACHE_ENABLED) {
      try {
        const cached = cache.get(geoCacheKey)
        if (cached) cachedGeo = cached
      } catch (_) {}
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-'))
    const configPath = path.join(tmpDir, 'config.yaml')

    // 用简单 ASCII 名称，避免特殊字符破坏 YAML
    const safeNode = { ...node, name: `proxy-${index}` }
    await fs.writeFile(configPath, buildConfig(safeNode, port), 'utf8')

    let proc = null
    try {
      const stderrLines = []
      proc = spawn(MIHOMO_PATH, ['-d', tmpDir, '-f', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
        shell: false,
      })
      proc.stderr.on('data', d => {
        const line = d.toString().trim()
        if (line) stderrLines.push(line)
      })
      proc.on('error', e => $.error(`[geo-rename] [${proxy.name}] spawn 错误: ${e.message}`))

      // 等待端口就绪
      const ready = await waitForPort(port, 8000)
      if (!ready) {
        const errMsg = stderrLines.slice(-2).join(' | ')
        $.error(`[geo-rename] [${proxy.name}] mihomo 未能启动 (port ${port})${errMsg ? ': ' + errMsg : ''}`)
        return
      }

      // ── 第一步：延迟测试 ───────────────────────────────────────────────────────
      const latency = await testLatency(TEST_URL, port, TEST_TIMEOUT)
      if (latency === null) {
        $.info(`[geo-rename] [${proxy.name}] ✗ 延迟测试不通（超时或节点无法连接），已舍弃`)
        return
      }
      $.info(`[geo-rename] [${proxy.name}] ✓ 延迟: ${latency}ms`)

      // 延迟测试通过，取消舍弃标记
      proxy._remove = false

      // ── 第二步：地理位置查询 ───────────────────────────────────────────────────
      if (cachedGeo) {
        proxy._geo = cachedGeo
        $.info(`[geo-rename] [${proxy.name}] 地理缓存: ${cachedGeo.country} / ${cachedGeo.isp || ''}`)
        return
      }

      const data = await fetchViaProxy(API_URL, port, GEO_TIMEOUT)
      if (data && data.country) {
        proxy._geo = { country: data.country, isp: data.isp || data.org || '' }
        $.info(`[geo-rename] [${proxy.name}] → ${data.country} / ${data.isp || ''}`)
        if (CACHE_ENABLED) {
          try { cache.set(geoCacheKey, proxy._geo) } catch (_) {}
        }
      } else {
        // 地理查询失败时保留节点但标记为未知
        proxy._geo = { country: '未知', isp: '' }
        $.error(`[geo-rename] [${proxy.name}] 地理查询失败，标记为未知`)
      }
    } catch (e) {
      $.error(`[geo-rename] [${proxy.name}] 检测异常: ${e.message || e}`)
    } finally {
      if (proc) {
        try {
          if (IS_WINDOWS) {
            spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore', shell: false })
          } else {
            proc.kill('SIGTERM')
          }
        } catch (_) {}
      }
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  // ─── 延迟测试：检查状态码，非 2xx 视为不通 ──────────────────────────────────────
  // 节点不通时 mihomo 会返回 502，必须校验状态码，否则 502 也会被误判为通过

  function testLatency(url, port, timeout) {
    const http = require('http')
    return new Promise(resolve => {
      const start = Date.now()
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, timeout)
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: url,
        headers: {
          Host: new (require('url').URL)(url).host,
          'User-Agent': 'curl/7.88.0',
          'Proxy-Connection': 'keep-alive',
        },
      }, res => {
        clearTimeout(timer)
        res.resume() // 丢弃响应体
        // 只有 2xx 才算连通，mihomo 返回的 502/503 会被过滤
        if (res.statusCode >= 200 && res.statusCode < 300) {
          res.on('end', () => resolve(Date.now() - start))
          res.on('error', () => resolve(null))
        } else {
          resolve(null)
        }
      })
      req.on('error', () => { clearTimeout(timer); resolve(null) })
      req.end()
    })
  }

  // ─── 地理查询：通过本地代理发请求 ────────────────────────────────────────────

  function fetchViaProxy(url, port, timeout) {
    const http = require('http')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); reject(new Error('地理查询超时')) }, timeout)
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: url,
        headers: {
          Host: new (require('url').URL)(url).host,
          'User-Agent': 'curl/7.88.0',
          'Proxy-Connection': 'keep-alive',
        },
      }, res => {
        let raw = ''
        res.on('data', d => (raw += d))
        res.on('end', () => {
          clearTimeout(timer)
          try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`解析失败: ${raw.slice(0, 200)}`)) }
        })
      })
      req.on('error', e => { clearTimeout(timer); reject(e) })
      req.end()
    })
  }

  // ─── 轮询端口直到可连接 ───────────────────────────────────────────────────────

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

  // ─── 构建 mihomo 配置 ─────────────────────────────────────────────────────────

  function buildConfig(node, port) {
    const lines = [
      `mixed-port: ${port}`,
      'allow-lan: false',
      'log-level: info',
      'ipv6: false',
      '',
      'proxies:',
      '  - ' + nodeToYaml(node),
      '',
      'proxy-groups:',
      '  - name: PROXY',
      '    type: select',
      '    proxies:',
      `      - ${node.name}`,
      '',
      'rules:',
      '  - MATCH,PROXY',
    ]
    return lines.join('\n')
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

  // ─── 并发控制 ─────────────────────────────────────────────────────────────────

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

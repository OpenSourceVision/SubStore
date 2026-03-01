/**
 * 节点落地地理位置重命名脚本 v2（单进程 + mihomo API 并发测速）
 *
 * 相比 v1 的核心改进:
 *   - 所有节点写入同一份 mihomo 配置，只启动 **一个** mihomo 进程
 *   - 延迟测试改用 mihomo External Controller REST API
 *     GET /proxies/{name}/delay  → mihomo 自己并发发出请求，省掉所有进程启动开销
 *   - 地理查询阶段才按并发数分批，每批临时起一个单节点 mihomo 测出口 IP
 *   - 两阶段流水线：① 并发测延迟（快） → ② 仅对存活节点查地理（少）
 *
 * 参数说明:
 * - [mihomo_path]    mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [api_port]       External Controller 端口，默认: 9090
 * - [proxy_port]     地理查询阶段临时代理起始端口，默认: 14000
 * - [test_url]       延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]   延迟测试超时(毫秒)，默认: 5000
 * - [api]            地理查询 API，默认: http://ip-api.com/json?fields=country,isp,org&lang=zh-CN
 * - [concurrency]         地理查询并发数，默认: 5
 * - [delay_concurrency]  延迟测试并发数，默认: 10
 * - [test_count]          每节点采样次数，取最小值，默认: 3
 * - [geo_timeout]    地理查询超时(毫秒)，默认: 10000
 * - [cache]          启用缓存，默认: true
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cache = scriptResourceCache
  const { spawn }        = require('child_process')
  const { promises: fs } = require('fs')
  const net              = require('net')
  const path             = require('path')
  const os               = require('os')
  const http             = require('http')

  const TEST_URL      = $arguments.test_url    || 'http://www.gstatic.com/generate_204'
  const TEST_TIMEOUT  = parseInt($arguments.test_timeout  || 5000)
  const API_URL       = $arguments.api         || 'http://ip-api.com/json?fields=country,isp,org&lang=zh-CN'
  const GEO_TIMEOUT   = parseInt($arguments.geo_timeout   || 10000)
  const CONCURRENCY         = parseInt($arguments.concurrency        || 5)
  const DELAY_CONCURRENCY   = parseInt($arguments.delay_concurrency   || 10)
  const TEST_COUNT          = parseInt($arguments.test_count          || 3)
  const API_PORT      = parseInt($arguments.api_port      || 9090)
  const PROXY_PORT    = parseInt($arguments.proxy_port    || 14000)
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
  $.info(`[geo-rename] 共 ${proxies.length} 个节点，延迟并发: 全量，地理并发: ${CONCURRENCY}`)
  $.info(`[geo-rename] 地理查询 API: ${API_URL}`)

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        node.name = `proxy_${index}`
        converted.push({ index, proxy, node })
      } else {
        $.error(`[geo-rename] [${proxy.name}] 无法转换为 mihomo 格式，跳过`)
      }
    } catch (e) {
      $.error(`[geo-rename] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[geo-rename] 可检测节点: ${converted.length}/${proxies.length}`)
  proxies.forEach(p => { p._remove = true })

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段一：单进程并发测延迟
  // ══════════════════════════════════════════════════════════════════════════════

  const aliveItems = await phaseLatency(converted)

  const removedCount = converted.length - aliveItems.length
  if (removedCount > 0) $.info(`[geo-rename] 舍弃不通节点: ${removedCount} 个`)
  $.info(`[geo-rename] 存活节点: ${aliveItems.length} 个，进入地理查询阶段`)

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段二：对存活节点并发查地理（每个节点独立 mihomo 实例，走自身出口）
  // ══════════════════════════════════════════════════════════════════════════════

  await runConcurrent(
    aliveItems.map((item, i) => () => phaseGeo(item, PROXY_PORT + i % 900)),
    CONCURRENCY
  )

  // ─── 过滤 + 按国家编号重命名 ───────────────────────────────────────────────────

  const before = proxies.length
  proxies = proxies.filter(p => !p._remove)
  const removed2 = before - proxies.length
  if (removed2 > 0) $.info(`[geo-rename] 最终过滤节点: ${removed2} 个`)

  const countryIndex = {}
  for (const proxy of proxies) {
    const country = proxy._geo?.country || '未知'
    if (!countryIndex[country]) countryIndex[country] = 1
    const num = String(countryIndex[country]++).padStart(2, '0')
    const isp = proxy._geo?.isp || ''
    proxy.name = isp ? `${country} ${num} ${isp}` : `${country} ${num}`
    delete proxy._geo
    delete proxy._remove
  }

  $.info(`[geo-rename] 完成，剩余节点: ${proxies.length}`)
  return proxies

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段一实现：启动单个 mihomo，用 REST API 并发测所有节点延迟
  // ══════════════════════════════════════════════════════════════════════════════

  async function phaseLatency(items) {
    if (items.length === 0) return []

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-lat-'))
    const configPath = path.join(tmpDir, 'config.yaml')

    await fs.writeFile(configPath, buildMultiConfig(items.map(i => i.node), API_PORT, PROXY_PORT), 'utf8')
    $.info(`[geo-rename] [阶段一] 配置已写入: ${configPath}，启动 mihomo...`)

    let proc = null
    try {
      proc = spawnMihomo(tmpDir, configPath)
      $.info(`[geo-rename] [阶段一] mihomo PID: ${proc.pid}，等待 API 端口 ${API_PORT} 就绪...`)

      const ready = await waitForPort(API_PORT, 12000)
      if (!ready) {
        $.error(`[geo-rename] [阶段一] mihomo API 端口 ${API_PORT} 在 12s 内未就绪，跳过延迟测试`)
        return []
      }
      $.info(`[geo-rename] [阶段一] mihomo 就绪，开始并发测延迟（${items.length} 个节点，每批 ${DELAY_CONCURRENCY} 个，每节点采样 ${TEST_COUNT} 次取最小值）...`)

      // 分批并发，每个节点采样 TEST_COUNT 次，取最小值，过滤抖动
      const results = new Array(items.length).fill(null)
      await runConcurrent(
        items.map((item, i) => async () => {
          const samples = []
          for (let n = 0; n < TEST_COUNT; n++) {
            const d = await queryDelay(item.node.name, TEST_URL, TEST_TIMEOUT).catch(() => null)
            if (typeof d === 'number' && d > 0) samples.push(d)
            else break  // 单次失败即判定不通，不继续采样
          }
          results[i] = samples.length === TEST_COUNT ? Math.min(...samples) : null
        }),
        DELAY_CONCURRENCY
      )

      const alive = []
      results.forEach((r, i) => {
        const item = items[i]
        if (typeof r === 'number' && r > 0) {
          $.info(`[geo-rename] [${item.proxy.name}] ✓ 延迟: ${r}ms`)
          item.proxy._remove = false
          alive.push(item)
        } else {
          $.info(`[geo-rename] [${item.proxy.name}] ✗ 超时或节点不通，已舍弃`)
        }
      })
      $.info(`[geo-rename] [阶段一] 完成，存活 ${alive.length}/${items.length}`)
      return alive

    } finally {
      $.info(`[geo-rename] [阶段一] 关闭 mihomo (PID: ${proc?.pid})`)
      killProc(proc)
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  // ─── 调用 mihomo API 测单节点延迟 ─────────────────────────────────────────────

  function queryDelay(nodeName, testUrl, timeout) {
    const encodedName = encodeURIComponent(nodeName)
    const encodedUrl  = encodeURIComponent(testUrl)
    const apiPath     = `/proxies/${encodedName}/delay?url=${encodedUrl}&timeout=${timeout}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, timeout + 2000)
      const req = http.request(
        { host: '127.0.0.1', port: API_PORT, method: 'GET', path: apiPath },
        res => {
          let raw = ''
          res.on('data', d => (raw += d))
          res.on('end', () => {
            clearTimeout(timer)
            try {
              const json = JSON.parse(raw)
              if (typeof json.delay === 'number' && json.delay > 0) {
                resolve(json.delay)
              } else {
                // mihomo 返回 { message: "..." } 表示节点不通
                resolve(null)
              }
            } catch (_) {
              resolve(null)
            }
          })
        }
      )
      req.on('error', e => { clearTimeout(timer); reject(e) })
      req.end()
    })
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段二实现：对单节点启动独立 mihomo，查出口 IP 地理信息
  // ══════════════════════════════════════════════════════════════════════════════

  async function phaseGeo({ proxy, node }, port) {
    const geoCacheKey = `geo-egress:${node.server}:${node.port}:${node.type}`

    // ── 缓存检查 ───────────────────────────────────────────────────────────────
    if (CACHE_ENABLED) {
      try {
        const cached = cache.get(geoCacheKey)
        if (cached) {
          proxy._geo = cached
          $.info(`[geo-rename] [${proxy.name}] 地理缓存命中: ${cached.country} / ${cached.isp || ''}`)
          return
        }
      } catch (e) {
        $.error(`[geo-rename] [${proxy.name}] 读取缓存失败: ${e.message}`)
      }
    }

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-ip-'))
    const configPath = path.join(tmpDir, 'config.yaml')
    await fs.writeFile(configPath, buildSingleConfig(node, port), 'utf8')
    $.info(`[geo-rename] [${proxy.name}] 启动 mihomo，端口 ${port}...`)

    let proc = null
    try {
      proc = spawnMihomo(tmpDir, configPath)
      $.info(`[geo-rename] [${proxy.name}] mihomo PID: ${proc.pid}，等待端口就绪...`)

      // ── 等待 mihomo 端口就绪 ────────────────────────────────────────────────
      const ready = await waitForPort(port, 8000)
      if (!ready) {
        $.error(`[geo-rename] [${proxy.name}] 端口 ${port} 在 8s 内未就绪，跳过地理查询`)
        return
      }
      $.info(`[geo-rename] [${proxy.name}] 端口就绪，发起地理查询...`)

      // ── 地理查询 ────────────────────────────────────────────────────────────
      let rawResponse = null
      try {
        rawResponse = await fetchViaProxy(API_URL, port, GEO_TIMEOUT)
      } catch (e) {
        $.error(`[geo-rename] [${proxy.name}] 地理查询请求异常: ${e.message}`)
      }

      $.info(`[geo-rename] [${proxy.name}] API 原始响应: ${JSON.stringify(rawResponse)}`)

      if (rawResponse?.country) {
        proxy._geo = { country: rawResponse.country, isp: rawResponse.isp || rawResponse.org || '' }
        $.info(`[geo-rename] [${proxy.name}] ✓ 地理查询成功: ${proxy._geo.country} / ${proxy._geo.isp}`)
        if (CACHE_ENABLED) {
          try { cache.set(geoCacheKey, proxy._geo) } catch (e) {
            $.error(`[geo-rename] [${proxy.name}] 写入缓存失败: ${e.message}`)
          }
        }
      } else {
        // rawResponse 存在但无 country 字段，说明 API 返回了错误（如 status:fail）
        const reason = rawResponse?.message || rawResponse?.status || '响应中无 country 字段'
        $.error(`[geo-rename] [${proxy.name}] 地理查询失败: ${reason}，标记为未知`)
        proxy._geo = { country: '未知', isp: '' }
      }

    } catch (e) {
      $.error(`[geo-rename] [${proxy.name}] 地理阶段异常: ${e.message || e}`)
      proxy._geo = { country: '未知', isp: '' }
    } finally {
      $.info(`[geo-rename] [${proxy.name}] 关闭 mihomo (PID: ${proc?.pid})`)
      killProc(proc)
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 工具函数
  // ══════════════════════════════════════════════════════════════════════════════

  function spawnMihomo(tmpDir, configPath) {
    const proc = spawn(MIHOMO_PATH, ['-d', tmpDir, '-f', configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      shell: false,
    })
    // 记录所有 stderr，方便排查启动失败原因
    proc.stderr.on('data', d => {
      const lines = d.toString().trim().split('\n')
      for (const line of lines) {
        if (!line) continue
        if (line.includes('level=error') || line.includes('level=fatal')) {
          $.error(`[mihomo:${proc.pid}] ${line}`)
        } else if (line.includes('level=warn')) {
          $.info(`[mihomo:${proc.pid}] ${line}`)
        }
        // info/debug 级别静默，避免日志过多
      }
    })
    proc.on('error', e => $.error(`[geo-rename] spawn 失败: ${e.message}`))
    proc.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        $.error(`[mihomo:${proc.pid}] 异常退出，code: ${code}, signal: ${signal}`)
      }
    })
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

  // ─── 地理查询：通过本地代理发请求，返回解析后的 JSON 对象 ─────────────────────

  function fetchViaProxy(url, port, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error(`请求超时 (>${timeout}ms): ${url}`))
      }, timeout)

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
          // 记录 HTTP 状态码，非 200 时有助于排查问题
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}，响应: ${raw.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(raw))
          } catch (e) {
            reject(new Error(`JSON 解析失败，原始响应: ${raw.slice(0, 200)}`))
          }
        })
        res.on('error', e => { clearTimeout(timer); reject(e) })
      })
      req.on('error', e => { clearTimeout(timer); reject(new Error(`连接失败: ${e.message}`)) })
      req.end()
    })
  }

  // ─── 等待端口可连接 ───────────────────────────────────────────────────────────

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

  // ─── 构建含所有节点的 mihomo 配置（阶段一） ───────────────────────────────────

  function buildMultiConfig(nodes, apiPort, mixedPort) {
    const proxyLines = nodes.map(n => '  - ' + nodeToYaml(n)).join('\n')
    const proxyNames = nodes.map(n => `      - "${n.name}"`).join('\n')
    return [
      `mixed-port: ${mixedPort}`,
      'allow-lan: false',
      'log-level: warning',
      'ipv6: false',
      `external-controller: 127.0.0.1:${apiPort}`,
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
    ].join('\n')
  }

  // ─── 构建单节点 mihomo 配置（阶段二，地理查询） ───────────────────────────────

  function buildSingleConfig(node, port) {
    return [
      `mixed-port: ${port}`,
      'allow-lan: false',
      'log-level: warning',
      'ipv6: false',
      '',
      'proxies:',
      '  - ' + nodeToYaml(node),
      '',
      'proxy-groups:',
      '  - name: PROXY',
      '    type: select',
      '    proxies:',
      `      - "${node.name}"`,
      '',
      'rules:',
      '  - MATCH,PROXY',
    ].join('\n')
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

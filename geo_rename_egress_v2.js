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
 * 参数说明（同 v1，新增 api_port）:
 * - [mihomo_path]    mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [api_port]       External Controller 端口，默认: 9090
 * - [proxy_port]     地理查询阶段临时代理起始端口，默认: 14000
 * - [test_url]       延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]   延迟测试超时(毫秒)，默认: 5000
 * - [api]            地理查询 API，默认: http://ip-api.com/json?fields=country,isp,org&lang=zh-CN
 * - [concurrency]    地理查询并发数，默认: 5
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
  const CONCURRENCY   = parseInt($arguments.concurrency   || 5)
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

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        // 用稳定的 ASCII 名称，后续作为 API 路径参数
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
    const isp = proxy._geo?.isp || proxy._geo?.org || ''
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

    const tmpDir    = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-lat-'))
    const configPath = path.join(tmpDir, 'config.yaml')

    // 所有节点写入同一配置，混杂端口随便给一个（地理阶段不用它）
    await fs.writeFile(configPath, buildMultiConfig(items.map(i => i.node), API_PORT, PROXY_PORT), 'utf8')

    let proc = null
    try {
      proc = spawnMihomo(tmpDir, configPath)

      // 等待 API 端口就绪（比等 mixed-port 更可靠，API 最后起）
      const ready = await waitForPort(API_PORT, 12000)
      if (!ready) {
        $.error('[geo-rename] [阶段一] mihomo API 端口未就绪，跳过延迟测试')
        return []
      }
      $.info(`[geo-rename] [阶段一] mihomo 就绪，开始并发测延迟...`)

      // 并发请求 API — mihomo 自己在内核层并发发出探测
      // 注意：这里的"并发"是 HTTP API 请求并发，mihomo 内核会真正并发测试
      const results = await Promise.allSettled(
        items.map(item => queryDelay(item.node.name, TEST_URL, TEST_TIMEOUT))
      )

      const alive = []
      results.forEach((r, i) => {
        const item = items[i]
        if (r.status === 'fulfilled' && r.value !== null) {
          $.info(`[geo-rename] [${item.proxy.name}] ✓ 延迟: ${r.value}ms`)
          item.proxy._remove = false
          alive.push(item)
        } else {
          const reason = r.status === 'rejected' ? r.reason?.message : '超时或不通'
          $.info(`[geo-rename] [${item.proxy.name}] ✗ ${reason}，已舍弃`)
        }
      })
      return alive

    } finally {
      killProc(proc)
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  // ─── 调用 mihomo API 测单节点延迟 ─────────────────────────────────────────────

  function queryDelay(nodeName, testUrl, timeout) {
    // GET /proxies/:name/delay?url=xxx&timeout=xxx
    const encodedName = encodeURIComponent(nodeName)
    const encodedUrl  = encodeURIComponent(testUrl)
    const apiPath     = `/proxies/${encodedName}/delay?url=${encodedUrl}&timeout=${timeout}`

    return new Promise((resolve, reject) => {
      // 给 API 请求比 TEST_TIMEOUT 多 2s 的等待窗口
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
              // 成功: { delay: 234 }，失败: { message: "..." }
              if (typeof json.delay === 'number' && json.delay > 0) {
                resolve(json.delay)
              } else {
                resolve(null)   // 节点不通，mihomo 返回 message 字段
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
    // 缓存检查
    const geoCacheKey = `geo-egress:${node.server}:${node.port}:${node.type}`
    if (CACHE_ENABLED) {
      try {
        const cached = cache.get(geoCacheKey)
        if (cached) {
          proxy._geo = cached
          $.info(`[geo-rename] [${proxy.name}] 地理缓存: ${cached.country} / ${cached.isp || ''}`)
          return
        }
      } catch (_) {}
    }

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-ip-'))
    const configPath = path.join(tmpDir, 'config.yaml')
    // 地理阶段不需要 API，给一个不冲突的 api_port（0 = 不启用）
    await fs.writeFile(configPath, buildSingleConfig(node, port), 'utf8')

    let proc = null
    try {
      proc = spawnMihomo(tmpDir, configPath)

      const ready = await waitForPort(port, 8000)
      if (!ready) {
        $.error(`[geo-rename] [${proxy.name}] 地理阶段 mihomo 未就绪`)
        return
      }

      const data = await fetchViaProxy(API_URL, port, GEO_TIMEOUT)
      if (data?.country) {
        proxy._geo = { country: data.country, isp: data.isp || data.org || '' }
        $.info(`[geo-rename] [${proxy.name}] → ${data.country} / ${data.isp || ''}`)
        if (CACHE_ENABLED) {
          try { cache.set(geoCacheKey, proxy._geo) } catch (_) {}
        }
      } else {
        proxy._geo = { country: '未知', isp: '' }
        $.error(`[geo-rename] [${proxy.name}] 地理查询失败，标记为未知`)
      }
    } catch (e) {
      $.error(`[geo-rename] [${proxy.name}] 地理阶段异常: ${e.message || e}`)
      proxy._geo = { country: '未知', isp: '' }
    } finally {
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
    proc.stderr.on('data', d => {
      const line = d.toString().trim()
      if (line && line.includes('level=error')) $.error(`[mihomo] ${line}`)
    })
    proc.on('error', e => $.error(`[geo-rename] spawn 错误: ${e.message}`))
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

  // ─── 地理查询：通过本地代理发请求 ────────────────────────────────────────────

  function fetchViaProxy(url, port, timeout) {
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
  // 注意: 阶段一无需真正代理流量，mixed-port 给一个占位值即可
  // external-controller 必须开启，这是调 /delay API 的入口

  function buildMultiConfig(nodes, apiPort, mixedPort) {
    const proxyLines = nodes.map(n => '  - ' + nodeToYaml(n)).join('\n')
    const proxyNames = nodes.map(n => `      - "${n.name}"`).join('\n')
    return [
      `mixed-port: ${mixedPort}`,
      'allow-lan: false',
      'log-level: warning',          // 减少日志噪音
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

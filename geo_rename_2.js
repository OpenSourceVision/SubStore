/**
 * 节点地理位置查询 & 自动重命名脚本（多实例并发版）
 *
 * 逐一切换节点 → 请求地理 API → 用返回数据重命名。
 * 支持多实例并发：将节点平均分配给 N 个 mihomo 实例同时跑，速度提升 N 倍。
 * 命名格式: 国家 序号 ISP（序号按同组累计，两位数补零）
 *
 * 参数说明:
 * - [内核路径]       mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [API端口]       External Controller 起始端口，默认: 9292（并发时依次 +1）
 * - [代理端口]      mihomo 混合代理起始端口，默认: 14000（并发时依次 +1）
 * - [并发数]        同时运行的 mihomo 实例数量，默认: 4
 * - [查询地址]      地理查询 API URL，默认: http://ip-api.com/json/?fields=country,isp,org,city
 * - [查询超时]      单次查询超时(毫秒)，默认: 8000
 * - [命名模板]      命名模板，支持 {country} {seq} {isp} {org} {city}，默认: {country} {seq} {isp}
 * - [失败处理]      查询失败处理: keep（保留原名）| remove（丢弃节点），默认: keep
 * - [缓存有效期]    缓存有效期（小时），0 表示永不过期，默认: 24
 * - [强制刷新]      是否强制忽略缓存重新查询: true | false，默认: false
 * - [缓存键]        自定义缓存存储键名前缀，默认: geo_cache
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { spawn }        = require('child_process')
  const { promises: fs } = require('fs')
  const net              = require('net')
  const path             = require('path')
  const os               = require('os')
  const http             = require('http')

  const GEO_URL        = $arguments["查询地址"]   || 'http://ip-api.com/json/?fields=country,isp,org,city&lang=zh-CN'
  const GEO_TIMEOUT    = parseInt($arguments["查询超时"]  || 8000)
  const NAME_FORMAT    = $arguments["命名模板"]    || '{country} {seq} {isp}'
  const FALLBACK_NAME  = $arguments["失败处理"]    || 'keep'
  const API_PORT_BASE  = parseInt($arguments["API端口"]    || 9292)
  const PROXY_PORT_BASE= parseInt($arguments["代理端口"]   || 14000)
  const CONCURRENCY    = Math.max(1, parseInt($arguments["并发数"] || 4))
  const CACHE_TTL_H    = parseFloat($arguments["缓存有效期"] ?? 24)
  const FORCE_REFRESH  = String($arguments["强制刷新"] || 'false').toLowerCase() === 'true'
  const CACHE_KEY_PFX  = $arguments["缓存键"] || 'geo_cache'

  const CACHE_TTL_MS   = CACHE_TTL_H > 0 ? CACHE_TTL_H * 3600 * 1000 : 0

  // ─── 平台 & 路径 ─────────────────────────────────────────────────────────────

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

  let MIHOMO_PATH = $arguments["内核路径"] || ''
  if (!MIHOMO_PATH) {
    for (const p of DEFAULT_PATHS) {
      try { await fs.access(p); MIHOMO_PATH = p; break } catch (_) {}
    }
  }

  // ─── 缓存工具 ─────────────────────────────────────────────────────────────────

  let CACHE_FILE = ''

  function initCacheFile() {
    const dir  = MIHOMO_PATH ? path.dirname(MIHOMO_PATH) : CWD
    CACHE_FILE = path.join(dir, `${CACHE_KEY_PFX}.json`)
    $.info(`[geo] 缓存文件: ${CACHE_FILE}`)
  }

  function loadCache() {
    try {
      const raw = require('fs').readFileSync(CACHE_FILE, 'utf8')
      return raw ? JSON.parse(raw) : {}
    } catch (_) { return {} }
  }

  function saveCache(cache) {
    try {
      require('fs').writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8')
    } catch (e) {
      $.info(`[geo] 缓存写入失败: ${e.message}`)
    }
  }

  function proxyFingerprint(proxy) {
    const server = proxy.server || proxy.hostname || ''
    const port   = proxy.port   || ''
    const type   = proxy.type   || ''
    return `${type}|${server}|${port}`
  }

  function getCached(cache, fp) {
    const entry = cache[fp]
    if (!entry) return undefined
    if (CACHE_TTL_MS > 0 && Date.now() - entry.ts > CACHE_TTL_MS) {
      delete cache[fp]
      return undefined
    }
    return entry.geo
  }

  function setCached(cache, fp, geo) {
    cache[fp] = { geo, ts: Date.now() }
  }

  // ─── 初始化 ───────────────────────────────────────────────────────────────────

  initCacheFile()
  const cache = FORCE_REFRESH ? {} : loadCache()
  if (FORCE_REFRESH) {
    $.info(`[geo] 强制刷新模式，忽略缓存`)
  } else {
    $.info(`[geo] 已加载缓存条目: ${Object.keys(cache).length}，有效期: ${CACHE_TTL_H > 0 ? CACHE_TTL_H + 'h' : '永久'}`)
  }

  $.info(`[geo] 节点数: ${proxies.length}，并发数: ${CONCURRENCY}，模板: "${NAME_FORMAT}"`)

  if (proxies.length === 0) return proxies

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    const fp        = proxyFingerprint(proxy)
    const cached    = getCached(cache, fp)
    const needQuery = cached === undefined

    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        node.name = `proxy_${index}`
        converted.push({ proxy, node, fp, needQuery, cachedGeo: needQuery ? undefined : cached })
      } else {
        $.info(`[geo] [${proxy.name}] 无法转换，跳过`)
      }
    } catch (e) {
      $.info(`[geo] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  const toQuery  = converted.filter(c => c.needQuery)
  const hitCount = converted.length - toQuery.length

  $.info(`[geo] 缓存命中: ${hitCount}，需查询: ${toQuery.length}`)

  // ─── 填入缓存结果 ─────────────────────────────────────────────────────────────

  const geoMap = {}
  converted.forEach(({ node, needQuery, cachedGeo }) => {
    if (!needQuery) geoMap[node.name] = cachedGeo
  })

  // ─── 多实例并发查询 ───────────────────────────────────────────────────────────

  if (toQuery.length > 0) {
    if (!MIHOMO_PATH) {
      throw new Error(
        `[geo] 未找到 mihomo 内核\n` +
        `请通过参数指定: 内核路径=<绝对路径>\n` +
        `或将二进制放置于: ${DEFAULT_PATHS[0]}`
      )
    }
    if (!IS_WINDOWS) {
      try { await fs.chmod(MIHOMO_PATH, 0o755) } catch (_) {}
    }
    $.info(`[geo] mihomo: ${MIHOMO_PATH}`)

    // 将待查询节点分片分配给各实例
    const actualConcurrency = Math.min(CONCURRENCY, toQuery.length)
    const chunks = Array.from({ length: actualConcurrency }, () => [])
    toQuery.forEach((item, i) => chunks[i % actualConcurrency].push(item))

    $.info(`[geo] 启动 ${actualConcurrency} 个实例，分片大小: ${chunks.map(c => c.length).join(' / ')}`)

    /**
     * 单个实例的完整生命周期：
     * 启动 mihomo → 等待就绪 → 串行查询本分片 → 关闭 mihomo
     */
    async function runInstance(instanceIdx, chunk) {
      const API_PORT   = API_PORT_BASE   + instanceIdx
      const PROXY_PORT = PROXY_PORT_BASE + instanceIdx

      const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), `geo${instanceIdx}-`))
      const configPath = path.join(tmpDir, 'config.yaml')

      const proxyLines = chunk.map(i => '  - ' + nodeToYaml(i.node)).join('\n')
      const proxyNames = chunk.map(i => `      - "${i.node.name}"`).join('\n')

      await fs.writeFile(configPath, [
        `mixed-port: ${PROXY_PORT}`,
        'allow-lan: true',
        'log-level: warning',
        'ipv6: true',
        `external-controller: 127.0.0.1:${API_PORT}`,
        "external-controller-cors-allow-origins: ['*']",
        '',
        'proxies:',
        proxyLines,
        '',
        'proxy-groups:',
        '  - name: GEO_PROXY',
        '    type: select',
        '    proxies:',
        proxyNames,
        '',
        'rules:',
        '  - MATCH,GEO_PROXY',
      ].join('\n'), 'utf8')

      const localResults = {}  // node.name -> geo | null
      let proc = null

      try {
        $.info(`[geo][实例${instanceIdx}] 等待端口 ${API_PORT} 释放...`)
        const released = await waitForRelease(API_PORT, 10000)
        if (!released) {
          $.error(`[geo][实例${instanceIdx}] 端口 ${API_PORT} 未能释放，跳过本分片`)
          chunk.forEach(({ node }) => { localResults[node.name] = null })
          return localResults
        }

        proc = spawnMihomo(tmpDir, configPath, instanceIdx)

        $.info(`[geo][实例${instanceIdx}] 等待 mihomo 就绪（端口 ${API_PORT}）...`)
        const ready = await waitForReady(API_PORT, 15000)
        if (!ready) {
          $.error(`[geo][实例${instanceIdx}] mihomo 未就绪，跳过本分片`)
          chunk.forEach(({ node }) => { localResults[node.name] = null })
          return localResults
        }
        $.info(`[geo][实例${instanceIdx}] 就绪，开始查询 ${chunk.length} 个节点...`)

        let pass = 0, fail = 0

        for (let i = 0; i < chunk.length; i++) {
          const { proxy, node, fp } = chunk[i]
          $.info(`[geo][实例${instanceIdx}] [${i + 1}/${chunk.length}] ${proxy.name}`)

          try {
            await switchProxy(API_PORT, 'GEO_PROXY', node.name)
          } catch (e) {
            $.info(`[geo][实例${instanceIdx}] [${proxy.name}] 切换失败: ${e.message}`)
            localResults[node.name] = null
            fail++
            continue
          }

          const geo = await queryGeo(PROXY_PORT)

          if (geo) {
            $.info(`[geo][实例${instanceIdx}] [${proxy.name}] ✓ ${geo.country || '?'} / ${geo.isp || geo.org || '?'}`)
            localResults[node.name] = geo
            setCached(cache, fp, geo)
            pass++
          } else {
            $.info(`[geo][实例${instanceIdx}] [${proxy.name}] ✗ 查询失败`)
            localResults[node.name] = null
            fail++
          }
        }

        $.info(`[geo][实例${instanceIdx}] 完成 — 成功: ${pass}，失败: ${fail}`)

      } finally {
        killProc(proc)
        try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
      }

      return localResults
    }

    // 并发跑所有实例，等待全部完成
    const allResults = await Promise.all(
      chunks.map((chunk, idx) => runInstance(idx, chunk))
    )

    // 合并各实例结果到 geoMap
    for (const result of allResults) {
      Object.assign(geoMap, result)
    }

    // 持久化缓存
    saveCache(cache)
    $.info(`[geo] 缓存已保存，共 ${Object.keys(cache).length} 条`)
  }

  // ─── 统计各组序号 & 重命名 ────────────────────────────────────────────────────

  const groupCursor = {}
  let renamed = 0, kept = 0, removed = 0

  proxies.forEach(proxy => {
    const item = converted.find(c => c.proxy === proxy)
    if (!item) return

    const geo = geoMap[item.node.name]
    if (!geo) {
      if (FALLBACK_NAME === 'remove') {
        proxy._remove = true
        $.info(`[geo] [${proxy.name}] 查询失败 → 丢弃`)
        removed++
      } else {
        $.info(`[geo] [${proxy.name}] 查询失败 → 保留原名`)
        kept++
      }
      return
    }

    const key        = geoKey(geo)
    groupCursor[key] = (groupCursor[key] || 0) + 1
    const seq        = String(groupCursor[key]).padStart(2, '0')
    const newName    = formatName(NAME_FORMAT, geo, seq)

    $.info(`[geo] [${proxy.name}] → [${newName}]`)
    proxy.name = newName
    renamed++
  })

  $.info(`[geo] 重命名: ${renamed}，保留原名: ${kept}，丢弃: ${removed}`)

  proxies = proxies.filter(p => !p._remove)
  proxies.forEach(p => { delete p._remove })
  $.info(`[geo] 输出节点数: ${proxies.length}`)
  return proxies

  // ─── 切换代理组 ───────────────────────────────────────────────────────────────

  function switchProxy(apiPort, group, nodeName) {
    return new Promise((resolve, reject) => {
      const body  = JSON.stringify({ name: nodeName })
      const timer = setTimeout(() => { req.destroy(); reject(new Error('切换超时')) }, 3000)
      const req   = http.request(
        {
          host: '127.0.0.1', port: apiPort,
          method: 'PUT',
          path: `/proxies/${encodeURIComponent(group)}`,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        res => { res.resume(); clearTimeout(timer); resolve() }
      )
      req.on('error', e => { clearTimeout(timer); reject(e) })
      req.write(body)
      req.end()
    })
  }

  // ─── 经代理请求地理 API ───────────────────────────────────────────────────────

  function queryGeo(proxyPort) {
    const geoUrlObj = new URL(GEO_URL)
    return new Promise(resolve => {
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, GEO_TIMEOUT)
      const req   = http.request(
        {
          host: '127.0.0.1', port: proxyPort,
          method: 'GET',
          path: GEO_URL,
          headers: { Host: geoUrlObj.hostname },
        },
        res => {
          let raw = ''
          res.on('data', d => (raw += d))
          res.on('end', () => {
            clearTimeout(timer)
            try {
              const json = JSON.parse(raw)
              if (json.status === 'fail' || !json.country) { resolve(null); return }
              resolve(json)
            } catch (_) { resolve(null) }
          })
        }
      )
      req.on('error', () => { clearTimeout(timer); resolve(null) })
      req.end()
    })
  }

  // ─── 工具函数 ─────────────────────────────────────────────────────────────────

  function geoKey(geo) {
    return `${geo.country || 'Unknown'}__${geo.isp || geo.org || 'Unknown'}`
  }

  function formatName(template, geo, seq) {
    return template
      .replace('{country}', geo.country || 'Unknown')
      .replace('{seq}',     seq)
      .replace('{isp}',     geo.isp  || geo.org || 'Unknown')
      .replace('{org}',     geo.org  || geo.isp || 'Unknown')
      .replace('{city}',    geo.city || '')
      .trim()
      .replace(/\s+/g, ' ')
  }

  function spawnMihomo(tmpDir, configPath, instanceIdx) {
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
          $.error(`[mihomo:实例${instanceIdx}:${proc.pid}] ${line}`)
        }
      }
    })
    proc.on('error', e => $.error(`[geo][实例${instanceIdx}] spawn 失败: ${e.message}`))
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

  function waitForRelease(port, maxMs = 10000, interval = 300) {
    return new Promise(resolve => {
      const deadline = Date.now() + maxMs
      function attempt() {
        const sock = new net.Socket()
        sock.setTimeout(interval)
        sock.connect(port, '127.0.0.1', () => {
          sock.destroy()
          if (Date.now() < deadline) setTimeout(attempt, interval)
          else resolve(false)
        })
        sock.on('error', () => { sock.destroy(); resolve(true) })
        sock.on('timeout', () => { sock.destroy(); resolve(true) })
      }
      attempt()
    })
  }

  function waitForReady(port, maxMs = 15000, interval = 300) {
    return new Promise(resolve => {
      const deadline = Date.now() + maxMs
      function attempt() {
        const timer = setTimeout(() => { req.destroy(); retry() }, interval)
        const req = http.request(
          { host: '127.0.0.1', port, method: 'GET', path: '/version' },
          res => {
            let raw = ''
            res.on('data', d => (raw += d))
            res.on('end', () => {
              clearTimeout(timer)
              try {
                const json = JSON.parse(raw)
                if (json.version) { resolve(true); return }
              } catch (_) {}
              retry()
            })
          }
        )
        req.on('error', () => { clearTimeout(timer); retry() })
        req.end()

        function retry() {
          if (Date.now() < deadline) setTimeout(attempt, interval)
          else resolve(false)
        }
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
}

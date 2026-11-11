/**
 * 节点地理位置查询 & 自动重命名脚本（多实例并发版）—— 链条第 3 步
 *
 * 逐一切换节点 → 请求地理 API → 用返回数据重命名。
 * 多实例并发：节点按下标对并发数取模，平均分给 N 个 mihomo 实例同时查，整体快约 N 倍；
 *             分组序号一律按原顺序统计，所以编号与并发数无关。
 * 命名格式: 国家 序号 ISP（序号按同组累计，两位数补零）
 *
 * 兜底原则：查询/切换失败或内核不可用时不编造"未知 01"，默认保留原名（要丢弃可设 失败处理=remove），失败不写缓存。
 * 默认查询地址 ip-api 免费档约 45 次/分钟，并发数 >1 更容易触发限流(429)。
 *
 * 参数说明:
 * - [内核路径]       mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [API端口]       External Controller 首选端口，默认: 9292
 *                    被占用时自动改用系统分配的空闲端口
 * - [代理端口]      mihomo 混合代理首选端口，默认: 14000，同上
 * - [并发数]        同时运行的 mihomo 实例数量，默认: 4
 * - [查询地址]      地理查询 API URL，必须为 http://（经 mihomo 转发，不支持 https 隧道）
 * - [查询超时]      单次查询超时(毫秒)，默认: 8000
 * - [命名模板]      命名模板，支持 {country} {seq} {isp} {org} {city}，默认: {country} {seq} {isp}
 * - [失败处理]      查询失败处理: keep（保留原名）| remove（丢弃节点），默认: keep
 * - [缓存有效期]    缓存有效期（小时），0 表示永不过期，默认: 24
 * - [强制刷新]      是否忽略缓存重新查询: true | false，默认: false
 *                   仅影响命中判断，不会清空缓存文件中其它条目
 * - [缓存键]        自定义缓存存储键名前缀，默认: geo_cache
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  if (typeof require !== 'function' || typeof process === 'undefined' || typeof ProxyUtils === 'undefined') {
    throw new Error('[geo] 本脚本依赖 Sub-Store 后端(Node)环境：需要 require / process / ProxyUtils 来启动 mihomo 内核')
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

  const GEO_URL          = String($arguments["查询地址"] || 'http://ip-api.com/json/?fields=country,isp,org,city&lang=zh-CN').trim()
  const GEO_TIMEOUT      = num($arguments["查询超时"],   8000, 1000)
  const NAME_FORMAT      = $arguments["命名模板"]    || '{country} {seq} {isp}'
  const FALLBACK_NAME    = $arguments["失败处理"]    || 'keep'
  const API_PORT_PREF    = num($arguments["API端口"],    9292,   1, 65535)
  const PROXY_PORT_PREF  = num($arguments["代理端口"],   14000,  1, 65535)
  const CONCURRENCY      = num($arguments["并发数"],     4,      1, 16)
  const CACHE_TTL_H      = Number.parseFloat($arguments["缓存有效期"] ?? 24)
  const FORCE_REFRESH    = String($arguments["强制刷新"] || 'false').toLowerCase() === 'true'
  const CACHE_KEY_PFX    = String($arguments["缓存键"] || 'geo_cache').replace(/[^\w.@-]/g, '_') || 'geo_cache'

  const CACHE_TTL_MS     = CACHE_TTL_H > 0 ? CACHE_TTL_H * 3600 * 1000 : 0

  // ─── 平台 & 路径 ─────────────────────────────────────────────────────────────

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

  let MIHOMO_PATH = $arguments["内核路径"] || ''
  if (!MIHOMO_PATH) {
    for (const p of DEFAULT_PATHS) {
      try { await fs.access(p); MIHOMO_PATH = p; break } catch (_) {}
    }
  }

  // ─── 端口分配 ────────────────────────────────────────────────────────────────
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

  // 多个实例并发取号，分配过程串行化，避免两个实例拿到同一个端口
  const takenPorts = new Set()
  let   portQueue  = Promise.resolve()

  function pickPort(preferred, label) {
    const task = portQueue.then(async () => {
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
          $.info(`[geo] ${label} 首选端口 ${preferred} 已被占用，改用 ${port}`)
          return port
        }
      }
      throw new Error(`[geo] 无法为 ${label} 分配空闲端口`)
    })
    portQueue = task.catch(() => {})
    return task
  }

  // ─── 缓存工具 ─────────────────────────────────────────────────────────────────

  let CACHE_FILE = ''

  function initCacheFile() {
    const dir  = MIHOMO_PATH ? path.dirname(MIHOMO_PATH) : CWD
    CACHE_FILE = path.join(dir, `${CACHE_KEY_PFX}.json`)
    $.info(`[geo] 缓存文件: ${CACHE_FILE}`)
  }

  function readCacheFile() {
    try {
      const raw = require('fs').readFileSync(CACHE_FILE, 'utf8')
      const obj = raw ? JSON.parse(raw) : {}
      return obj && typeof obj === 'object' ? obj : {}
    } catch (e) {
      if (e.code !== 'ENOENT') $.info(`[geo] 缓存文件读取失败(${e.code || e.name})，本次视为空缓存: ${e.message}`)
      return {}
    }
  }

  // 保存前先与磁盘内容合并：同一目录下的缓存文件被多个订阅/多个实例共用，
  // 直接覆盖会抹掉别的来源刚写入的条目。
  function saveCache(cache) {
    try {
      const merged = { ...readCacheFile() }
      const now    = Date.now()
      for (const [fp, entry] of Object.entries(cache)) {
        if (CACHE_TTL_MS > 0 && now - entry.ts > CACHE_TTL_MS) continue
        merged[fp] = entry
      }
      for (const fp of Object.keys(merged)) {
        const e = merged[fp]
        if (!e || typeof e.ts !== 'number' || (CACHE_TTL_MS > 0 && now - e.ts > CACHE_TTL_MS)) delete merged[fp]
      }
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`
      require('fs').writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
      require('fs').renameSync(tmp, CACHE_FILE)   // 原子替换，中途崩溃不会留下半个 JSON
      return Object.keys(merged).length
    } catch (e) {
      $.info(`[geo] 缓存写入失败: ${e.message}`)
      return null
    }
  }

  function proxyFingerprint(proxy) {
    const server = proxy.server || proxy.hostname || ''
    const port   = proxy.port   || ''
    const type   = proxy.type   || ''
    if (!server) return ''            // 拿不到服务器信息时不做缓存，避免不同节点共用同一指纹
    return `${type}|${server}|${port}`
  }

  function getCached(cache, fp) {
    if (!fp) return undefined
    const entry = cache[fp]
    if (!entry) return undefined
    if (CACHE_TTL_MS > 0 && Date.now() - entry.ts > CACHE_TTL_MS) {
      delete cache[fp]
      return undefined
    }
    return entry.geo
  }

  function setCached(cache, fp, geo) {
    if (!fp) return
    cache[fp] = { geo, ts: Date.now() }
  }

  // ─── 初始化 ───────────────────────────────────────────────────────────────────

  initCacheFile()
  const cache = FORCE_REFRESH ? {} : readCacheFile()
  if (FORCE_REFRESH) {
    $.info(`[geo] 强制刷新模式，忽略缓存命中（保存时仍会与文件内容合并）`)
  } else {
    $.info(`[geo] 已加载缓存条目: ${Object.keys(cache).length}，有效期: ${CACHE_TTL_H > 0 ? CACHE_TTL_H + 'h' : '永久'}`)
  }
  if (!Number.isFinite(CACHE_TTL_H)) {
    $.info(`[geo] [缓存有效期] 取值无效(${JSON.stringify($arguments["缓存有效期"])})，按默认 24 小时处理`)
  }

  $.info(`[geo] 节点数: ${proxies.length}，并发数: ${CONCURRENCY}，模板: "${NAME_FORMAT}"`)

  if (proxies.length === 0) return proxies

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    const fp        = proxyFingerprint(proxy)
    const cached    = getCached(cache, fp)
    const needQuery = cached === undefined  // undefined = 无缓存(需查询)；对象 = 缓存命中

    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        // 用 proxy_N 而不是原名：原名可能带空格/emoji/重名，会破坏 /proxies/{name} 这类 API 路径
        node.name = `proxy_${index}`
        converted.push({ proxy, node, fp, needQuery, cachedGeo: needQuery ? undefined : cached })
      } else {
        $.info(`[geo] [${proxy.name}] 无法转换，跳过`)
      }
    } catch (e) {
      $.info(`[geo] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  const byProxy = new Map(converted.map(c => [c.proxy, c]))
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

    let geoUrlObj
    try { geoUrlObj = new URL(GEO_URL) } catch (_) { geoUrlObj = null }
    if (!geoUrlObj) throw new Error(`[geo] [查询地址] 不是合法 URL: ${GEO_URL}`)
    if (geoUrlObj.protocol !== 'http:') {
      throw new Error(
        `[geo] [查询地址] 必须是 http:// 协议: ${GEO_URL}\n` +
        `查询是把完整 URL 以 absolute-form 请求行交给 mihomo 的 http 混合端口转发的，https 需要 CONNECT 隧道，当前实现不支持`
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
    if (actualConcurrency > 1 && /ip-api\.com/.test(GEO_URL)) {
      $.info(`[geo] 提示: ip-api 免费档约 45 次/分钟，并发过高会被限流(HTTP 429)，届时按查询失败处理且不写缓存`)
    }

    /**
     * 单个实例的完整生命周期：
     * 取空闲端口 → 启动 mihomo → 确认是自己的实例 → 串行查询本分片 → 关闭 mihomo
     */
    async function runInstance(instanceIdx, chunk) {
      const API_PORT   = await pickPort(API_PORT_PREF,   `实例${instanceIdx} API`)
      const PROXY_PORT = await pickPort(PROXY_PORT_PREF, `实例${instanceIdx} 代理`)

      const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), `geo${instanceIdx}-`))
      const configPath = path.join(tmpDir, 'config.yaml')

      const proxyLines = chunk.map(i => '  - ' + nodeToYaml(i.node)).join('\n')
      const proxyNames = chunk.map(i => `      - "${i.node.name}"`).join('\n')

      await fs.writeFile(configPath, [
        `mixed-port: ${PROXY_PORT}`,
        'log-level: warning',
        `external-controller: 127.0.0.1:${API_PORT}`,
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
      const markFailed   = () => chunk.forEach(({ node }) => { localResults[node.name] = null })
      let proc = null

      try {
        proc = spawnMihomo(tmpDir, configPath, instanceIdx)

        // 只看 /version 不够：端口被别的实例占着时 mihomo 只打日志不退出，
        // 应答的可能是别人的控制器，查询结果会张冠李戴。
        const expected = chunk.map(i => i.node.name)
        const check = await waitForInstance(API_PORT, 'GEO_PROXY', expected, 15000, proc)
        if (!check.ok) {
          $.error(`[geo][实例${instanceIdx}] ${check.reason}` + (check.log.length ? `\n${check.log.join('\n')}` : ''))
          markFailed()
          return localResults
        }
        $.info(`[geo][实例${instanceIdx}] 就绪 (API ${API_PORT} / 代理 ${PROXY_PORT})，开始查询 ${chunk.length} 个节点...`)

        let pass = 0, fail = 0, switchFailed = 0

        for (let i = 0; i < chunk.length; i++) {
          const { proxy, node, fp } = chunk[i]
          $.info(`[geo][实例${instanceIdx}] [${i + 1}/${chunk.length}] ${proxy.name}`)

          try {
            await switchProxy(API_PORT, 'GEO_PROXY', node.name)
          } catch (e) {
            // 切换没生效时查询到的是上一个节点的出口，不能当成本节点的结果缓存
            $.info(`[geo][实例${instanceIdx}] [${proxy.name}] 切换失败: ${e.message}，跳过`)
            localResults[node.name] = null
            switchFailed++
            fail++
            continue
          }

          const geo = await queryGeo(PROXY_PORT, geoUrlObj)

          if (geo) {
            $.info(`[geo][实例${instanceIdx}] [${proxy.name}] ✓ ${geo.country || '?'} / ${geo.isp || geo.org || '?'}`)
            localResults[node.name] = geo
            setCached(cache, fp, geo)
            pass++
          } else {
            $.info(`[geo][实例${instanceIdx}] [${proxy.name}] ✗ 查询失败，不缓存`)
            localResults[node.name] = null
            fail++
          }
        }

        $.info(`[geo][实例${instanceIdx}] 完成 — 成功: ${pass}，失败: ${fail}（其中切换失败 ${switchFailed}）`)

      } catch (e) {
        $.error(`[geo][实例${instanceIdx}] 异常: ${e.message}`)
        markFailed()
      } finally {
        await killProc(proc)
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
  }

  // 全量重命名后再持久化：一次查询都没发生时也要落盘，否则过期条目永远留在文件里
  const savedCount = saveCache(cache)
  if (savedCount !== null) $.info(`[geo] 缓存已保存，共 ${savedCount} 条`)

  // ─── 统计各组序号 & 重命名 ────────────────────────────────────────────────────

  const groupCursor = {}
  let renamed = 0, kept = 0, removed = 0

  proxies.forEach(proxy => {
    const item = byProxy.get(proxy)
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
        res => {
          let raw = ''
          res.on('data', d => (raw += d))
          res.on('end', () => {
            clearTimeout(timer)
            // mihomo 切换成功是 204 无响应体；节点名不存在时返回 400。
            // 若不区分，切换失败会被当成成功，接下来的查询用的是上一个节点的出口。
            if (res.statusCode === 204) resolve()
            else reject(new Error(`HTTP ${res.statusCode} ${raw.trim().slice(0, 120)}`))
          })
        }
      )
      req.on('error', e => { clearTimeout(timer); reject(e) })
      req.write(body)
      req.end()
    })
  }

  // ─── 经代理请求地理 API ───────────────────────────────────────────────────────

  function queryGeo(proxyPort, urlObj) {
    return new Promise(resolve => {
      let done = false
      const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
      const timer  = setTimeout(() => { req.destroy(); finish(null) }, GEO_TIMEOUT)
      const req    = http.request(
        {
          host: '127.0.0.1', port: proxyPort,
          method: 'GET',
          path: GEO_URL,                 // absolute-form 请求行，由 mihomo 转发
          // mihomo 是按 Host 头决定转发目标的（实测），这里必须带上端口，
          // 否则 查询地址 写 :8080 之类的非默认端口时会被转发到 80 而静默失败
          headers: { Host: urlObj.host },
        },
        res => {
          let raw = ''
          res.on('data', d => {
            raw += d
            if (raw.length > 65536) { req.destroy(); finish(null) }   // 防御异常大响应
          })
          res.on('end', () => {
            if (res.statusCode !== 200) {
              finish(null)
              $.info(`[geo] 地理 API 返回 HTTP ${res.statusCode}` + (res.statusCode === 429 ? '（触发限流，稍后再刷新）' : ''))
              return
            }
            try {
              const json = JSON.parse(raw)
              if (json.status === 'fail' || !json.country) { finish(null); return }
              finish(json)
            } catch (_) { finish(null) }
          })
        }
      )
      req.on('error', () => finish(null))
      req.end()
    })
  }

  // ─── 工具函数 ─────────────────────────────────────────────────────────────────

  function geoKey(geo) {
    return `${geo.country || 'Unknown'}__${geo.isp || geo.org || 'Unknown'}`
  }

  function formatName(template, geo, seq) {
    const values = {
      country: geo.country || 'Unknown',
      seq,
      isp:  geo.isp || geo.org || 'Unknown',
      org:  geo.org || geo.isp || 'Unknown',
      city: geo.city || '',
    }
    // split/join 而非 replace：replace 只替换首个占位符，且替换串里的 $& 等会被当作特殊模式
    let out = template
    for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(String(value))
    return out.replace(/\s+/g, ' ').trim()
  }

  function spawnMihomo(tmpDir, configPath, instanceIdx) {
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
          $.error(`[mihomo:实例${instanceIdx}:${proc.pid}] ${line}`)
        }
      }
    }
    // mihomo 的 error/fatal 全部写在 stdout，stderr 是空的，只监听 stderr 等于什么都没看
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)

    proc.on('exit', code => { proc.__exitCode = code })
    proc.on('error', e => { proc.__log.push(`spawn 失败: ${e.message}`); $.error(`[geo][实例${instanceIdx}] spawn 失败: ${e.message}`) })
    return proc
  }

  // 必须等到进程真的退出：并发实例与下游脚本都会复用同类端口，
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
          reason: `端口 ${port} 上的 mihomo 分组 [${group}] 节点表与本任务不一致，判定为其它进程的内核，放弃本分片以免张冠李戴`,
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
}

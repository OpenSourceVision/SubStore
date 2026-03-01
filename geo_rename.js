/**
 * 节点地理位置查询 & 自动重命名脚本
 *
 * 逐一切换节点 → 请求地理 API → 用返回数据重命名，串行无并发。
 * 命名格式: 国家 序号 ISP（序号按同组累计，两位数补零）
 *
 * 参数说明:
 * - [内核路径]    mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [API端口]       External Controller 端口，默认: 9090
 * - [代理端口]     mihomo 混合代理端口，默认: 14000
 * - [查询地址]        地理查询 API URL，默认: http://ip-api.com/json/?fields=country,isp,org,city
 * - [查询超时]    单次查询超时(毫秒)，默认: 8000
 * - [命名模板]    命名模板，支持 {country} {seq} {isp} {org} {city}，默认: {country} {seq} {isp}
 * - [失败处理]  查询失败处理: keep（保留原名）| remove（丢弃节点），默认: keep
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { spawn }        = require('child_process')
  const { promises: fs } = require('fs')
  const net              = require('net')
  const path             = require('path')
  const os               = require('os')
  const http             = require('http')

  const GEO_URL       = $arguments["查询地址"]       || 'http://ip-api.com/json/?fields=country,isp,org,city&lang=zh-CN'
  const GEO_TIMEOUT   = parseInt($arguments["查询超时"]   || 8000)
  const NAME_FORMAT   = $arguments["命名模板"]   || '{country} {seq} {isp}'
  const FALLBACK_NAME = $arguments["失败处理"] || 'keep'
  const API_PORT      = parseInt($arguments["API端口"]      || 9090)
  const PROXY_PORT    = parseInt($arguments["代理端口"]    || 14000)

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
  if (!MIHOMO_PATH) {
    throw new Error(
      `[geo] 未找到 mihomo 内核\n` +
      `请通过参数指定: mihomo_path=<绝对路径>\n` +
      `或将二进制放置于: ${DEFAULT_PATHS[0]}`
    )
  }
  if (!IS_WINDOWS) {
    try { await fs.chmod(MIHOMO_PATH, 0o755) } catch (_) {}
  }

  $.info(`[geo] mihomo : ${MIHOMO_PATH}`)
  $.info(`[geo] 节点数 : ${proxies.length}，模板: "${NAME_FORMAT}"`)

  if (proxies.length === 0) return proxies

  // ─── 转换节点格式 ─────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        node.name = `proxy_${index}`
        converted.push({ proxy, node })
      } else {
        $.info(`[geo] [${proxy.name}] 无法转换，跳过`)
      }
    } catch (e) {
      $.info(`[geo] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[geo] 可查询节点: ${converted.length}/${proxies.length}`)

  // ─── 生成 mihomo 配置并启动 ───────────────────────────────────────────────────

  const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-'))
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
    '  - name: GEO_PROXY',
    '    type: select',
    '    proxies:',
    proxyNames,
    '',
    'rules:',
    '  - MATCH,GEO_PROXY',
  ].join('\n'), 'utf8')

  let proc = null
  try {
    // 等待上一个 mihomo 实例完全释放端口，再启动新实例
    $.info(`[geo] 等待端口 ${API_PORT} 释放...`)
    const released = await waitForRelease(API_PORT, 10000)
    if (!released) {
      $.error(`[geo] 端口 ${API_PORT} 未能释放，放弃查询`)
      return proxies
    }

    proc = spawnMihomo(tmpDir, configPath)

    // 用 GET /version 确认 API 真正可用，而不仅仅是端口连通
    $.info(`[geo] 等待 mihomo API 就绪...`)
    const ready = await waitForReady(API_PORT, 15000)
    if (!ready) {
      $.error(`[geo] mihomo API 端口 ${API_PORT} 未就绪，放弃查询`)
      return proxies
    }
    $.info(`[geo] mihomo 就绪，开始逐一查询...`)

    // ─── 逐一查询，完全串行 ───────────────────────────────────────────────────

    const geoMap = {}   // nodeName -> geo 对象 | null
    let pass = 0, fail = 0

    for (let i = 0; i < converted.length; i++) {
      const { proxy, node } = converted[i]
      $.info(`[geo] [${i + 1}/${converted.length}] 查询: ${proxy.name}`)

      // 1. 切换代理组到该节点
      try {
        await switchProxy('GEO_PROXY', node.name)
      } catch (e) {
        $.info(`[geo] [${proxy.name}] 切换失败: ${e.message}，跳过`)
        geoMap[node.name] = null
        fail++
        continue
      }

      // 2. 请求地理 API
      const geo = await queryGeo()

      if (geo) {
        $.info(`[geo] [${proxy.name}] ✓ ${geo.country || '?'} / ${geo.isp || geo.org || '?'}`)
        geoMap[node.name] = geo
        pass++
      } else {
        $.info(`[geo] [${proxy.name}] ✗ 返回无效，继续下一个`)
        geoMap[node.name] = null
        fail++
      }
    }

    $.info(`[geo] 查询完成 — 成功: ${pass}，失败: ${fail}`)

    // ─── 统计各组数量，用于序号 ───────────────────────────────────────────────

    const groupCount  = {}
    const groupCursor = {}

    converted.forEach(({ node }) => {
      const geo = geoMap[node.name]
      if (!geo) return
      const key = geoKey(geo)
      groupCount[key] = (groupCount[key] || 0) + 1
    })

    // ─── 重命名 ───────────────────────────────────────────────────────────────

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

  } finally {
    killProc(proc)
    try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }

  proxies = proxies.filter(p => !p._remove)
  proxies.forEach(p => { delete p._remove })
  $.info(`[geo] 输出节点数: ${proxies.length}`)
  return proxies

  // ─── 切换代理组 ───────────────────────────────────────────────────────────────

  function switchProxy(group, nodeName) {
    return new Promise((resolve, reject) => {
      const body  = JSON.stringify({ name: nodeName })
      const timer = setTimeout(() => { req.destroy(); reject(new Error('切换超时')) }, 3000)
      const req   = http.request(
        {
          host: '127.0.0.1', port: API_PORT,
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

  function queryGeo() {
    const geoUrlObj = new URL(GEO_URL)
    return new Promise(resolve => {
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, GEO_TIMEOUT)
      const req   = http.request(
        {
          host: '127.0.0.1', port: PROXY_PORT,
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
    proc.on('error', e => $.error(`[geo] spawn 失败: ${e.message}`))
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

  // 等待端口完全释放（连不上才算释放）
  function waitForRelease(port, maxMs = 10000, interval = 300) {
    return new Promise(resolve => {
      const deadline = Date.now() + maxMs
      function attempt() {
        const sock = new net.Socket()
        sock.setTimeout(interval)
        sock.connect(port, '127.0.0.1', () => {
          // 还能连上，说明旧进程未退出，继续等
          sock.destroy()
          if (Date.now() < deadline) setTimeout(attempt, interval)
          else resolve(false)
        })
        sock.on('error', () => {
          // 连不上，端口已释放
          sock.destroy()
          resolve(true)
        })
        sock.on('timeout', () => {
          sock.destroy()
          resolve(true)
        })
      }
      attempt()
    })
  }

  // 等待 mihomo API 真正就绪：反复请求 GET /version 直到返回有效 JSON
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
                // mihomo 返回 { version: "..." }
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

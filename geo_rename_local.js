/**
 * 节点落地地理位置重命名脚本（本地数据库版）
 *
 * 通过 mihomo 内核将请求从节点自身发出，同时完成:
 *   1. 延迟测试 — 单进程 + mihomo API 并发，不通的节点直接舍弃
 *   2. 获取真实出口 IP — 通过 checkip.amazonaws.com
 *   3. 本地 mmdb 查询 — 无网络请求，无限速，毫秒级
 * 最终按"国家 序号 ISP"格式重命名。
 * 例如: 美国 01 Cloudflare, 日本 02 NTT Communications
 *
 * 前置条件:
 *   1. mihomo 内核放在 Sub-Store 同目录（Windows: mihomo.exe，Linux/macOS: mihomo）
 *      下载: https://github.com/MetaCubeX/mihomo/releases
 *
 *   2. MaxMind GeoLite2 数据库放在 Sub-Store 同目录下的 mmdb/ 文件夹:
 *      mmdb/GeoLite2-Country.mmdb
 *      mmdb/GeoLite2-ASN.mmdb
 *      下载: https://dev.maxmind.com/geoip/geolite2-free-geolocation-data（需免费注册）
 *
 * 参数说明:
 * - [mihomo_path]   mihomo 二进制绝对路径（可选，自动搜索默认位置）
 * - [mmdb_dir]      mmdb 目录绝对路径（可选，默认 <Sub-Store目录>/mmdb）
 * - [api_port]      External Controller 端口，默认: 9090
 * - [test_url]      延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]  延迟测试超时(毫秒)，默认: 5000
 * - [concurrency]      地理查询并发数，默认: 5
 * - [delay_concurrency] 延迟测试并发数，默认: 10
 * - [ip_timeout]    IP 查询超时(毫秒)，默认: 10000
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
  const http             = require('http')

  const TEST_URL      = $arguments.test_url     || 'http://www.gstatic.com/generate_204'
  const TEST_TIMEOUT  = parseInt($arguments.test_timeout  || 5000)
  const IP_TIMEOUT    = parseInt($arguments.ip_timeout    || 10000)
  const CONCURRENCY         = parseInt($arguments.concurrency        || 5)
  const DELAY_CONCURRENCY   = parseInt($arguments.delay_concurrency   || 10)
  const START_PORT    = parseInt($arguments.start_port    || 14000)
  const API_PORT      = parseInt($arguments.api_port      || 9090)
  const CACHE_ENABLED = $arguments.cache !== false && $arguments.cache !== 'false'

  const IS_WINDOWS = os.platform() === 'win32'
  const BIN_NAME   = IS_WINDOWS ? 'mihomo.exe' : 'mihomo'
  const CWD        = process.cwd()

  // ─── 定位 mihomo ────────────────────────────────────────────────────────────

  const MIHOMO_SEARCH = IS_WINDOWS
    ? [path.join(CWD, BIN_NAME), path.join(os.homedir(), BIN_NAME), `C:\\mihomo\\${BIN_NAME}`]
    : [path.join(CWD, BIN_NAME), path.join(os.homedir(), BIN_NAME), '/usr/local/bin/mihomo']

  let MIHOMO_PATH = $arguments.mihomo_path || ''
  if (!MIHOMO_PATH) {
    for (const p of MIHOMO_SEARCH) {
      try { await fs.access(p); MIHOMO_PATH = p; break } catch (_) {}
    }
  }
  if (!MIHOMO_PATH) throw new Error(`[geo] 未找到 mihomo，请放置于 ${MIHOMO_SEARCH[0]}`)
  if (!IS_WINDOWS) { try { await fs.chmod(MIHOMO_PATH, 0o755) } catch (_) {} }

  // ─── 定位并加载 mmdb 数据库 ─────────────────────────────────────────────────

  const MMDB_DIR      = $arguments.mmdb_dir || path.join(CWD, 'mmdb')
  const COUNTRY_PATH  = path.join(MMDB_DIR, 'GeoLite2-Country.mmdb')
  const ASN_PATH      = path.join(MMDB_DIR, 'GeoLite2-ASN.mmdb')

  $.info(`[geo] 加载数据库: ${MMDB_DIR}`)
  let countryDb, asnDb
  try {
    const [cBuf, aBuf] = await Promise.all([fs.readFile(COUNTRY_PATH), fs.readFile(ASN_PATH)])
    countryDb = createMmdbReader(cBuf)
    asnDb     = createMmdbReader(aBuf)
    $.info(`[geo] 数据库加载完成`)
  } catch (e) {
    throw new Error(`[geo] 数据库加载失败: ${e.message}\n请确认以下文件存在:\n  ${COUNTRY_PATH}\n  ${ASN_PATH}`)
  }

  $.info(`[geo] mihomo: ${MIHOMO_PATH}`)
  $.info(`[geo] 共 ${proxies.length} 个节点，并发数: ${CONCURRENCY}`)

  // ─── 转换节点格式 ────────────────────────────────────────────────────────────

  const converted = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        node.name = `proxy_${index}`
        converted.push({ index, proxy, node })
      } else {
        $.error(`[geo] [${proxy.name}] 无法转换为 mihomo 格式，跳过`)
      }
    } catch (e) {
      $.error(`[geo] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[geo] 可检测节点: ${converted.length}/${proxies.length}`)
  proxies.forEach(p => { p._remove = true })

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段一：单进程并发测延迟（与在线版相同）
  // ══════════════════════════════════════════════════════════════════════════════

  const aliveItems = await phaseLatency(converted)

  const removedCount = converted.length - aliveItems.length
  if (removedCount > 0) $.info(`[geo] 舍弃不通节点: ${removedCount} 个`)
  $.info(`[geo] 存活节点: ${aliveItems.length} 个，进入地理查询阶段`)

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段二：对存活节点并发查地理（独立 mihomo 实例 + 本地 mmdb）
  // ══════════════════════════════════════════════════════════════════════════════

  await runConcurrent(
    aliveItems.map((item, i) => () => phaseGeo(item, START_PORT + i % 900)),
    CONCURRENCY
  )

  // ─── 过滤 + 按国家编号重命名 ───────────────────────────────────────────────────

  const before = proxies.length
  proxies = proxies.filter(p => !p._remove)
  const removed = before - proxies.length
  if (removed > 0) $.info(`[geo] 舍弃不通节点（最终）: ${removed} 个`)

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

  $.info(`[geo] 完成，剩余节点: ${proxies.length}`)
  return proxies

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段一实现：单进程 + mihomo API 并发测延迟
  // ══════════════════════════════════════════════════════════════════════════════

  async function phaseLatency(items) {
    if (items.length === 0) return []

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-lat-'))
    const configPath = path.join(tmpDir, 'config.yaml')

    // 所有节点写入同一配置，开启 External Controller
    const proxyLines = items.map(i => '  - ' + nodeToYaml(i.node)).join('\n')
    const proxyNames = items.map(i => `      - "${i.node.name}"`).join('\n')
    const config = [
      `mixed-port: ${START_PORT}`,
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
    ].join('\n')
    await fs.writeFile(configPath, config, 'utf8')

    let proc = null
    try {
      proc = spawnMihomo(tmpDir, configPath)

      const ready = await waitForPort(API_PORT, 12000)
      if (!ready) {
        $.error(`[geo] [阶段一] mihomo API 端口 ${API_PORT} 未就绪，跳过延迟测试`)
        return []
      }
      $.info(`[geo] [阶段一] mihomo 就绪，并发测延迟（${items.length} 个节点，每批 ${DELAY_CONCURRENCY} 个）...`)

      // 分批并发调用 /proxies/{name}/delay，避免同时打开过多连接
      const results = new Array(items.length).fill(null)
      await runConcurrent(
        items.map((item, i) => async () => {
          results[i] = await queryDelay(item.node.name).catch(e => Promise.reject(e))
        }),
        DELAY_CONCURRENCY
      )

      const alive = []
      results.forEach((r, i) => {
        const item = items[i]
        if (typeof r === 'number' && r > 0) {
          $.info(`[geo] [${item.proxy.name}] ✓ 延迟: ${r}ms`)
          item.proxy._remove = false
          alive.push(item)
        } else {
          $.info(`[geo] [${item.proxy.name}] ✗ 超时或节点不通，已舍弃`)
        }
      })
      $.info(`[geo] [阶段一] 完成，存活 ${alive.length}/${items.length}`)
      return alive

    } finally {
      killProc(proc)
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  // ─── 调用 mihomo API 测单节点延迟 ─────────────────────────────────────────────

  function queryDelay(nodeName) {
    const encodedName = encodeURIComponent(nodeName)
    const encodedUrl  = encodeURIComponent(TEST_URL)
    const apiPath     = `/proxies/${encodedName}/delay?url=${encodedUrl}&timeout=${TEST_TIMEOUT}`

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

  // ══════════════════════════════════════════════════════════════════════════════
  // 阶段二实现：独立 mihomo 进程 + checkip 获取出口 IP + 本地 mmdb 查询
  // （与原版逻辑完全相同，仅拆分自独立函数）
  // ══════════════════════════════════════════════════════════════════════════════

  async function phaseGeo({ proxy, node }, port) {
    const cacheKey = `geo-local:${node.server}:${node.port}:${node.type}`
    if (CACHE_ENABLED) {
      try {
        const c = cache.get(cacheKey)
        if (c) {
          proxy._geo = c
          $.info(`[geo] [${proxy.name}] 缓存: ${c.country} / ${c.isp}`)
          return
        }
      } catch (_) {}
    }

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-'))
    const configPath = path.join(tmpDir, 'config.yaml')
    await fs.writeFile(configPath, buildSingleConfig(node, port), 'utf8')

    let proc = null
    try {
      const stderrLines = []
      proc = spawn(MIHOMO_PATH, ['-d', tmpDir, '-f', configPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
        shell: false,
      })
      proc.stderr.on('data', d => { const l = d.toString().trim(); if (l) stderrLines.push(l) })
      proc.on('error', e => $.error(`[geo] [${proxy.name}] spawn 错误: ${e.message}`))

      const ready = await waitForPort(port, 8000)
      if (!ready) {
        $.error(`[geo] [${proxy.name}] mihomo 未能启动 (port ${port}): ${stderrLines.slice(-2).join(' | ')}`)
        return
      }

      // 通过节点获取真实出口 IP
      const ip = await fetchIP(port)
      if (!ip) {
        proxy._geo = { country: '未知', isp: '' }
        $.error(`[geo] [${proxy.name}] IP 获取失败，标记为未知`)
        return
      }

      // 本地 mmdb 查询，毫秒级，无网络请求
      const geo = queryGeo(ip)
      proxy._geo = geo
      $.info(`[geo] [${proxy.name}] ${ip} → ${geo.country} / ${geo.isp}`)

      if (CACHE_ENABLED) {
        try { cache.set(cacheKey, geo) } catch (_) {}
      }
    } catch (e) {
      $.error(`[geo] [${proxy.name}] 检测异常: ${e.message || e}`)
    } finally {
      killProc(proc)
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch (_) {}
    }
  }

  // ─── 通过代理获取出口 IP ──────────────────────────────────────────────────────

  function fetchIP(port) {
    const url = 'http://checkip.amazonaws.com/'
    return new Promise(resolve => {
      const timer = setTimeout(() => { req.destroy(); resolve(null) }, IP_TIMEOUT)
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: url,
        headers: { Host: 'checkip.amazonaws.com', 'User-Agent': 'curl/7.88.0', 'Proxy-Connection': 'keep-alive' },
      }, res => {
        let raw = ''
        res.on('data', d => (raw += d))
        res.on('end', () => {
          clearTimeout(timer)
          const ip = raw.trim()
          resolve(/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : null)
        })
      })
      req.on('error', () => { clearTimeout(timer); resolve(null) })
      req.end()
    })
  }

  // ─── 本地 mmdb 查询 ───────────────────────────────────────────────────────────

  function queryGeo(ip) {
    let country = '未知'
    let isp = ''
    try {
      const cr = countryDb.lookup(ip)
      if (cr && cr.country) {
        country = cr.country.names?.['zh-CN'] || cr.country.names?.en || '未知'
      }
    } catch (_) {}
    try {
      const ar = asnDb.lookup(ip)
      if (ar) {
        isp = ar.autonomous_system_organization || ''
      }
    } catch (_) {}
    return { country, isp }
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
      const lines = d.toString().trim().split('\n')
      for (const line of lines) {
        if (line && (line.includes('level=error') || line.includes('level=fatal'))) {
          $.error(`[mihomo] ${line}`)
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

  // ─── 等待端口可连接 ───────────────────────────────────────────────────────────

  function waitForPort(port, maxMs = 8000, interval = 200) {
    return new Promise(resolve => {
      const deadline = Date.now() + maxMs
      function attempt() {
        const sock = new net.Socket()
        sock.setTimeout(interval)
        sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true) })
        sock.on('error', () => { sock.destroy(); Date.now() < deadline ? setTimeout(attempt, interval) : resolve(false) })
        sock.on('timeout', () => { sock.destroy(); Date.now() < deadline ? setTimeout(attempt, interval) : resolve(false) })
      }
      attempt()
    })
  }

  // ─── 构建单节点 mihomo 配置（阶段二） ────────────────────────────────────────

  function buildSingleConfig(node, port) {
    return [
      `mixed-port: ${port}`, 'allow-lan: false', 'log-level: warning', 'ipv6: false', '',
      'proxies:', '  - ' + nodeToYaml(node), '',
      'proxy-groups:', '  - name: PROXY', '    type: select', '    proxies:', `      - "${node.name}"`, '',
      'rules:', '  - MATCH,PROXY',
    ].join('\n')
  }

  function nodeToYaml(node) {
    const parts = []
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        parts.push(`${k}: [${v.map(i => typeof i === 'object' ? JSON.stringify(i) : i).join(', ')}]`)
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
          task().catch(() => {}).finally(() => { running--; done++; done === total ? resolve() : next() })
        }
      }
      next()
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 纯 JS mmdb 解析器（支持 MaxMind GeoLite2，无需任何外部依赖）
  // ═══════════════════════════════════════════════════════════════════════════════

  function createMmdbReader(buf) {
    const MARKER = [0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d]
    let markerPos = -1
    outer: for (let i = buf.length - MARKER.length; i >= 0; i--) {
      for (let j = 0; j < MARKER.length; j++) {
        if (buf[i + j] !== MARKER[j]) continue outer
      }
      markerPos = i
      break
    }
    if (markerPos < 0) throw new Error('无效的 mmdb 文件：找不到元数据标记')

    const [meta] = decodeValue(buf, markerPos + MARKER.length, 0)

    const nodeCount        = meta.node_count
    const recordSize       = meta.record_size
    const ipVersion        = meta.ip_version
    const nodeByteSize     = recordSize * 2 / 8
    const searchTreeSize   = nodeCount * nodeByteSize
    const dataSectionStart = searchTreeSize + 16

    function getNodeChild(nodeNum, bit) {
      const off = nodeNum * nodeByteSize
      if (recordSize === 24) {
        return bit === 0
          ? ((buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]) >>> 0
          : ((buf[off + 3] << 16) | (buf[off + 4] << 8) | buf[off + 5]) >>> 0
      }
      if (recordSize === 28) {
        return bit === 0
          ? (((buf[off + 3] & 0xf0) << 20) | (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]) >>> 0
          : (((buf[off + 3] & 0x0f) << 24) | (buf[off + 4] << 16) | (buf[off + 5] << 8) | buf[off + 6]) >>> 0
      }
      if (recordSize === 32) {
        return bit === 0 ? buf.readUInt32BE(off) : buf.readUInt32BE(off + 4)
      }
      throw new Error(`不支持的 record_size: ${recordSize}`)
    }

    function lookup(ip) {
      const parts = ip.split('.').map(Number)
      if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null

      let node = ipVersion === 6 ? 96 : 0

      for (const octet of parts) {
        for (let bit = 7; bit >= 0; bit--) {
          node = getNodeChild(node, (octet >> bit) & 1)
          if (node >= nodeCount) {
            if (node === nodeCount) return null
            const dataOffset = dataSectionStart + (node - nodeCount - 16)
            const [record] = decodeValue(buf, dataOffset, dataSectionStart)
            return record
          }
        }
      }
      return null
    }

    return { lookup }

    function decodeValue(buf, offset, dataStart) {
      const ctrl = buf[offset++]
      let type = (ctrl >> 5) & 0x7
      let size = ctrl & 0x1f

      if (type === 0) { type = buf[offset++] + 7 }

      if (type === 1) {
        const psize = (size >> 3) & 0x3
        const v     = size & 0x7
        let ptr
        if (psize === 0) {
          ptr = (v << 8) | buf[offset]; offset += 1
        } else if (psize === 1) {
          ptr = (v << 16) | (buf[offset] << 8) | buf[offset + 1]; ptr += 2048; offset += 2
        } else if (psize === 2) {
          ptr = (v << 24) | (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2]; ptr += 526336; offset += 3
        } else {
          ptr = buf.readUInt32BE(offset); offset += 4
        }
        const [val] = decodeValue(buf, dataStart + ptr, dataStart)
        return [val, offset]
      }

      if (size === 29) {
        size = buf[offset++] + 29
      } else if (size === 30) {
        size = ((buf[offset] << 8) | buf[offset + 1]) + 285; offset += 2
      } else if (size === 31) {
        size = ((buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2]) + 65821; offset += 3
      }

      switch (type) {
        case 2: {
          const s = buf.slice(offset, offset + size).toString('utf8')
          return [s, offset + size]
        }
        case 3: return [buf.readDoubleBE(offset), offset + size]
        case 4: return [buf.slice(offset, offset + size), offset + size]
        case 5: {
          let v = 0
          for (let i = 0; i < size; i++) v = (v << 8) | buf[offset + i]
          return [v >>> 0, offset + size]
        }
        case 6: {
          let v = 0
          for (let i = 0; i < size; i++) v = (v * 256 + buf[offset + i]) >>> 0
          return [v, offset + size]
        }
        case 7: {
          const map = {}
          let pos = offset
          for (let i = 0; i < size; i++) {
            const [k, p1] = decodeValue(buf, pos, dataStart)
            const [v, p2] = decodeValue(buf, p1, dataStart)
            map[k] = v
            pos = p2
          }
          return [map, pos]
        }
        case 8: {
          let v = 0
          for (let i = 0; i < size; i++) v = (v << 8) | buf[offset + i]
          if (size > 0 && (buf[offset] & 0x80)) v = v - (1 << (size * 8))
          return [v, offset + size]
        }
        case 9: {
          let v = 0
          for (let i = 0; i < Math.min(size, 6); i++) v = v * 256 + buf[offset + i]
          return [v, offset + size]
        }
        case 11: {
          const arr = []
          let pos = offset
          for (let i = 0; i < size; i++) {
            const [v, p] = decodeValue(buf, pos, dataStart)
            arr.push(v); pos = p
          }
          return [arr, pos]
        }
        case 14: return [size !== 0, offset]
        case 15: return [buf.readFloatBE(offset), offset + size]
        default: return [null, offset + size]
      }
    }
  }
}

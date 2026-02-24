/**
 * 节点落地地理位置重命名脚本（本地数据库版）
 *
 * 通过 mihomo 内核将请求从节点自身发出，同时完成:
 *   1. 延迟测试 — 不通的节点直接舍弃
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
 * - [test_url]      延迟测试 URL，默认: http://www.gstatic.com/generate_204
 * - [test_timeout]  延迟测试超时(毫秒)，默认: 5000
 * - [concurrency]   并发节点数，默认: 5
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

  const TEST_URL      = $arguments.test_url || 'http://www.gstatic.com/generate_204'
  const TEST_TIMEOUT  = parseInt($arguments.test_timeout || 5000)
  const IP_TIMEOUT    = parseInt($arguments.ip_timeout || 10000)
  const CONCURRENCY   = parseInt($arguments.concurrency || 5)
  const START_PORT    = parseInt($arguments.start_port || 14000)
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
        converted.push({ index, proxy, node })
      } else {
        $.error(`[geo] [${proxy.name}] 无法转换为 mihomo 格式，跳过`)
      }
    } catch (e) {
      $.error(`[geo] [${proxy.name}] 转换出错: ${e.message}`)
    }
  })

  $.info(`[geo] 可检测节点: ${converted.length}/${proxies.length}`)

  // 所有节点默认标记为待舍弃
  proxies.forEach(p => { p._remove = true })

  await runConcurrent(
    converted.map((item, i) => () => detectProxy(item, START_PORT + i % 900)),
    CONCURRENCY
  )

  // 过滤不通节点
  const before = proxies.length
  proxies = proxies.filter(p => !p._remove)
  const removed = before - proxies.length
  if (removed > 0) $.info(`[geo] 舍弃不通节点: ${removed} 个`)

  // 按国家分组编号，生成最终名称
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

  // ─── 检测单个节点 ─────────────────────────────────────────────────────────────

  async function detectProxy({ index, proxy, node }, port) {
    // 缓存 key：同一服务器配置共用缓存（地理信息不变，但延迟每次都实时检测）
    const cacheKey = `geo-local:${node.server}:${node.port}:${node.type}`
    let cachedGeo = null
    if (CACHE_ENABLED) {
      try { const c = cache.get(cacheKey); if (c) cachedGeo = c } catch (_) {}
    }

    const tmpDir     = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-'))
    const configPath = path.join(tmpDir, 'config.yaml')
    // 节点名用简单 ASCII，避免特殊字符破坏 YAML
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
      proc.stderr.on('data', d => { const l = d.toString().trim(); if (l) stderrLines.push(l) })
      proc.on('error', e => $.error(`[geo] [${proxy.name}] spawn 错误: ${e.message}`))

      // 等待 mihomo 端口就绪
      const ready = await waitForPort(port, 8000)
      if (!ready) {
        $.error(`[geo] [${proxy.name}] mihomo 未能启动 (port ${port}): ${stderrLines.slice(-2).join(' | ')}`)
        return
      }

      // ── 步骤一：延迟测试 ─────────────────────────────────────────────────────
      const latency = await testLatency(TEST_URL, port, TEST_TIMEOUT)
      if (latency === null) {
        $.info(`[geo] [${proxy.name}] ✗ 延迟测试不通，已舍弃`)
        return
      }
      $.info(`[geo] [${proxy.name}] ✓ 延迟: ${latency}ms`)

      // 延迟测试通过，取消舍弃标记
      proxy._remove = false

      // ── 步骤二：地理位置（优先命中缓存） ────────────────────────────────────
      if (cachedGeo) {
        proxy._geo = cachedGeo
        $.info(`[geo] [${proxy.name}] 缓存: ${cachedGeo.country} / ${cachedGeo.isp}`)
        return
      }

      // 通过节点获取真实出口 IP
      const ip = await fetchIP(port)
      if (!ip) {
        proxy._geo = { country: '未知', isp: '' }
        $.error(`[geo] [${proxy.name}] IP 获取失败，标记为未知`)
        return
      }

      // 本地 mmdb 查询
      const geo = queryGeo(ip)
      proxy._geo = geo
      $.info(`[geo] [${proxy.name}] ${ip} → ${geo.country} / ${geo.isp}`)

      if (CACHE_ENABLED) {
        try { cache.set(cacheKey, geo) } catch (_) {}
      }
    } catch (e) {
      $.error(`[geo] [${proxy.name}] 检测异常: ${e.message || e}`)
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

  // ─── 通过代理获取出口 IP ──────────────────────────────────────────────────────
  // checkip.amazonaws.com 返回纯文本 IP，HTTP/HTTPS 都支持

  function fetchIP(port) {
    const url = 'http://checkip.amazonaws.com/'
    const http = require('http')
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
          // 校验是否为合法 IPv4
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

  // ─── 延迟测试 ─────────────────────────────────────────────────────────────────
  // 只有返回 2xx 才算通，mihomo 返回 502 表示节点不通

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
        headers: { Host: new (require('url').URL)(url).host, 'User-Agent': 'curl/7.88.0', 'Proxy-Connection': 'keep-alive' },
      }, res => {
        clearTimeout(timer)
        res.resume()
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

  // ─── 端口轮询 ─────────────────────────────────────────────────────────────────

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

  // ─── 构建 mihomo 配置 ─────────────────────────────────────────────────────────

  function buildConfig(node, port) {
    return [
      `mixed-port: ${port}`, 'allow-lan: false', 'log-level: info', 'ipv6: false', '',
      'proxies:', '  - ' + nodeToYaml(node), '',
      'proxy-groups:', '  - name: PROXY', '    type: select', '    proxies:', `      - ${node.name}`, '',
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
    // 找到元数据分隔符 \xab\xcd\xef + "MaxMind.com"
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

    // 解析元数据（元数据本身也是 mmdb 数据格式编码的）
    const [meta] = decodeValue(buf, markerPos + MARKER.length, 0)

    const nodeCount      = meta.node_count
    const recordSize     = meta.record_size
    const ipVersion      = meta.ip_version
    const nodeByteSize   = recordSize * 2 / 8
    const searchTreeSize = nodeCount * nodeByteSize
    const dataSectionStart = searchTreeSize + 16  // 16 字节零值分隔符

    // 读取搜索树中某节点的左（bit=0）或右（bit=1）子节点编号
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
        return bit === 0
          ? buf.readUInt32BE(off)
          : buf.readUInt32BE(off + 4)
      }
      throw new Error(`不支持的 record_size: ${recordSize}`)
    }

    // IPv4 地址查询：返回数据记录对象，找不到返回 null
    function lookup(ip) {
      const parts = ip.split('.').map(Number)
      if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null

      // IPv6 数据库中 IPv4 映射节点从第 96 个节点开始遍历
      let node = ipVersion === 6 ? 96 : 0

      for (const octet of parts) {
        for (let bit = 7; bit >= 0; bit--) {
          node = getNodeChild(node, (octet >> bit) & 1)
          if (node >= nodeCount) {
            if (node === nodeCount) return null  // 空记录
            const dataOffset = dataSectionStart + (node - nodeCount - 16)
            const [record] = decodeValue(buf, dataOffset, dataSectionStart)
            return record
          }
        }
      }
      return null
    }

    return { lookup }

    // ── mmdb 数据段解码 ─────────────────────────────────────────────────────────
    // 返回 [value, nextOffset]

    function decodeValue(buf, offset, dataStart) {
      const ctrl = buf[offset++]
      let type = (ctrl >> 5) & 0x7
      let size = ctrl & 0x1f

      // type=0 表示扩展类型，下一字节 + 7 为真实类型
      if (type === 0) { type = buf[offset++] + 7 }

      // 指针类型单独处理（size 字段含义不同）
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

      // 普通类型的 size 扩展解码
      if (size === 29) {
        size = buf[offset++] + 29
      } else if (size === 30) {
        size = ((buf[offset] << 8) | buf[offset + 1]) + 285; offset += 2
      } else if (size === 31) {
        size = ((buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2]) + 65821; offset += 3
      }

      switch (type) {
        case 2: {  // UTF-8 字符串
          const s = buf.slice(offset, offset + size).toString('utf8')
          return [s, offset + size]
        }
        case 3: {  // double (8 字节)
          return [buf.readDoubleBE(offset), offset + size]
        }
        case 4: {  // bytes
          return [buf.slice(offset, offset + size), offset + size]
        }
        case 5: {  // uint16
          let v = 0
          for (let i = 0; i < size; i++) v = (v << 8) | buf[offset + i]
          return [v >>> 0, offset + size]
        }
        case 6: {  // uint32
          let v = 0
          for (let i = 0; i < size; i++) v = (v * 256 + buf[offset + i]) >>> 0
          return [v, offset + size]
        }
        case 7: {  // map（键值对）
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
        case 8: {  // int32
          let v = 0
          for (let i = 0; i < size; i++) v = (v << 8) | buf[offset + i]
          if (size > 0 && (buf[offset] & 0x80)) v = v - (1 << (size * 8))
          return [v, offset + size]
        }
        case 9: {  // uint64（JS 精度有限，取低 6 字节足够）
          let v = 0
          for (let i = 0; i < Math.min(size, 6); i++) v = v * 256 + buf[offset + i]
          return [v, offset + size]
        }
        case 11: {  // array
          const arr = []
          let pos = offset
          for (let i = 0; i < size; i++) {
            const [v, p] = decodeValue(buf, pos, dataStart)
            arr.push(v); pos = p
          }
          return [arr, pos]
        }
        case 14: {  // boolean
          return [size !== 0, offset]
        }
        case 15: {  // float (4 字节)
          return [buf.readFloatBE(offset), offset + size]
        }
        default:
          return [null, offset + size]
      }
    }
  }
}

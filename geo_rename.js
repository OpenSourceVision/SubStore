/**
 * 节点地理位置重命名脚本
 *
 * 通过节点的服务器 IP 查询地理位置信息，按格式"国家 序号 ISP"重命名节点
 * 例如: 美国 01 Cloudflare, 日本 02 NTT
 *
 * 参数说明:
 * - [api]              查询 API，默认: http://ip-api.com/json/{ip}?fields=country,isp,org,as&lang=zh-CN
 * - [concurrency]      并发请求数，默认: 5
 * - [timeout]          单次请求超时(毫秒)，默认: 5000
 * - [retries]          失败重试次数，默认: 2
 * - [cache]            启用缓存，默认: true
 * - [remove_failed]    移除查询失败的节点，默认: false
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cache = scriptResourceCache

  const API_TEMPLATE = $arguments.api || 'http://ip-api.com/json/{ip}?fields=country,isp,org,query&lang=zh-CN'
  const CONCURRENCY = parseInt($arguments.concurrency || 5)
  const TIMEOUT = parseInt($arguments.timeout || 5000)
  const RETRIES = parseInt($arguments.retries || 2)
  const CACHE_ENABLED = $arguments.cache !== false && $arguments.cache !== 'false'
  const REMOVE_FAILED = $arguments.remove_failed === true || $arguments.remove_failed === 'true'

  $.info(`[geo-rename] 共 ${proxies.length} 个节点，开始查询地理位置...`)

  // 并发查询所有节点
  await runConcurrent(proxies.map(proxy => () => fetchGeo(proxy)), CONCURRENCY)

  // 按国家分组，依次编号，生成最终名称
  const countryIndex = {}
  for (const proxy of proxies) {
    if (!proxy._geo) continue
    const country = proxy._geo.country || '未知'
    if (!countryIndex[country]) countryIndex[country] = 1
    const num = String(countryIndex[country]++).padStart(2, '0')
    const isp = proxy._geo.isp || proxy._geo.org || ''
    proxy.name = isp ? `${country} ${num} ${isp}` : `${country} ${num}`
    delete proxy._geo
  }

  if (REMOVE_FAILED) {
    const before = proxies.length
    proxies = proxies.filter(p => p._geoOk)
    $.info(`[geo-rename] 移除失败节点 ${before - proxies.length} 个`)
  }

  // 清理临时标记
  proxies.forEach(p => delete p._geoOk)

  $.info(`[geo-rename] 重命名完成`)
  return proxies

  // ─── 查询单个节点 ────────────────────────────────────────────────────────────

  async function fetchGeo(proxy) {
    const server = proxy.server
    if (!server) return

    const cacheKey = `geo-rename:${server}`
    if (CACHE_ENABLED) {
      try {
        const cached = cache.get(cacheKey)
        if (cached) {
          proxy._geo = cached
          proxy._geoOk = true
          $.info(`[geo-rename] [${proxy.name}] 命中缓存: ${cached.country} / ${cached.isp || ''}`)
          return
        }
      } catch (_) {}
    }

    const url = API_TEMPLATE.replace('{ip}', server)

    let data = null
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const resp = await $.http.get({ url, timeout: TIMEOUT })
        const body = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body
        if (body && body.country) {
          data = body
          break
        }
      } catch (e) {
        if (attempt === RETRIES) {
          $.error(`[geo-rename] [${proxy.name}] 查询失败: ${e.message || e}`)
        }
      }
    }

    if (data) {
      proxy._geo = { country: data.country, isp: data.isp || data.org || '' }
      proxy._geoOk = true
      $.info(`[geo-rename] [${proxy.name}] ${data.country} / ${data.isp || ''}`)
      if (CACHE_ENABLED) {
        try { cache.set(cacheKey, proxy._geo) } catch (_) {}
      }
    } else {
      $.error(`[geo-rename] [${proxy.name}] 查询无结果，保留原名`)
    }
  }

  // ─── 并发控制 ─────────────────────────────────────────────────────────────────

  function runConcurrent(tasks, concurrency) {
    return new Promise((resolve, reject) => {
      let index = 0
      let running = 0
      let done = 0
      const total = tasks.length
      if (total === 0) return resolve()

      function next() {
        while (running < concurrency && index < total) {
          const task = tasks[index++]
          running++
          task()
            .catch(() => {})
            .finally(() => {
              running--
              done++
              if (done === total) resolve()
              else next()
            })
        }
      }
      next()
    })
  }
}

/**
 * 节点地理位置检测脚本 (HTTP META 版) - 固定命名：国家 [序号] ISP
 * 
 * 示例：
 *   美国 01 Cloudflare
 *   美国 02 Cloudflare
 *   日本 01 SoftBank
 *   香港 01 香港宽频
 *   台湾 01 中华电信
 *   德国 01 Hetzner
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cacheEnabled = !!$arguments.cache
  const cache = scriptResourceCache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const remove_failed = !!$arguments.remove_failed
  const remove_incompatible = !!$arguments.remove_incompatible
  const incompatibleEnabled = $arguments.incompatible !== false  // 默认保留 _incompatible
  const geoEnabled = $arguments.geo !== false                   // 默认保留 _geo

  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_authorization = $arguments.http_meta_authorization ?? ''
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)

  const method = $arguments.method || 'get'
  const apiUrl = $arguments.api || 'http://ip-api.com/json?lang=zh-CN'

  // ─── 转换为 ClashMeta 内部格式 ───
  const internalProxies = []
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        // 保留原有 _ 开头的字段
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({ ...node, _proxies_index: index })
      } else {
        proxies[index]._incompatible = true
      }
    } catch (e) {
      $.error(`[${proxy.name}] 转换为 ClashMeta 格式失败: ${e}`)
      proxies[index]._incompatible = true
    }
  })

  $.info(`支持 HTTP META 检测的节点数: ${internalProxies.length} / ${proxies.length}`)
  if (internalProxies.length === 0) return proxies

  // ─── 检查缓存 ───
  if (cacheEnabled) {
    let allCached = true
    for (const proxy of internalProxies) {
      const id = getCacheId({ proxy, url: apiUrl })
      const cached = cache.get(id)
      if (cached?.api?.country) {
        const originalProxy = proxies[proxy._proxies_index]
        originalProxy._geo = cached.api
        // 暂不在这里重命名，等统一处理
      } else {
        allCached = false
        if (!disableFailedCache && cached === {}) {
          $.info(`[${proxy.name}] 使用失败缓存，跳过检测`)
        }
      }
    }
    if (allCached) {
      $.info('所有节点均命中有效缓存，直接完成')
      // 仍需执行统一重命名
    }
  }

  // ─── 启动 HTTP META ───
  let http_meta_pid, http_meta_ports
  try {
    const timeoutTotal = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout
    const res = await http({
      retries: 0,
      method: 'post',
      url: `${http_meta_api}/start`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({
        proxies: internalProxies,
        timeout: timeoutTotal,
      }),
    })

    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    http_meta_pid = body.pid
    http_meta_ports = body.ports

    if (!http_meta_pid || !Array.isArray(http_meta_ports)) {
      throw new Error('HTTP META 启动失败：未返回有效 pid/ports')
    }

    $.info(`HTTP META 启动成功 | 端口: ${http_meta_ports.join(', ')} | PID: ${http_meta_pid} | 预计超时约 ${Math.round(timeoutTotal/60000)} 分钟`)
  } catch (e) {
    $.error(`启动 HTTP META 失败: ${e.message || e}`)
    return proxies
  }

  await $.wait(http_meta_start_delay)
  $.info(`等待 ${http_meta_start_delay/1000}s 后开始并发检测...`)

  // ─── 并发检测 ───
  const concurrency = parseInt($arguments.concurrency || 10)
  await executeAsyncTasks(
    internalProxies.map(p => () => check(p)),
    { concurrency }
  )

  // ─── 关闭 HTTP META ───
  try {
    await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({ pid: [http_meta_pid] }),
    })
    $.info('HTTP META 已关闭')
  } catch (e) {
    $.error(`关闭 HTTP META 失败: ${e}`)
  }

  // ─── 统一重命名：国家 [序号] ISP ───
  const countryGroups = {}
  proxies.forEach(p => {
    if (p._geo?.country) {
      const c = p._geo.country
      if (!countryGroups[c]) countryGroups[c] = []
      countryGroups[c].push(p)
    }
  })

  Object.entries(countryGroups).forEach(([country, group]) => {
    group.forEach((proxy, idx) => {
      let parts = [country]

      // 同国家 ≥2 个才加序号
      if (group.length > 1) {
        const num = String(idx + 1).padStart(2, '0')
        parts.push(num)
      }

      // ISP 优先级
      const isp = (
        proxy._geo.isp ||
        proxy._geo.org ||
        proxy._geo.as  ||
        proxy._geo.aso ||
        ''
      ).trim()

      if (isp) parts.push(isp)

      proxy.name = parts.join(' ').trim()
    })
  })

  // ─── 清理不符合条件的节点 & 字段 ───
  if (remove_incompatible || remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_incompatible && p._incompatible) return false
      if (remove_failed && !p._geo?.country) return false
      return true
    })
  }

  if (!geoEnabled) {
    proxies.forEach(p => delete p._geo)
  }
  if (!incompatibleEnabled) {
    proxies.forEach(p => delete p._incompatible)
  }

  return proxies

  // ─── 单个节点检测 ───
  async function check(proxy) {
    const originalIndex = proxy._proxies_index
    const originalProxy = proxies[originalIndex]
    const cacheId = cacheEnabled ? getCacheId({ proxy, url: apiUrl }) : null

    // 优先使用缓存
    if (cacheEnabled) {
      const cached = cache.get(cacheId)
      if (cached?.api?.country) {
        $.info(`[${originalProxy.name}] 使用成功缓存`)
        originalProxy._geo = cached.api
        return
      }
      if (cached === {} && !disableFailedCache) {
        $.info(`[${originalProxy.name}] 使用失败缓存，跳过`)
        return
      }
    }

    try {
      const port = http_meta_ports[internalProxies.indexOf(proxy)]
      if (!port) throw new Error('未分配端口')

      const started = Date.now()
      const res = await http({
        proxy: `http://${http_meta_host}:${port}`,
        method,
        url: apiUrl,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
        }
      })

      let apiData = {}
      try {
        apiData = JSON.parse(String(res.body || '{}'))
      } catch {}

      const status = Number(res.status || res.statusCode || 0)
      const latency = Date.now() - started

      $.info(`[${originalProxy.name}] status: ${status} | latency: ${latency}ms`)

      if (status === 200 && apiData.country) {
        originalProxy._geo = apiData
        if (cacheEnabled) {
          cache.set(cacheId, { api: apiData })
          $.info(`[${originalProxy.name}] 缓存成功`)
        }
      } else if (cacheEnabled) {
        cache.set(cacheId, {})
        $.info(`[${originalProxy.name}] 检测失败，已标记缓存`)
      }

      $.log(`[${originalProxy.name}] → ${JSON.stringify(apiData, null, 2)}`)
    } catch (e) {
      $.error(`[${originalProxy.name}] 检测异常: ${e.message || e}`)
      if (cacheEnabled) cache.set(cacheId, {})
    }
  }

  // ─── 辅助函数 ───
  async function http(opt = {}) {
    const METHOD = (opt.method || 'get').toLowerCase()
    const TIMEOUT = parseInt(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseInt(opt.retries ?? $arguments.retries ?? 2)
    const RETRY_DELAY = parseInt(opt.retry_delay ?? $arguments.retry_delay ?? 800)

    let attempt = 0
    while (true) {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (err) {
        attempt++
        if (attempt > RETRIES) throw err
        await $.wait(RETRY_DELAY * attempt)
      }
    }
  }

  function getCacheId({ proxy, url }) {
    const relevant = Object.fromEntries(
      Object.entries(proxy).filter(([k]) => !/^(collectionName|subName|id|_.*)$/i.test(k))
    )
    return `http-meta:geo:${url}:${JSON.stringify(relevant)}`
  }

  function executeAsyncTasks(tasks, { concurrency = 10 } = {}) {
    return new Promise(resolve => {
      let running = 0, idx = 0
      function next() {
        while (idx < tasks.length && running < concurrency) {
          const i = idx++
          running++
          tasks[i]().catch(() => {}).finally(() => {
            running--
            next()
          })
        }
        if (running === 0) resolve()
      }
      next()
    })
  }
}

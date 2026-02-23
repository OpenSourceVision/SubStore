/**
 * 节点入口地理位置检测脚本 - 固定命名格式：国家 序号 ISP
 * 
 * 示例输出：
 *   美国 01 Cloudflare
 *   美国 02 Cloudflare
 *   日本 01 SoftBank
 *   香港 01 香港宽频
 *   台湾 01 中华电信
 *   德国 01 Hetzner
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  
  // 可通过参数控制的主要开关（默认值）
  const cacheEnabled       = !!$arguments.cache
  const remove_failed      = !!$arguments.remove_failed
  const entranceEnabled    = $arguments.entrance !== false          // 默认保留 _entrance
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const concurrency        = parseInt($arguments.concurrency || 10)
  const method             = $arguments.method || 'get'
  const apiUrlTemplate     = $arguments.api || 'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN'
  const uniq_key           = $arguments.uniq_key || '^server$'
  const cache              = scriptResourceCache

  // 并发执行所有节点的 IP-API 查询
  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  // ──────────────── 重命名逻辑 ────────────────
  // 按国家分组
  const countryGroups = {}
  proxies.forEach(proxy => {
    if (proxy._entrance?.country) {
      const country = proxy._entrance.country
      if (!countryGroups[country]) countryGroups[country] = []
      countryGroups[country].push(proxy)
    }
  })

  // 对每个国家内的节点进行编号 + ISP 拼接
  Object.keys(countryGroups).forEach(country => {
    const group = countryGroups[country]
    group.forEach((proxy, idx) => {
      let parts = [country]

      // 同一个国家有多个节点才加序号
      if (group.length > 1) {
        const num = String(idx + 1).padStart(2, '0')
        parts.push(num)
      }

      // ISP 信息（优先级顺序）
      const isp = (
        proxy._entrance.isp ||
        proxy._entrance.org ||
        proxy._entrance.as  ||
        proxy._entrance.aso ||
        ''
      ).trim()

      if (isp) {
        parts.push(isp)
      }

      proxy.name = parts.join(' ').trim()
    })
  })

  // ──────────────── 后续处理 ────────────────
  // 1. 是否删除检测失败的节点
  if (remove_failed) {
    proxies = proxies.filter(p => !!p._entrance?.country)
  }

  // 2. 是否保留 _entrance 附加字段
  if (!entranceEnabled) {
    proxies.forEach(p => {
      if (p._entrance) delete p._entrance
    })
  }

  return proxies

  // ──────────────── 检测单个节点 ────────────────
  async function check(proxy) {
    if (!proxy.server) return

    // 缓存 key
    let cacheId
    if (cacheEnabled) {
      const uniqPart = Object.fromEntries(
        Object.entries(proxy).filter(([k]) => new RegExp(uniq_key).test(k))
      )
      cacheId = `entrance:${apiUrlTemplate}:${JSON.stringify(uniqPart)}`
    }

    // 尝试读取缓存
    if (cacheEnabled) {
      const cached = cache.get(cacheId)
      if (cached) {
        if (cached.api?.country) {
          $.info(`[${proxy.name}] 使用成功缓存`)
          proxy._entrance = cached.api
          return
        }
        if (!disableFailedCache) {
          $.info(`[${proxy.name}] 使用失败缓存，跳过本次检测`)
          return
        }
        // 否则继续检测（disableFailedCache = true）
      }
    }

    try {
      const started = Date.now()

      const res = await http({
        method,
        url: apiUrlTemplate.replace(/{{proxy\.server}}/g, proxy.server),
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        }
      })

      let apiData = {}
      try {
        apiData = JSON.parse(String(res.body || '{}'))
      } catch {}

      const status = Number(res.status || res.statusCode || 0)
      const latency = Date.now() - started

      $.info(`[${proxy.name}] status:${status}  latency:${latency}ms`)

      // 简单有效性判断
      if (status === 200 && apiData.country && ProxyUtils?.isIP?.(apiData.query || apiData.ip)) {
        proxy._entrance = apiData

        if (cacheEnabled) {
          cache.set(cacheId, { api: apiData })
          $.info(`[${proxy.name}] 缓存成功`)
        }
      } else {
        if (cacheEnabled) {
          cache.set(cacheId, {})  // 空对象代表失败
          $.info(`[${proxy.name}] 缓存失败标记`)
        }
      }

      $.log(`[${proxy.name}] → ${JSON.stringify(apiData, null, 2)}`)
    } catch (e) {
      $.error(`[${proxy.name}] 检测异常 → ${e.message || e}`)
      if (cacheEnabled) {
        cache.set(cacheId, {})
      }
    }
  }

  // ──────────────── http 请求（带重试） ────────────────
  async function http(opt) {
    const METHOD = (opt.method || 'get').toLowerCase()
    const TIMEOUT = parseInt(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseInt(opt.retries ?? $arguments.retries ?? 2)
    const RETRY_DELAY = parseInt(opt.retry_delay ?? $arguments.retry_delay ?? 800)

    let attempt = 0
    while (true) {
      try {
        return await $.http[METHOD]({
          ...opt,
          timeout: TIMEOUT
        })
      } catch (err) {
        attempt++
        if (attempt > RETRIES) throw err
        await $.wait(RETRY_DELAY * attempt)
      }
    }
  }

  // ──────────────── 并发控制工具 ────────────────
  function executeAsyncTasks(tasks, { concurrency = 10 } = {}) {
    return new Promise((resolve) => {
      let running = 0
      let index = 0

      function next() {
        while (index < tasks.length && running < concurrency) {
          const i = index++
          running++
          tasks[i]()
            .catch(() => {})   // 错误已在内部处理
            .finally(() => {
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

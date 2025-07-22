/**
 * 节点出口地理位置检测脚本
 * 
 * 用途：检测代理节点的落地地理位置（出口位置）
 * 
 * 核心功能：通过 HTTP META 代理核心检测节点的落地地理位置信息，支持自定义命名格式
 * 
 * HTTP META 核心参数 (https://github.com/xream/http-meta)
 * - [http_meta_protocol] 协议，默认: http
 * - [http_meta_host] 服务地址，默认: 127.0.0.1
 * - [http_meta_port] 端口号，默认: 9876
 * - [http_meta_authorization] Authorization 认证头，默认无
 * - [http_meta_start_delay] 初始启动延时(毫秒)，默认: 3000
 * - [http_meta_proxy_timeout] 每个节点超时时间(毫秒)，默认: 10000
 * 
 * 检测参数
 * - [retries] 重试次数，默认: 1
 * - [retry_delay] 重试延时(毫秒)，默认: 1000
 * - [concurrency] 并发数，默认: 10
 * - [timeout] 请求超时(毫秒)，默认: 5000
 * - [method] 请求方法，默认: get
 * - [api] 地理位置检测 API，默认: http://ip-api.com/json?lang=zh-CN
 * - [regex] 正则表达式提取数据，格式: a:x;b:y
 * 
 * 命名格式参数
 * - [format] 自定义格式模板，默认: {{api.country}} {{api.city}}
 * - [show_country] 在最终名称中显示国家，默认: true
 * - [show_city] 在最终名称中显示城市，默认: true
 * - [show_isp] 在最终名称中显示 ISP，默认: false
 * 
 * 输出控制参数
 * - [geo] 在节点上附加 _geo 字段，默认: false
 * - [incompatible] 在节点上附加 _incompatible 字段，默认: false
 * - [remove_incompatible] 移除不兼容的节点，默认: false
 * - [remove_failed] 移除检测失败的节点，默认: false
 * 
 * 缓存参数
 * - [cache] 启用缓存，默认: false
 * - [disable_failed_cache] 禁用失败缓存，默认: false
 * 
 * 缓存时长配置:
 * 设置持久化缓存 sub-store-csr-expiration-time 的值来自定义缓存时长
 * 默认: 172800000 (48小时)
 * 
 * 示例用法:
 * - 默认命名: "美国 纽约 01"
 * - 包含 ISP: "美国 纽约 01 Cloudflare" (show_isp=true)
 * - 仅国家: "美国 01" (show_city=false)
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const cacheEnabled = $arguments.cache
  const cache = scriptResourceCache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const remove_failed = $arguments.remove_failed
  const remove_incompatible = $arguments.remove_incompatible
  const incompatibleEnabled = $arguments.incompatible
  const geoEnabled = $arguments.geo
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_authorization = $arguments.http_meta_authorization ?? ''
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)
  const method = $arguments.method || 'get'
  const regex = $arguments.regex
  const show_country = $arguments.show_country !== false // 默认显示国家
  const show_city = $arguments.show_city !== false // 默认显示城市
  const show_isp = $arguments.show_isp === true // 默认不显示ISP
  let format = $arguments.format || '{{api.country}} {{api.city}}'
  let url = $arguments.api || 'http://ip-api.com/json?lang=zh-CN'

  const internalProxies = []
  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        // $.info(JSON.stringify(node, null, 2))
        internalProxies.push({ ...node, _proxies_index: index })
      } else {
        proxies[index]._incompatible = true
      }
    } catch (e) {
      $.error(e)
    }
  })
  // $.info(JSON.stringify(internalProxies, null, 2))
  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  if (cacheEnabled) {
    try {
      let allCached = true
      for (var i = 0; i < internalProxies.length; i++) {
        const proxy = internalProxies[i]
        const id = getCacheId({ proxy, url, format, regex })
        const cached = cache.get(id)
        if (cached) {
          if (cached.api) {
            proxies[proxy._proxies_index].name = formatter({
              proxy: proxies[proxy._proxies_index],
              api: cached.api,
              format,
              regex,
            })
            proxies[proxy._proxies_index]._geo = cached.api
          } else {
            if (disableFailedCache) {
              allCached = false
              break
            }
          }
        } else {
          allCached = false
          break
        }
      }
      if (allCached) {
        $.info('所有节点都有有效缓存 完成')
        return proxies
      }
    } catch (e) {}
  }

  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout

  let http_meta_pid
  let http_meta_ports = []

  // 启动 HTTP META
  const res = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: http_meta_authorization,
    },
    body: JSON.stringify({
      proxies: internalProxies,
      timeout: http_meta_timeout,
    }),
  })
  let body = res.body
  try {
    body = JSON.parse(body)
  } catch (e) {}
  const { ports, pid } = body
  if (!pid || !ports) {
    throw new Error(`======== HTTP META 启动失败 ====\n${body}`)
  }
  http_meta_pid = pid
  http_meta_ports = ports
  $.info(
    `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] 若未手动关闭 ${
      Math.round(http_meta_timeout / 60 / 10) / 100
    } 分钟后自动关闭\n`
  )
  $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始检测`)
  await $.wait(http_meta_start_delay)

  const concurrency = parseInt($arguments.concurrency || 10) // 一组并发数
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  )
  // const batches = []
  // for (let i = 0; i < internalProxies.length; i += concurrency) {
  //   const batch = internalProxies.slice(i, i + concurrency)
  //   batches.push(batch)
  // }
  // for (const batch of batches) {
  //   await Promise.all(batch.map(check))
  // }

  // stop http meta
  try {
    const res = await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({
        pid: [http_meta_pid],
      }),
    })
    $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(res, null, 2)}`)
  } catch (e) {
    $.error(e)
  }

  if (remove_incompatible || remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_incompatible && p._incompatible) {
        return false
      } else if (remove_failed && !p._geo) {
        return !remove_incompatible && p._incompatible
      }
      return true
    })
  }

  if (!geoEnabled || !incompatibleEnabled) {
    proxies = proxies.map(p => {
      if (!geoEnabled) {
        delete p._geo
      }
      if (!incompatibleEnabled) {
        delete p._incompatible
      }
      return p
    })
  }

  return proxies

  async function check(proxy) {
    // $.info(`[${proxy.name}] 检测`)
    // $.info(`检测 ${JSON.stringify(proxy, null, 2)}`)
    const id = cacheEnabled ? getCacheId({ proxy, url, format, regex }) : undefined
    // $.info(`检测 ${id}`)
    try {
      const cached = cache.get(id)
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`)
          $.log(`[${proxy.name}] api: ${JSON.stringify(cached.api, null, 2)}`)
          proxies[proxy._proxies_index].name = formatter({
            proxy: proxies[proxy._proxies_index],
            api: cached.api,
            format,
            regex,
          })
          if (geoEnabled) proxies[proxy._proxies_index]._geo = cached.api
          return
        } else {
          if (disableFailedCache) {
            $.info(`[${proxy.name}] 不使用失败缓存`)
          } else {
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
        }
      }
      // $.info(JSON.stringify(proxy, null, 2))
      const index = internalProxies.indexOf(proxy)
      const startedAt = Date.now()

      const res = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url,
      })
      let api = String(lodash_get(res, 'body'))
      const status = parseInt(res.status || res.statusCode || 200)
      let latency = ''
      latency = `${Date.now() - startedAt}`
      $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)
      try {
        api = JSON.parse(api)
      } catch (e) {}

      if (status == 200) {
        proxies[proxy._proxies_index].name = formatter({ proxy: proxies[proxy._proxies_index], api, format, regex })
        proxies[proxy._proxies_index]._geo = api
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置成功缓存`)
          cache.set(id, { api })
        }
      } else {
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置失败缓存`)
          cache.set(id, {})
        }
      }

      $.log(`[${proxy.name}] api: ${JSON.stringify(api, null, 2)}`)
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    }
  }
  // 请求
  async function http(opt = {}) {
    const METHOD = opt.method || $arguments.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        // $.error(e)
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
          // $.info(`第 ${count} 次请求失败: ${e.message || e}, 等待 ${delay / 1000}s 后重试`)
          await $.wait(delay)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }
  function lodash_get(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.')
    let result = source
    for (const p of paths) {
      result = Object(result)[p]
      if (result === undefined) {
        return defaultValue
      }
    }
    return result
  }
  function formatter({ proxy = {}, api = {}, format = '', regex = '' }) {
    if (regex) {
      const regexPairs = regex.split(/\s*;\s*/g).filter(Boolean)
      const extracted = {}
      for (const pair of regexPairs) {
        const [key, pattern] = pair.split(/\s*:\s*/g).map(s => s.trim())
        if (key && pattern) {
          try {
            const reg = new RegExp(pattern)
            extracted[key] = (typeof api === 'string' ? api : JSON.stringify(api)).match(reg)?.[1]?.trim()
          } catch (e) {
            $.error(`正则表达式解析错误: ${e.message}`)
          }
        }
      }
      api = { ...api, ...extracted }
    }
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}')
    return eval(`\`${f}\``)
  }
  function getCacheId({ proxy = {}, url, format, regex }) {
    return `http-meta:geo:${url}:${format}:${regex}:${JSON.stringify(
      Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(collectionName|subName|id|_.*)$/i.test(key)))
    )}`
  }
  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []

        let index = 0

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++

            currentTask()
              .then(data => {
                if (result) {
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error
                }
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }

          if (running === 0) {
            return resolve(result ? results : undefined)
          }
        }

        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }

  // 检测完成后，统一重命名节点
  // 根据参数动态构建名称格式
  const nameCountMap = {};
  const nameIndexMap = {};

  proxies.forEach((p, idx) => {
    // 只处理有 _geo 字段的节点
    if (p._geo && (p._geo.country || p._geo.countryCode)) {
      const nameParts = [];
      
      // 添加国家信息
      if (show_country) {
        const country = p._geo.country || p._geo.countryCode || '';
        if (country) nameParts.push(country);
      }
      
      // 添加城市信息
      if (show_city) {
        const city = p._geo.city || '';
        if (city) nameParts.push(city);
      }
      
      // ISP信息不参与分组键，只在最终名称中显示
      const key = nameParts.join(' ').trim() || '未知';
      nameCountMap[key] = (nameCountMap[key] || 0) + 1;
    }
  });

  // 重新编号并命名
  proxies.forEach((p, idx) => {
    if (p._geo && (p._geo.country || p._geo.countryCode)) {
      const nameParts = [];
      
      // 添加国家信息
      if (show_country) {
        const country = p._geo.country || p._geo.countryCode || '';
        if (country) nameParts.push(country);
      }
      
      // 添加城市信息
      if (show_city) {
        const city = p._geo.city || '';
        if (city) nameParts.push(city);
      }
      
      const key = nameParts.join(' ').trim() || '未知';
      if (!nameIndexMap[key]) nameIndexMap[key] = 1;
      const index = nameIndexMap[key]++;
      const num = index.toString().padStart(2, '0');
      
      // 构建最终名称：国家 城市 序号 ISP
      let finalName = `${key} ${num}`;
      
      // 添加ISP信息到序号后面
      if (show_isp) {
        const isp = p._geo.isp || p._geo.org || p._geo.as || p._geo.aso || '';
        if (isp) {
          finalName += ` ${isp}`;
        }
      }
      
      p.name = finalName.trim();
    }
  });

  return proxies
}

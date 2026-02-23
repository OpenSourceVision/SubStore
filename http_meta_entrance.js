/**
 * 节点入口地理位置检测脚本
 * 
 * 通过检测节点服务器的地理位置信息，支持自定义命名格式
 * 
 * 检测参数
 * - [retries] 重试次数，默认: 1
 * - [retry_delay] 重试延时(毫秒)，默认: 1000
 * - [concurrency] 并发数，默认: 10
 * - [timeout] 请求超时(毫秒)，默认: 5000
 * - [method] 请求方法，默认: get
 * - [api] 入口地理位置检测 API，默认: http://ip-api.com/json/{{proxy.server}}?lang=zh-CN
 * - [regex] 正则表达式提取数据，格式: a:x;b:y
 * - [valid] API 响应验证条件，默认: ProxyUtils.isIP('{{api.ip || api.query}}')
 * 
 * 命名格式参数
 * - [format] 自定义格式模板，默认: {{api.country}} {{api.city}}
 * - [show_country] 在最终名称中显示国家，默认: true
 * - [show_city] 在最终名称中显示城市，默认: false
 * - [show_isp] 在最终名称中显示 ISP，默认: true
 * 
 * 输出控制参数
 * - [entrance] 在节点上附加 _entrance 字段，默认: false
 * - [remove_failed] 移除检测失败的节点，默认: false
 * 
 * 缓存参数
 * - [cache] 启用缓存，默认: false
 * - [disable_failed_cache] 禁用失败缓存，默认: false
 * - [uniq_key] 缓存唯一键字段匹配正则，默认: ^server$
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
  const regex = $arguments.regex
  const show_country = $arguments.show_country !== false // 默认 true
  const show_city = $arguments.show_city === true // 默认 false
  const show_isp = $arguments.show_isp !== false // 默认 true
  let valid = $arguments.valid || `ProxyUtils.isIP('{{api.ip || api.query}}')`
  let format = $arguments.format || `{{api.country}}`
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const remove_failed = $arguments.remove_failed
  const entranceEnabled = $arguments.entrance
  const cacheEnabled = $arguments.cache
  const uniq_key = $arguments.uniq_key || '^server$'
  const cache = scriptResourceCache
  const method = $arguments.method || 'get'
  const url = $arguments.api || `http://ip-api.com/json/{{proxy.server}}?lang=zh-CN`
  const concurrency = parseInt($arguments.concurrency || 10)
  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  // 新增：根据参数动态构建名称并重命名
  // 只处理有 _entrance 字段的节点
  const nameMap = {}
  proxies.forEach(proxy => {
    if (proxy._entrance) {
      const parts = []
      if (show_country && proxy._entrance.country) {
        parts.push(proxy._entrance.country)
      }
      if (show_city && proxy._entrance.city) {
        parts.push(proxy._entrance.city)
      }
      const key = parts.join(' ').trim() || '未知'
      if (!nameMap[key]) nameMap[key] = []
      nameMap[key].push(proxy)
    }
  })
  Object.keys(nameMap).forEach(key => {
    nameMap[key].forEach((proxy, idx) => {
      // 序号从 1 开始，补零
      const num = String(idx + 1).padStart(2, '0')
      let finalName = key
      if (nameMap[key].length > 1) {
        finalName += ` ${num}`
      }
      // 添加 ISP 信息（如果启用）
      if (show_isp && proxy._entrance) {
        const isp = proxy._entrance.isp || proxy._entrance.org || proxy._entrance.as || proxy._entrance.aso || ''
        if (isp) {
          finalName += ` ${isp}`
        }
      }
      proxy.name = finalName.trim()
    })
  })

  if (remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_failed && !p._entrance) {
        return false
      }
      return true
    })
  }

  if (!entranceEnabled) {
    proxies = proxies.map(p => {
      if (!entranceEnabled) {
        delete p._entrance
      }
      return p
    })
  }

  return proxies

  async function check(proxy) {
    const id = cacheEnabled
      ? `entrance:${url}:${format}:${regex}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => {
              const re = new RegExp(uniq_key)
              return re.test(key)
            })
          )
        )}`
      : undefined
    try {
      const cached = cache.get(id)
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`)
          $.log(`[${proxy.name}] api: ${JSON.stringify(cached.api, null, 2)}`)
          proxy.name = formatter({ proxy, api: cached.api, format, regex })
          proxy._entrance = cached.api
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
      const startedAt = Date.now()
      let api = {}
      const res = await http({
        method,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url: formatter({ proxy, format: url }),
      })
      api = String(lodash_get(res, 'body'))
      try {
        api = JSON.parse(api)
      } catch (e) {}
      const status = parseInt(res.status || res.statusCode || 200)
      let latency = ''
      latency = `${Date.now() - startedAt}`
      $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)
      if (status == 200 && eval(formatter({ api, format: valid, regex }))) {
        proxy.name = formatter({ proxy, api, format, regex })
        proxy._entrance = api
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

  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          const delay = RETRY_DELAY * count
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
}

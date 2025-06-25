/**
 * 节点信息脚本，适用于 Surge/Loon 或 HTTP API 平台。
 * 用于获取代理节点的地理位置信息并格式化节点名称。
 * 详情请见：https://t.me/zhetengsha/1269
 * 加入 Telegram 群组：https://t.me/zhetengsha
 *
 * 参数说明：
 * - retries: 重试次数（默认：1）
 * - retry_delay: 重试延时（毫秒，默认：1000）
 * - concurrency: 并发请求数（默认：10）
 * - internal: 使用内部 IP 查询（仅 Surge/Loon，默认：false）
 * - timeout: 请求超时（毫秒，默认：5000）
 * - method: HTTP 请求方法（默认：get）
 * - api: 地理位置 API 地址（默认：http://ip-api.com/json?lang=zh-CN）
 * - format: 输出格式（默认：{{api.country}}{{api.city}} - {{proxy.name}}）
 * - regex: 使用正则从 API 响应提取数据（格式：a:x;b:y）
 * - geo: 在节点附加 _geo 字段（默认：false）
 * - incompatible: 标记不兼容协议（默认：false）
 * - remove_incompatible: 移除不兼容节点（默认：false）
 * - remove_failed: 移除失败节点（默认：false）
 * - surge_http_api: 远程 HTTP API 地址（例：192.168.31.5:6171）
 * - surge_http_api_protocol: HTTP API 协议（默认：http）
 * - surge_http_api_key: HTTP API 密码
 * - cache: 启用缓存（默认：false）
 * - disable_failed_cache: 不缓存失败结果（默认：false）
 * 缓存时长：通过 sub-store-csr-expiration-time 设置（默认：48小时）
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isLoon, isSurge } = $.env;

  // 配置参数
  const internal = $arguments.internal;
  const regex = $arguments.regex;
  const format = $arguments.format || (internal ? '{{api.country}} {{api.aso}} - {{proxy.name}}' : '{{api.country}}{{api.city}} - {{proxy.name}}');
  const url = $arguments.api || (internal ? 'http://checkip.amazonaws.com' : 'http://ip-api.com/json?lang=zh-CN');
  const surge_http_api = $arguments.surge_http_api;
  const surge_http_api_protocol = $arguments.surge_http_api_protocol || 'http';
  const surge_http_api_key = $arguments.surge_http_api_key;
  const surge_http_api_enabled = !!surge_http_api;
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error;
  const remove_failed = $arguments.remove_failed;
  const remove_incompatible = $arguments.remove_incompatible;
  const incompatibleEnabled = $arguments.incompatible;
  const geoEnabled = $arguments.geo;
  const cacheEnabled = $arguments.cache;
  const cache = scriptResourceCache;
  const method = $arguments.method || 'get';
  const target = surge_http_api_enabled ? 'Surge' : (isLoon ? 'Loon' : isSurge ? 'Surge' : undefined);
  const concurrency = parseInt($arguments.concurrency || 10);

  // 验证运行环境
  if (!surge_http_api_enabled && !isLoon && !isSurge) {
    throw new Error('需要 Loon、Surge（支持 http-client-policy）或配置 HTTP API');
  }
  if (internal && (!isLoon && !isSurge || typeof $utils === 'undefined' || !$utils.geoip || !$utils.ipaso)) {
    $.error('内部方法需要 Surge/Loon（build >= 692）支持 $utils.ipaso 和 $utils.geoip API');
    throw new Error('不支持内部 IP 查询');
  }

  // 并发处理代理节点
  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  );

  // 过滤节点
  if (remove_incompatible || remove_failed) {
    proxies = proxies.filter(p => !(remove_incompatible && p._incompatible) && !(remove_failed && !p._geo));
  }

  // 清理元数据
  if (!geoEnabled || !incompatibleEnabled) {
    proxies = proxies.map(p => {
      if (!geoEnabled) delete p._geo;
      if (!incompatibleEnabled) delete p._incompatible;
      return p;
    });
  }

  return proxies;

  // 检查单个代理节点
  async function check(proxy) {
    const cacheId = cacheEnabled ? `geo:${url}:${format}:${regex}:${internal}:${JSON.stringify(
      Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(collectionName|subName|id|_.*)$/i.test(key)))
    )}` : undefined;

    try {
      const node = ProxyUtils.produce([proxy], target);
      if (!node) {
        proxy._incompatible = true;
        return;
      }

      // 检查缓存
      if (cacheEnabled && cacheId) {
        const cached = cache.get(cacheId);
        if (cached) {
          if (cached.api) {
            $.info(`[${proxy.name}] 使用缓存成功结果`);
            proxy.name = formatter({ proxy, api: cached.api, format, regex });
            proxy._geo = cached.api;
            return;
          } else if (!disableFailedCache) {
            $.info(`[${proxy.name}] 使用缓存失败结果`);
            return;
          }
        }
      }

      // 执行 HTTP 请求
      const startedAt = Date.now();
      const res = await http({
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url,
        'policy-descriptor': node,
        node,
      });

      let api = res.body;
      const status = parseInt(res.status || res.statusCode || 200);
      const latency = Date.now() - startedAt;
      $.info(`[${proxy.name}] 状态: ${status}, 延迟: ${latency}ms`);

      // 处理 API 响应
      if (internal) {
        const ip = api.trim();
        api = {
          country: $utils.geoip(ip) || '',
          aso: $utils.ipaso(ip) || '',
          asn: $utils.ipasn(ip) || '',
        };
      } else {
        try {
          api = JSON.parse(api);
        } catch (e) {
          $.error(`[${proxy.name}] 解析 API 响应失败: ${e.message}`);
        }
      }

      // 更新节点信息
      if (status === 200) {
        proxy.name = formatter({ proxy, api, format, regex });
        proxy._geo = api;
        if (cacheEnabled && cacheId) {
          $.info(`[${proxy.name}] 缓存成功结果`);
          cache.set(cacheId, { api });
        }
      } else if (cacheEnabled && cacheId) {
        $.info(`[${proxy.name}] 缓存失败结果`);
        cache.set(cacheId, {});
      }
    } catch (e) {
      $.error(`[${proxy.name}] 错误: ${e.message}`);
      if (cacheEnabled && cacheId) {
        $.info(`[${proxy.name}] 缓存失败结果`);
        cache.set(cacheId, {});
      }
    }
  }

  // 执行带重试的 HTTP 请求
  async function http(opt = {}) {
    const METHOD = opt.method || 'get';
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000);
    const RETRIES = parseFloat(opt.retries || $arguments.retries || 1);
    const RETRY_DELAY = parseFloat(opt.retry_delay || $arguments.retry_delay || 1000);

    let count = 0;
    const fn = async () => {
      try {
        if (surge_http_api_enabled) {
          const res = await $.http.post({
            url: `${surge_http_api_protocol}://${surge_http_api}/v1/scripting/evaluate`,
            timeout: TIMEOUT,
            headers: { 'x-key': surge_http_api_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              script_text: `$httpClient.get(${JSON.stringify({ ...opt, timeout: TIMEOUT / 1000 })}, (error, response, data) => { $done({ error, response, data }) })`,
              mock_type: 'cron',
              timeout: TIMEOUT / 1000,
            }),
          });
          const body = JSON.parse(res.body || '{}');
          if (body.result.error) throw new Error(body.result.error);
          return { ...body.result.response, body: body.result.data };
        } else {
          return await $.http[METHOD]({ ...opt, timeout: TIMEOUT });
        }
      } catch (e) {
        if (count++ < RETRIES) {
          await $.wait(RETRY_DELAY * count);
          return fn();
        }
        throw e;
      }
    };
    return fn();
  }

  // 从对象中提取嵌套属性
  function lodash_get(source, path, defaultValue = undefined) {
    return path.replace(/\[(\d+)\]/g, '.$1').split('.')
      .reduce((result, p) => result?.[p], source) ?? defaultValue;
  }

  // 使用 API 数据和正则格式化节点名称
  function formatter({ proxy = {}, api = {}, format = '', regex = '' }) {
    if (regex) {
      const regexPairs = regex.split(/\s*;\s*/g).filter(Boolean);
      const extracted = {};
      for (const pair of regexPairs) {
        const [key, pattern] = pair.split(/\s*:\s*/g).map(s => s.trim());
        if (key && pattern) {
          try {
            const reg = new RegExp(pattern);
            extracted[key] = (typeof api === 'string' ? api : JSON.stringify(api)).match(reg)?.[1]?.trim();
          } catch (e) {
            $.error(`正则表达式错误: ${e.message}`);
          }
        }
      }
      api = { ...api, ...extracted };
    }
    return format.replace(/\{\{(.*?)\}\}/g, (_, key) => lodash_get({ proxy, api }, key, ''));
  }

  // 并发执行任务
  async function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    let running = 0, index = 0;
    return new Promise((resolve) => {
      async function executeNext() {
        while (index < tasks.length && running < concurrency) {
          running++;
          tasks[index++]()
            .finally(() => { running--; executeNext(); });
        }
        if (running === 0) resolve();
      }
      executeNext();
    });
  }
}
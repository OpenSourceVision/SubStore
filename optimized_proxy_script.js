/**
 * 节点信息(入口版) - 优化版本
 *
 * ⚠️ 本脚本不进行域名解析 如有需要 可在节点操作中添加域名解析
 *
 * 查看说明: https://t.me/zhetengsha/1358
 * 落地版脚本请查看: https://t.me/zhetengsha/1269
 * 欢迎加入 Telegram 群组 https://t.me/zhetengsha
 *
 * 参数说明:
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [internal] 使用内部方法获取 IP 信息. 默认 false
 * - [method] 请求方法. 默认 get
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [api] 测入口的 API . 默认为 http://ip-api.com/json/{{proxy.server}}?lang=zh-CN
 * - [format] 自定义格式 默认为: {{api.country}} {{api.isp}} - {{proxy.name}}
 * - [regex] 使用正则表达式从API响应中取数据
 * - [valid] 验证 api 请求是否合法
 * - [uniq_key] 设置缓存唯一键名包含的节点数据字段名匹配正则. 默认为 ^server$
 * - [entrance] 在节点上附加 _entrance 字段(API 响应数据), 默认不附加
 * - [remove_failed] 移除失败的节点. 默认不移除
 * - [cache] 使用缓存, 默认不使用缓存
 * - [disable_failed_cache] 禁用失败缓存
 */

// 常量定义
const DEFAULT_CONFIG = {
  retries: 1,
  retry_delay: 1000,
  concurrency: 10,
  timeout: 5000,
  method: 'get',
  api: 'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN',
  format: '{{api.country}} {{api.isp}} - {{proxy.name}}',
  format_internal: '{{api.countryCode}} {{api.aso}} - {{proxy.name}}',
  valid: `ProxyUtils.isIP('{{api.ip || api.query}}')`,
  valid_internal: `"{{api.countryCode || api.aso}}".length > 0`,
  uniq_key: '^server$',
  user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
};

class ProxyChecker {
  constructor(args, $substore) {
    this.$ = $substore;
    this.config = this.parseArguments(args);
    this.cache = scriptResourceCache;
    this.utils = null;
    
    this.initializeUtils();
  }

  parseArguments(args) {
    const config = { ...DEFAULT_CONFIG };
    
    // 解析参数
    Object.keys(args).forEach(key => {
      if (args[key] !== undefined) {
        config[key] = args[key];
      }
    });

    // 处理内部模式的特殊配置
    if (config.internal) {
      config.format = args.format || config.format_internal;
      config.valid = args.valid || config.valid_internal;
    }

    // 类型转换
    config.concurrency = parseInt(config.concurrency);
    config.timeout = parseFloat(config.timeout);
    config.retries = parseFloat(config.retries);
    config.retry_delay = parseFloat(config.retry_delay);

    return config;
  }

  initializeUtils() {
    if (!this.config.internal) return;

    const { isNode } = this.$.env;
    
    if (isNode) {
      this.utils = new ProxyUtils.MMDB({ 
        country: this.config.mmdb_country_path, 
        asn: this.config.mmdb_asn_path 
      });
      this.logMMDBPaths();
    } else {
      this.validateUtilsAPI();
      this.utils = $utils;
    }
  }

  logMMDBPaths() {
    const countryPath = this.config.mmdb_country_path || eval('process.env.SUB_STORE_MMDB_COUNTRY_PATH');
    const asnPath = this.config.mmdb_asn_path || eval('process.env.SUB_STORE_MMDB_ASN_PATH');
    
    this.$.info(`[MMDB] GeoLite2 Country 数据库文件路径: ${countryPath}`);
    this.$.info(`[MMDB] GeoLite2 ASN 数据库文件路径: ${asnPath}`);
  }

  validateUtilsAPI() {
    if (typeof $utils === 'undefined' || 
        typeof $utils.geoip === 'undefined' || 
        typeof $utils.ipaso === 'undefined') {
      this.$.error('目前仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App');
      throw new Error('不支持使用内部方法获取 IP 信息, 请查看日志');
    }
  }

  async processProxies(proxies) {
    // 执行并发检测
    await this.executeAsyncTasks(
      proxies.map(proxy => () => this.checkProxy(proxy)),
      { concurrency: this.config.concurrency }
    );

    return this.filterAndCleanProxies(proxies);
  }

  filterAndCleanProxies(proxies) {
    let result = proxies;

    // 移除失败的节点
    if (this.config.remove_failed) {
      result = result.filter(proxy => proxy._entrance);
    }

    // 清理入口信息
    if (!this.config.entrance) {
      result = result.map(proxy => {
        delete proxy._entrance;
        return proxy;
      });
    }

    return result;
  }

  async checkProxy(proxy) {
    const cacheId = this.generateCacheId(proxy);
    
    try {
      // 尝试使用缓存
      if (await this.tryUseCache(proxy, cacheId)) {
        return;
      }

      // 执行检测
      const api = await this.fetchProxyInfo(proxy);
      
      // 验证和处理结果
      if (this.validateAPIResponse(api)) {
        this.updateProxyInfo(proxy, api);
        this.setCacheIfEnabled(cacheId, { api });
      } else {
        this.setCacheIfEnabled(cacheId, {});
      }

      this.$.log(`[${proxy.name}] api: ${JSON.stringify(api, null, 2)}`);
    } catch (error) {
      this.$.error(`[${proxy.name}] ${error.message ?? error}`);
      this.setCacheIfEnabled(cacheId, {});
    }
  }

  generateCacheId(proxy) {
    if (!this.config.cache) return undefined;

    const keyData = Object.fromEntries(
      Object.entries(proxy).filter(([key]) => {
        const regex = new RegExp(this.config.uniq_key);
        return regex.test(key);
      })
    );

    return `entrance:${this.config.api}:${this.config.format}:${this.config.regex}:${this.config.internal}:${JSON.stringify(keyData)}`;
  }

  async tryUseCache(proxy, cacheId) {
    if (!this.config.cache || !cacheId) return false;

    const cached = this.cache.get(cacheId);
    if (!cached) return false;

    if (cached.api) {
      this.$.info(`[${proxy.name}] 使用成功缓存`);
      this.$.log(`[${proxy.name}] api: ${JSON.stringify(cached.api, null, 2)}`);
      this.updateProxyInfo(proxy, cached.api);
      return true;
    } else if (!this.config.disable_failed_cache) {
      this.$.info(`[${proxy.name}] 使用失败缓存`);
      return true;
    } else {
      this.$.info(`[${proxy.name}] 不使用失败缓存`);
      return false;
    }
  }

  async fetchProxyInfo(proxy) {
    if (this.config.internal) {
      return this.fetchInternalInfo(proxy);
    } else {
      return this.fetchExternalInfo(proxy);
    }
  }

  fetchInternalInfo(proxy) {
    const api = {
      countryCode: this.utils.geoip(proxy.server) || '',
      aso: this.utils.ipaso(proxy.server) || '',
    };
    
    this.$.info(`[${proxy.name}] countryCode: ${api.countryCode}, aso: ${api.aso}`);
    return api;
  }

  async fetchExternalInfo(proxy) {
    const startTime = Date.now();
    
    const response = await this.httpRequest({
      method: this.config.method,
      url: this.formatString({ proxy, format: this.config.api }),
      headers: {
        'User-Agent': this.config.user_agent
      }
    });

    const latency = Date.now() - startTime;
    const status = parseInt(response.status || response.statusCode || 200);
    
    this.$.info(`[${proxy.name}] status: ${status}, latency: ${latency}ms`);

    let api = String(this.lodashGet(response, 'body'));
    try {
      api = JSON.parse(api);
    } catch (error) {
      // 保持字符串格式
    }

    if (status !== 200) {
      throw new Error(`HTTP ${status}`);
    }

    return api;
  }

  validateAPIResponse(api) {
    return eval(this.formatString({ api, format: this.config.valid, regex: this.config.regex }));
  }

  updateProxyInfo(proxy, api) {
    proxy.name = this.formatString({ proxy, api, format: this.config.format, regex: this.config.regex });
    proxy._entrance = api;
  }

  setCacheIfEnabled(cacheId, data) {
    if (this.config.cache && cacheId) {
      const action = data.api ? '成功' : '失败';
      this.$.info(`[设置${action}缓存]`);
      this.cache.set(cacheId, data);
    }
  }

  async httpRequest(options = {}) {
    const method = options.method || 'get';
    const timeout = parseFloat(options.timeout || this.config.timeout);
    const retries = parseFloat(options.retries ?? this.config.retries);
    const retryDelay = parseFloat(options.retry_delay ?? this.config.retry_delay);

    let attempt = 0;
    
    const makeRequest = async () => {
      try {
        return await this.$.http[method]({ ...options, timeout });
      } catch (error) {
        if (attempt < retries) {
          attempt++;
          const delay = retryDelay * attempt;
          await this.$.wait(delay);
          return makeRequest();
        } else {
          throw error;
        }
      }
    };

    return makeRequest();
  }

  formatString({ proxy = {}, api = {}, format = '', regex = '' }) {
    let processedAPI = api;

    // 处理正则表达式提取
    if (regex) {
      const extracted = this.extractWithRegex(api, regex);
      processedAPI = { ...api, ...extracted };
    }

    // 替换模板变量
    const template = format.replace(/\{\{(.*?)\}\}/g, '${$1}');
    return eval(`\`${template}\``);
  }

  extractWithRegex(api, regex) {
    const regexPairs = regex.split(/\s*;\s*/).filter(Boolean);
    const extracted = {};
    
    for (const pair of regexPairs) {
      const [key, pattern] = pair.split(/\s*:\s*/).map(s => s.trim());
      
      if (key && pattern) {
        try {
          const regexp = new RegExp(pattern);
          const content = typeof api === 'string' ? api : JSON.stringify(api);
          const match = content.match(regexp);
          extracted[key] = match?.[1]?.trim();
        } catch (error) {
          this.$.error(`正则表达式解析错误: ${error.message}`);
        }
      }
    }
    
    return extracted;
  }

  executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve, reject) => {
      let running = 0;
      let index = 0;

      const executeNext = () => {
        while (index < tasks.length && running < concurrency) {
          const taskIndex = index++;
          const task = tasks[taskIndex];
          running++;

          task()
            .catch(error => {
              // 错误已在各个任务中处理，这里静默处理
            })
            .finally(() => {
              running--;
              executeNext();
            });
        }

        if (running === 0 && index >= tasks.length) {
          resolve();
        }
      };

      executeNext();
    });
  }

  lodashGet(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let result = source;
    
    for (const segment of paths) {
      result = Object(result)[segment];
      if (result === undefined) {
        return defaultValue;
      }
    }
    
    return result;
  }
}

// 主函数
async function operator(proxies = [], targetPlatform, context) {
  const checker = new ProxyChecker($arguments, $substore);
  return checker.processProxies(proxies);
}
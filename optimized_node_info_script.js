/**
 * 节点信息检测脚本 (优化版)
 *
 * ⚠️ 本脚本不进行域名解析 如有需要 可在节点操作中添加域名解析
 *
 * 主要优化:
 * 1. 改进代码结构和可读性
 * 2. 优化错误处理和日志记录
 * 3. 提升性能和并发控制
 * 4. 增强缓存机制
 * 5. 改进参数验证和默认值处理
 */

class NodeInfoChecker {
  constructor(args = {}) {
    this.$ = $substore;
    this.isNode = this.$.env.isNode;
    
    // 配置参数
    this.config = this.validateAndSetDefaults(args);
    
    // 初始化工具
    this.utils = null;
    this.cache = scriptResourceCache;
    
    this.initializeUtils();
  }

  /**
   * 验证并设置默认参数
   */
  validateAndSetDefaults(args) {
    const config = {
      // 基础配置
      retries: Math.max(0, parseInt(args.retries) || 1),
      retryDelay: Math.max(0, parseInt(args.retry_delay) || 1000),
      concurrency: Math.max(1, Math.min(50, parseInt(args.concurrency) || 10)),
      timeout: Math.max(1000, parseInt(args.timeout) || 5000),
      method: (args.method || 'get').toLowerCase(),
      
      // API 配置
      api: args.api || 'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN',
      
      // 内部方法配置
      internal: Boolean(args.internal),
      mmdbCountryPath: args.mmdb_country_path,
      mmdbAsnPath: args.mmdb_asn_path,
      
      // 格式化配置
      format: args.format,
      regex: args.regex || '',
      valid: args.valid,
      
      // 缓存配置
      cache: Boolean(args.cache),
      disableFailedCache: Boolean(args.disable_failed_cache || args.ignore_failed_error),
      uniqKey: args.uniq_key || '^server$',
      
      // 其他配置
      entrance: Boolean(args.entrance),
      removeFailed: Boolean(args.remove_failed)
    };

    // 根据内部方法设置默认格式
    if (config.internal) {
      config.format = config.format || '{{api.countryCode}} {{api.aso}} - {{proxy.name}}';
      config.valid = config.valid || '"{{api.countryCode || api.aso}}".length > 0';
    } else {
      config.format = config.format || '{{api.country}} {{api.isp}} - {{proxy.name}}';
      config.valid = config.valid || "ProxyUtils.isIP('{{api.ip || api.query}}')";
    }

    return config;
  }

  /**
   * 初始化工具
   */
  initializeUtils() {
    if (!this.config.internal) return;

    try {
      if (this.isNode) {
        this.utils = new ProxyUtils.MMDB({
          country: this.config.mmdbCountryPath || process.env.SUB_STORE_MMDB_COUNTRY_PATH,
          asn: this.config.mmdbAsnPath || process.env.SUB_STORE_MMDB_ASN_PATH
        });
        
        this.$.info(`[MMDB] Country DB: ${this.config.mmdbCountryPath || process.env.SUB_STORE_MMDB_COUNTRY_PATH}`);
        this.$.info(`[MMDB] ASN DB: ${this.config.mmdbAsnPath || process.env.SUB_STORE_MMDB_ASN_PATH}`);
      } else {
        if (typeof $utils === 'undefined' || !$utils.geoip || !$utils.ipaso) {
          throw new Error('当前环境不支持内部方法，需要 Surge/Loon(build >= 692) 等支持 $utils.ipaso 和 $utils.geoip API');
        }
        this.utils = $utils;
      }
    } catch (error) {
      this.$.error(`初始化工具失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 主要处理函数
   */
  async process(proxies = []) {
    if (!Array.isArray(proxies) || proxies.length === 0) {
      this.$.info('没有需要处理的节点');
      return [];
    }

    this.$.info(`开始处理 ${proxies.length} 个节点，并发数: ${this.config.concurrency}`);

    try {
      // 并发处理所有节点
      await this.executeAsyncTasks(
        proxies.map(proxy => () => this.checkNode(proxy)),
        { concurrency: this.config.concurrency }
      );

      // 处理结果
      let processedProxies = this.postProcess(proxies);
      
      this.$.info(`处理完成，成功: ${processedProxies.filter(p => p._entrance).length}，失败: ${processedProxies.length - processedProxies.filter(p => p._entrance).length}`);
      
      return processedProxies;
    } catch (error) {
      this.$.error(`处理过程出错: ${error.message}`);
      throw error;
    }
  }

  /**
   * 后处理：移除失败节点和清理入口信息
   */
  postProcess(proxies) {
    let result = [...proxies];

    // 移除失败的节点
    if (this.config.removeFailed) {
      const beforeCount = result.length;
      result = result.filter(p => p._entrance);
      this.$.info(`移除失败节点: ${beforeCount - result.length} 个`);
    }

    // 清理入口信息
    if (!this.config.entrance) {
      result.forEach(p => delete p._entrance);
    }

    return result;
  }

  /**
   * 检查单个节点
   */
  async checkNode(proxy) {
    const startTime = Date.now();
    const cacheId = this.generateCacheId(proxy);

    try {
      // 尝试使用缓存
      if (this.config.cache) {
        const cached = this.cache.get(cacheId);
        if (cached !== undefined) {
          if (cached.success) {
            this.$.info(`[${proxy.name}] 使用成功缓存`);
            this.applyResult(proxy, cached.api);
            return;
          } else if (!this.config.disableFailedCache) {
            this.$.info(`[${proxy.name}] 使用失败缓存`);
            return;
          }
        }
      }

      // 获取节点信息
      const api = await this.fetchNodeInfo(proxy);
      
      // 验证结果
      if (this.validateResult(api)) {
        this.applyResult(proxy, api);
        this.setCacheResult(cacheId, true, api);
        this.$.info(`[${proxy.name}] 检测成功 (${Date.now() - startTime}ms)`);
      } else {
        this.setCacheResult(cacheId, false);
        this.$.warn(`[${proxy.name}] 结果验证失败`);
      }

    } catch (error) {
      this.setCacheResult(cacheId, false);
      this.$.error(`[${proxy.name}] 检测失败: ${error.message}`);
    }
  }

  /**
   * 获取节点信息
   */
  async fetchNodeInfo(proxy) {
    if (this.config.internal) {
      return this.fetchInternalInfo(proxy);
    } else {
      return this.fetchExternalInfo(proxy);
    }
  }

  /**
   * 使用内部方法获取信息
   */
  async fetchInternalInfo(proxy) {
    const api = {
      countryCode: this.utils.geoip(proxy.server) || '',
      aso: this.utils.ipaso(proxy.server) || '',
    };

    this.$.log(`[${proxy.name}] Internal - Country: ${api.countryCode}, ASO: ${api.aso}`);
    return api;
  }

  /**
   * 使用外部API获取信息
   */
  async fetchExternalInfo(proxy) {
    const url = this.formatString(this.config.api, { proxy });
    
    const response = await this.httpRequest({
      method: this.config.method,
      url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
      }
    });

    let api = response.body;
    
    try {
      api = JSON.parse(api);
    } catch (e) {
      // 如果不是JSON，保持原样
    }

    const status = parseInt(response.status || response.statusCode || 200);
    if (status !== 200) {
      throw new Error(`HTTP ${status}`);
    }

    this.$.log(`[${proxy.name}] External API response:`, JSON.stringify(api, null, 2));
    return api;
  }

  /**
   * HTTP请求with重试机制
   */
  async httpRequest(options) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        return await this.$.http[options.method]({
          ...options,
          timeout: this.config.timeout
        });
      } catch (error) {
        lastError = error;
        
        if (attempt < this.config.retries) {
          const delay = this.config.retryDelay * (attempt + 1);
          await this.$.wait(delay);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * 验证结果
   */
  validateResult(api) {
    try {
      return eval(this.formatString(this.config.valid, { api }));
    } catch (error) {
      this.$.error(`验证表达式执行失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 应用结果到代理节点
   */
  applyResult(proxy, api) {
    // 处理正则提取
    if (this.config.regex) {
      api = { ...api, ...this.extractWithRegex(api) };
    }

    // 格式化名称
    proxy.name = this.formatString(this.config.format, { proxy, api });
    proxy._entrance = api;
  }

  /**
   * 使用正则表达式提取数据
   */
  extractWithRegex(api) {
    const extracted = {};
    const regexPairs = this.config.regex.split(/\s*;\s*/g).filter(Boolean);
    
    for (const pair of regexPairs) {
      const [key, pattern] = pair.split(/\s*:\s*/g).map(s => s.trim());
      if (key && pattern) {
        try {
          const regex = new RegExp(pattern);
          const apiString = typeof api === 'string' ? api : JSON.stringify(api);
          const match = apiString.match(regex);
          extracted[key] = match?.[1]?.trim() || '';
        } catch (error) {
          this.$.error(`正则表达式解析错误 (${pattern}): ${error.message}`);
        }
      }
    }
    
    return extracted;
  }

  /**
   * 生成缓存ID
   */
  generateCacheId(proxy) {
    if (!this.config.cache) return null;

    const keyFields = Object.fromEntries(
      Object.entries(proxy).filter(([key]) => new RegExp(this.config.uniqKey).test(key))
    );

    return `entrance:${this.config.api}:${this.config.format}:${this.config.regex}:${this.config.internal}:${JSON.stringify(keyFields)}`;
  }

  /**
   * 设置缓存结果
   */
  setCacheResult(cacheId, success, api = null) {
    if (!this.config.cache || !cacheId) return;

    if (success) {
      this.cache.set(cacheId, { success: true, api });
    } else if (!this.config.disableFailedCache) {
      this.cache.set(cacheId, { success: false });
    }
  }

  /**
   * 字符串格式化
   */
  formatString(template, data = {}) {
    try {
      const formatted = template.replace(/\{\{(.*?)\}\}/g, '${$1}');
      return eval(`\`${formatted}\``);
    } catch (error) {
      this.$.error(`字符串格式化失败: ${error.message}`);
      return template;
    }
  }

  /**
   * 深度获取对象属性
   */
  static get(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let result = source;
    
    for (const p of paths) {
      result = Object(result)[p];
      if (result === undefined) {
        return defaultValue;
      }
    }
    
    return result;
  }

  /**
   * 并发任务执行器
   */
  async executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve, reject) => {
      let running = 0;
      let index = 0;
      let hasError = false;

      function executeNext() {
        while (index < tasks.length && running < concurrency && !hasError) {
          const taskIndex = index++;
          const task = tasks[taskIndex];
          running++;

          task()
            .catch(error => {
              // 单个任务失败不影响整体流程
            })
            .finally(() => {
              running--;
              executeNext();
            });
        }

        if (running === 0) {
          resolve();
        }
      }

      try {
        executeNext();
      } catch (error) {
        hasError = true;
        reject(error);
      }
    });
  }
}

/**
 * 主入口函数
 */
async function operator(proxies = [], targetPlatform, context) {
  try {
    const checker = new NodeInfoChecker($arguments);
    return await checker.process(proxies);
  } catch (error) {
    $substore.error(`脚本执行失败: ${error.message}`);
    return proxies; // 出错时返回原始数据
  }
}
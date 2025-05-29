/**
 * 代理检测器 - 优化版本
 * 主要功能：检测代理的地理位置信息并格式化代理名称
 */
class ProxyOperator {
  constructor(args, substore) {
    this.$ = substore;
    this.env = substore.env;
    this.cache = scriptResourceCache;
    
    // 配置参数
    this.config = this.parseArguments(args);
    
    // 验证环境和配置
    this.validateEnvironment();
  }

  /**
   * 解析和标准化参数
   */
  parseArguments(args) {
    const config = {
      // 基础配置
      internal: args.internal || false,
      regex: args.regex || '',
      format: args.format || '{{api.country}} {{api.isp}} - {{proxy.name}}',
      api: args.api || 'http://ip-api.com/json?lang=zh-CN',
      method: (args.method || 'get').toLowerCase(),
      
      // HTTP API 配置
      surgeHttpApi: args.surge_http_api,
      surgeHttpApiProtocol: args.surge_http_api_protocol || 'http',
      surgeHttpApiKey: args.surge_http_api_key,
      
      // 缓存和错误处理
      cacheEnabled: args.cache !== false,
      disableFailedCache: args.disable_failed_cache || args.ignore_failed_error || false,
      removeFailed: args.remove_failed || false,
      removeIncompatible: args.remove_incompatible || false,
      
      // 输出控制
      geoEnabled: args.geo !== false,
      incompatibleEnabled: args.incompatible !== false,
      
      // 性能配置
      concurrency: Math.max(1, parseInt(args.concurrency) || 10),
      timeout: Math.max(1000, parseFloat(args.timeout) || 5000),
      retries: Math.max(0, parseInt(args.retries) || 1),
      retryDelay: Math.max(0, parseFloat(args.retry_delay) || 1000)
    };

    // 内部模式的特殊配置
    if (config.internal) {
      config.format = args.format || '{{api.countryCode}} {{api.aso}} - {{proxy.name}}';
      config.api = args.api || 'http://checkip.amazonaws.com';
    }

    return config;
  }

  /**
   * 验证运行环境
   */
  validateEnvironment() {
    const { isLoon, isSurge } = this.env;
    const { internal, surgeHttpApi } = this.config;

    if (internal) {
      if (typeof $utils === 'undefined' || 
          typeof $utils.geoip === 'undefined' || 
          typeof $utils.ipaso === 'undefined') {
        throw new Error('内部模式需要 Surge/Loon(build >= 692) 等支持 $utils.ipaso 和 $utils.geoip API 的应用');
      }
    }

    if (!surgeHttpApi && !isLoon && !isSurge) {
      throw new Error('请使用 Loon, Surge(ability=http-client-policy) 或配置 HTTP API');
    }
  }

  /**
   * 主要操作函数
   */
  async operator(proxies = [], targetPlatform, context) {
    if (!Array.isArray(proxies) || proxies.length === 0) {
      return proxies;
    }

    this.$.info(`开始检测 ${proxies.length} 个代理节点`);
    
    try {
      // 并发检测所有代理
      await this.executeAsyncTasks(
        proxies.map(proxy => () => this.checkProxy(proxy)),
        { concurrency: this.config.concurrency }
      );

      // 过滤不需要的代理
      const filteredProxies = this.filterProxies(proxies);
      
      // 清理输出字段
      const finalProxies = this.cleanProxies(filteredProxies);

      this.$.info(`检测完成，剩余 ${finalProxies.length} 个代理节点`);
      return finalProxies;
    } catch (error) {
      this.$.error(`代理检测过程中发生错误: ${error.message}`);
      throw error;
    }
  }

  /**
   * 检测单个代理
   */
  async checkProxy(proxy) {
    const proxyName = proxy.name || 'Unknown';
    const cacheKey = this.generateCacheKey(proxy);

    try {
      // 生成代理节点配置
      const target = this.env.isLoon ? 'Loon' : this.env.isSurge ? 'Surge' : undefined;
      const node = ProxyUtils.produce([proxy], this.config.surgeHttpApi ? 'Surge' : target);
      
      if (!node) {
        proxy._incompatible = true;
        this.$.info(`[${proxyName}] 不兼容的代理类型`);
        return;
      }

      // 检查缓存
      const cachedResult = this.getCachedResult(cacheKey, proxyName);
      if (cachedResult !== null) {
        if (cachedResult.success) {
          proxy.name = this.formatProxyName({ proxy, api: cachedResult.api });
          proxy._geo = cachedResult.api;
        }
        return;
      }

      // 执行HTTP请求
      const apiResult = await this.makeRequest(node, proxyName);
      
      if (apiResult.success) {
        proxy.name = this.formatProxyName({ proxy, api: apiResult.api });
        proxy._geo = apiResult.api;
        this.setCacheResult(cacheKey, proxyName, { success: true, api: apiResult.api });
      } else {
        this.setCacheResult(cacheKey, proxyName, { success: false });
      }

    } catch (error) {
      this.$.error(`[${proxyName}] 检测失败: ${error.message}`);
      this.setCacheResult(cacheKey, proxyName, { success: false });
    }
  }

  /**
   * 生成缓存键
   */
  generateCacheKey(proxy) {
    if (!this.config.cacheEnabled) return null;
    
    const proxyData = Object.fromEntries(
      Object.entries(proxy).filter(([key]) => 
        !/^(collectionName|subName|id|_.*)$/i.test(key)
      )
    );
    
    return `geo:${this.config.api}:${this.config.format}:${this.config.regex}:${this.config.internal}:${JSON.stringify(proxyData)}`;
  }

  /**
   * 获取缓存结果
   */
  getCachedResult(cacheKey, proxyName) {
    if (!this.config.cacheEnabled || !cacheKey) return null;
    
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;

    if (cached.api) {
      this.$.info(`[${proxyName}] 使用成功缓存`);
      return { success: true, api: cached.api };
    } else if (!this.config.disableFailedCache) {
      this.$.info(`[${proxyName}] 使用失败缓存`);
      return { success: false };
    }
    
    return null;
  }

  /**
   * 设置缓存结果
   */
  setCacheResult(cacheKey, proxyName, result) {
    if (!this.config.cacheEnabled || !cacheKey) return;
    
    if (result.success) {
      this.$.info(`[${proxyName}] 设置成功缓存`);
      this.cache.set(cacheKey, { api: result.api });
    } else {
      this.$.info(`[${proxyName}] 设置失败缓存`);
      this.cache.set(cacheKey, {});
    }
  }

  /**
   * 执行HTTP请求
   */
  async makeRequest(node, proxyName) {
    const startTime = Date.now();
    const requestOptions = {
      method: this.config.method,
      url: this.config.api,
      timeout: this.config.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
      },
      'policy-descriptor': node,
      node
    };

    const response = await this.httpRequest(requestOptions);
    const latency = Date.now() - startTime;
    const status = parseInt(response.status || response.statusCode || 200);
    
    this.$.info(`[${proxyName}] HTTP ${status}, 延迟: ${latency}ms`);

    if (status === 200) {
      const apiData = this.parseApiResponse(response.body);
      this.$.log(`[${proxyName}] API响应: ${JSON.stringify(apiData, null, 2)}`);
      return { success: true, api: apiData };
    }
    
    return { success: false };
  }

  /**
   * 解析API响应
   */
  parseApiResponse(responseBody) {
    let apiData = String(responseBody || '').trim();
    
    if (this.config.internal) {
      const ip = apiData;
      return {
        countryCode: $utils.geoip(ip) || '',
        aso: $utils.ipaso(ip) || '',
        asn: $utils.ipasn(ip) || ''
      };
    }
    
    try {
      return JSON.parse(apiData);
    } catch {
      return apiData;
    }
  }

  /**
   * 格式化代理名称
   */
  formatProxyName({ proxy = {}, api = {} }) {
    let processedApi = { ...api };
    
    // 应用正则表达式提取
    if (this.config.regex) {
      const extracted = this.extractWithRegex(api);
      processedApi = { ...processedApi, ...extracted };
    }
    
    // 使用模板字符串格式化
    const template = this.config.format.replace(/\{\{(.*?)\}\}/g, '${$1}');
    
    try {
      return eval(`\`${template}\``);
    } catch (error) {
      this.$.error(`格式化代理名称失败: ${error.message}`);
      return proxy.name || 'Unknown';
    }
  }

  /**
   * 使用正则表达式提取信息
   */
  extractWithRegex(api) {
    const extracted = {};
    const regexPairs = this.config.regex.split(/\s*;\s*/g).filter(Boolean);
    
    for (const pair of regexPairs) {
      const [key, pattern] = pair.split(/\s*:\s*/g).map(s => s.trim());
      if (!key || !pattern) continue;
      
      try {
        const regex = new RegExp(pattern);
        const apiString = typeof api === 'string' ? api : JSON.stringify(api);
        const match = apiString.match(regex);
        extracted[key] = match?.[1]?.trim() || '';
      } catch (error) {
        this.$.error(`正则表达式解析错误 "${pattern}": ${error.message}`);
      }
    }
    
    return extracted;
  }

  /**
   * HTTP请求封装（支持重试）
   */
  async httpRequest(options) {
    let attempt = 0;
    
    while (attempt <= this.config.retries) {
      try {
        if (this.config.surgeHttpApi) {
          return await this.makeHttpRequestViaSurgeApi(options);
        } else {
          return await this.$[options.method](options);
        }
      } catch (error) {
        attempt++;
        if (attempt <= this.config.retries) {
          const delay = this.config.retryDelay * attempt;
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * 通过Surge API发送HTTP请求
   */
  async makeHttpRequestViaSurgeApi(options) {
    const apiUrl = `${this.config.surgeHttpApiProtocol}://${this.config.surgeHttpApi}/v1/scripting/evaluate`;
    const scriptText = `$httpClient.${options.method}(${JSON.stringify({
      ...options,
      timeout: options.timeout / 1000
    })}, (error, response, data) => { $done({ error, response, data }) })`;

    const response = await this.$.http.post({
      url: apiUrl,
      timeout: options.timeout,
      headers: {
        'x-key': this.config.surgeHttpApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        script_text: scriptText,
        mock_type: 'cron',
        timeout: options.timeout / 1000
      })
    });

    const body = this.parseJsonSafely(response.body);
    const error = this.getNestedValue(body, 'result.error');
    
    if (error) {
      throw new Error(error);
    }

    return {
      status: this.getNestedValue(body, 'result.response.status'),
      statusCode: this.getNestedValue(body, 'result.response.statusCode'),
      body: this.getNestedValue(body, 'result.data')
    };
  }

  /**
   * 过滤代理
   */
  filterProxies(proxies) {
    if (!this.config.removeIncompatible && !this.config.removeFailed) {
      return proxies;
    }

    return proxies.filter(proxy => {
      if (this.config.removeIncompatible && proxy._incompatible) {
        return false;
      }
      if (this.config.removeFailed && !proxy._geo) {
        return !this.config.removeIncompatible && proxy._incompatible;
      }
      return true;
    });
  }

  /**
   * 清理代理对象的内部字段
   */
  cleanProxies(proxies) {
    return proxies.map(proxy => {
      const cleanedProxy = { ...proxy };
      
      if (!this.config.geoEnabled) {
        delete cleanedProxy._geo;
      }
      if (!this.config.incompatibleEnabled) {
        delete cleanedProxy._incompatible;
      }
      
      return cleanedProxy;
    });
  }

  /**
   * 并发执行异步任务
   */
  async executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise((resolve, reject) => {
      let running = 0;
      let index = 0;
      let hasError = false;

      function executeNext() {
        while (index < tasks.length && running < concurrency && !hasError) {
          const currentTask = tasks[index++];
          running++;

          currentTask()
            .catch(error => {
              // 单个任务失败不影响其他任务
              console.warn('Task failed:', error.message);
            })
            .finally(() => {
              running--;
              executeNext();
            });
        }

        if (running === 0 && !hasError) {
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

  /**
   * 工具方法：安全的JSON解析
   */
  parseJsonSafely(str) {
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  /**
   * 工具方法：获取嵌套对象值
   */
  getNestedValue(obj, path, defaultValue = undefined) {
    const keys = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let result = obj;
    
    for (const key of keys) {
      result = result?.[key];
      if (result === undefined) {
        return defaultValue;
      }
    }
    
    return result;
  }

  /**
   * 工具方法：休眠
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 主入口函数（保持原有接口兼容性）
 */
async function operator(proxies = [], targetPlatform, context) {
  const proxyOperator = new ProxyOperator($arguments, $substore);
  return await proxyOperator.operator(proxies, targetPlatform, context);
}
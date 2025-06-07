/*
 * SubStore 节点信息获取与重命名脚本
 * 功能：获取节点的地理位置信息，缓存数据，重新命名节点
 * 支持：国家、城市、ISP等参数的自定义配置
 */

// 脚本配置
const CONFIG = {
    // 节点名称格式配置
    naming: {
        format: "{country}", // 默认格式：仅显示国家
        // 可选格式示例：
        // "{country} - {city}" - 国家 + 城市
        // "{country} - {isp}" - 国家 + ISP
        // "{country} - {city} - {isp}" - 国家 + 城市 + ISP
        // "{flag} {country}" - 旗帜 + 国家
        customFormats: {
            simple: "{country}",
            detailed: "{country} - {city}",
            withISP: "{country} - {isp}",
            full: "{country} - {city} - {isp}",
            withFlag: "{flag} {country}",
            flagDetailed: "{flag} {country} - {city}"
        }
    },
    
    // API配置
    api: {
        // IP信息查询API列表（按优先级排序）
        endpoints: [
            "http://ip-api.com/json/",
            "https://ipapi.co/json/",
            "https://api.ipify.org?format=json", // 备用简单API
        ],
        timeout: 5000, // 请求超时时间（毫秒）
        retryCount: 3 // 重试次数
    },
    
    // 缓存配置
    cache: {
        enable: true,
        expireTime: 7 * 24 * 60 * 60 * 1000, // 7天过期
        storageKey: "substore_node_cache"
    },
    
    // 国家代码到旗帜emoji的映射
    countryFlags: {
        "US": "🇺🇸", "CN": "🇨🇳", "HK": "🇭🇰", "TW": "🇹🇼", "SG": "🇸🇬",
        "JP": "🇯🇵", "KR": "🇰🇷", "GB": "🇬🇧", "DE": "🇩🇪", "FR": "🇫🇷",
        "CA": "🇨🇦", "AU": "🇦🇺", "RU": "🇷🇺", "IN": "🇮🇳", "BR": "🇧🇷",
        "NL": "🇳🇱", "CH": "🇨🇭", "SE": "🇸🇪", "NO": "🇳🇴", "FI": "🇫🇮",
        "IT": "🇮🇹", "ES": "🇪🇸", "BE": "🇧🇪", "AT": "🇦🇹", "DK": "🇩🇰",
        "TR": "🇹🇷", "IL": "🇮🇱", "AE": "🇦🇪", "SA": "🇸🇦", "EG": "🇪🇬",
        "ZA": "🇿🇦", "NG": "🇳🇬", "KE": "🇰🇪", "TH": "🇹🇭", "VN": "🇻🇳",
        "MY": "🇲🇾", "ID": "🇮🇩", "PH": "🇵🇭", "PK": "🇵🇰", "BD": "🇧🇩"
    }
};

// 全局变量
let cache = {};
let proxyList = [];

// 工具函数
const Utils = {
    // 日志记录
    log: (message, level = "INFO") => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level}] ${message}`);
    },
    
    // 错误记录
    error: (message, error = null) => {
        Utils.log(`ERROR: ${message}${error ? ` - ${error.message}` : ""}`, "ERROR");
    },
    
    // HTTP请求函数
    httpRequest: async (url, options = {}) => {
        const defaultOptions = {
            method: "GET",
            timeout: CONFIG.api.timeout,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        };
        
        const finalOptions = { ...defaultOptions, ...options };
        
        try {
            // 这里使用SubStore环境的HTTP请求方法
            if (typeof $httpClient !== 'undefined') {
                return new Promise((resolve, reject) => {
                    $httpClient.get({ url, timeout: finalOptions.timeout }, (error, response, data) => {
                        if (error) {
                            reject(new Error(error));
                        } else {
                            resolve({ status: response.status, data: data });
                        }
                    });
                });
            } else {
                // 备用方法
                const response = await fetch(url, finalOptions);
                const data = await response.text();
                return { status: response.status, data: data };
            }
        } catch (error) {
            throw new Error(`HTTP请求失败: ${error.message}`);
        }
    },
    
    // 延迟函数
    delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    
    // 检查IP地址格式
    isValidIP: (ip) => {
        const ipv4Regex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
        return ipv4Regex.test(ip) || ipv6Regex.test(ip);
    },
    
    // 从节点信息中提取IP地址
    extractIP: (proxyInfo) => {
        if (proxyInfo.server) return proxyInfo.server;
        if (proxyInfo.hostname) return proxyInfo.hostname;
        if (proxyInfo.host) return proxyInfo.host;
        return null;
    }
};

// 缓存管理器
const CacheManager = {
    // 加载缓存
    load: () => {
        if (!CONFIG.cache.enable) return {};
        
        try {
            const cacheData = $persistentStore.read(CONFIG.cache.storageKey);
            if (cacheData) {
                const parsed = JSON.parse(cacheData);
                // 清理过期缓存
                const now = Date.now();
                Object.keys(parsed).forEach(key => {
                    if (parsed[key].timestamp + CONFIG.cache.expireTime < now) {
                        delete parsed[key];
                    }
                });
                return parsed;
            }
        } catch (error) {
            Utils.error("加载缓存失败", error);
        }
        return {};
    },
    
    // 保存缓存
    save: (cacheData) => {
        if (!CONFIG.cache.enable) return false;
        
        try {
            $persistentStore.write(JSON.stringify(cacheData), CONFIG.cache.storageKey);
            return true;
        } catch (error) {
            Utils.error("保存缓存失败", error);
            return false;
        }
    },
    
    // 获取缓存数据
    get: (ip) => {
        if (!CONFIG.cache.enable || !cache[ip]) return null;
        
        const now = Date.now();
        if (cache[ip].timestamp + CONFIG.cache.expireTime < now) {
            delete cache[ip];
            return null;
        }
        
        return cache[ip].data;
    },
    
    // 设置缓存数据
    set: (ip, data) => {
        if (!CONFIG.cache.enable) return;
        
        cache[ip] = {
            data: data,
            timestamp: Date.now()
        };
    }
};

// IP信息获取器
const IPInfoFetcher = {
    // 获取IP信息
    getIPInfo: async (ip) => {
        // 检查缓存
        const cachedInfo = CacheManager.get(ip);
        if (cachedInfo) {
            Utils.log(`使用缓存数据: ${ip}`);
            return cachedInfo;
        }
        
        // 尝试从多个API获取信息
        for (let i = 0; i < CONFIG.api.endpoints.length; i++) {
            const endpoint = CONFIG.api.endpoints[i];
            
            for (let retry = 0; retry < CONFIG.api.retryCount; retry++) {
                try {
                    Utils.log(`正在查询IP信息: ${ip} (API: ${endpoint}, 尝试: ${retry + 1})`);
                    
                    const response = await Utils.httpRequest(`${endpoint}${ip}`);
                    
                    if (response.status === 200) {
                        const data = JSON.parse(response.data);
                        const ipInfo = IPInfoFetcher.parseResponse(data, endpoint);
                        
                        if (ipInfo.country) {
                            // 缓存结果
                            CacheManager.set(ip, ipInfo);
                            Utils.log(`成功获取IP信息: ${ip} - ${ipInfo.country}`);
                            return ipInfo;
                        }
                    }
                } catch (error) {
                    Utils.error(`获取IP信息失败: ${ip} (API: ${endpoint}, 尝试: ${retry + 1})`, error);
                    
                    if (retry < CONFIG.api.retryCount - 1) {
                        await Utils.delay(1000 * (retry + 1)); // 递增延迟
                    }
                }
            }
        }
        
        // 所有API都失败，返回默认信息
        Utils.error(`无法获取IP信息: ${ip}`);
        return {
            country: "Unknown",
            countryCode: "XX",
            city: "Unknown",
            isp: "Unknown",
            flag: "🏳️"
        };
    },
    
    // 解析不同API的响应格式
    parseResponse: (data, endpoint) => {
        let result = {
            country: "Unknown",
            countryCode: "XX",
            city: "Unknown",
            isp: "Unknown",
            flag: "🏳️"
        };
        
        try {
            if (endpoint.includes("ip-api.com")) {
                result.country = data.country || "Unknown";
                result.countryCode = data.countryCode || "XX";
                result.city = data.city || "Unknown";
                result.isp = data.isp || data.org || "Unknown";
            } else if (endpoint.includes("ipapi.co")) {
                result.country = data.country_name || "Unknown";
                result.countryCode = data.country_code || "XX";
                result.city = data.city || "Unknown";
                result.isp = data.org || "Unknown";
            } else if (endpoint.includes("ipify.org")) {
                // ipify只返回IP，需要其他API补充信息
                result.country = "Unknown";
                result.countryCode = "XX";
                result.city = "Unknown";
                result.isp = "Unknown";
            }
            
            // 设置国旗
            result.flag = CONFIG.countryFlags[result.countryCode] || "🏳️";
            
        } catch (error) {
            Utils.error("解析API响应失败", error);
        }
        
        return result;
    }
};

// 节点名称生成器
const NodeNameGenerator = {
    // 生成节点名称
    generateName: (originalName, ipInfo, customFormat = null) => {
        const format = customFormat || CONFIG.naming.format;
        
        let newName = format
            .replace("{country}", ipInfo.country)
            .replace("{city}", ipInfo.city)
            .replace("{isp}", ipInfo.isp)
            .replace("{flag}", ipInfo.flag)
            .replace("{countryCode}", ipInfo.countryCode);
        
        // 添加原始名称中的序号或特殊标识
        const originalNumber = NodeNameGenerator.extractNumber(originalName);
        if (originalNumber) {
            newName += ` ${originalNumber}`;
        }
        
        return newName.trim();
    },
    
    // 提取原始名称中的数字序号
    extractNumber: (name) => {
        const match = name.match(/(\d+)$/);
        return match ? match[1] : null;
    },
    
    // 批量生成名称（处理重复）
    generateUniqueNames: (nodeList) => {
        const nameCount = {};
        const results = [];
        
        nodeList.forEach((node, index) => {
            let baseName = node.generatedName;
            let finalName = baseName;
            
            // 处理重复名称
            if (nameCount[baseName]) {
                nameCount[baseName]++;
                finalName = `${baseName} ${nameCount[baseName]}`;
            } else {
                nameCount[baseName] = 1;
            }
            
            results.push({
                ...node,
                finalName: finalName
            });
        });
        
        return results;
    }
};

// 主要处理器
const ProxyProcessor = {
    // 处理单个节点
    processNode: async (proxy) => {
        try {
            const ip = Utils.extractIP(proxy);
            
            if (!ip || !Utils.isValidIP(ip)) {
                Utils.error(`无效的IP地址: ${proxy.name} - ${ip}`);
                return {
                    ...proxy,
                    processed: false,
                    error: "无效IP地址"
                };
            }
            
            // 获取IP信息
            const ipInfo = await IPInfoFetcher.getIPInfo(ip);
            
            // 生成新名称
            const generatedName = NodeNameGenerator.generateName(proxy.name, ipInfo);
            
            return {
                ...proxy,
                originalName: proxy.name,
                ipInfo: ipInfo,
                generatedName: generatedName,
                processed: true
            };
            
        } catch (error) {
            Utils.error(`处理节点失败: ${proxy.name}`, error);
            return {
                ...proxy,
                processed: false,
                error: error.message
            };
        }
    },
    
    // 批量处理节点
    processAllNodes: async (proxies) => {
        Utils.log(`开始处理 ${proxies.length} 个节点`);
        
        const results = [];
        const batchSize = 5; // 并发处理数量
        
        for (let i = 0; i < proxies.length; i += batchSize) {
            const batch = proxies.slice(i, i + batchSize);
            const batchPromises = batch.map(proxy => ProxyProcessor.processNode(proxy));
            
            try {
                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults);
                
                Utils.log(`已处理 ${Math.min(i + batchSize, proxies.length)}/${proxies.length} 个节点`);
                
                // 批次间延迟，避免API限制
                if (i + batchSize < proxies.length) {
                    await Utils.delay(1000);
                }
            } catch (error) {
                Utils.error(`批处理失败`, error);
                // 继续处理下一批
            }
        }
        
        return results;
    }
};

// 主函数
async function main() {
    try {
        Utils.log("=== SubStore 节点重命名脚本开始执行 ===");
        
        // 初始化缓存
        cache = CacheManager.load();
        Utils.log(`加载了 ${Object.keys(cache).length} 条缓存记录`);
        
        // 获取节点列表（需要根据实际环境调整）
        let proxies = [];
        
        // SubStore环境获取代理列表
        if (typeof $content !== 'undefined') {
            proxies = $content; // SubStore传入的代理列表
        } else {
            // 测试数据
            proxies = [
                { name: "测试节点1", server: "1.1.1.1", port: 443 },
                { name: "测试节点2", server: "8.8.8.8", port: 443 }
            ];
        }
        
        if (!proxies || proxies.length === 0) {
            Utils.error("没有找到可处理的节点");
            return proxies;
        }
        
        // 处理所有节点
        const processedNodes = await ProxyProcessor.processAllNodes(proxies);
        
        // 生成最终名称（处理重复）
        const finalNodes = NodeNameGenerator.generateUniqueNames(
            processedNodes.filter(node => node.processed)
        );
        
        // 应用新名称
        const renamedProxies = proxies.map(proxy => {
            const processedNode = finalNodes.find(node => node.originalName === proxy.name);
            if (processedNode && processedNode.finalName) {
                return {
                    ...proxy,
                    name: processedNode.finalName
                };
            }
            return proxy;
        });
        
        // 保存缓存
        CacheManager.save(cache);
        
        // 统计信息
        const successCount = processedNodes.filter(node => node.processed).length;
        const failureCount = processedNodes.length - successCount;
        
        Utils.log("=== 处理完成 ===");
        Utils.log(`总节点数: ${proxies.length}`);
        Utils.log(`成功处理: ${successCount}`);
        Utils.log(`处理失败: ${failureCount}`);
        Utils.log(`缓存记录: ${Object.keys(cache).length}`);
        
        return renamedProxies;
        
    } catch (error) {
        Utils.error("脚本执行失败", error);
        return proxies || [];
    }
}

// 配置管理函数
function setNamingFormat(format) {
    CONFIG.naming.format = format;
    Utils.log(`命名格式已设置为: ${format}`);
}

function useCustomFormat(formatName) {
    if (CONFIG.naming.customFormats[formatName]) {
        CONFIG.naming.format = CONFIG.naming.customFormats[formatName];
        Utils.log(`使用自定义格式: ${formatName} (${CONFIG.naming.format})`);
    } else {
        Utils.error(`未找到自定义格式: ${formatName}`);
    }
}

// 导出函数供外部调用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        main,
        setNamingFormat,
        useCustomFormat,
        CONFIG
    };
}

// SubStore环境直接执行
if (typeof $content !== 'undefined') {
    main().then(result => {
        $content = result;
        $done();
    }).catch(error => {
        Utils.error("脚本执行异常", error);
        $done();
    });
}
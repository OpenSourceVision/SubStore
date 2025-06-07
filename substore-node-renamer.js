/*
 * SubStore 节点重命名 Operator
 * 专门为SubStore环境优化的简化版本
 */

// 配置
const CONFIG = {
    naming: {
        format: "{country}",
        formats: {
            simple: "{country}",
            detailed: "{country} - {city}",
            withISP: "{country} - {isp}",
            withFlag: "{flag} {country}"
        }
    },
    api: {
        timeout: 5000,
        retryCount: 2
    },
    cache: {
        enable: true,
        expireTime: 7 * 24 * 60 * 60 * 1000 // 7天
    },
    flags: {
        "US": "🇺🇸", "CN": "🇨🇳", "HK": "🇭🇰", "TW": "🇹🇼", "SG": "🇸🇬",
        "JP": "🇯🇵", "KR": "🇰🇷", "GB": "🇬🇧", "DE": "🇩🇪", "FR": "🇫🇷",
        "CA": "🇨🇦", "AU": "🇦🇺", "RU": "🇷🇺", "IN": "🇮🇳", "BR": "🇧🇷",
        "NL": "🇳🇱", "CH": "🇨🇭", "SE": "🇸🇪", "NO": "🇳🇴", "IT": "🇮🇹"
    }
};

// 全局缓存
let ipCache = {};

// 日志函数
function log(message) {
    console.log(`[SubStore Node Renamer] ${message}`);
}

// HTTP请求函数
async function httpGet(url) {
    return new Promise((resolve, reject) => {
        if (typeof $httpClient !== 'undefined') {
            $httpClient.get({ url: url, timeout: CONFIG.api.timeout }, (error, response, data) => {
                if (error) {
                    reject(new Error(error));
                } else {
                    resolve(data);
                }
            });
        } else {
            reject(new Error("HTTP客户端不可用"));
        }
    });
}

// 获取IP信息
async function getIPInfo(ip) {
    // 检查缓存
    if (ipCache[ip] && Date.now() - ipCache[ip].timestamp < CONFIG.cache.expireTime) {
        return ipCache[ip].data;
    }
    
    try {
        // 使用ip-api.com获取信息
        const response = await httpGet(`http://ip-api.com/json/${ip}?fields=country,countryCode,city,isp,status`);
        const data = JSON.parse(response);
        
        if (data.status === 'success') {
            const ipInfo = {
                country: data.country || "Unknown",
                countryCode: data.countryCode || "XX",
                city: data.city || "Unknown",
                isp: data.isp || "Unknown",
                flag: CONFIG.flags[data.countryCode] || "🏳️"
            };
            
            // 缓存结果
            if (CONFIG.cache.enable) {
                ipCache[ip] = {
                    data: ipInfo,
                    timestamp: Date.now()
                };
            }
            
            return ipInfo;
        }
    } catch (error) {
        log(`获取IP信息失败: ${ip} - ${error.message}`);
    }
    
    // 返回默认值
    return {
        country: "Unknown",
        countryCode: "XX", 
        city: "Unknown",
        isp: "Unknown",
        flag: "🏳️"
    };
}

// 提取IP地址
function extractIP(proxy) {
    return proxy.server || proxy.hostname || proxy.host || null;
}

// 生成节点名称
function generateName(originalName, ipInfo, format = CONFIG.naming.format) {
    let newName = format
        .replace("{country}", ipInfo.country)
        .replace("{city}", ipInfo.city)
        .replace("{isp}", ipInfo.isp)
        .replace("{flag}", ipInfo.flag)
        .replace("{countryCode}", ipInfo.countryCode);
    
    // 保留原始名称中的数字
    const numberMatch = originalName.match(/(\d+)$/);
    if (numberMatch) {
        newName += ` ${numberMatch[1]}`;
    }
    
    return newName.trim();
}

// 处理重复名称
function handleDuplicateNames(nodes) {
    const nameCount = {};
    
    return nodes.map(node => {
        let finalName = node.newName;
        
        if (nameCount[finalName]) {
            nameCount[finalName]++;
            finalName = `${finalName} ${nameCount[finalName]}`;
        } else {
            nameCount[finalName] = 1;
        }
        
        return {
            ...node,
            finalName: finalName
        };
    });
}

// 主要的Operator函数
async function operator(proxies = []) {
    log(`开始处理 ${proxies.length} 个节点`);
    
    if (!proxies || proxies.length === 0) {
        return proxies;
    }
    
    const processedNodes = [];
    
    // 批量处理节点
    for (let i = 0; i < proxies.length; i++) {
        const proxy = proxies[i];
        const ip = extractIP(proxy);
        
        if (!ip) {
            log(`跳过无效节点: ${proxy.name}`);
            processedNodes.push({
                proxy: proxy,
                newName: proxy.name,
                processed: false
            });
            continue;
        }
        
        try {
            const ipInfo = await getIPInfo(ip);
            const newName = generateName(proxy.name, ipInfo);
            
            processedNodes.push({
                proxy: proxy,
                newName: newName,
                processed: true
            });
            
            log(`处理完成: ${proxy.name} -> ${newName}`);
            
            // 添加延迟避免API限制
            if (i < proxies.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            
        } catch (error) {
            log(`处理失败: ${proxy.name} - ${error.message}`);
            processedNodes.push({
                proxy: proxy,
                newName: proxy.name,
                processed: false
            });
        }
    }
    
    // 处理重复名称
    const finalNodes = handleDuplicateNames(processedNodes);
    
    // 应用新名称
    const result = finalNodes.map(node => ({
        ...node.proxy,
        name: node.finalName || node.newName
    }));
    
    const successCount = processedNodes.filter(n => n.processed).length;
    log(`处理完成: 成功 ${successCount}/${proxies.length}, 缓存 ${Object.keys(ipCache).length} 条`);
    
    return result;
}

// 导出函数
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { operator };
}

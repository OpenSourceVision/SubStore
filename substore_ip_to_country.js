/**
 * Sub-Store 脚本: 根据IP修改节点名称为国家
 * 功能: 检测代理节点的IP地址，并将节点名称修改为对应的国家名称
 * 作者: Claude AI
 * 版本: 1.0.0
 */

// 国家映射表 (IP段到国家的映射)
const COUNTRY_MAPPING = {
    // 亚洲
    'CN': '🇨🇳 中国',
    'HK': '🇭🇰 香港',
    'TW': '🇹🇼 台湾',
    'SG': '🇸🇬 新加坡',
    'JP': '🇯🇵 日本',
    'KR': '🇰🇷 韩国',
    'TH': '🇹🇭 泰国',
    'MY': '🇲🇾 马来西亚',
    'IN': '🇮🇳 印度',
    'PH': '🇵🇭 菲律宾',
    'ID': '🇮🇩 印尼',
    'VN': '🇻🇳 越南',
    // 北美
    'US': '🇺🇸 美国',
    'CA': '🇨🇦 加拿大',
    'MX': '🇲🇽 墨西哥',
    // 欧洲
    'GB': '🇬🇧 英国',
    'DE': '🇩🇪 德国',
    'FR': '🇫🇷 法国',
    'NL': '🇳🇱 荷兰',
    'IT': '🇮🇹 意大利',
    'ES': '🇪🇸 西班牙',
    'RU': '🇷🇺 俄罗斯',
    'CH': '🇨🇭 瑞士',
    'SE': '🇸🇪 瑞典',
    'NO': '🇳🇴 挪威',
    'FI': '🇫🇮 芬兰',
    'DK': '🇩🇰 丹麦',
    'AT': '🇦🇹 奥地利',
    'BE': '🇧🇪 比利时',
    'PT': '🇵🇹 葡萄牙',
    'IE': '🇮🇪 爱尔兰',
    'PL': '🇵🇱 波兰',
    'CZ': '🇨🇿 捷克',
    'HU': '🇭🇺 匈牙利',
    'GR': '🇬🇷 希腊',
    'TR': '🇹🇷 土耳其',
    'UA': '🇺🇦 乌克兰',
    // 大洋洲
    'AU': '🇦🇺 澳大利亚',
    'NZ': '🇳🇿 新西兰',
    // 南美
    'BR': '🇧🇷 巴西',
    'AR': '🇦🇷 阿根廷',
    'CL': '🇨🇱 智利',
    // 非洲
    'ZA': '🇿🇦 南非',
    'EG': '🇪🇬 埃及',
    // 中东
    'AE': '🇦🇪 阿联酋',
    'SA': '🇸🇦 沙特',
    'IL': '🇮🇱 以色列'
};

// IP地理位置查询API配置
const GEO_APIS = [
    {
        name: 'ip-api',
        url: 'http://ip-api.com/json/',
        parse: (data) => data.countryCode
    },
    {
        name: 'ipapi',
        url: 'https://ipapi.co/',
        suffix: '/json/',
        parse: (data) => data.country_code
    },
    {
        name: 'ipinfo',
        url: 'https://ipinfo.io/',
        suffix: '/json',
        parse: (data) => data.country
    }
];

// HTTP请求配置
const HTTP_CONFIG = {
    timeout: 5000,
    retries: 2,
    headers: {
        'User-Agent': 'Sub-Store/1.0'
    }
};

/**
 * 执行HTTP请求
 * @param {string} url - 请求URL
 * @param {object} options - 请求选项
 * @returns {Promise<object>} 响应数据
 */
async function httpRequest(url, options = {}) {
    const config = {
        ...HTTP_CONFIG,
        ...options,
        url: url
    };
    
    for (let i = 0; i < config.retries; i++) {
        try {
            const response = await $http.get(config);
            if (response.status === 200) {
                return response.body;
            }
        } catch (error) {
            if (i === config.retries - 1) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

/**
 * 通过IP获取国家代码
 * @param {string} ip - IP地址
 * @returns {Promise<string>} 国家代码
 */
async function getCountryByIP(ip) {
    // 首先检查是否为内网IP
    if (isPrivateIP(ip)) {
        return null;
    }
    
    for (const api of GEO_APIS) {
        try {
            const url = api.url + ip + (api.suffix || '');
            const data = await httpRequest(url);
            
            if (typeof data === 'string') {
                const jsonData = JSON.parse(data);
                const countryCode = api.parse(jsonData);
                if (countryCode && countryCode !== 'XX') {
                    return countryCode.toUpperCase();
                }
            } else if (typeof data === 'object') {
                const countryCode = api.parse(data);
                if (countryCode && countryCode !== 'XX') {
                    return countryCode.toUpperCase();
                }
            }
        } catch (error) {
            console.log(`API ${api.name} 查询失败:`, error.message);
            continue;
        }
    }
    
    return null;
}

/**
 * 检查是否为内网IP
 * @param {string} ip - IP地址
 * @returns {boolean} 是否为内网IP
 */
function isPrivateIP(ip) {
    const privateRanges = [
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
        /^192\.168\./,
        /^127\./,
        /^169\.254\./,
        /^::1$/,
        /^fc00:/,
        /^fe80:/
    ];
    
    return privateRanges.some(range => range.test(ip));
}

/**
 * 解析服务器IP
 * @param {object} proxy - 代理配置对象
 * @returns {string|null} IP地址
 */
function extractServerIP(proxy) {
    if (!proxy || !proxy.server) {
        return null;
    }
    
    const server = proxy.server;
    
    // 检查是否已经是IP地址
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    if (ipRegex.test(server)) {
        return server;
    }
    
    // 如果是域名，需要DNS解析（这里返回null，让调用者处理）
    return null;
}

/**
 * 通过域名获取IP（模拟DNS查询）
 * @param {string} hostname - 主机名
 * @returns {Promise<string|null>} IP地址
 */
async function resolveHostname(hostname) {
    try {
        // 使用DNS over HTTPS查询
        const dohUrl = `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`;
        const response = await httpRequest(dohUrl, {
            headers: {
                'Accept': 'application/dns-json'
            }
        });
        
        const data = typeof response === 'string' ? JSON.parse(response) : response;
        if (data.Answer && data.Answer.length > 0) {
            // 查找A记录
            const aRecord = data.Answer.find(record => record.type === 1);
            if (aRecord) {
                return aRecord.data;
            }
        }
    } catch (error) {
        console.log(`DNS解析失败 ${hostname}:`, error.message);
    }
    
    return null;
}

/**
 * 获取代理节点的国家信息
 * @param {object} proxy - 代理配置对象
 * @returns {Promise<string|null>} 国家名称
 */
async function getProxyCountry(proxy) {
    let ip = extractServerIP(proxy);
    
    // 如果server不是IP，尝试DNS解析
    if (!ip && proxy.server) {
        ip = await resolveHostname(proxy.server);
    }
    
    if (!ip) {
        console.log(`无法获取 ${proxy.name || proxy.server} 的IP地址`);
        return null;
    }
    
    const countryCode = await getCountryByIP(ip);
    if (countryCode && COUNTRY_MAPPING[countryCode]) {
        return COUNTRY_MAPPING[countryCode];
    }
    
    return countryCode ? `🌍 ${countryCode}` : null;
}

/**
 * 主函数 - Sub-Store脚本入口
 * @param {Array} proxies - 代理列表
 * @returns {Array} 修改后的代理列表
 */
async function operator(proxies = []) {
    if (!Array.isArray(proxies) || proxies.length === 0) {
        console.log('代理列表为空');
        return proxies;
    }
    
    console.log(`开始处理 ${proxies.length} 个代理节点...`);
    
    const results = [];
    const batchSize = 5; // 批量处理，避免过多并发请求
    
    for (let i = 0; i < proxies.length; i += batchSize) {
        const batch = proxies.slice(i, i + batchSize);
        const batchPromises = batch.map(async (proxy, index) => {
            try {
                const country = await getProxyCountry(proxy);
                const newProxy = { ...proxy };
                
                if (country) {
                    // 保存原始名称（如果需要的话）
                    if (!newProxy.tag) {
                        newProxy.tag = newProxy.name;
                    }
                    
                    // 设置新的国家名称
                    newProxy.name = country;
                    console.log(`✅ ${proxy.name || proxy.server} -> ${country}`);
                } else {
                    console.log(`⚠️  ${proxy.name || proxy.server} -> 无法识别国家`);
                }
                
                return newProxy;
            } catch (error) {
                console.log(`❌ ${proxy.name || proxy.server} 处理失败:`, error.message);
                return proxy;
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // 批次间延迟，避免API限制
        if (i + batchSize < proxies.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    console.log(`处理完成，共 ${results.length} 个节点`);
    return results;
}

// 导出操作函数给Sub-Store使用
module.exports = operator;
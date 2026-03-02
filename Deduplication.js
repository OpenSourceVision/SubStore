/**
 * 各协议参与去重的字段定义
 *
 * 排除原则：
 *   - name        : 不同订阅来源节点名称不同，不参与
 *   - flow        : 仅影响客户端行为，不影响服务端认证，不参与
 *   - up/down     : hysteria 带宽限速参数，非认证参数，不参与
 *   - congestion-controller : tuic 性能参数，非认证参数，不参与
 *   - protocol-param/obfs-param : ssr 可选辅助参数，来源不稳定，不参与
 *
 * 未列出的协议使用 DEFAULT 兜底规则
 */
const PROTOCOL_FIELDS = {
  // Shadowsocks
  ss: ['server', 'port', 'type', 'password', 'cipher'],

  // ShadowsocksR：移除 protocol-param / obfs-param，来源不稳定易漏判
  ssr: ['server', 'port', 'type', 'password', 'cipher', 'protocol', 'obfs'],

  // VMess：移除 cipher（各来源写法不统一，auto/空均常见）
  vmess: ['server', 'port', 'type', 'uuid', 'alterId', 'network', 'tls', 'servername', 'path', 'host'],

  // VLESS：补充 reality-opts 中的 public-key / short-id 以支持 Reality 节点
  vless: ['server', 'port', 'type', 'uuid', 'network', 'tls', 'servername', 'path', 'host', 'reality-public-key', 'reality-short-id'],

  // Trojan
  trojan: ['server', 'port', 'type', 'password', 'network', 'tls', 'servername', 'path', 'host'],

  // Hysteria：移除 up / down（带宽限速参数，非认证参数）
  hysteria: ['server', 'port', 'type', 'auth-str', 'protocol', 'sni'],

  // Hysteria2
  hysteria2: ['server', 'port', 'type', 'password', 'sni', 'obfs', 'obfs-password'],

  // TUIC：移除 congestion-controller（拥塞控制算法，性能参数非认证参数）
  tuic: ['server', 'port', 'type', 'uuid', 'password', 'token', 'sni'],

  // WireGuard
  wireguard: ['server', 'port', 'type', 'private-key', 'public-key', 'ip', 'ipv6', 'preshared-key'],

  // HTTP / HTTPS
  http:  ['server', 'port', 'type', 'username', 'password', 'tls', 'sni'],
  https: ['server', 'port', 'type', 'username', 'password', 'tls', 'sni'],

  // SOCKS5
  socks5: ['server', 'port', 'type', 'username', 'password', 'tls', 'sni'],

  // ANYTLS
  anytls: ['server', 'port', 'type', 'password', 'sni'],

  // 默认兜底
  DEFAULT: ['server', 'port', 'type', 'password'],
};

/**
 * 对字段值做归一化处理，消除来源差异导致的误判
 * @param {string} field
 * @param {*} value
 * @returns {*}
 */
function normalizeValue(field, value) {
  if (value === undefined || value === null || value === '') return null;

  switch (field) {
    // tls: true / 'true' / 1 统一为 true，其余为 false
    case 'tls':
      return value === true || value === 'true' || value === 1 ? true : false;

    // alterId: 字符串数字统一转数字
    case 'alterId':
      return Number(value) || 0;

    // port: 统一转数字
    case 'port':
      return Number(value);

    // 字符串字段统一 trim + 小写
    case 'cipher':
    case 'network':
    case 'protocol':
    case 'obfs':
      return String(value).trim().toLowerCase();

    // 其余字段 trim 处理
    default:
      return typeof value === 'string' ? value.trim() : value;
  }
}

/**
 * 根据协议类型获取该节点的去重 key
 * @param {Object} proxy
 * @returns {string}
 */
function getKey(proxy) {
  const type = (proxy.type || '').toLowerCase();
  const fields = PROTOCOL_FIELDS[type] || PROTOCOL_FIELDS.DEFAULT;

  // 对于 vless，reality-opts 可能是嵌套对象，需展开
  const flatProxy = { ...proxy };
  if (type === 'vless' && proxy['reality-opts']) {
    flatProxy['reality-public-key'] = proxy['reality-opts']['public-key'] ?? null;
    flatProxy['reality-short-id']   = proxy['reality-opts']['short-id']   ?? null;
  }

  const keyObj = fields.reduce((acc, field) => {
    acc[field] = normalizeValue(field, flatProxy[field]);
    return acc;
  }, {});

  return JSON.stringify(keyObj);
}

/**
 * 移除数组中重复的代理节点
 * @param {Array} proxies
 * @returns {{ deduped: Array, removed: Array }}
 */
function removeDuplicates(proxies) {
  const seen = new Map(); // key -> 首次出现的节点名
  const deduped = [];
  const removed = [];

  for (const proxy of proxies) {
    const key = getKey(proxy);
    if (seen.has(key)) {
      removed.push({ proxy, keptName: seen.get(key) });
    } else {
      seen.set(key, proxy.name);
      deduped.push(proxy);
    }
  }

  return { deduped, removed };
}

/**
 * 清除代理对象中的内部属性
 * @param {Object} proxy
 * @returns {Object}
 */
function cleanProxy(proxy) {
  const { _geo, _entrance, ...rest } = proxy;
  return rest;
}

/**
 * 主处理函数
 * @param {Array} proxies
 * @returns {Array}
 */
function operator(proxies = []) {
  const $ = $substore;

  $.info(`[去重] 处理前节点总数: ${proxies.length}`);

  const { deduped, removed } = removeDuplicates(proxies);

  if (removed.length > 0) {
    for (const { proxy, keptName } of removed) {
      $.info(`[去重] 移除重复节点: ${proxy.name} (${proxy.server}:${proxy.port} ${proxy.type}) → 保留: ${keptName}`);
    }
    $.info(`[去重] 共移除 ${removed.length} 个重复节点`);
  } else {
    $.info(`[去重] 未发现重复节点`);
  }

  const result = deduped.map(cleanProxy);
  $.info(`[去重] 处理后节点总数: ${result.length}`);

  return result;
}

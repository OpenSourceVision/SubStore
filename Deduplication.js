/**
 * 移除数组中具有相同字段值组合的重复项
 * @param {Array} arr - 要处理的数组
 * @param {Array} fields - 用于确定唯一性的字段名数组
 * @return {Array} 处理后的数组，不含重复项
 */
function removeDuplicates(arr, fields) {
  if (!Array.isArray(arr)) {
    throw new Error('The first argument must be an array.');
  }

  const seen = new Set();

  return arr.filter(item => {
    const key = fields.map(field => item[field]).join('\x00')
    return seen.has(key) ? false : seen.add(key)
  });
}

/**
 * 清除代理对象中的特定属性
 * @param {Object} proxy - 代理对象
 * @return {Object} 清除了特定属性后的代理对象
 */
function cleanProxy(proxy) {
  const { _geo, _entrance, ...rest } = proxy;
  return rest;
}

/**
 * 处理代理数组，移除重复的代理并清除特定属性
 * @param {Array} proxies - 代理数组，默认为空数组
 * @return {Array} 处理后的代理数组
 */
function operator(proxies = []) {
  const $ = $substore

  $.info(`[去重] 处理前节点总数: ${proxies.length}`)

  const deduped = removeDuplicates(proxies, ['server', 'port', 'type'])
  const dupCount = proxies.length - deduped.length

  if (dupCount > 0) {
    // 找出被去重的节点名称，逐条打印
    const keptKeys = new Set(deduped.map(p => [p.server, p.port, p.type].join('\x00')))
    const seen = new Set()
    for (const p of proxies) {
      const key = [p.server, p.port, p.type].join('\x00')
      if (seen.has(key)) {
        $.info(`[去重] 移除重复节点: ${p.name} (${p.server}:${p.port} ${p.type})`)
      } else {
        seen.add(key)
      }
    }
    $.info(`[去重] 共移除 ${dupCount} 个重复节点`)
  } else {
    $.info(`[去重] 未发现重复节点`)
  }

  const result = deduped.map(cleanProxy)
  $.info(`[去重] 处理后节点总数: ${result.length}`)

  return result
}

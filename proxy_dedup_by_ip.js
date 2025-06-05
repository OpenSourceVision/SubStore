/**
 * 移除数组中具有相同IP地址的重复项
 * @param {Array} arr - 要处理的数组
 * @return {Array} 处理后的数组，不含重复项
 */
function removeDuplicatesByIP(arr) {
  // 确保传入的第一个参数是一个数组
  if (!Array.isArray(arr)) {
    throw new Error('The first argument must be an array.');
  }
  
  // 使用Set来存储已经遇到过的IP地址
  const seenIPs = new Set();
  
  // 使用filter方法过滤数组，只保留不重复的项
  return arr.filter(item => {
    // 获取server字段作为IP地址
    const ip = item.server;
    
    // 如果IP为空或未定义，跳过该项
    if (!ip) {
      return false;
    }
    
    // 如果Set中已经存在这个IP，则返回false，表示这个元素是重复的，应该被过滤掉
    if (seenIPs.has(ip)) {
      return false;
    }
    
    // 将这个IP添加到Set中，并返回true，表示这个元素不是重复的，应该被保留
    seenIPs.add(ip);
    return true;
  });
}

/**
 * 清除代理对象中的特定属性
 * @param {Object} proxy - 代理对象
 * @return {Object} 清除了特定属性后的代理对象
 */
function cleanProxy(proxy) {
  // 使用解构赋值来分离要删除的属性和剩余的属性
  // 注意：属性名以*开头需要使用引号包围
  const { '*geo': geo, '*entrance': entrance, ...rest } = proxy;
  // 返回不包含 *geo 和 *entrance 属性的代理对象
  return rest;
}

/**
 * 处理代理数组，根据IP地址移除重复的代理并清除特定属性
 * @param {Array} proxies - 代理数组，默认为空数组
 * @return {Array} 处理后的代理数组
 */
function operator(proxies = []) {
  // 使用removeDuplicatesByIP函数处理proxies数组，根据IP地址移除重复的代理
  return removeDuplicatesByIP(proxies).map(cleanProxy);
}

// 使用示例
/*
const proxies = [
  { server: '192.168.1.1', port: 8080, type: 'http', '*geo': 'US', '*entrance': 'main' },
  { server: '192.168.1.1', port: 8081, type: 'https', '*geo': 'CN', '*entrance': 'backup' }, // 重复IP，会被移除
  { server: '192.168.1.2', port: 8080, type: 'socks5', '*geo': 'JP', '*entrance': 'main' },
  { server: '10.0.0.1', port: 1080, type: 'socks5', '*geo': 'UK', '*entrance': 'main' }
];

const result = operator(proxies);
console.log(result);
// 输出：只保留第一个、第三个和第四个代理，且移除了*geo和*entrance属性
*/
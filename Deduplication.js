/**
 * 移除数组中具有相同字段值组合的重复项
 * @param {Array} arr - 要处理的数组
 * @param {Array} fields - 用于确定唯一性的字段名数组
 * @return {Array} 处理后的数组，不含重复项
 */
function removeDuplicates(arr, fields) {
  // 确保传入的第一个参数是一个数组
  if (!Array.isArray(arr)) {
    throw new Error('The first argument must be an array.');
  }

  // 使用Set来存储已经遇到过的字段值组合
  const seen = new Set();

  // 使用filter方法过滤数组，只保留不重复的项
  return arr.filter(item => {
    // 将指定字段的值组合成一个字符串，作为Set的键
    const key = fields.map(field => item[field]).join('-');

    // 如果Set中已经存在这个键，则返回false，表示这个元素是重复的，应该被过滤掉
    // 否则，将这个键添加到Set中，并返回true，表示这个元素不是重复的，应该被保留
    return seen.has(key) ? false : seen.add(key);
  });
}

/**
 * 清除代理对象中的特定属性
 * @param {Object} proxy - 代理对象
 * @return {Object} 清除了特定属性后的代理对象
 */
function cleanProxy(proxy) {
  // 使用解构赋值来分离要删除的属性和剩余的属性
  const { _geo, _entrance, ...rest } = proxy;

  // 返回不包含 _geo 和 _entrance 属性的代理对象
  return rest;
}

/**
 * 处理代理数组，移除重复的代理并清除特定属性
 * @param {Array} proxies - 代理数组，默认为空数组
 * @return {Array} 处理后的代理数组
 */
function operator(proxies = []) {
  // 使用removeDuplicates函数处理proxies数组，移除重复的代理
  // 指定要比较的字段为'server'、'port'和'type'
  return removeDuplicates(proxies, ['server', 'port', 'type']).map(cleanProxy);
}
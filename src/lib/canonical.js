/**
 * 确定性序列化：键名递归排序后输出 JSON。
 * 双端签名校验的基石——bridge 与云函数各自实现同一算法，
 * 保证任意引擎下对同一对象得到逐字节一致的字符串。
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

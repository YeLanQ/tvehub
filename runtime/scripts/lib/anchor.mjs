// 构建脚本公共守卫（唯一定义处）：锚点断言与 wasm 魔数校验。
// 约定：锚点是对产物源字面串的精确匹配，命中次数 ≠ 期望即构建失败——
// 把「产物形态漂移」从设备上首用才暴露提前到构建期。label 需能定位锚点
// （各 transform 模块头部的锚点清单即按 label 索引）。

/** 精确锚点替换：命中次数不符即抛错（期望默认 1 次） */
export function replaceExact(text, anchor, replacement, label, expect = 1) {
  const count = text.split(anchor).length - 1;
  if (count !== expect) {
    throw new Error(
      `[runtime-scripts] ${label} 锚点命中 ${count} 次（期望 ${expect}），产物源可能已变化，请人工核对`,
    );
  }
  return text.split(anchor).join(replacement);
}

/** 断言 wasm 魔数（\0asm + 版本 1），抽取正确性的最后防线 */
export function assertWasmMagic(bytes, label) {
  const magic = [0, 0x61, 0x73, 0x6d];
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== magic[i]) throw new Error(`[runtime-scripts] ${label} wasm 魔数不符（抽取逻辑漂移）`);
  }
  if (bytes[4] !== 1) throw new Error(`[runtime-scripts] ${label} wasm 版本非 1`);
}

/** 产物形态断言（微信 CJS bundle）：输出里不允许任何 import()/import 语句/
 *  裸 export 存活——微信沙箱内动态求值全灭，cjs 形态是硬约束 */
export function assertCjsOutput(text, label) {
  const dynamicImport = text.match(/[^.\w$"']import\s*\(/);
  if (dynamicImport) {
    const at = dynamicImport.index;
    throw new Error(`[wechat-bundle] ${label} 存活动态 import: …${text.slice(Math.max(0, at - 60), at + 60)}…`);
  }
  if (/(^|[;{}\n])\s*import\s*["']/.test(text) || /(^|[;{}\n])\s*export\s+\{/.test(text)) {
    throw new Error(`[wechat-bundle] ${label} 存活 ESM import/export 语句`);
  }
}

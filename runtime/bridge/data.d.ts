// data.js 形态声明：导出期 Rust 生成的 CJS 模块（不入库——esbuild 标记 external，
// 产物内保留运行期 require("./data.js")）。此声明只服务类型检查（moduleResolution
// 把 "./data.js" 解析到本文件）；运行期形态以导出期为事实源，多出的键经索引兼容。

declare const data: {
  config: Record<string, unknown>;
  assets: Record<string, string>;
  assetFiles?: Record<string, string>;
};

export default data;

// 构建脚本公共 esbuild 选项（唯一定义处）：渠道 bundle 的统一构建口径。
// charset:"utf8" 是硬约定——默认 ascii 会把 wasm 内嵌字符串与非 ASCII 文案
// 转成 \uXXXX 转义，体积膨胀 ~20%（jolt/ammo 实测）。
import esbuild from "esbuild";

/** CJS 渠道 bundle 的统一 esbuild 选项（overrides 覆盖同名键） */
export function cjsBundleOptions(overrides = {}) {
  return {
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    minify: true,
    legalComments: "none",
    charset: "utf8",
    logLevel: "warning",
    ...overrides,
  };
}

/** esbuild.build 的薄包装（类型补全与未来公共钩子的挂点） */
export function esbuildBuild(options) {
  return esbuild.build(options);
}

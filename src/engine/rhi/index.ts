// RHI 公共出口：类型 + 注册表（零 three 依赖——具体后端在 backends/ 下，
// 由消费方显式注册，见 backends/three/index.ts）。
export * from "./types";
export * from "./registry";

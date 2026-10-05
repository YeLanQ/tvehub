// vendored three 构建的类型垫片：运行时 import 的 ../core/three.module.min.js
// 由构建期从 three 同版本 vendor 而来（仓库内不存在实体文件），此声明让
// vue-tsc 按 npm three 的类型解析该模块（纯类型文件，esbuild 不参与编译）。
export * from "three";

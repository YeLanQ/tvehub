// 文档窗口入口（全局单例：Tauri 窗口 label "docs"，加载 public/docs 静态文档站）：
// 与首页同级的全局工具窗口，不绑定项目；由首页「开发者服务」等文档入口打开
// （show_docs_window，单例不存在则建、存在则聚焦）。打开指定文档页走双通道：
// take_pending_docs_hash 冷启动拉取兜底 + tve:docs-open 事件热直达（Rust 侧
// emit_to，窗口已就绪时必达）。
import { createApp } from "vue";
import DocsWindowApp from "./docs-window/DocsWindowApp.vue";
import "./styles/global.scss";

createApp(DocsWindowApp).mount("#app");

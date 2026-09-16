/// <reference types="vite/client" />

/** 应用显示版本（vite.config.ts 构建期注入；来源 src-tauri/tauri.conf.json 的 version，+N 规范为 .N） */
declare const __APP_VERSION__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// 由 scripts/gen-web-preview-files.mjs 自动生成（vite 启动/构建与 pnpm build
// 时重建；请勿手动编辑。微信小游戏渠道专用清单，与 web-preview 清单互相独立）
export interface WechatRuntimeFile { key: string; rel: string; }
export const WEB_WECHAT_RUNTIME_FILES: WechatRuntimeFile[] = [
  {
    "key": "code.js",
    "rel": "exports/wechat/runtime/code.js"
  },
  {
    "key": "engine/core/tve.js",
    "rel": "exports/wechat/runtime/engine/core/tve.js"
  }
];
export const WEB_WECHAT_RAPIER_FILES: WechatRuntimeFile[] = [
  {
    "key": "engine/runtime/physics-engines/rapier.js",
    "rel": "exports/wechat/runtime/engine/runtime/physics-engines/rapier.js"
  }
];

# runtime/ — 运行时统一目录

游戏运行时的唯一管理入口：本体（player + engine）只有一份，各渠道通过桥接层
接入；构建/生成脚本统一在本目录。渠道拓扑与各层职责如下。

## 渠道拓扑

| 渠道 | 平台宿主 | 接入形态 | 构建 |
| --- | --- | --- | --- |
| web | 浏览器（编辑器 iframe / 产物页） | **零桥接**：原生 ESM 多文件，入口 `public/web-preview/player.mjs` 直接自启 | `runtime/scripts/engine.mjs` 产出 public/engine + 产物按多文件/单页落盘 |
| wechat（微信小游戏） | wx 小游戏沙箱 | `bridge/entries/wechat.ts`：平台端点注册 → 桥接核心安装 → player | `runtime/scripts/wechat.mjs` 产出 `public/exports/wechat/runtime/`（code.js 单文件 CJS bundle） |

新渠道（抖音小游戏 / 原生壳等）= 平级新增 `bridge/platforms/<id>.ts`（实现
24 方法 + platformId 标识的 `HostEndpoint` 契约，HOST_SURFACE 台账 25 项，
见 `bridge/contract.ts`）+ 一份组装入口，核心零改动。

## 目录导览

```
runtime/
├── bridge/                 桥接层（TS 源码；构建时由 esbuild 转译打包生成 js）
│   ├── protocol.ts         运行时协议单源：__tve* 钩子名 / tve: 前缀 / 包内路径约定
│   ├── contract.ts         契约：HostEndpoint 接口 + HOST_SURFACE/GLOBAL_SURFACE
│   │                       清单 + assertHost 注册期校验
│   ├── host.ts             端点容器（setHost/host/bridgeActive；缺席 = 核心空转）
│   ├── install.ts util.ts  安装机器与共享工具
│   ├── env/canvas/dom/…    桥接核心（window/document/画布/HTTP/事件/音频/存储
│   │                       等浏览器形态装配，全部经 host 取平台能力）
│   ├── platforms/wechat.ts 微信端点（全部 wx.* 收敛于此）
│   ├── entries/wechat.ts   渠道组装入口（求值序 = 安装序，player 最后）
│   ├── check-surface.mjs   漂移守卫：统一运行时源码的全局消费面对照覆盖清单 +
│   │                       surface-baseline.json 台账；新增未覆盖 = 构建失败
│   │                       （独立 npm script：pnpm check:surface）
│   ├── bridge.spec.mjs     契约一致性测试（node 类型剥离直跑 TS；pnpm test:bridge）
│   └── smoke.cjs           bundle 冒烟（裸包装脚本语义加载 + 门面可达性）
└── scripts/                运行时构建/生成脚本
    ├── lib/                公共件：paths（目录单源）/ fs（幂等写）/ anchor（锚点
    │                       与形态断言）/ esbuild（统一构建选项，charset utf8）
    ├── engine.mjs          src/runtime/** → public/engine（ESM 多文件，双渠道共用；
    │                       verifyOutput 内建产物形态断言）
    ├── wechat.mjs          bridge + engine + player → 微信渠道 bundle（编排；实现
    │                       拆在 wechat/：engines 物理预转换、meshopt、transforms
    │                       锚点改写、guards 三连守卫）
    └── manifest.mjs        双渠道运行时清单 → src/generated/channel-runtimes.ts
```

## 运行时供给链

```
runtime/scripts/manifest.mjs
  → src/generated/channel-runtimes.ts（双渠道 base + 条件组，含每文件 fetch URL）
  → src/app/lib/runtime-supply.ts（统一拉取：缓存 + HTML 兜底守卫 + 条件组映射）
  → 预览面板 / 构建导出（web 与 wechat 同一通道）
```

`src/app/lib/web-preview-runtime.ts` 是 runtime-supply 的全量 re-export 门面，
历史消费者 import 无需改动。

## 导出内容一致性

Rust 侧 `src-tauri/src/build/kernel/content.rs` 是渠道无关的「导出内容内核」（场景收集
+ 引用资产 + release 处理），web/wechat 管线都只消费它的产物做包装；跨渠道一致
性（场景清单/资产集合/缺失/release 生效/内容字节）由
`src-tauri/src/build/tests/consistency_e2e.rs` 守护。

## 修改指引

- 改桥接核心/端点：`node runtime/scripts/wechat.mjs`（漂移守卫 + 契约测试 + 冒烟
  三连）；dev 下 vite watcher 监听 runtime/bridge 自动重建。
- 引擎新增浏览器 API 消费：先过 check-surface——未覆盖会在构建期红，扩核心或入
  台账，不要等设备报错。
- web 渠道刻意零桥接（浏览器即宿主）；不要给 web 运行时引入桥接依赖。

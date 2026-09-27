# 架构：RHI / RPI / Framework / App / Runtime 分层

引擎的渲染栈按「底层实现 → 硬件抽象 → 管线抽象 → 引擎功能 → 应用组装」
组织。设计目标：**后端渲染接口（three.js 或未来的自研/其他图形库）升级或
更换时，只需适配 `src/engine/*/backends/` 下的实现，引擎上层功能不改**。

```
┌─────────────────────────────────────────────────────────────┐
│ App 层   src/app                 编辑器应用（Vue 壳/面板/命令） │
│          ↳ editorService 选定渲染后端偏好 → engine.mount       │
│ Runtime 层 src/runtime + public/web-preview/player.mjs        │
│          播放运行时组合根（stage 创建设备+管线，player 驱动帧） │
├─────────────────────────────────────────────────────────────┤
│ Framework 层 src/framework       可复用引擎功能与通用机制       │
│   engine/RendererManager  编辑器视口策略（空闲降帧/尺寸节奏/   │
│                           阴影按需重画），设备与管线全走 RHI/RPI │
│   prototype/ scene/       数据模型（零渲染库依赖）             │
│   material/ mesh/ physics/backend/ …  注册表工厂模式           │
├─────────────────────────────────────────────────────────────┤
│ RPI 层   src/engine/rpi          渲染管线标准接口              │
│   types.ts               RPIViewDesc / RPIPipeline            │
│   layerSet.ts            分层多 pass 纯逻辑（零渲染库依赖）     │
│   backends/three/        three 管线实现（清除/分层/离屏/回贴）  │
├─────────────────────────────────────────────────────────────┤
│ RHI 层   src/engine/rhi          渲染硬件抽象                  │
│   types.ts               RHIDevice（接口零渲染库类型，载荷透传）│
│   registry.ts            后端工厂注册 + auto→WebGPU→WebGL 回退 │
│   backends/three/        WebGL / WebGPU 设备实现（唯一直接     │
│                          import three 的位置）                 │
├─────────────────────────────────────────────────────────────┤
│ 共用基础 src/platform_abstraction（eventBus/id/logger，零依赖）│
└─────────────────────────────────────────────────────────────┘
```

## 依赖规则（由 `pnpm check:layers` 门禁强制）

1. **Tauri IPC**：`@tauri-apps/api/core` 只允许 `src/lib/`（门面）。
2. **渲染库解耦**：直接 import three（裸 `three` / `three/webgpu` /
   `examples` / vendored `three.*.min.js`）只允许
   `src/engine/{rhi,rpi}/backends/` 与存量台账
   `scripts/layers-three-allowlist.json`（只减不增；批量迁移用
   `node scripts/check-layers.mjs --update-three-allowlist` 重建）。
   **新增文件不得直接依赖渲染库**——设备操作走 RHI，渲染流程走 RPI。
3. **engine 层方向**：`src/engine` 不依赖 framework/app/runtime/UI 包
   （vue/tauri 等）；层内只准向下（rpi → rhi，禁止反向）。

## 双轨消费

- **编辑器轨**：`src/app` → `EditorEngine.mount` → `RendererManager`
  （framework）→ `createRHIDevice` / `createRPIPipeline`。遗留 WebGL 专属
  路径（nishita 天空 LUT 等）经 `device.native` 逃生口，不扩散。
- **播放轨**：`src/runtime/runtime/stage.ts` 创建设备+管线（构建时
  `src/engine` 源码内联进 `public/engine/runtime/stage.mjs`，three 外部化
  为 vendored 构建）；`player.mjs` 帧循环调 `pipeline.renderView` /
  `pipeline.renderOverlay`，设备面（预热/统计/阴影开关）走 `RHIDevice`。
  两条轨道消费**同一份** RHI/RPI 源码，无镜像维护。

## 物理（参照样板）

物理后端（rapier / jolt / ammo）此前已完成引擎无关抽象
（`src/framework/physics/backend/`：IPhysicsWorld + 后端工厂注册表），
与 RHI 同一模式；其残留 three 依赖仅存在于「Object3D 位姿读写 + 几何
采样」两个接缝（PhysicsSystem / colliderShape），随台账逐步收缩。

## 迁移状态（台账口径）

场景内容层（SceneSynchronizer 的对象/材质/灯光构建、AnimationSystem
骨骼、模型 Loader）仍直接使用 three（见台账）——它们经「不透明载荷」边界
穿过 RHI/RPI，替换渲染库时需随后端适配一并迁移；渲染设备面与渲染管线面
（本仓库全部两处渲染调用路径）已完成 RHI/RPI 化。

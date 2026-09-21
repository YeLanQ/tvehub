# 单元：地形（程序化设置 + 绘制模式）

## 操作面：程序化地形（TerrainSection 检查器）

- 绑定/解绑 **.terrain 资产**（新建：资产面板右键「新建地形」默认程序化山地）；
  修改程序化参数 → 「保存回 .terrain」（后端 terrain_write 落盘 + 补 .meta）。
- **Heightfield 参数组**：seed（可随机）/ 尺寸 / 网格密度 / 起伏 heightScale /
  频率 / 分形层数 octaves / 频率步进 lacunarity / 振幅步进 gain / 导数阻尼 erosion /
  域扭曲 warp / 谷地压平 valleyBias / 海平面 / 热侵蚀 talus(+passes)。
- **Surface**：草地/岩石/积雪三色（烘焙顶点色）。
- 绑定 **.terrainmat**（4 纹理图层 + splatmap + 全局 PBR；新建：右键「新建地形材质」）。
- **生成 Splatmap**（:272）：按海拔/坡度烘 RGBA 权重纹理 → 写
  `assets/..._splat.png` → 更新材质引用——**绘制模式的前置**。

## 操作面：地形绘制模式（editor.terrainPaint toggle）

- 入口：视口「绘制」按钮或命令；**前提 = 场景视图 + 地形已绑材质并生成 Splatmap**
  （editorCommands.ts:96）；再执行一次或点「退出」结束；激活期间 W/E/R 失效。
- 浮动笔刷面板（Viewport.vue:237）：
  - **雕刻**页签：抬升 / 压低 / 压平 / 平滑（写高度偏移层，经 patchNode 可撤销）；
  - **权重**页签：材质层 1-4 按钮（层色取自材质层色）+ **擦除**（该层权重清零
    转移回其余层）；
  - 笔刷大小 0.5–40m、强度 5–100%；贴地圆环光标。
- 交互接管：左键 = 笔刷（轨道相机左键旋转禁用；右键平移/滚轮缩放保留）。

## 规则/要点

- 落盘链：paint 会话盖 splatmap 工作缓冲 → 抬笔提交/100ms 节流 → PNG base64 →
  `api.writeAssetBinary` → 引擎缓存失效重载（terrain-paint-io.ts:1）。
- 脚本侧贴地查询：`TerrainNode.sampleHeight/sampleSlope`（模板见
  `tve-sdk-scripting` physics-collision.md）。
- 程序化生成的确定性由 seed 保证（同参数同地形）；运行时烘焙：
  `bakeTerrainHeights`。

## 测试例

- 地形纯逻辑是**核心桶**（90/85）且有 4 个真实 spec：
  `src/framework/terrain/types.spec.ts`（parse 钳制/颜色收敛）、`generate.spec.ts`
  （seed 确定性/产物）、`paint.spec.ts`（世界↔像素换算/stampSplat 权重守恒/擦除）、
  `sculpt.spec.ts`（base64 编解码往返）。
- smoke P1 的 `terrain` 套件为已知契约漂移（对照 tests/ISSUES.md）。

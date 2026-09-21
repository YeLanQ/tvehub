# 单元：预览 / 构建 / 项目设置 / 首页 / 共享

## 操作面：预览（WebPreviewPanel）

- 进入「预览」页签（或 `preview.open`）自动完成：保存场景 → 导出运行时 +
  scene.json + project.config.json 到 `<项目>/.tmp/web-preview` → 启动本地静态
  服务 → iframe 嵌入。
- 操作：**刷新**（重新导出并重载）、**在浏览器打开**、**停止预览**（释放端口）、
  **调试**按钮（postMessage `__editorPreviewDebug` 切运行时统计）——运行时内嵌
  页面另支持 **F3**（player.mjs:878，iframe 聚焦时生效）。
- 设备仿真：iPhone SE/14/15 Pro、安卓 360×800、Pixel 7、iPad 系列 + 自定义
  宽高/DPR/朝向/缩放（偏好持久化 `tve:web-preview-device:`）。
- 关闭面板自动回 scene 视图；`preview.screenshot`（devtools）截视口 PNG。

## 操作面：构建导出（BuildPanel）

- 入口：工具栏「构建」。左栏渠道：**Web（支持）** / 微信小游戏（占位禁用）。
- 通用：构建场景多选（默认全选）+ 主场景。
- 渠道设置：导出模板多选（**多文件/单页互斥**）、页面标题、**调试/发布互斥**
  （发布 = uid 重命名 + 引用重写 + JSON 压缩）、gzip 资产归档、CDN 模式
  （three 不内嵌）+ gzipBase/cdnBase。
- 「构建」→ 后端打包 `<项目>/build/<渠道>/` → 结果区产物信息 + 缺失资产清单 +
  「打开构建目录」；**构建产物预览**（服务 build/<渠道> + iframe）。
- 配置持久化项目根 `build.config.json`。

## 操作面：项目设置（ProjectSettingsPanel，工具栏 ⚙）

写 `project.config.json`：基础信息（名称/版本/描述/主场景/入口脚本）；显示与运行
（设计分辨率/方向/缩放模式/HDR·LDR/抗锯齿 MSAA 0·2·4·8/渲染后端 WebGPU·WebGL
——改后端重载视口生效）；物理（启用开关/ammo·jolt·rapier/重力 XYZ——即时生效）；
资源（Draco 压缩/Basis 纹理压缩）；标签与 32 层表（添加层占最低空闲索引，
删除 = 清空索引）。

## 操作面：首页（HomeView，7 分区）

projects（打开/新建/卡片 ⋯：在文件夹中显示/重命名/移到垃圾篓/移除记录；卡片
右键「打开场景图」）；templates（模板清单）；workshop（创意工坊两栏：分类标签 =
repos 目录，code/effect 原型可增删改，只读分类仅打开目录）；prefs（主题/默认项目
位置/关于与许可）；dev（开发者服务启停/工具权限逐个开关/MCP 配置复制）；whiteboard
（见 whiteboard-files.md）；lan（共享服务卡片/条目二维码/启停/删除/访问统计）。

## 操作面：局域网共享

- 编辑器侧：工具栏「共享」→ 先 build web 单页 gzip 到 `.tmp/share` → 分享弹层。
- 服务配置：`lanShareSetConfig`（端口/网卡/口令/自动启动/允许下载），启停
  `lanShareStart/Stop`；发布 = `lanSharePublishSite`（整站覆盖）；访问统计内存态。

## 测试例

- 构建/预览 IPC 调用点：`src/app/lib/build-export.ts:271`、WebPreviewPanel.vue:293
  （契约见 `tve-api-usage` facade-tasks-build.md，含浏览器分支示范 spec）。
- 项目设置解析收敛真实落点：`src/app/stores/project.ts:135 applyProjectConfig`
  （缺字段回默认）——无 spec，推荐示范见 facade-projects.md 测试例段。
- 产物链路回归：`pnpm test:regression:core`（P0 全绿，含 runtime 模块导出面）。

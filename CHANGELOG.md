# 更新日志

本文件由 scripts/gen-changelog.mjs 从 Conventional Commits 自动生成，**请勿手改**。

- 全量再生：`pnpm changelog`（发版提交 `chore(version): vX.Y.Z` / git tag 即发布锚点）；
- `pnpm version:bump auto` 按未发布提交的类型自动递增版本（feat→minor、fix→patch、
  破坏性→major，0.x 阶段破坏性按 semver 惯例只升 minor），并把新版本段写进本文件。

## v0.1.3+1（2026-09-21）

### 新特性
- **whiteboard**: 形状支持图片填充（填满/适应/拉伸/平铺）
- **editor**: draco 压缩/添加物理组件未开项目开关时气泡提醒（可直达项目设置）
- **share**: 共享改用单页 gzip 打包，产物落 .tmp/share
- **share**: 编辑器工具栏「共享」——网页预览发布到局域网（目录引用）
- **share**: 局域网产物共享（统一配置 / 地址二维码 / 白板放映页分享）
- **ui-kit**: 统一气泡通知——替换 alert 与四处散落提示
- **whiteboard**: 切页动画接入缓动曲线（与元素动画共用一份曲线表）
- **whiteboard**: 放映期间图层裁到画板内，可见区域只有白板
- **whiteboard**: 幻灯片放映——图层当页播放（浮动工具/四种切换/三种驱动）
- **whiteboard**: 文本排版改造——语法富文本、字形与描边，并修斜体不生效
- **workshop**: 编辑器导入工坊内容按源文件名直接落盘，不再弹命名窗
- **licenses**: 第三方依赖许可证统一管理 + 首页「关于」动态许可清单
- **whiteboard**: 白板资产管理——时间轴/标签/归档/删除，尺寸预设与标题栏调整
- **whiteboard**: 全局单例白板窗口——绘制/图层/富文本，首页白板分区入口

### 问题修复
- **lanshare**: 子进程加 CREATE_NO_WINDOW，修 Release 共享页弹空窗
- **runtime**: 真机触摸拖拽被浏览器手势取消——画布禁用触摸手势与页面缩放
- **gizmo**: 布局视口变换工具不再随视图缩放膨胀（移除反向 zoom 补偿）
- **shadow**: 运行时补齐阴影相机贴合与自动 normalBias，修掠射条纹与边缘锯齿
- **share**: 放映页全屏改纯净放映——画布满幅，消除上下黑边
- **ui**: 装载蒙版进度条回滚（已完成阶段被重复汇报拉回进行中）
- **ui**: 白板画布浮动工具条图标被内边距压小（声明 18px 实际只画 12px）
- **ui-kit**: ComboBox 打开即展示全量候选，修正与组件契约不符的过滤时机
- **ui**: 移除 index.html 中失效的 /vite.svg 图标引用
- **dev**: dev 启动/服务期三类故障修复（资产直出、compiler 预置、engine 产物按内容落盘）
- **preview**: HTML 兜底页拦截不得误伤产物自带的 index.html（预览/构建取数失败）
- **dev**: 运行时资产缺失不再被 SPA 兜底成 HTML，杜绝 Worker Blob 里的神秘 SyntaxError
- **preview**: 运行时文本抓取识别 dev SPA 兜底 HTML，避免内联成 blob 后神秘 SyntaxError

### 重构
- **share**: 移除「共享一个目录」卡片与目录共享创建链路
- **workshop**: 导入脚本原样落盘，移除 {{CLASS_NAME}} 注入与类名-文件名同步
- **repos**: public/repos 转为独立子模块（TvEHub-Repos，MIT）
- **engine**: public/engine 转为纯构建产物目录，不再入库跟踪
- **engine**: 手动维护的外部资产迁入 src/runtime/extra，构建期自动拷入 engine

### 文档
- **license**: docs 子模块补 MIT 许可 + 指针前移至 26607f9
- **readme**: 仓库结构标注 public/docs 为 submodule（TvEHub-Docs）+ 快捷键 F 聚焦

### 测试
- **vitest**: 接入 vitest 组件测试，挂进 dev/build 门禁
- **smoke**: 统一入口 pnpm smoke + 套件集中 scripts/smoke/tracker

### 其他
- **version**: 版本自动同步脚本挂进 dev/build 链
- **tauri**: Rust crate 更名 tve-hub，对齐产品名与版本
- **submodule**: repos 指针更新至角色控制器移动方向修复
- 合入 forge-kp-2 的 dev 修复与类型检查口径更新
- **types**: 修正 vite.config.ts 的类型检查口径（allowJs + node 工程补 target/lib/types）
- 合入 forge-kp-2 的 smoke 测试统一入口与 README 更新
- public/docs 注册为 submodule——接通 TvEHub-Docs 双边同步
- public/docs 拆分为独立文档仓库（TvEHub-Docs）

## v0.1.2.2-forge（2026-09-19）

### 新特性
- **assets**: 资产面板可拖拽模型/预制体到视口——接通面板外落点分派
- **mesh**: 新增 Quad 基元——竖直公告牌片与 Plane 地面语义配对
- **app**: 便携式数据落盘——release 数据/缓存随 exe 走 data/ + dock 布局键去除旧应用名

### 问题修复
- **assets**: 拖放资产落在视口松开位置——拾取换算落点并贯通创建链路
- **inspector**: 资产下拉随项目就绪自动加载——修属性面板材质/脚本列表为空
- **mesh**: Plane 创建默认地面尺度 10×10——scale=1 时与 1×1 的 Quad 一眼可辨
- **mesh**: plane 基元按地面语义重建——平躺 XZ、法线 +Y、10×10 细分

### 性能优化
- **inspector**: 资产预览复用渲染器——修选择资产卡一帧

## v0.1.2.1（2026-09-19）

### 新特性
- **graph**: 行为树容器补全——selector/parallel 模式、条件配对、帧驱动步进与周期重跑
- **graph**: 状态机容器迁移守卫与同状态去重——多状态切换可控
- **graph**: 追击目标按导航网格自动寻路——绕行障碍不再直线穿墙
- **graph**: 中断开关 flow.gate——控制流通断中断下游执行链与帧驱动器
- **graph**: 原型卡「接入」口——图数据/实体直传脚本 + 脚本卡属性默认值兜底
- **graph**: 属性路径通用化 + 获取子级卡 + 卡片去重与执行日志
- **graph-window**: 控制台 dock 与场景面板 — 引擎日志落面板 + 布局装载修复
- **graph**: 场景图系统模块化重构 — 模块/驱动/原子注入与动态扩展
- **build**: 预览/构建注入场景图 — script-graph.json 随产物下发并在 config 标记启用
- **graph**: multi 入端口多入汇聚 — 目标/路径点保留不同源多条连线
- **graph**: 追击驱动器联动导航 — 追击时暂停目标代理巡回，脱离后恢复
- **graph**: 场景图架构完善 — 组件化原型卡/逻辑容器/驱动器/导航运行时
- **graph**: 图窗口多会话化 — 动态 graph-N 窗口，关闭即销毁
- **boot**: 蒙版扩展为全产物装载，最短显示 + 深色原生底消除开窗白屏
- **editor**: 多会话架构 — 每个项目独立编辑器窗口
- **perf**: 多窗口多线程/进程架构优化 — 5 阶段并行化重构
- **window**: 移除系统边框，自定义标题栏/窗口控制按钮，编辑器与图窗口工具栏合并
- **graph**: 脚本图蓝图编程系统 —— 节点类型注册表重构 + 执行链级联 + 数据流求值 + 控制流 + 数学节点库 + 可扩展自定义节点
- **assets**: 资产面板过滤状态（搜索/类型/排序/视图）写入共享键 —— 脚本图窗口的资产面板跟随同一份过滤（storage 事件跨窗口同步，键按项目隔离）
- **graph-window**: 补 lib.rs 的 show_graph_window 命令与注册（脚本图窗口显示入口）
- **graph-window**: 脚本图独立窗口与工作台 ——…
- **hub**: 项目卡片右键「打开脚本图」—— show_graph_window 显示图窗口并经 graph:project-open 事件移交项目，graph:ready 握手补发免启动时序竞态
- **scene**: 场景会话按场景 rel 分键，命令按调用窗口当前指针路由 —— 同一场景全窗口共享同一份会话数据（含未保存修改，跨窗口实时一致），不同场景各自会话互不产生命令冲突；scene:changed 载荷带 rel…
- **runtime**: 脚本图行为解释器与播放器注入钩子 —— graph-behaviors 按 userData 节点id/标签/类型解析目标实体，启动设值、每帧旋转浮动、点击显隐与 FSM 事件（语义对齐 engine.logic）；player.mjs…
- **graph**: 统一脚本图会话模型与原子操作目录 —— 原型（拖入实体生成）/匹配（标签|类型批量圈定）/操作三类节点 + 实体集与执行链双通道连线 + normalizeGraphDoc 收敛装载 +…

### 问题修复
- **graph**: 行为树容器可退出——嵌套容器可打状态归属 + 显式「退出」口
- **graph**: 嵌套容器随父级调度——状态机内的行为树随状态启停
- **graph**: 路径巡逻/追击目标朝向移动方向——按本帧位移写 yaw（可关）
- **runtime**: 批处理排除沿父链传播——可动父节点下的子网格跟随移动
- **runtime**: 批处理烘焙前刷新场景世界矩阵——同材质网格不再烘到错误位置而消失
- **build**: Release 打包漏重写逻辑运行器资产引用——状态机/行为树空转
- **graph-window**: 注释框选中框与内容两层尺寸脱节
- **graph-window**: 画布工具条按钮竖排换行——禁收缩 + 不换行
- **graph-window**: 层级拖入画布失效——图窗口禁用 Tauri 原生拖放拦截
- **preview**: 图驱动实体排除静态批处理 + 装配诊断走引擎日志通道
- **task**: 消除 dead_code 警告 — 导出流程真正走 TaskHandle，Priority 标注为跨端预留
- **preview**: 移除预览/构建默认注入的环境光与天空盒半球光
- **nav**: 移除导航代理的蓝色锥体占位渲染
- **terrain**: 默认 segments 改为 256（2 的幂），新建地形默认持有顶点优化
- **preview**: 预览服务器按窗口分键 + 临时端口，多会话不再串台
- **window**: 移除 --force-high-performance-gpu，修复混合显卡下黑闪
- **boot**: 打开项目先布防蒙版再挂载，修复兜底项目/编辑器骨架闪现
- **audio**: 编辑器不自动播放 autoplay + 窗口关闭/项目关闭停止音频
- **home**: 重命名项目改用 ui-kit prompt 弹窗，首页窗口补挂 PromptDialog
- **window**: 窗口关闭时布防蒙版，修复再次打开旧场景闪现和图窗口卡蒙版
- **graph**: 修复变量重命名回车后仍为原名
- **assets**: 统一两窗口资产过滤 —— 后端扫描隐藏内部产物 + 过滤跟随键对齐
- **graph**: 图窗口资产面板过滤 .json 文件（脚本图保存产物不再干扰资产浏览）
- **scene**: 跨项目同 rel 会话误复用 —— scene_open 只按 rel 分键复用会话未校验 root，新建项目复用 assets/Main.scene 时误开其他项目场景；复用前校验 core.root_path 与当前 root…
- **window**: 图窗口关闭后无法打开 —— on_window_event 未处理 graph 窗口关闭走默认销毁，get_webview_window 返回 None 无法再 show；加 CloseRequested 分支 prevent_close…
- **scene**: 修复首次打开项目显示兜底场景 —— 根因：编辑器窗口启动时兜底场景以默认 rel 落键污染会话表，首次打开同名真实场景时 scene_open 复用兜底不读盘；无项目时改不携带 rel 走 Rust 哨兵键…
- **script**: 相机打射线无法选中碰撞体 —— 射线拾取链路五处断点：① engine.physics.castRay 未桥接（engine-api physicsApi 缺 castRay 方法，脚本调用即…

### 重构
- **graph**: 「脚本图」更名「场景图」（与场景绑定的行为图，更贴合设计概念）
- **dock**: 统一编辑器/图窗口停靠系统为 src/docks 共享工厂
- **graph**: 脚本图文件后缀改为 .graph，文件名取场景名不再嵌套路径（assets/Main.scene → graph/Main.graph）
- **graph**: 脚本图保存路径从 .tve/script-graph/ 旁路改为 graph/ 目录（与 assets/src 同级）
- **window,scene**: 窗口+会话架构统一重构 —— 会话键从纯 rel 升级为 SessionKey(root,rel) 复合键根除跨项目同 rel 冲突，scene_close 引用计数避免多窗口共享场景一关全毁；窗口生命周期改声明式…
- **ui-state**: 界面状态持久化彻底告别 localStorage，改走后端 UI 状态 KV —— 新增 ui_state.rs（app_config_dir/ui-state/ 每键一文件、键名 %XX 转义、临时文件原子写）+…
- **ui**: 关于面板显示版本改自动注入不再手工维护 —— vite 构建期读 src-tauri/tauri.conf.json 的 version（exe 文件版本唯一来源）注入 __APP_VERSION__（+N 规范为第 4 段…

### 文档
- **readme**: 添加支持我们章节——请求 Star 与赞助（渠道链接占位待补）
- **readme**: README 更新为 kp-2——场景图重大更新、多会话客户端重构与已知缺陷
- **graph**: 新增场景图章节文档，补充索引与总览入口
- **readme**: 新增产品哲学一节 ——…

### 测试
- **graph**: 脚本图冒烟测试 —— 会话模型收敛/操作目录/场景会话分键与 rel 事件/窗口与能力契约/无图资产回归断言

### 其他
- 图容器文本不换行
- 修复容器无法取消选中
- 产物更新
- 导航锥体渲染移除
- 语义更新
- **inspector**: 音频资产预览改用自定义播放器，参考 Uixder 样式
- **graph**: 变量/自定义节点面板补齐布局结构（检查器观感对齐）
- **graph**: 图画布背景改为点阵（暗底等距小点）
- **deps**: 引入 Vue Flow 与配套插件依赖 —— @vue-flow/core/background/controls/minimap/node-resizer（脚本图画布），批准 vue-demi 构建脚本（pnpm-workspace…
- **app**: exe 文件版本升至 0.1.0.1 —— tauri.conf.json version 改 0.1.0+1（tauri-build 把 semver build metadata 取作 winres 四段文件版本第 4…
- **ui**: 关于面板显示版本升至 v0.1.0.1 —— 第 4 段为构建号，semver 版本（package.json/tauri.conf.json/Cargo.toml）保持 0.1.0 不变（Cargo 版本字段不支持 4…

## v0.1-forge（2026-09-16）

### 新特性
- **logic**: 状态机/行为树落地引擎 —— 新增 fsmRunnerNode/btRunnerNode 运行器节点（层级「逻辑」分组，设置=资产绑定/autoStart/时间倍率，运行态不序列化）+ framework/logic…
- **input**: engine.input 支持多点触控与多键查询 —— keys 全部按下键集合视图；pointers/getPointer 按 pointerId 分触点 + onPointerCancel（系统抢占后不再有 up）；pointer…
- **nav**: 导航代理目标点改为节点多选 + 移动模式选择 —— NavAgentSettings 加 targetIds/moveMode(sequence 巡回+loop 循环)/nearest 最近可达(按路径折线最短) + 引擎…
- **nav**: 导航区域支持任意网格采样源（nav mesh）—— terrainId→sourceIds 多选(旧场景自动迁移) + meshField 三角形光栅化高度场(顶面优先 2.5D 合并地形) + 引擎多源…
- **terrain**: 地形笔刷 —— splatmap 材质层绘制 + 高度雕刻（抬升/压低/压平/平滑）
- **material**: 模型内嵌材质提取为 .mat 资产 + MeshNode 按槽位材质覆盖
- **nav**: 导航系统（地形烘焙可行走网格 + SDF 寻路 + 代理移动）+ 导航节点与检查器
- **logic**: .fsm 状态机 / .bt 行为树逻辑资产 + 可视化编辑器 + framework 运行时
- **terrain**: .terrainmat 资产类型 + splatmap 4 层混合 + 导出收集 + 资产面板复制路径
- **resource**: 统一 ResourceLoader + AssetBundle 资源加载层，HTTP 引导替代 file://
- **debug**: 编辑器+预览视口渲染调试统计面板（FPS/DrawCall/网格/顶点等）
- **animation**: 骨骼动画 + IK 移入 Worker 线程（与物理 Worker 同模式）
- **physics**: 物理引擎移入 Worker 线程 + terrains 序列化修复
- **export**: 资源配置标签页 + 压缩解码器按需打包
- **model**: Draco 压缩全闭环（编辑器压缩工具 + 压缩 glTF 加载支持）
- **app**: 项目装载蒙版（Manager 打开项目 → 资产/场景装载进度，就绪后揭幕）
- **fog**: 高度雾（雾组第三类型：exp2 距离衰减 + 海拔衰减）
- **fog**: 场景环境雾（雾节点 + 线性/指数雾类型）
- **physics**: 地形高度场碰撞（heightfield 碰撞体形状）
- **terrain**: 程序化地形系统（地形节点 + .terrain 资产）
- **ui**: SortOrder 层级继承与 UI 节点换父位置补偿
- **script-editor**: 脚本类型自动导入与全项目模型镜像
- **repos**: 新增虚拟摇杆与角色控制器原型
- **repos**: 完善创意工坊代码原型（2 升级 + 7 新增）
- **scripting**: 脚本组件新增 onFixedUpdate / onLateUpdate 生命周期钩子
- **ui-kit**: 抽取通用组件库 + 统一滑动条组件
- **assets**: 资产目录树折叠状态按项目持久化
- **hierarchy**: 层级折叠状态按项目+场景持久化
- **hierarchy**: 层级面板按视图域拆分场景树与 UI 树
- **animation**: 属性通道按节点能力出层级菜单（灯光/相机/UI）+ 动画面板蒙版保护
- **animation**: 蒙皮完全控制——动作混合/加法层/骨骼/形态键/IK 与骨骼绑定落盘
- **hierarchy**: 层级面板支持复制对象与 Ctrl+D 快捷键

### 问题修复
- **preview**: 无灯光场景预览/导出画面全黑（关键帧动画在跑但不可见）—— 播放器只应用 settings.rendering.backgroundColor，同一设置对象里的…
- **ui**: release 构建后工具栏右侧按钮（撤销/保存/关闭）挤到左边 —— assets-panel.scss 的全局 .spacer { flex: 0 1 8px } 与 toolbar/viewport/ui-kit utilities…
- **script**: 脚本引用状态机/行为树运行器的编辑器链路断裂 —— 多运行器场景 @property({ type: FsmRunnerNode/BtRunnerNode }) 在编辑器无法绑定：script-compile…
- **config**: 修正 bundle identifier 含空格导致构建校验失败 —— tauri.conf.json identifier "TvE Hub"→"TvE.Hub"（Tauri 标识符仅允许字母数字/连字符/点号，5cd8c5f…
- **bundle**: release 版 exe 旁 public 只有 internal，缺 repos/templates/exports —— build.rs 构建期只打包了 internal 一个 kind，而工坊/工程模板/导出模板在生产模式由…
- **nav**: 顺序巡回走完即停与低净空目标点行为 —— loop 默认改 true(巡回=持续巡逻,旧场景缺字段回退新默认,走完即停为显式关闭特例) +…
- **nav**: 打开项目后导航区域/代理绑定不生效（需重新勾选才恢复）—— rebuildAll 整体重建漏了导航：replace 事件阶段同步器不重建对象，绑定落在旧/空对象表上；rebuildAll 补 nav.unbindAll +…
- **ui**: 节点多选下拉面板可滚动 —— 选项列表自身 overflow 滚动不再触发外点关闭（window capture scroll 监听过滤面板内滚动目标），外部容器滚动/窗口变化仍关闭
- **logic**: 状态机/行为树编辑器布局与保存优化 —— 右侧栏参数/条件行 minmax(0,1fr) 修复横向溢出 + BT 长字段标签缩短并以 placeholder 提示 + 打开时自动适配视图并新增适配视图按钮 +…
- **terrain**: 绘制层/雕刻切换不生效 —— 切换工具时重建笔刷会话（paint/sculpt session 数据结构不同，不重建则 stampAt 仍走旧 kind）
- **logic**: 状态机/行为树编辑器交互修复 —— 平移按按下起点绝对定位（修复拖拽漂移）+ 弹窗内屏蔽浏览器右键菜单并接入自定义右键菜单（新建/连线/设入口/删除/加子节点）+ 中键任意处拖拽平移 + wheel 绑定等 nextTick
- **physics**: Worker 模式 getLinearVelocity/bodyInfo 返回真实数据（修复跳跃失效）
- **preview**: 预览面板传入 draco/basis 解码器条件选项
- **engine**: 修正物理引擎动态 import 路径外部化（fixExternalSpecifiers 漏处理 import()）
- **export**: 导出产物排除多余 draco/basis 解码器文件，修正 basisBase 路径
- **repos**: 角色控制器对角移动转身左右跳 + 停下回正回归
- **physics**: 重力缩放失效（ammo 未实现）+ 改缩放后睡眠体不恢复下落
- **tve**: getComponent 按脚本类名查找组件永远返回 null
- **assets**: 外部修改脚本/资产后编辑器自动刷新

### 性能优化
- **terrain**: 绘制权重实时预览不刷新地形 —— 盖章后 rAF 增量重烤颜色纹理复用 DataTexture + 提交只写盘不触发 refreshTerrain
- **terrain**: 笔刷绘制性能优化 —— sculpt 增量复用基准高度跳过重生成 + rAF 调度提交 + canvas 复用
- **terrain**: 颜色纹理替代顶点色 + 4×4 chunk 视锥剔除 + 锯齿/边缘修复
- **terrain**: 自适应四叉树网格简化减面（平坦区合并、陡峭区保留细节）
- **render**: InstancedMesh + 静态几何合并 + LOD 组件（减少 DrawCall）
- **runtime**: 模型/贴图加载并行化 + 启动流程优化
- **hierarchy**: 层级行计算下沉 Rust 后端（单次 DFS 域过滤 + 搜索）

### 重构
- **ui**: 节点多选下拉下沉 ui-kit 通用组件 —— 新增 MultiSelect(options 数据驱动 + v-model:selectedIds + Teleport 浮层/翻转定位/面板内滚动保留，样式独立…
- **terrain**: 绘制面板优化 —— 绘制层更名权重 + 分组分隔符布局 + 滑动条改用 ui-kit Slider 统一样式
- **engine**: public/engine 全部由 src/runtime 编译生成，basis/draco 迁入引擎目录
- **engine**: web 运行时统一为单一事实源，构建/预览时自动编译（管线 + 压缩解码层试点）
- **workshop**: 精简原型卡片为固定尺寸并移除预览与文件名字段
- **tve**: 拆解 tve.mjs 大文件为 17 个子模块

### 文档
- **readme**: 重写为项目实际说明 —— 应用名统一 TvE Hub（首页）/ TvE Editor（编辑器窗口），tve 仅作脚本 SDK…
- **sdk**: 实体与查询章节区分节点句柄与组件门面
- **tve**: 编辑器与 SDK 文档从概述扩写为详细参考手册

### 其他
- **icons**: 收录 Tauri 应用图标 —— src-tauri/.gitignore 取消忽略 icons/，tauri icon 产物（icon.ico/icns/png 及 32/128/128@2x 各尺寸）入库随 tauri build 打包
- **license**: 添加 Apache 2.0 许可证 —— 新增 LICENSE 标准全文（附录版权人取仓库所有人：Copyright 2026 YeLanQ），package.json 与 src-tauri/Cargo.toml 声明 license…
- 修复identifier和应用名不统一
- **app**: 移除安装包打包改为便携式应用，正式名称更名 TvE Hub（公司 Tve Team）
- 节点句柄和组件声明说明
- 修复碰撞体的胶囊和凸包形状绘制
- 修复基本网格在预览中缺失的形状和胶囊网格的数据修复
- 骨骼动画权重滑条
- 修复滑动条存在空格
- **home**: 项目卡片改为固定 220px 宽度
- 脚本 SDK 新增 UI 布局/坐标查询与数学标量角度工具：engine.ui 增加 rectOf（锚点/布局解析后的画布局部空间实际矩形，数据取自 ui.mjs 逐帧解析缓存的 userData.uiRect…
- 脚本系统新增完整 Tween 补间动画：tve.mjs 新增 tween/easing/Tween 导出与 engine.tween（新模块 core/tween.mjs：31 个标准缓动（Robert Penner 族）+…
- 补充 UI 系统文档与原型接口：PrototypeDocumentation 新增 UICanvas/UIWidget/UIImage/UIText/UIButton/UILayout…
- 所有缩放模式统一将锚点定位到屏幕像素：rootRect = screenRect / canvasModeScale(s)，经 glue…
- full 模式改为等比包含 + 锚点解析在屏幕尺寸：glue 缩放取 min（contain 不裁切），rootRect 用 screenRect/s（锚点在屏幕尺寸内解析），拉伸锚点 Widget 铺满屏幕、点锚点 Widget…
- full 缩放模式改为等比铺满（cover）：取 max(screenW/cw, screenH/ch) 等比缩放，画布铺满屏幕不留白，UI 元素等比缩放保持像素比不变形，缩放系数一致
- full 缩放模式改为等比包含（contain）：取 min(screenW/cw, screenH/ch) 等比缩放保证 UI 内容保持原有比例不再非等比拉伸变形；与 fixedauto（cover，取 max…
- 统一 UI 缩放模式到项目设置：舞台不再按 scaleMode 做 CSS 拉伸（场景始终按窗口尺寸渲染铺满），UI 系统从 config 读统一 scaleMode 不再逐画布独立；检查器去掉画布 scaleMode…
- 修复 UICanvas 锚点定位非等比拉伸：撤销 glueScaleForCamera 的 screenAspect+kx 方向性补偿，恢复基于 camAspect 的等比 glue，使…
- 修复 SceneSynchronizer.onGraphChange 重复 case "remove"：合并为单分支并补 bumpAllUILayoutRevs，使删除节点后布局版本正确递增
- 网页预览新增设备仿真（参考 LQEN）：按设备逻辑分辨率渲染并套设备框架等比缩放，DPR 经 ?dpr= 参数传 player 调 setPixelRatio 真实生效
- 隐藏变换工具选中/悬停轴时出现的无限长辅助直线
- 修复层级内拖拽调整 UI Canvas 下节点排序后渲染排序不即时生效
- 修复 UI 节点 gizmo 拖拽松手后回弹到原位
- UI 渲染成本优化 + 同 SortOrder 按树序稳定排序（越靠后越在上层）
- 内嵌脚本编辑器（工作台）支持 .shader 着色器资产的打开、编辑与保存
- 修复预览切回布局视口闪色块：容器隐藏期间不再把渲染缓冲目标缩到 1×1
- 资产新建统一弹命名窗：材质/着色器/天空盒/TextureCube 补上命名弹窗
- 修复视口点选与视图语义不符：布局视图不可选中 3D 场景对象，场景视图不可选中 UI 节点
- 修复布局视口平移方向取反：改为抓取语义（内容跟随光标），拖右内容右移、拖下内容下移
- 布局视口 2D 设计视图鼠标导航：滚轮缩放（指针锚点）+ 右/中键拖拽平移
- UI Canvas 缩放模式改为仅运行时生效：编辑器布局视图恒按设计尺寸 1:1 显示
- 布局视口变换工具按 UI 2D 语义显示：平移/缩放只显示 X/Y 轴，旋转只显示 Z 轴（UI 旋转即绕 Z），关闭全部平面手柄（叠在 Widget 中心的方块杂乱），手柄尺寸 0.7→1.2 便于点抓；切回场景视图恢复 3D 全轴…
- 修复 2D Transform 卡布局参差：field-row 不再覆盖 label 宽度，统一沿用 72px 定宽 label 列，单字段行与成对行的输入框左缘对齐成线；成对行输入框加宽 8px 容纳像素值不裁字
- 2D Transform 卡：旋转独占一行，不再与缩放 X/Y 并列
- 修复 UI 卡片成对数值行在窄面板被裁剪（2D Transform/Anchor/Layout 的 field-row）：
- 显示 UI Canvas 设计矩形辅助线框（编辑器专用）：
- UI 画布渲染尺寸（设计分辨率/缩放模式）+ 2D 变换（100px=1 单位）+ 锚点系统 + 横/竖/网格布局容器：
- 新增布局视图（UI 独占渲染，只显示 Canvas 子树）与天空盒常显规则：
- 实现 UI 系统（Canvas-Widget，相机叠加渲染，SortOrder 控制画布内叠加顺序）：
- 优化项目管理窗口与编辑器窗口的启动/读写性能：
- 优化导出产物 WebGPU/WebGL 渲染性能（含 Clock 弃用修复与 Windows 高性能 GPU）：
- 修复 WebGPU 效果着色器镂空丢失：If 分支体在材质构建期被整段跳过：
- 修复溶解效果着色器噪声图案跨后端漂移（WebGPU 与 WebGL 图案完全不同）：
- 修复 WebGPU 下带裁剪阈值的材质整体不可见（alphaTest 语义两后端不一致）：
- 修复 WebGPU 渲染三处问题（效果器黑屏/天空天地颠倒/预览导出漏 WebGPU 运行时）：
- 相机辅助线纳入选中门控
- 修复视口点选：不可见节点（含隐藏父级下的子级）不再能被选中
- 修复材质预览在"同分支换着色器"时不刷新（效果器切入/切回都不同步）
- 修复切换着色器/分支可能卡死：消除三处可自激的循环 + 预览重建闸门
- 旧版着色器（缺 Base）可一键迁移：按 pragma 推断原分支并补 Base 声明
- 修复不同着色器效果复用同一条 program（两个网格都渲染成同一个效果）：
- 着色器统一为效果着色器（Base + Hook），GLSL→TSL 翻译覆盖 WebGPU：
- glslToTsl
- 粒子系统支持 WebGPU + 预览/导出运行时支持 WebGPU 后端：
- 清理注释与文案里的外部引擎归属（Unity / Blender / Cocos Creator 及 GameObject 等同源术语）：
- 粒子系统支持贴图（Renderer → Texture）：编辑器 / 预览构建运行时 / 导出打包 / 脚本 SDK 全链路：
- 粒子系统节点（Unity ParticleSystem 语义子集）：编辑器 / 预览构建运行时 / 脚本 SDK 全链路落地：
- 主页创意工坊「编辑原型」表单改为居中模态弹窗（用户实测反馈）：
- 层级/标签检查器 UI 打磨 + 预览服务器体验修正（用户实测反馈四项）：
- 渲染层级与标签系统（Unity Tags and Layers 语义）+ 预览/构建链路三处修复：
- 修复灯光辅助线三处缺陷并落地 Unity 式参数呈现：①辅助线改为仅选中该灯时显示（HelperSystem 选中门控扩展到…
- 阴影新增分辨率质量下拉（Unity Resolution 语义）：点光/平行光/聚光灯的 Shadow 参数组末尾新增 Resolution 下拉——Auto（自动）/ Low（512）/ Medium（1024）/…
- 灯光检查器卡片按 Unity 面板重排参数顺序（聚光/点光）：Range（照射距离/作用半径，原 Distance）提至卡片首位，聚光灯随后为 Spot Angle（原 Angle）与 Penumbra，再…
- 阴影系统重构为「各灯自带 Unity Shadows 参数组」，并修复阴影链路多处渲染缺陷：不再设独立承影节点，点光/平行光/聚光灯各自实现阴影并自带 Shadow 类型下拉（Off/Hard/Soft）+…
- 属性面板资产预览改为真正可交互的预览视口，并修复自定义着色器材质与模型取景。①视口重写：OrbitControls 交互（左键旋转/滚轮缩放/右键平移/双击重置，带阻尼）+…
- 修复新建材质在资产检查器里被判成立方体天空盒材质：天空材质判别条件写过「shader 字段是不是 .shader 引用」（shaderRef = shader.endsWith(".shader")），挂…
- src/app 大文件模块化：五个巨型文件按「壳组件持状态、纯逻辑进 composable、展示进子组件」拆分，行为与文案零变化。①InspectorPanel.vue 1291→324：抽出 composables/inspector/…
- 修复右键菜单子菜单在窗口边缘压住上一级菜单：定位由「越界即拉回窗口内」改为「贴父级右侧 / 翻到父级左侧」双侧优选。原收敛逻辑只有一条「越界就把 x…
- 完善着色器系统（新增自定义着色器 custom：.shader 源码真正编译渲染）+ 新增创意工坊（public/repos 资源仓库、两栏工作台与资产面板右键接入）
- 修复视口变换工具快捷键 W/E/R 无效：按键映射此前从未实现（setGizmoMode 仅工具条按钮单一调用点，提示文案与实际不符）。①editorCommands 注册 editor.gizmoMode…
- 相机节点右键新增「对齐到当前视口」（Unity Align With View…
- 新增内嵌文档系统（public/docs）：编辑器+SDK 双套文档与静态查看网页。①文档 16 篇小文件（README 导航 + editor/ 8…
- 移除主页开发者服务内容页的运行环境卡片：删除应用版本/运行环境/渲染引擎/界面框架四行信息卡片整体，并清理只为该卡片服务的代码——tauriVersion 状态与启动时 getVersion()…
- 脚本系统新增数据中心（热/冷分解，tve SDK v1.3.0）：跨组件共享的命名数据仓库 dataCenter 单例（隔离需求可 new…
- 脚本系统新增委托系统与池系统（tve SDK v1.2.0）：纯脚本通用设施，import { Delegate, Pool } from "tve" 即用。①委托（Delegate）：C# Delegate / UnityEvent…
- 修复物理持续接触反复反弹：jolt Persisted 接触清弹性 + ammo 存续流形置零弹性（首次撞击保留）。根因（jolt…
- 刚体组件新增「直立不倒」姿态设置（upright）：碰撞不翻倒但保留水平旋转，与「锁定旋转」并存。此前 lockRotation 是全冻结语义（AllowedDOFs 平移-only/角因子…
- 修复 jolt 物理碰撞监听器回调崩溃（id1.GetIndex is not a function）：刚体一接触其他碰撞体即崩、预览页报「预览运行失败」。根因：本 wasm 构建的 ContactListenerJS…
- 物理引擎按配置后端打包：修复构建时 rapier/jolt/ammo 三套运行时全量塞入产物的问题。web-preview-runtime 物理文件清单改为按后端映射…
- 运行时引擎目录化：web-preview/libs 迁移为 public/engine/core + engine/runtime；入口脚本自愈补建。①目录拆分：core = three.js…
- 1
- 脚本组件系统完善（SDK v1.1.0）：六内置组件门面 + getComponent 泛型化 + 运行时动态创建 + 组件字段声明 + Unity…
- tve 脚本 SDK 新增内置组件门面：Entity.getComponent("rigidBody") 返回刚体门面（mode/gravityScale/colliderCount 只读属性 +…
- 工坊原型集成进资产右键菜单：src 目录三处右键菜单「新建脚本」与「代码工坊 ▸」子菜单并列（新建脚本保留内置基础模板入口；代码工坊子菜单实时列出 repos/code…
- 主页新增代码工坊：脚本原型以独立文件形式存于 public/repos/code/*.ts（一原型一文件，文件名即原型名，描述存首行 // @desc: 注释，代码支持 {{CLASS_NAME}} 占位符创建时注入类名）；Rust 新增…
- tve 脚本 SDK 新增 math 向量数学库：v3/clone 与 zero/one/up/down/forward/back/left/right 冻结常量，add/sub/scale/negate/abs/min/max…
- 节点-组件-脚本系统接口化完善 + 播放器相机跟随修复：原型层新增 interfaces.ts（IPrototype/ITransform/INode，Prototype/Transform/Node/PrototypeRegistry…
- 动画剪辑组件「在动画编辑器中打开」新增聚焦编辑模式：子树锁定 + 视口材质压暗 + 层级高亮 + 面板锁定 + 退出按钮
- 移除动画资产属性面板中「在动画编辑器中打开」按钮
- 修复动画面板贝塞尔切线编辑：方向/可编辑/角度/长度显示全线打通
- 移除动画编辑帧动画视图的浏览器原生水平滚动条：.anim-lanes 由 overflow:auto 改为 overflow-x:hidden +…
- 对齐帧动画与曲线编辑的中键平移方案：横向平移统一为「内容跟指针走」——dope 原来按 1× 像素密度换算（缩放越大内容位移越超过指针、与曲线手感分叉），改为当前可视窗像素密度（laneWidth/tSpan 秒每像素），与曲线…
- 动画编辑器拆分为模块化结构：AnimationEditorPanel.vue 由 1790 行瘦身为 349 行组合壳，脚本按领域拆到 app/composables/anim-editor/（useAnimClip…
- 动画面板曲线编辑完善 + 两视图统一时间窗缩放平移：数据层 .anim 关键帧新增可选贝塞尔切线（ti/to 入出斜率 dv/dt、tm 两侧联动，parseKeys 收敛钳 ±10000、旧文件零改动兼容），新增…
- 动画面板时间轴缩放滑条 + 刻度自适应 + 底栏插值下拉：底栏右端新增缩放滑条（×1.0–×8.0 步进 0.5），dope 视图内容包进 lane-wrap…
- 动画面板时间轴铺满修复 + 时间吸附：轨道区尺寸测量改 watch(laneEl) 挂 ResizeObserver——原 RO 只在组件挂载时尝试绑定一次，而轨道区在剪辑加载完才渲染（v-else 分支），挂载时 laneEl 必为…
- 动画编辑器通道层级树 + 视图下拉切换 + 交互修复：通道键泛化为任意可动画属性字符串（clip.ts 移除 9 变换白名单与 PROP_CHANNELS，新增 app/lib/anim-props.ts…
- 修复预览中关键帧动画不播放：collect_anim_refs 取错字段层级——animationClip 组件的 clip 字段是绑定对象（资产路径在其内层 clip 字段），原实现把绑定对象当字符串取导致 .anim…
- 属性面板材质卡移至底部并支持折叠：Material 卡（基元 .mat 编辑/模型内嵌材质清单）从类型卡区域（Mesh 与 Animation 之间）移到面板最底部的独立「材质」区（分隔标题 inspector-divider +…
- 动画系统与动画组件完善：新增 .anim 关键帧动画剪辑资产（变换 9 通道——位置/旋转度制/缩放 XYZ 各一条关键帧曲线，每帧线性/阶跃/平滑 Catmull-Rom 三种插值，时长/循环设置，parseAnimationClip…
- Node 卡精简：移除「激活」勾选与「ID」「子节点统计」展示（激活与可见/小眼睛功能重复；可见性统一由层级小眼睛与 Node 卡「可见」表达，active 字段保留于数据层——旧场景兼容、SDK/播放器语义不变，obj.visible…
- 预制体实例身份与层级体验完善：serializePrefabTree 增加 forAsset 选项（存资产剥 prefab 自引用与组件实例 id；scene_add_tree 提交实例文档保留来源引用与重生成的组件…
- 物理模拟并入物理组件卡、添加组件按钮样式修复：移除独立 Simulation 卡（原挂物理组件即常驻面板），模拟控制（播放/暂停/停止+运行状态+提示）并入 Rigid Body…
- 视口选中反馈简化：去掉选中灰色包围盒、碰撞体线框改选中才显示——GizmoController 移除 BoxHelper（创建/每帧更新/显隐/清理，select 只做 gizmo attach/detach，引擎渲染循环与拖动回调里的…
- 预制体系统 + 物理碰撞回调 + 检查器多选批量编辑：新增 .prefab 资产（单根节点嵌套文档，与 .scene root 同形状，走通用 write_text 资产链零 Rust…
- 组件模式完善（对齐 Unity GameObject-Component）：新增内置灯光组件 light（点光/平行光/聚光灯/环境光，单实例、类型下拉切换）与音源组件 audioSource（复用…
- 程序化天空接入材质/着色器分离：新增两个内置天空着色器资产 internal/shaders/SkyProcedural.shader（Nishita 大气散射，Unity Skybox/Procedural 风格）与…
- 着色器与材质分离：新增 .shader 着色器资产（Unity ShaderLab 风格源码 = 渲染程序，材质 .mat 改经 shader 字段引用着色器、参数值存材质，读取端兼容旧 materialType…
- 窗口名称独立
- 固定预览端口
- 网页运行时程序化天空同步编辑器新算法：sky.mjs 旧 Preetham 解析实现替换为透射 LUT + 多重散射双 pass（与 framework/engine/modules/nishitaSky.ts…
- Nishita 天空重写为透射 LUT + 多重散射双 pass（对齐 Blender sky_multiple_scattering）并修复四处问题：256×64 透射率 LUT 预计算（cosθ/海拔，64 步 ray march…
- 检查器添加组件集中子菜单：按物理/脚本分类，支持子级
- 碰撞体辅助线框：视口实时显示 collider 形状线框（绿色常规/青色传感器），形状计算从 PhysicsSystem 抽出为共享 colliderShape 模块（建体与画线同一实现，所见即所碰，含 autoSize…
- 项目设置面板布局优化：字段说明文字换行至控件下方并与控件列对齐（修复物理分类重力行说明与输入框重叠），重力输入槽增加 X/Y/Z 轴标签
- 物理系统：工厂模式三后端适配器（rapier/jolt/ammo，WASM 惰性加载/离线内置），rigidBody+collider 组件（静态/运动学/动力学，五形状/自动包围盒/传感器/CCD/复合），检查器 Physics…
- 音频引擎：AudioSystem + audioNode 音源节点（2D/3D 空间化），音频资产/检查器/脚本 SDK engine.audio/播放器/构建导出全链路
- 程序化天空：Nishita 大气散射（Blender 天空纹理风格），三色移除，各端呈现统一
- 天空盒材质资产化：cube 持有 TextureCube 与渲染参数，新建天空盒资产
- 资产检查器：属性面板支持资产预览与暴露属性（纹理/材质/模型/天空）
- TextureCube 资产 + 立方体天空盒贴图，修复资产访问器注入与预览贴图翻转
- Rust 存储下沉：read_text/write_text/write_asset_binary fs 直写收口 store.rs
- devtools/MCP：工具权限迁 Rust 权威存储，纯后端方法本地直接应答
- 修复：资产目录 F2 未生效/误弹旧资产
- 修复：资产面板选中目录时 F2 重命名不生效
- 修复：移动/重命名当前打开的场景后被旧路径重建（重复 Main）
- F2 按面板上下文重命名：资产面板内重命名选中资产，场景区重命名选中节点
- 修复 F2 重命名失效：放宽触发条件 + 捕获阶段监听 + canRun 容错
- AssetsPanel 交互拆分完成：工具栏/拖放导入/右键菜单全部抽离
- AssetsPanel 交互拆分：资产条目视图抽 AssetEntryCell 子组件
- devtools 远程契约收敛到 state.ts：method→命令路由与 MCP_TOOLS/权限单源
- Rust 存储分层：recent/prefs 持久化下沉 store 模块
- 资产域业务下沉 assetService：store 瘦身为状态+委托
- editor 生命周期编排抽 editorService：mount/场景装载/首页交接/dispose 迁出 store
- 分层架构：数据门面收口 + 统一命令注册表 + devtools 归并执行
- 修复命令无效：材质写入字段错位、首页垃圾篓确认框缺失、最近列表与 devtools 资源命令回归
- 正交相机天空盒失效修复：等距柱状色带纹理+全屏背景面按光线方向采样
- project.list查后端最近项目+路径规范化去重
- 开发者服务：本地控制服务器+工具权限+MCP桥
- 两个独立窗口
- Home页开发者服务标签
- 相机清除标志
- 自动关闭预览
- 层级子菜单三级支持
- 脚本装饰器
- 脚本编辑样式优化
- 用户脚本支持和脚本编辑器
- 修复构建的cdn路径计算统一
- gzip远程地址和cdn支持
- 修复单页构建
- 构建预览修复
- 模型 发布模式转二进制
- 发布模式
- 构建发布模式
- 构建导出
- 构建导出
- 动画骨骼绑定显示
- 模型上载渲染
- player.mjs模块化
- 架构迁移，性能优化
- 外部模型材质
- 网格/模型工厂模式
- 移除项目硬编码加载Main场景
- 组件刷新
- 相机类型切换
- 新建的场景默认清屏色
- 卡通轮廓边
- Toon材质
- PBR和Unlit
- 材质工厂
- 1
- 修复场景统计
- 脏标记
- 场景切换
- 新建资产
- 资产导入和重命名
- 材质特性启动勾选
- 默认清屏黑色
- 缩放模式修复
- 修复空场景Bug
- - PBR材质 - 纹理支持 - 透明裁剪
- 程序化天空
- 天空盒材质
- - 应用级命令 - 视口选中
- 天空盒
- 材质组件属性同步
- 属性面板中变换数据同步
- - 材质系统 - 内置资源目录 - web预览
- 缩放模式
- 网页预览
- 相机默认值和限制
- 主页和持久存储修复
- 抗锯齿+渲染合成
- 项目配置和meta动态生成
- 更新项目配置
- webgpu和webgl支持
- 项目设置面板
- 相机辅助线框
- 预览修复
- 层级对象图标
- 灯光图标和辅助线
- 相机、灯光图标
- 相机，光照辅助线
- 独立相机轨道
- 颜色值在修改时同步
- 修复，通过射线选中对象
- 修复组件属性
- 修复世界/本地切换
- 欧拉角旋转
- 主题更新
- 修复变换原型数据同步
- 重构属性面板结构
- 修复层级中的拖拽问题
- 重构层级面板，修复层级节点删除
- 工具栏显示
- 场景根保护
- 重构资产面板
- 编辑器解析项目
- 添加了两种内置纹理
- 项目管理器+新建项目
- 新建项目
- 场景原型结构
- 资产面板拖拽
- 修复右键事件
- 修复变换命令
- 修复样式表属性
- 修复构造问题
- 模块化文件
- 样式表统一
- 最小窗口
- 浮动面板位置同步

## v0.1.2.1（2026-09-04，早期同名版本）

（无）

## v0.1.2（2026-09-04）

（无）

## v0.1.1（2026-09-04）

（无）

## v0.1（2026-09-04）

（无）


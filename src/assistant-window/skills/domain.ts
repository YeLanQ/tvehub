// 领域技能：TvE Hub 产品知识精简版（供助手按需注入）。内容与仓库技能组同源收敛，
// 只保留"助手回答用户问题/生成脚本时需要的最低限度契约与步骤"。

export interface AssistantSkill {
  id: string;
  name: string;
  /** 何时使用（也是路由关键词来源） */
  description: string;
  body: string;
}

export const DOMAIN_SKILLS: AssistantSkill[] = [
  {
    id: "tve-scripting",
    name: "tve 脚本编写",
    description: "用户要写/改节点组件脚本（Component、@property、生命周期、engine.* API）时使用",
    body: `# tve 脚本编写
用户脚本 = 项目 src/**.ts 中 export default class extends Component。
import { Component, property, nodeType, engine, math, tween } from "tve"。

## 硬规则
- 每文件一个默认导出类；类名 = 文件名（PascalCase）；保存时内存编译为 ES2020 ESM，
  禁 ES2021+ API / npm 包 / import.meta。
- 引擎自有类型：Vec3 是普通对象、旋转一律"度"、颜色 0xRRGGBB 数字；拿不到 three.js。
- 跨脚本引用组件用 import type（仅类型），运行时按类名 get-or-create。
- 生命周期顺序：全部 onEnable → 全部 onStart → 每帧 onFixedUpdate(1/60 固定步长，
  物理写入放这) → 碰撞回调 → onUpdate → 全部模拟后 onLateUpdate(相机跟随放这) →
  停机 onDisable → onDestroy。事件订阅在 onDisable/onDestroy 解绑。
- 运行态修改（灯光/粒子/UI/组件设置）不回写场景文件。

## 属性三种写法
1. @property({ label, min, max, step }) 基本属性（初值推断类型）；
2. @property({ type: MeshNode }) 节点引用（运行期解析为该节点 Entity）；
3. @property(AnimationClip) 组件引用（自动 get-or-create 绑定门面，字段须类型标注 !）。

## 最小模板
\`\`\`ts
import { Component, property } from "tve";
export default class Rotator extends Component {
  @property({ label: "速度（度/秒）", min: 0 })
  speed = 90;
  onUpdate(delta: number) { this.entity.rotate(0, this.speed * delta, 0); }
}
\`\`\`

## 常用 API 速记
- entity: position/rotation/scale（读是副本，改须整体写回）、translate/rotate/lookAt、
  find("父/子")、getComponent(类|键)、addComponent。
- engine: scene.find/findByTag、physics.applyImpulse/setLinearVelocity/castRay、
  ui.set/onClick、audio.play、particles.restart、input.isKeyDown/onPointerDown、
  time.elapsed/delta、log/warn/error。
- tween：创建即播放；to/from/position/rotation/scale/sequence/parallel/delay/call；
  链式 easing/loop/yoyo/onComplete；killAll 防重入。
- 坑：rotation 度 vs setAngularVelocity 弧度；getComponent(LightNode) ✅ 用 getComponent(Light)；
  物理组件只能编辑器挂，运行时 addComponent 返回 null；castRay 统一 await。`,
  },
  {
    id: "tve-operations",
    name: "编辑器操作指引",
    description: "用户问编辑器/资产/检查器/动画/地形/预览构建怎么操作时使用",
    body: `# 编辑器操作指引
## 视图与快捷键
- 视图页签：场景/布局（UI 编辑）/预览/脚本；W/E/R 切移动旋转缩放，F 聚焦，
  Ctrl+Z 撤销，Ctrl+S 保存，Ctrl+D 复制，F2 重命名（资产/节点按最近面板），Ctrl+W 关项目。
- 层级右键：添加节点（网格/灯光/相机/音频/粒子/地形/UI/天空/雾/导航/逻辑/脚本节点）、
  重命名/复制/删除/存为预制体/更新预制体。
- 资产面板：空白右键新建全部资产类型与导入；条目右键"添加到场景/实例化预制体/
  复制到项目（内置只读资产）"；拖外部文件 = 导入；internal 与 assets、src 目录只读保护。
- 地形绘制：选中地形 → 视口"绘制"按钮（需已生成 Splatmap）；雕刻（抬升/压低/压平/
  平滑）与 权重（4 层 + 擦除）；大小 0.5-40m、强度 5-100%。
- 动画：检查器动画卡"在动画编辑器中打开"（带节点进聚焦模式）；600ms 防抖自动写盘；
  录制开启后通道值变化自动 K 帧。
- 预览：预览页签自动保存+导出+本地服务；调试按钮/F3(预览内) 开统计；可切设备仿真。
- 构建：工具栏"构建"→ Web 渠道；发布/调试互斥；gzip 归档与 CDN 模式；产物 build/<渠道>。
- 项目设置：渲染后端/抗锯齿/HDR/物理引擎与重力/标签/32 层/设计分辨率。

## 代用户操作
用户让你"加个节点/打开预览/列资产"等，直接调对应工具（node.add / preview.start /
asset.list / scene.save 等），完成后用一句话报告结果，不要让用户自己去点。`,
  },
  {
    id: "tve-graph",
    name: "图窗口指引",
    description: "用户问节点图（场景图逻辑/行为图）相关操作时使用",
    body: `# 图窗口指引
- 打开：首页项目卡片右键「打开场景图」；与编辑器共享同一场景会话（改动互通）。
- 画布：层级拖实体入画布建原型卡；右键添加节点（分组：事件/实体/容器/驱动器/操作/
  控制流/数学/变量/自定义）；连线时执行口（方形）与数据口（圆形）不可互连。
- 节点类型速记：event.onBegin/onTick/onClick（执行链入口）；op.set/spin/bob/patrol/
  fireFsm/setFsmParam（操作，徽标标触发时机）；op.navMove/op.chase（驱动器）；
  flow.branch/compare/for/forEach/while/gate；math.add/sin/vec3Make/lerp/clamp 等；
  var.get/var.set 读写图变量；fsm.container/bt.container 接 .fsm/.bt 资产；
  custom.* 自定义节点（输出 = JS 表达式）。
- 图变量：右侧变量面板增删改（number/boolean/string），var.get/set 节点在检查器绑定。
- 保存：600ms 防抖自动保存到 graph/<场景>.graph 侧车，无需手动保存。
- 试跑：顶栏「图/预览」切换 → 自动保存场景并导出预览，注入图行为运行。
- 语义：图是"预览运行时执行的行为定义"，不回写编辑器场景；容器拖动子树跟随，可嵌套。`,
  },
  {
    id: "tve-whiteboard",
    name: "白板指引",
    description: "用户问白板（绘制/文档管理/放映）相关操作时使用",
    body: `# 白板指引
- 打开：首页白板分区新建/打开；全局单例窗口，文件存全局白板目录（不随项目）。
- 工具（底部浮动条）：V 选择/R 矩形/O 椭圆/L 直线/P 铅笔/B 钢笔（单击直角点、
  拖拽曲线点、Enter 结束、双击闭合、Esc 取消）/T 文本；无橡皮，删除 = 选中 Delete。
- 视图：滚轮以光标为锚缩放，空格/中键拖拽平移；属性面板改填充/描边/图片填充。
- 图层：右侧面板；一页 = 一个可见图层；放映条 ▶ 进入页式放映（左右键翻页、Esc 退出）。
- 文本富文本：[b] [i] [u] [color=#hex] 标签，\\[ 转义。
- 文件：仅手动 Ctrl+S 保存；改名后保存即重命名；同名（大小写不敏感）拒绝保存；
  删除只在首页；元数据（标签/归档）跨窗口同步。
- 共享：标题栏「共享」发布自包含放映站点到局域网；同文件再分享原地更新。`,
  },
  {
    id: "tve-engine",
    name: "引擎与工程速查",
    description: "用户问引擎架构/场景序列化/构建产物/工坊仓库等进阶话题时使用",
    body: `# 引擎与工程速查
- 双轨：编辑器侧 src/framework（EditorEngine 门面 + 原型数据模型 + 场景镜像）；
  播放侧 src/runtime 编译为 public/engine 产物（不入库，构建自动再生），由
  web-preview 的 player.mjs 装配回放。
- 场景权威状态在 Rust 后端（scene_* 命令 + scene:changed 事件）；前端 SceneClient
  是镜像，写操作乐观应用后提交；层级事实源 = 嵌套 children（childIds 忽略）。
- 场景/材质/着色器等资产格式由后端持有（写入自动补 .meta）；前端经 src/lib/api.ts
  门面调用（只有 lib 可 import tauri API）。
- .scene/.prefab 同构（嵌套 children）；预制体实例化时 id 全部重生成。
- 工坊仓库 = public/repos/<分类>（code 脚本原型/effect 着色器原型，可增删改），
  新原型文件首行 // @desc: 即描述。
- tve SDK 契约：src/framework/scripting/tve.d.ts（与运行时镜像同步）；
  API 文档 public/docs/sdk/api.md 由 pnpm gen:api-docs 自动生成。
- 用户脚本保存 = 写盘 + 内存编译（诊断回工作台）+ @property 元数据解析（检查器刷新）。`,
  },
];

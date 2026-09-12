/**
 * 原型文档结构定义
 * 
 * 本文件定义了编辑器中使用的所有原型结构体的文档说明。
 * 供编辑器在创建原型时参考，也用于生成原型文档。
 * 
 * 结构层级：
 * 1. ScenePrototype - 场景原型（顶层容器）
 * 2. Node - 基元节点原型（场景中的节点）
 * 3. Transform - 基元变换原型（节点的空间变换）
 */

/**
 * 场景原型文档
 * 
 * 定义场景文件的完整数据结构，用于序列化/反序列化场景。
 * 
 * 结构：
 * ```
 * ScenePrototype {
 *   metadata: SceneMetadata      // 场景元数据
 *   settings: SceneSettings      // 场景设置
 *   rootId: string | null        // 根节点ID
 *   nodes: Map<string, Node>     // 所有节点
 *   childrenIndex: Map<string, string[]>  // 子节点索引
 * }
 * ```
 * 
 * 使用场景：
 * - 加载场景文件（JSON -> ScenePrototype）
 * - 保存场景文件（ScenePrototype -> JSON）
 * - 创建新场景（ScenePrototype -> SceneGraph）
 * - 预览场景结构
 */
export interface ScenePrototypeDoc {
  /**
   * 场景元数据
   * 
   * 包含场景的版本、时间、描述等信息
   */
  metadata: {
    /** 场景名称 */
    name: string;
    /** 场景版本号 */
    version: { major: number; minor: number; patch: number };
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 最后修改时间 (ISO 8601) */
    modifiedAt: string;
    /** 场景描述 */
    description?: string;
    /** 自定义标签 */
    tags?: string[];
  };

  /**
   * 场景设置
   * 
   * 包含渲染等全局设置（物理配置在项目设置中）
   */
  settings: {
    /** 渲染设置 */
    rendering: {
      /** 背景色 (RGB hex) */
      backgroundColor: number;
      /** 是否启用雾效 */
      fogEnabled: boolean;
      /** 雾效颜色 */
      fogColor: number;
      /** 雾效近裁剪距离 */
      fogNear: number;
      /** 雾效远裁剪距离 */
      fogFar: number;
      /** 环境光强度 */
      ambientIntensity: number;
      /** 环境光颜色 */
      ambientColor: number;
    };
  };

  /**
   * 节点树
   * 
   * 层级结构，每个节点包含：
   * - 基础信息（id, name, parentId, active, visible）
   * - 变换信息（Transform）
   * - 自定义属性（properties）
   * - 子节点列表（children）
   */
  nodes: {
    /** 节点类型标识 */
    type:
      | "node"
      | "meshNode"
      | "lightNode"
      | "cameraNode"
      | "uiCanvasNode"
      | "uiImageNode"
      | "uiTextNode"
      | "uiButtonNode"
      | "uiLayoutNode";
    /** 唯一ID */
    id: string;
    /** 显示名称 */
    name: string;
    /** 父节点ID（根节点为null） */
    parentId: string | null;
    /** 是否激活 */
    active: boolean;
    /** 是否可见 */
    visible: boolean;
    /** 变换信息 */
    transform: {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
      scale: { x: number; y: number; z: number };
    };
    /** 自定义属性 */
    properties: Record<string, unknown>;
    /** 子节点 */
    children?: Array<ScenePrototypeDoc["nodes"]>;
  }[];
}

/**
 * 基元节点原型文档
 * 
 * 所有节点原型的基类，定义了场景中节点的基础结构。
 * 
 * 结构：
 * ```
 * Node {
 *   id: string              // 唯一标识
 *   name: string            // 显示名称
 *   parentId: string | null // 父节点ID
 *   childIds: string[]      // 子节点ID列表
 *   active: boolean         // 是否激活
 *   visible: boolean        // 是否可见
 *   transform: Transform    // 变换基元
 *   properties: JsonRecord  // 自定义属性
 * }
 * ```
 * 
 * 派生类型：
 * - MeshNode - 网格节点（包含 geometry, material）
 * - LightNode - 灯光节点（包含 type, color, intensity）
 * - CameraNode - 相机节点（包含 fov, near, far）
 */
export interface NodePrototypeDoc {
  /**
   * 节点类型标识
   * - "node": 基础节点
   * - "meshNode": 网格节点
   * - "lightNode": 灯光节点
   * - "cameraNode": 相机节点
   * - "uiCanvasNode": UI 画布节点
   * - "uiImageNode" / "uiTextNode" / "uiButtonNode" / "uiLayoutNode": UI Widget 节点
   */
  type:
    | "node"
    | "meshNode"
    | "lightNode"
    | "cameraNode"
    | "uiCanvasNode"
    | "uiImageNode"
    | "uiTextNode"
    | "uiButtonNode"
    | "uiLayoutNode";

  /**
   * 唯一标识符
   *
   * 自动生成，格式：{type}_{timestamp}_{random}
   */
  id: string;

  /**
   * 显示名称
   * 
   * 在层级面板中显示的名称
   */
  name: string;

  /**
   * 父节点ID
   * 
   * 根节点为 null
   */
  parentId: string | null;

  /**
   * 子节点ID列表
   * 
   * 用于构建层级结构
   */
  childIds: string[];

  /**
   * 是否激活
   * 
   * 不激活的节点不参与渲染和物理计算
   */
  active: boolean;

  /**
   * 是否可见
   * 
   * 不可见的节点在视口中隐藏
   */
  visible: boolean;

  /**
   * 变换信息
   * 
   * 节点的空间位置、旋转、缩放
   */
  transform: {
    /** 位置 */
    position: { x: number; y: number; z: number };
    /** 旋转 (欧拉角，单位：度) */
    rotation: { x: number; y: number; z: number };
    /** 缩放 */
    scale: { x: number; y: number; z: number };
  };

  /**
   * 自定义属性
   * 
   * 存储编辑器扩展的任意属性
   */
  properties: Record<string, unknown>;
}

/**
 * 网格节点原型文档
 * 
 * 继承自 Node，添加了几何与材质**资产引用**。
 * 材质参数不内嵌在节点上，而是由 .mat 材质资产文件持有（可被多个网格共享）：
 * - internal/materials/…：编辑器内置材质（只读，编辑前「复制到项目材质」）
 * - assets/materials/…：项目材质资产（可编辑，修改写回 .mat）
 * 
 * 结构：
 * ```
 * MeshNode extends Node {
 *   geometry: GeometryKind   // 几何体类型
 *   size: Vec3               // 尺寸
 *   material: string         // 材质资产引用路径（默认 internal/materials/Default.mat）
 * }
 * ```
 */
export interface MeshNodePrototypeDoc extends NodePrototypeDoc {
  type: "meshNode";

  /**
   * 几何体类型
   * - "box": 立方体
   * - "sphere": 球体
   * - "plane": 平面
   * - "cylinder": 圆柱体
   */
  geometry: "box" | "sphere" | "plane" | "cylinder";

  /**
   * 尺寸
   * 
   * 对于不同几何体：
   * - box: {x: width, y: height, z: depth}
   * - sphere: {x: radius, y: radius, z: radius}
   * - plane: {x: width, y: 1, z: depth}
   * - cylinder: {x: radiusTop, y: height, z: radiusBottom}
   */
  size: { x: number; y: number; z: number };

  /**
   * 材质资产引用路径
   * - "internal/materials/Default.mat"：内置默认材质
   * - "assets/materials/<Name>.mat"：项目材质资产
   */
  material: string;
}

/**
 * 灯光节点原型文档
 * 
 * 继承自 Node，添加了灯光相关属性。
 * 
 * 结构：
 * ```
 * LightNode extends Node {
 *   lightType: LightType     // 灯光类型
 *   color: number            // 灯光颜色
 *   intensity: number        // 灯光强度
 *   castShadow: boolean      // 是否投射阴影
 *   ...
 * }
 * ```
 */
export interface LightNodePrototypeDoc extends NodePrototypeDoc {
  type: "lightNode";

  /**
   * 灯光类型
   * - "ambient": 环境光
   * - "directional": 方向光
   * - "point": 点光源
   * - "spot": 聚光灯
   */
  lightType: "ambient" | "directional" | "point" | "spot";

  /**
   * 灯光颜色 (RGB hex)
   */
  color: number;

  /**
   * 灯光强度
   */
  intensity: number;

  /**
   * 是否投射阴影
   */
  castShadow: boolean;

  /**
   * 光照距离（点光源/聚光灯）
   */
  distance?: number;

  /**
   * 光照衰减（点光源/聚光灯）
   */
  decay?: number;

  /**
   * 聚光灯角度（聚光灯，单位：弧度）
   */
  angle?: number;

  /**
   * 聚光灯半影（聚光灯）
   */
  penumbra?: number;
}

/**
 * 相机节点原型文档
 * 
 * 继承自 Node，添加了相机相关属性。
 * 
 * 结构：
 * ```
 * CameraNode extends Node {
 *   fov: number              // 视场角
 *   near: number             // 近裁剪面
 *   far: number              // 远裁剪面
 *   ...
 * }
 * ```
 */
export interface CameraNodePrototypeDoc extends NodePrototypeDoc {
  type: "cameraNode";

  /**
   * 视场角（单位：度）
   */
  fov: number;

  /**
   * 近裁剪面距离
   */
  near: number;

  /**
   * 远裁剪面距离
   */
  far: number;

  /**
   * 是否为主相机
   *
   * 只有一个主相机
   */
  isPrimary: boolean;
}

// ---------------------------------------------------------------------------
// UI 系统（Canvas-Widget）：画布容器 + 图片/文本/按钮/布局容器 Widget。
//
// 2D 设计标准：100 设计像素 = 1 UI 单位（UI_PPU），2D 字段（size/anchoredPosition/
// offset 等）序列化均为 UI 单位，检查器按像素显示换算；坐标 y 向上。
// 定位：Widget 位置由锚点系统在每帧布局解析中推导（ui-shared resolveUIRect），
// 画布子树内节点的 transform.position 不直接生效（旧数据迁移：无锚点字段时取原
// transform.position 作中心锚点下的 anchoredPosition，视觉位置不变）。
// 排序：渲染序 = 画布 sortOrder（×1e7）+ Widget sortOrder（×1e4）+ 树序 rank，
// 材质统一关深度测试，按渲染序从小到大叠加（大 SortOrder 在上层）。
// ---------------------------------------------------------------------------

/** UI 缩放模式（画布设计矩形映射到屏幕矩形的适配策略；与项目设置 scaleMode 同名集） */
export type UIScaleModeDoc = "noscale" | "fixedwidth" | "fixedheight" | "fixedauto" | "full";

/**
 * UI 锚点字段集文档（Canvas-Widget 锚点系统，Unity uGUI 同语义）。
 * 全部为归一化 0..1 锚点/枢轴 + UI 单位偏移，坐标 y 向上：
 * - 某轴 anchorMin == anchorMax 为**点锚点**：该轴位置由 anchoredPosition 给出
 *   （枢轴相对锚点的偏移），尺寸取 size；
 * - 某轴 anchorMin < anchorMax 为**拉伸锚点**：该轴矩形 = 父矩形上两锚线之间
 *   收进 offsetMin/offsetMax 边距（尺寸随父矩形推导，屏幕适配时跟随）。
 */
export interface UIAnchorFieldsDoc {
  /** 归一化锚点下限（父矩形 0..1） */
  anchorMin: { x: number; y: number };
  /** 归一化锚点上限（min<max 该轴为拉伸锚点） */
  anchorMax: { x: number; y: number };
  /** 归一化枢轴（Widget 自身 0..1；点锚点定位与旋转基准） */
  pivot: { x: number; y: number };
  /** 点锚点轴：枢轴相对锚点的偏移（UI 单位） */
  anchoredPosition: { x: number; y: number };
  /** 拉伸轴边距：相对下/左锚线（UI 单位） */
  offsetMin: { x: number; y: number };
  /** 拉伸轴边距：相对上/右锚线（UI 单位） */
  offsetMax: { x: number; y: number };
}

/**
 * UI 画布节点原型文档
 *
 * 继承自 Node，是 UI Widget 的容器根（Canvas-Widget 的 Canvas）。
 * 渲染为屏幕叠加：画布空间每帧贴合活动渲染相机（原点 = 屏幕中心，+x 右 +y 上），
 * 画布自身变换不参与取景；子节点经锚点系统相对画布矩形定位。
 *
 * 结构：
 * ```
 * UICanvasNode extends Node {
 *   renderMode: "overlay"    // 渲染模式（当前仅屏幕叠加）
 *   sortOrder: number        // 画布整体排序（多画布叠加时大者在上）
 *   designWidth: number      // 设计宽度（设计像素，100px = 1 UI 单位）
 *   designHeight: number     // 设计高度（设计像素）
 *   scaleMode: UIScaleModeDoc // 屏幕适配方案（仅预览/构建运行时生效）
 * }
 * ```
 */
export interface UICanvasNodePrototypeDoc extends NodePrototypeDoc {
  type: "uiCanvasNode";

  /**
   * 渲染模式
   * - "overlay": 屏幕叠加（相机叠加；保留字段给未来的世界空间画布）
   */
  renderMode: "overlay";

  /**
   * 画布整体排序（-500..500）
   *
   * 多画布叠加时先按此比较（大者在上），再比画布内 Widget 的 sortOrder
   */
  sortOrder: number;

  /**
   * 设计宽度（设计像素，1..16384）
   *
   * 画布渲染尺寸 = 设计分辨率 / 100（UI 单位）；新建画布默认取项目设置的设计分辨率
   */
  designWidth: number;

  /** 设计高度（设计像素，1..16384） */
  designHeight: number;

  /**
   * 屏幕适配方案（仅预览/构建产物运行时生效；编辑器布局视图恒按设计尺寸 1:1 显示）：
   * - "noscale": 不缩放，画布按设计尺寸原样显示；
   * - "fixedwidth": 固定宽度，宽度铺满屏幕的等比缩放；
   * - "fixedheight": 固定高度，高度铺满屏幕的等比缩放；
   * - "fixedauto": 固定宽高比（cover），取较大缩放比铺满屏幕，超出部分裁切；
   * - "full": 等比包含（contain），取较小缩放比完整显示不裁切。
   *
   * 缩放模式由项目设置统一控制（画布可覆盖，新建画布取项目设置值）
   */
  scaleMode: UIScaleModeDoc;
}

/**
 * UI Widget 基类原型文档（抽象）
 *
 * 画布上 UI 元素（图片/文本/按钮/布局容器）的共有字段：叠加序 + 设计尺寸 + 锚点集。
 * size 为设计尺寸（UI 单位，100px = 1 单位）；位置由锚点系统每帧解析推导。
 *
 * 结构：
 * ```
 * UIWidgetNode extends Node {
 *   sortOrder: number        // 画布内叠加序（-999..999；大者在上）
 *   size: Vec2               // 设计尺寸（UI 单位；点锚点轴生效）
 *   + UIAnchorFieldsDoc      // 锚点字段集
 * }
 * ```
 */
export interface UIWidgetPrototypeDoc extends NodePrototypeDoc, UIAnchorFieldsDoc {
  type: "uiImageNode" | "uiTextNode" | "uiButtonNode" | "uiLayoutNode";

  /**
   * 画布内叠加序（-999..999）
   *
   * 同一画布内 sortOrder 大的 Widget 叠在上层（点击命中也取最上层）；
   * 同 SortOrder 按画布下节点顺序（树序）稳定细分，越靠后越在上层
   */
  sortOrder: number;

  /** 矩形设计尺寸（UI 单位；拉伸锚点轴由父矩形与边距推导，size 不生效） */
  size: { x: number; y: number };
}

/**
 * UI 图片 Widget 原型文档
 *
 * 画布上的矩形图片（或纯色块）。图片资产引用按导出产物相对路径解析
 * （与粒子贴图同一打包链路）；无图片时渲染 color 纯色矩形。
 *
 * 结构：
 * ```
 * UIImageNode extends UIWidgetNode {
 *   image: string    // 图片资产相对路径（空串 = 纯色矩形）
 *   color: number    // 着色（int24 RGB hex；与图片相乘，无图片时即矩形底色）
 * }
 * ```
 */
export interface UIImageNodePrototypeDoc extends UIWidgetPrototypeDoc {
  type: "uiImageNode";

  /** 图片资产相对路径（png/jpg/webp/…；空串 = 纯色矩形） */
  image: string;

  /** 着色（int24 RGB hex，如 0xffffff；与图片相乘） */
  color: number;
}

/**
 * UI 文本 Widget 原型文档
 *
 * 2D 画布光栅化的多行文本（逐字符断行自动换行，中文友好），三种字族。
 * 字号按设计像素解释（100px = 1 UI 单位），与屏幕比例无关。
 *
 * 结构：
 * ```
 * UITextNode extends UIWidgetNode {
 *   text: string          // 文本内容（\n 分行，超界自动换行）
 *   fontSize: number      // 字号（设计像素，4..512）
 *   color: number         // 文本颜色（int24 RGB hex）
 *   bold: boolean         // 粗体
 *   italic: boolean       // 斜体
 *   fontFamily: string    // "system" 系统无衬线 | "serif" 衬线 | "mono" 等宽
 *   align: string         // 多行文本水平对齐："left" | "center" | "right"
 * }
 * ```
 */
export interface UITextNodePrototypeDoc extends UIWidgetPrototypeDoc {
  type: "uiTextNode";

  /** 文本内容（\n 分行；超界自动换行） */
  text: string;

  /** 字号（设计像素，4..512；100px = 1 UI 单位） */
  fontSize: number;

  /** 文本颜色（int24 RGB hex） */
  color: number;

  /** 粗体 */
  bold: boolean;

  /** 斜体 */
  italic: boolean;

  /** 字族："system" 系统无衬线 | "serif" 衬线 | "mono" 等宽 */
  fontFamily: "system" | "serif" | "mono";

  /** 相对 Widget 矩形的水平对齐："left" | "center" | "right" */
  align: "left" | "center" | "right";
}

/**
 * UI 按钮 Widget 原型文档
 *
 * 背景（图片或纯色）+ 居中标签，运行时可点击：点击命中在画布空间做反投影 +
 * 矩形命中测试（按渲染序取最上层）；脚本经 engine.ui.onClick(entity, cb) 订阅。
 *
 * 结构：
 * ```
 * UIButtonNode extends UIWidgetNode {
 *   image: string         // 背景图片资产相对路径（空串 = 纯色背景）
 *   color: number         // 背景着色（int24 RGB hex）
 *   label: string         // 标签文本
 *   labelColor: number    // 标签颜色（int24 RGB hex）
 *   fontSize: number      // 标签字号（设计像素，4..512）
 *   labelBold: boolean    // 标签粗体
 *   interactable: boolean // 可交互（false 时仅展示，不参与点击命中）
 * }
 * ```
 */
export interface UIButtonNodePrototypeDoc extends UIWidgetPrototypeDoc {
  type: "uiButtonNode";

  /** 背景图片资产相对路径（空串 = 纯色背景） */
  image: string;

  /** 背景着色（int24 RGB hex；无图片时即底色） */
  color: number;

  /** 标签文本 */
  label: string;

  /** 标签颜色（int24 RGB hex） */
  labelColor: number;

  /** 标签字号（设计像素，4..512；与文本 Widget 同一语义） */
  fontSize: number;

  /** 标签粗体 */
  labelBold: boolean;

  /** 可交互：运行时参与指针点击命中（false 时仅展示） */
  interactable: boolean;
}

/**
 * UI 布局容器原型文档（Layout Group）
 *
 * 按横向/竖向/网格排列其直接子 UI 节点。自身是一个"无形 Widget"：有 size/锚点/
 * sortOrder（可被父布局排列、参与锚点定位），但不渲染内容；子元素位置由本容器在
 * 每帧布局解析中接管（resolveUILayoutCenters），子元素的 anchoredPosition 被忽略
 * （与 Unity Layout Group 同语义）；layoutMode=none 时子元素回归锚点定位。
 * 排列顺序 = 层级子节点顺序；子元素在槽位/格子内居中。
 *
 * 结构：
 * ```
 * UILayoutNode extends UIWidgetNode {
 *   layoutMode: string      // "none" | "horizontal" | "vertical" | "grid"
 *   padding: UIPaddingDoc   // 内容区内边距（UI 单位）
 *   spacing: Vec2           // 子元素间距（UI 单位；x 横向 / y 纵向）
 *   gridColumns: number     // 网格列数（grid 模式；行数由子元素数量推导）
 * }
 * ```
 */
export interface UILayoutNodePrototypeDoc extends UIWidgetPrototypeDoc {
  type: "uiLayoutNode";

  /**
   * 排列模式：
   * - "none": 不排列（纯容器，子元素走锚点定位）
   * - "horizontal": 横向一行（从内容区左缘起向右排，垂直居中）
   * - "vertical": 竖向一列（从内容区顶缘起向下排，水平居中）
   * - "grid": 网格（格子尺寸 = 子元素最大宽高，行从上往下）
   */
  layoutMode: "none" | "horizontal" | "vertical" | "grid";

  /** 内容区内边距（UI 单位；内容区 = 容器矩形收进四边） */
  padding: { left: number; right: number; top: number; bottom: number };

  /** 子元素间距（UI 单位；x 横向 / y 纵向） */
  spacing: { x: number; y: number };

  /** 网格列数（grid 模式，≥1；行数由子元素数量推导） */
  gridColumns: number;
}

/**
 * 基元变换原型文档
 * 
 * 定义节点的空间变换信息。
 * 
 * 结构：
 * ```
 * Transform {
 *   position: Vec3   // 位置
 *   rotation: Euler  // 旋转（欧拉角）
 *   scale: Vec3      // 缩放
 * }
 * ```
 * 
 * 使用场景：
 * - 所有节点都包含一个 Transform 实例
 * - 支持深拷贝（clone）和序列化（toJSON/fromJSON）
 * - 可派生扩展（如 AnchoredTransform）
 */
export interface TransformPrototypeDoc {
  /**
   * 变换类型标识
   * - "transform": 基础变换
   * - "anchoredTransform": 带锚点的变换
   */
  type: "transform" | "anchoredTransform";

  /**
   * 位置
   * 
   * 世界坐标（x, y, z）
   */
  position: { x: number; y: number; z: number };

  /**
   * 旋转
   * 
   * 欧拉角（x, y, z），单位：度
   */
  rotation: { x: number; y: number; z: number };

  /**
   * 缩放
   * 
   * 沿各轴的缩放因子，默认 (1, 1, 1)
   */
  scale: { x: number; y: number; z: number };

  /**
   * 锚点（仅 AnchoredTransform）
   * 
   * 用于锚定变换的参考点
   */
  anchor?: { x: number; y: number; z: number };
}

/**
 * 原型类型映射
 *
 * 用于编辑器根据类型标识创建对应的原型实例
 */
export interface PrototypeTypeMap {
  node: NodePrototypeDoc;
  meshNode: MeshNodePrototypeDoc;
  lightNode: LightNodePrototypeDoc;
  cameraNode: CameraNodePrototypeDoc;
  uiCanvasNode: UICanvasNodePrototypeDoc;
  uiImageNode: UIImageNodePrototypeDoc;
  uiTextNode: UITextNodePrototypeDoc;
  uiButtonNode: UIButtonNodePrototypeDoc;
  uiLayoutNode: UILayoutNodePrototypeDoc;
  transform: TransformPrototypeDoc;
  anchoredTransform: TransformPrototypeDoc;
}

/**
 * 原型文档完整结构
 *
 * 包含所有原型类型的文档定义
 */
export interface PrototypeDocumentation {
  /** 场景原型文档 */
  scene: ScenePrototypeDoc;
  /** 节点原型文档 */
  node: NodePrototypeDoc;
  /** 网格节点原型文档 */
  meshNode: MeshNodePrototypeDoc;
  /** 灯光节点原型文档 */
  lightNode: LightNodePrototypeDoc;
  /** 相机节点原型文档 */
  cameraNode: CameraNodePrototypeDoc;
  /** UI 画布节点原型文档 */
  uiCanvasNode: UICanvasNodePrototypeDoc;
  /** UI Widget 基类原型文档（图片/文本/按钮/布局容器的共有字段） */
  uiWidget: UIWidgetPrototypeDoc;
  /** UI 图片节点原型文档 */
  uiImageNode: UIImageNodePrototypeDoc;
  /** UI 文本节点原型文档 */
  uiTextNode: UITextNodePrototypeDoc;
  /** UI 按钮节点原型文档 */
  uiButtonNode: UIButtonNodePrototypeDoc;
  /** UI 布局容器节点原型文档 */
  uiLayoutNode: UILayoutNodePrototypeDoc;
  /** 变换原型文档 */
  transform: TransformPrototypeDoc;
}
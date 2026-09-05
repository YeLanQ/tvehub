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
 * 类似 Unity `.unity` 场景文件。
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
   * 包含渲染、物理等全局设置
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
    /** 物理设置 */
    physics: {
      /** 重力向量 */
      gravity: { x: number; y: number; z: number };
      /** 是否启用物理模拟 */
      physicsEnabled: boolean;
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
    type: "node" | "meshNode" | "lightNode" | "cameraNode";
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
   */
  type: "node" | "meshNode" | "lightNode" | "cameraNode";

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
  /** 变换原型文档 */
  transform: TransformPrototypeDoc;
}
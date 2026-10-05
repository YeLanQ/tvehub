// ---------------------------------------------------------------------------
// 运行时场景节点 JSON 的结构视图：buildSceneTree 产出的节点/网格/裁剪条目在
// 各运行时子系统（批处理/LOD/逻辑/物理/动画）间流转，这里只声明它们只读的
// 通用字段；未知名的段经索引签名放行，形状对齐编辑器 framework/prototype
// 的节点序列化（.scene 文档节点）。
// ---------------------------------------------------------------------------

/** 节点组件 JSON（type/enabled 为通用字段；组件私有字段按消费点窄化） */
export interface NodeComponentJson {
  type?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

/** 场景节点 JSON（运行时只读视图） */
export interface NodeJson {
  /** 节点 id（tve SDK 实体寻址；根/内部对象可能缺省） */
  id?: string;
  /** 节点类型（meshNode/cameraNode/fsmRunnerNode/…） */
  type?: string;
  name?: string;
  tag?: string;
  /** 网格来源：primitive 基元 / data 数据化网格 / model 模型实例 */
  source?: string;
  /** 模型资产 rel（source=model 时） */
  model?: string;
  active?: boolean;
  visible?: boolean;
  /** 节点设置（逻辑运行器/粒子等按需读取） */
  settings?: Record<string, unknown>;
  components?: NodeComponentJson[];
  [key: string]: unknown;
}

import { Node } from "../prototype/Node";

import { cloneRecord, type JsonRecord, type JsonValue } from "../prototype/types";

/**
 * 场景版本信息
 */
export interface SceneVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * 场景元数据
 */
export interface SceneMetadata {
  /** 场景名称 */
  name: string;
  /** 场景版本 */
  version: SceneVersion;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 最后修改时间 (ISO 8601) */
  modifiedAt: string;
  /** 场景描述 */
  description?: string;
  /** 自定义标签 */
  tags?: string[];
  /** 自定义元数据 */
  custom?: JsonRecord;
}

/**
 * 场景渲染设置
 *
 * 雾效为场景环境节点（FogNode："新建 > 雾 > 雾类型"，支持线性/指数雾），
 * 不再走场景全局开关。
 */
export interface SceneRenderingSettings {
  /** 背景色 (RGB hex) */
  backgroundColor: number;
  /** 环境光强度 */
  ambientIntensity: number;
  /** 环境光颜色 */
  ambientColor: number;
}

/**
 * 场景完整设置
 */
export interface SceneSettings {
  rendering: SceneRenderingSettings;
}

/**
 * 创建默认场景元数据
 */
export function createDefaultMetadata(name: string = "Untitled Scene"): SceneMetadata {
  const now = new Date().toISOString();
  return {
    name,
    version: { major: 1, minor: 0, patch: 0 },
    createdAt: now,
    modifiedAt: now,
    tags: [],
  };
}

/**
 * 创建默认场景设置
 */
export function createDefaultSettings(): SceneSettings {
  return {
    rendering: {
      backgroundColor: 0,
      ambientIntensity: 0.3,
      ambientColor: 0xffffff,
    },
  };
}

/**
 * 场景原型结构体
 * 
 * 定义场景文件的完整数据结构，用于序列化/反序列化场景。
 * 包含：
 * - 场景元数据（名称、版本、创建时间等）
 * - 场景设置（渲染；物理配置在项目设置中）
 * - 节点树（层级结构）
 * 
 * 编辑器通过此结构体：
 * - 加载场景文件
 * - 保存场景文件
 * - 创建新场景
 * - 预览场景结构
 */
export class ScenePrototype {
  /** 场景元数据 */
  metadata: SceneMetadata;
  
  /** 场景设置 */
  settings: SceneSettings;
  
  /** 根节点 ID */
  rootId: string | null;
  
  /** 所有节点 (id -> node) */
  nodes: Map<string, Node>;
  
  /** 子节点索引 (parentId -> childIds[]) */
  childrenIndex: Map<string, string[]>;

  constructor() {
    this.metadata = createDefaultMetadata();
    this.settings = createDefaultSettings();
    this.rootId = null;
    this.nodes = new Map();
    this.childrenIndex = new Map();
  }

  /**
   * 从 JSON 数据创建场景原型
   */
  static fromJSON(json: JsonRecord): ScenePrototype {
    const scene = new ScenePrototype();
    
    // 解析元数据
    if (json.metadata) {
      const meta = json.metadata as JsonRecord;
      scene.metadata = {
        name: (meta.name as string) ?? "Untitled Scene",
        version: (meta.version as unknown as SceneVersion) ?? { major: 1, minor: 0, patch: 0 },
        createdAt: (meta.createdAt as string) ?? new Date().toISOString(),
        modifiedAt: (meta.modifiedAt as string) ?? new Date().toISOString(),
        description: meta.description as string | undefined,
        tags: (meta.tags as string[]) ?? [],
        custom: (meta.custom as JsonRecord) ?? {},
      };
    }
    
    // 解析设置
    if (json.settings) {
      const settings = json.settings as JsonRecord;
      if (settings.rendering) {
        const r = settings.rendering as JsonRecord;
        scene.settings.rendering = { ...scene.settings.rendering, ...r };
      }

    }
    
    // 解析节点树
    if (json.root) {
      const root = Node.fromJSON(json.root as JsonRecord);
      scene.nodes.set(root.id, root);
      scene.rootId = root.id;
      scene.buildChildrenIndex(root);
    }
    
    return scene;
  }

  /**
   * 构建子节点索引
   */
  private buildChildrenIndex(node: Node): void {
    if (node.childIds.length > 0) {
      this.childrenIndex.set(node.id, [...node.childIds]);
    }
    for (const childId of node.childIds) {
      const child = this.nodes.get(childId);
      if (child) {
        this.buildChildrenIndex(child);
      }
    }
  }

  /**
   * 序列化为 JSON
   */
  toJSON(): JsonRecord {
    const result: JsonRecord = {
      metadata: { ...this.metadata } as unknown as JsonRecord,
      settings: {
        rendering: { ...this.settings.rendering } as unknown as JsonRecord,
      },
    };
    
    if (this.rootId && this.nodes.has(this.rootId)) {
      const root = this.nodes.get(this.rootId)!;
      result.root = this.serializeNode(root);
    }
    
    return result;
  }

  /**
   * 递归序列化节点
   */
  private serializeNode(node: Node): JsonValue {
    const json = node.toJSON() as JsonRecord;
    const children: JsonValue[] = [];
    
    for (const childId of node.childIds) {
      const child = this.nodes.get(childId);
      if (child) {
        children.push(this.serializeNode(child));
      }
    }
    
    if (children.length > 0) {
      json.children = children;
    }
    
    return json;
  }

  /**
   * 添加节点
   */
  addNode(node: Node, parentId: string | null = null): void {
    node.parentId = parentId;
    this.nodes.set(node.id, node);
    
    if (parentId) {
      const siblings = this.childrenIndex.get(parentId) ?? [];
      if (!siblings.includes(node.id)) {
        siblings.push(node.id);
        this.childrenIndex.set(parentId, siblings);
      }
      const parent = this.nodes.get(parentId);
      if (parent && !parent.childIds.includes(node.id)) {
        parent.childIds.push(node.id);
      }
    } else {
      this.rootId = node.id;
    }
    
    // 更新修改时间
    this.touch();
  }

  /**
   * 移除节点
   */
  removeNode(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    
    // 递归移除子节点
    for (const childId of [...node.childIds]) {
      this.removeNode(childId);
    }
    
    // 从父节点移除引用
    if (node.parentId) {
      const siblings = this.childrenIndex.get(node.parentId);
      if (siblings) {
        const idx = siblings.indexOf(nodeId);
        if (idx >= 0) siblings.splice(idx, 1);
      }
      const parent = this.nodes.get(node.parentId!);
      if (parent) {
        parent.childIds = parent.childIds.filter(id => id !== nodeId);
      }
    } else {
      this.rootId = null;
    }
    
    // 移除节点
    this.nodes.delete(nodeId);
    this.childrenIndex.delete(nodeId);
    
    this.touch();
    return true;
  }

  /**
   * 查找节点
   */
  findNode(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  /**
   * 获取子节点
   */
  getChildren(parentId: string): Node[] {
    const ids = this.childrenIndex.get(parentId);
    if (!ids) return [];
    return ids.map(id => this.nodes.get(id)).filter((n): n is Node => !!n);
  }

  /**
   * 更新修改时间
   */
  private touch(): void {
    this.metadata.modifiedAt = new Date().toISOString();
  }

  /**
   * 克隆场景原型
   */
  clone(): ScenePrototype {
    const clone = new ScenePrototype();
    clone.metadata = cloneRecord(this.metadata as unknown as JsonRecord) as unknown as SceneMetadata;
    clone.settings = cloneRecord(this.settings as unknown as JsonRecord) as unknown as SceneSettings;
    
    if (this.rootId) {
      const root = this.nodes.get(this.rootId);
      if (root) {
        const clonedRoot = this.cloneNode(root);
        clone.addNode(clonedRoot);
      }
    }
    
    return clone;
  }

  /**
   * 递归克隆节点
   */
  private cloneNode(node: Node): Node {
    const clone = node.clone();
    const clonedChildren = node.childIds.map(childId => {
      const child = this.nodes.get(childId);
      return child ? this.cloneNode(child) : null;
    }).filter((n): n is Node => !!n);
    
    for (const child of clonedChildren) {
      child.parentId = clone.id;
      this.nodes.set(child.id, child);
      clone.childIds.push(child.id);
    }
    
    this.nodes.set(clone.id, clone);
    return clone;
  }

  /**
   * 清空场景
   */
  clear(): void {
    this.nodes.clear();
    this.childrenIndex.clear();
    this.rootId = null;
    this.metadata = createDefaultMetadata();
    this.touch();
  }

  /**
   * 检查是否为空场景
   */
  isEmpty(): boolean {
    return this.rootId === null || this.nodes.size === 0;
  }

  /**
   * 获取节点数量
   */
  getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * 遍历所有节点（深度优先）
   */
  traverse(callback: (node: Node) => void): void {
    if (!this.rootId) return;
    const root = this.nodes.get(this.rootId);
    if (root) {
      this.traverseNode(root, callback);
    }
  }

  private traverseNode(node: Node, callback: (node: Node) => void): void {
    callback(node);
    for (const childId of node.childIds) {
      const child = this.nodes.get(childId);
      if (child) {
        this.traverseNode(child, callback);
      }
    }
  }
}
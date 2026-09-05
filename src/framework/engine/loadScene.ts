import type { EditorEngine } from "./EditorEngine";
import type { Node } from "../prototype/Node";
import type { JsonRecord } from "../prototype/types";

/**
 * 从场景文件 JSON 文本加载节点树到引擎场景图。
 * 支持 ScenePrototype / SceneGraph 序列化的嵌套 `children` 格式；
 * 节点类型经 engine.factory（PrototypeRegistry）按 `type` 还原为对应派生类。
 * 返回是否成功加载（场景为空/损坏/含魔法空标记时返回 false，由调用方回退到初始场景）。
 */
export function loadSceneFromJson(engine: EditorEngine, sceneJson: string): boolean {
  const data = JSON.parse(sceneJson) as JsonRecord;
  const rootJson = data.root as JsonRecord | undefined;
  if (!rootJson || typeof rootJson !== "object") return false;
  // 旧版空场景输出会写下 type="empty" 的魔法标记，无法还原为节点 → 视为空场景
  if (rootJson.type === "empty") return false;

  try {
    const all: Node[] = [];
    const root = parseNode(rootJson, engine, all);
    engine.replaceGraph(root, all);
    return true;
  } catch (e) {
    console.warn(`[scene] 场景解析失败: ${String(e)}`);
    return false;
  }
}

/** 递归解析单个节点：还原派生类型，重建 childIds / parentId 链 */
function parseNode(json: JsonRecord, engine: EditorEngine, all: Node[]): Node {
  const node = engine.factory.fromJSON(json);
  node.childIds = [];

  const children = json.children as JsonRecord[] | undefined;
  if (Array.isArray(children)) {
    for (const childJson of children) {
      const child = parseNode(childJson, engine, all);
      child.parentId = node.id;
      node.childIds.push(child.id);
      all.push(child);
    }
  }

  all.push(node);
  return node;
}
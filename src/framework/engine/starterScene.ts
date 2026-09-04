import type { EditorEngine } from "./EditorEngine";
import { Node } from "../prototype/Node";
import { vec3 } from "../prototype/types";

/**
 * 搭建初始场景：一个根 Group 节点 + 一盏环境光 + 一盏方向光。
 * 通过工厂派生原型节点，并直接写入场景图（初始态不入历史栈）。
 */
export function setupStarterScene(engine: EditorEngine): void {
  const root = new Node({ name: "Scene Root" });

  engine.graph.setRoot(root);

  const ambient = engine.factory.createLight("ambient", { parentId: root.id, name: "Ambient" });
  engine.graph.add(ambient);

  const sun = engine.factory.createLight("directional", { parentId: root.id, name: "Directional Light" });
  sun.intensity = 2.0;
  sun.castShadow = true;
  sun.transform.position = vec3(6, 10, 6);
  engine.graph.add(sun);

  const cube = engine.factory.createMesh("box", { parentId: root.id, name: "Starter Cube" });
  cube.transform.position = vec3(0, 0.5, 0);
  engine.graph.add(cube);

  engine.rebuildAll();
  engine.select(cube.id);
}
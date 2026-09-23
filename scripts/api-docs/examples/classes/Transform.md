```ts tve
import { Component, property, Transform, MeshNode, LightNode, CameraNode, SkyboxNode, FogNode, engine } from "tve";

export default class NodeRefs extends Component {
  // 通用节点（Transform = 空组基类，可引用任意场景节点）
  @property({ type: Transform, label: "出生点" })
  spawn: Transform | null = null;

  // 网格节点（基元/模型网格）
  @property({ type: MeshNode, label: "目标网格" })
  target: MeshNode | null = null;

  // 灯光 / 相机 / 天空盒 / 雾节点（场景节点句柄）
  @property({ type: LightNode, label: "光源" })
  lamp: LightNode | null = null;
  @property({ type: CameraNode, label: "相机" })
  cam: CameraNode | null = null;
  @property({ type: SkyboxNode, label: "天空盒" })
  sky: SkyboxNode | null = null;
  @property({ type: FogNode, label: "雾" })
  fog: FogNode | null = null;

  onStart() {
    // 节点句柄 = Entity 子类：全部通用能力（变换/层级/查找/组件）可用
    if (this.spawn) this.entity.position = this.spawn.position;
    // instanceof 收窄（engine.scene.find 返回宽类型 Entity）
    const found = engine.scene.find("主相机");
    if (found instanceof CameraNode) found.lookAt({ x: 0, y: 0, z: 0 });
  }
}
```

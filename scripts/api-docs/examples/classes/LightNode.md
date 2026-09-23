```ts tve
import { Component, property, LightNode, Light } from "tve";

export default class LightNodeDemo extends Component {
  // 引用灯光【节点】（变换/层级/可见性走 Entity 能力）
  @property({ type: LightNode, label: "吊灯节点" })
  lampNode: LightNode | null = null;

  onUpdate() {
    if (!this.lampNode) return;
    // 节点级操作：位置/旋转/可见
    this.lampNode.visible = true;
    // 灯光【属性】（intensity/color/kind…）经组件门面 Light 访问——
    // LightNode 是节点句柄不是组件，不能传给 getComponent
    const light = this.lampNode.getComponent(Light);
    if (light) light.intensity = 2 + Math.sin(Date.now() / 300);
  }
}
```

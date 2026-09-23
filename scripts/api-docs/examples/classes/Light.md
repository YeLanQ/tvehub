```ts tve
import { Component, property, LightNode, Light, tween } from "tve";

export default class Torch extends Component {
  @property({ type: LightNode, label: "火把节点" })
  lamp: LightNode | null = null;

  onStart() {
    // 灯光属性经组件门面 Light 访问（节点句柄只管变换/层级）
    const light = this.lamp?.getComponent(Light);
    if (!light) return;
    light.kind = "point";       // point/directional/spot/ambient（切换即重建灯光）
    light.color = 0xffa030;
    light.intensity = 2;
    light.distance = 12;        // 点光/聚光照射距离
    light.decay = 2;            // 物理衰减指数
    light.castShadow = true;
    light.shadowStrength = 0.6; // 阴影浓度 0~1

    // 聚光灯参数
    // light.angle = 30;        // 光束半角（度）
    // light.penumbra = 0.4;    // 边缘柔和度 0~1

    // 渲染层级掩码（只照亮掩码内层的对象；-1 = 全部）
    // light.cullingMask = 0b11;

    // 火光呼吸（intensity 补间循环往返）
    tween.to(light, { intensity: 3 }, 0.4).yoyo(true).loop(-1).easing("sineInOut");
  }
}
```

```ts tve
import { Component, property, SkyboxNode, FogNode } from "tve";

export default class Weather extends Component {
  // 天空盒节点引用（环境级；场景配置在检查器，脚本可运行态微调）
  @property({ type: SkyboxNode, label: "天空盒" })
  sky: SkyboxNode | null = null;

  // 雾节点引用（场景环境级：第一个启用且可见的雾节点生效）
  @property({ type: FogNode, label: "雾" })
  fog: FogNode | null = null;

  onStart() {
    // 运行态开关（不回写场景文件）
    if (this.fog) this.fog.visible = false;
    if (this.sky) this.sky.visible = true;
  }
}
```

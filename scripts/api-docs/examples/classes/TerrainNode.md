```ts tve
import { Component, property, TerrainNode, math } from "tve";

export default class Drop extends Component {
  @property({ type: TerrainNode, label: "地形" })
  ground: TerrainNode | null = null;

  @property({ label: "离地高度", step: 0.1 })
  offset = 0;

  onUpdate() {
    if (!this.ground) return;
    // 贴地：双线性采样地表高度（节点本地 x/z；仅平移的地形即世界坐标）
    const p = this.entity.position;
    p.y = this.ground.sampleHeight(p.x, p.z) + this.offset;
    this.entity.position = p;
  }
}
```

撒放装饰物（平坦度检测）：

```ts tve
import { Component, property, TerrainNode, math, Vec3 } from "tve";

export default class Scatter extends Component {
  @property({ type: TerrainNode, label: "地形" })
  ground: TerrainNode | null = null;

  scatter(count: number): Vec3[] {
    if (!this.ground) return [];
    const out: Vec3[] = [];
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 100;
      const z = (Math.random() - 0.5) * 100;
      // sampleSlope：1 = 平地 → 0 = 崖壁（有限差分估算）
      if (this.ground.sampleSlope(x, z) > 0.85) {
        out.push(math.v3(x, this.ground.sampleHeight(x, z), z));
      }
    }
    return out;
  }

  onStart() {
    // 地形设置快照（只读；seed/size/segments/heightScale…）
    void this.ground?.settings;
    this.scatter(50);
  }
}
```

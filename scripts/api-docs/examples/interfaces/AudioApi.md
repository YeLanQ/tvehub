```ts tve
import { Component, property, MeshNode, engine } from "tve";

export default class Bgm extends Component {
  @property({ type: MeshNode, label: "音源节点" })
  source: MeshNode | null = null;

  onStart() {
    if (!this.source) return;
    // 音频运行期控制（按实体寻址：音源节点或挂音源组件的节点）
    engine.audio.play(this.source);
    engine.audio.setVolume(this.source, 0.5); // 运行时音量（不落盘）
    // engine.audio.pause(this.source);
    // engine.audio.resume(this.source);
    // engine.audio.stop(this.source);
  }
}
```

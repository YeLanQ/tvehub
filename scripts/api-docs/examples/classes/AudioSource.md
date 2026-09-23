```ts tve
import { Component, AudioSource } from "tve";

export default class Sfx extends Component {
  sfx!: AudioSource; // 组件字段：运行期自动绑定门面

  onStart() {
    // 音源设置（写入经运行时合并生效）
    this.sfx.source = "assets/hit.ogg"; // 音频资产引用（写入即重载）
    this.sfx.loop = false;
    this.sfx.volume = 0.8;              // 0..1
    this.sfx.speed = 1;                 // 播放倍速 0.1..4
    this.sfx.spatial = "3d";            // "2d" 全局 / "3d" 位置音源

    // 播放控制（按组件 id 寻址）
    this.sfx.play();     // 暂停态续播；停止/播完态从头播
    // this.sfx.pause();
    // this.sfx.resume();
    // this.sfx.stop();
    this.sfx.setVolume(0.5); // 运行时音量
  }

  onUpdate() {
    // 只读运行态
    void this.sfx.playing;
    void this.sfx.paused;
    void this.sfx.ready; // 缓冲是否就绪
  }
}
```

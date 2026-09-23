```ts tve
import { Component, AnimationClip } from "tve";

export default class DoorAnim extends Component {
  anim!: AnimationClip; // 关键帧动画剪辑组件（.anim 资产）门面

  onStart() {
    // 绑定剪辑（相对路径；写入即重载；空串解绑）
    this.anim.clip = "assets/door-open.anim";
    this.anim.loop = false;
    this.anim.speed = 1;
    this.anim.autoplay = true;

    // 播放控制与进度
    this.anim.play();   // 从头播放
    // this.anim.pause();
    // this.anim.resume();
    // this.anim.stop();        // 停止并回初始姿势
    // this.anim.time = 0.5;    // 写入即跳转采样（秒）
    void this.anim.duration;    // 剪辑时长（秒；未加载 0）
    void this.anim.playing;
  }
}
```

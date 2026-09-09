// @desc: 脚本驱动动画：动画剪辑组件 / 骨骼动画 / 动画图（组件字段声明 + getComponent + addComponent）
import { Component, property, engine, MeshNode, AnimationClip, SkeletalAnimation } from "tve";

// 演示脚本动画的三条通路：
// 1. 组件字段声明（clipAnim!: AnimationClip）：宿主在本实体上 get-or-create
//    动画剪辑组件并绑定门面，直接改参数/播放；
// 2. entity.getComponent(SkeletalAnimation)：取目标模型节点上已挂载的骨骼动画
//    （模型内嵌动画），读剪辑列表、播放；
// 3. entity.addComponent / ensureGraph：运行期动态创建动画图（状态机 + 参数条件过渡），
//    并用 setParam 驱动状态切换。
// 使用：把本脚本挂到带 .anim 剪辑组件的节点上，target 指向一个模型网格节点。
export default class AnimationDemo extends Component {
  // 组件字段声明：运行期 = 本实体上的关键帧动画剪辑组件（没有则自动创建）
  clipAnim!: AnimationClip;

  @property({ type: MeshNode, label: "目标模型（骨骼动画）" })
  target: MeshNode | null = null;

  @property({ label: "开始建图时间（秒）", min: 0, step: 0.5 })
  graphAt = 5;

  private skel: SkeletalAnimation | null = null;
  private graphBuilt = false;
  private t = 0;

  onStart() {
    // 1) 组件字段声明的剪辑组件：有 .anim 绑定才播放
    if (this.clipAnim && this.clipAnim.clip) {
      this.clipAnim.speed = 1.5;
      this.clipAnim.loop = true;
      this.clipAnim.play();
      engine.log("剪辑组件已播放：", this.clipAnim.clip, "时长", this.clipAnim.duration, "s");
    } else {
      engine.warn("本节点没有绑定 .anim 剪辑（可在检查器为动画剪辑组件选择资产）");
    }

    // 2) 获取目标模型节点的骨骼动画
    if (this.target) {
      this.skel = this.target.getComponent(SkeletalAnimation);
      if (this.skel) {
        engine.log("模型内嵌剪辑：", this.skel.clips.join(", ") || "（无）");
        this.skel.play();
      } else {
        engine.warn("目标节点不是模型网格（或没有内嵌动画）");
      }
    }
  }

  onUpdate(delta: number) {
    this.t += delta;

    // 3) 到点后动态创建动画图：A↔B 双状态 + go 参数条件过渡
    if (this.skel && !this.graphBuilt && this.t >= this.graphAt) {
      this.graphBuilt = true;
      const first = this.skel.clips[0] ?? "";
      const second = this.skel.clips[1] ?? first;
      if (!first) return;
      const ok = this.skel.ensureGraph({
        entry: "A",
        states: [
          { name: "A", clip: first, speed: 1, loop: "loop" },
          { name: "B", clip: second, speed: 1.2, loop: "loop" },
        ],
        transitions: [
          { from: "A", to: "B", duration: 0.3, exitTime: 0, conditions: [{ param: "go", op: ">", value: 0 }] },
          { from: "B", to: "A", duration: 0.3, exitTime: 0, conditions: [{ param: "go", op: "<", value: 1 }] },
        ],
        params: { go: 0 },
      });
      engine.log(ok ? "动画图已创建（A↔B）" : "动画图创建失败");
    }

    // 每 3 秒翻转 go 参数驱动过渡
    if (this.skel?.hasGraph) {
      const bucket = Math.floor(this.t / 3);
      if (bucket !== Math.floor((this.t - delta) / 3)) {
        const next = this.skel.getParam("go") === 1 ? 0 : 1;
        this.skel.setParam("go", next);
        engine.log("go =", next, "当前剪辑：", this.skel.currentClip);
      }
    }
  }
}

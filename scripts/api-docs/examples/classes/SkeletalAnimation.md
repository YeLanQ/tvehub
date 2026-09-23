```ts tve
import { Component, SkeletalAnimation } from "tve";

export default class ActorAnim extends Component {
  // 仅模型网格节点拥有绑定；组件字段运行期自动绑定门面
  anim!: SkeletalAnimation;

  onStart() {
    // 单剪辑模式
    this.anim.clip = "run";      // 模型内嵌剪辑名（写入即切换播放）
    this.anim.speed = 1.2;
    this.anim.loop = "loop";     // loop / once / pingpong
    this.anim.play();            // 缺省取首个剪辑

    void this.anim.clips;        // 模型内嵌剪辑名列表
    void this.anim.currentClip;
    void this.anim.playing;
    void this.anim.hasGraph;     // 是否动画图模式

    // —— 混合层（权重独立于 play/stop）——
    this.anim.fadeIn("walk", 0.25);          // 权重 0→1
    this.anim.fadeOut("run", 0.25);          // 权重→0（动作不停止）
    this.anim.crossFade("run", "walk", 0.3); // 交叉淡化（warp 自动对齐相位）
    this.anim.setWeight("aim", 0.7);         // 直接设权重（确保动作在播）
    void this.anim.getWeight("aim");
    this.anim.setActionSpeed("walk", 1.5);   // 单动作速度（与全局速度相乘）
    this.anim.setActionLoop("attack", "once");
    this.anim.playOneShot("wave");           // 一次性动作：定格末帧后淡回基础层
    this.anim.globalSpeed(1);
    this.anim.stopAction("aim");             // 停止单层

    // 事件订阅（返回注销函数）
    const off1 = this.anim.onFinished((e) => { void e.clip; }); // 播完
    const off2 = this.anim.onLoop((e) => { void e.clip; });     // 循环
    void off1; void off2;

    // 加法混合层（独立权重，如疲劳叠加摆动）
    this.anim.playAdditive("tired", 0.5);
    this.anim.stopAdditive("tired");
  }
}
```

蒙皮完全控制（骨骼/形态键/IK/绑定）：

```ts tve
import { Component, SkeletalAnimation } from "tve";

export default class RigControl extends Component {
  anim!: SkeletalAnimation;

  onStart() {
    void this.anim.skinInfo;   // {boneCount, boneNames, morphMeshes}
    void this.anim.bones;      // 骨骼名列表
    void this.anim.boneHierarchy; // [{name,parent,children}]
    void this.anim.morphs;     // [{mesh, targets}] 形态键清单

    // 骨骼读写（度制欧拉；动作播放中 mixer 每帧覆写被驱动骨骼——
    // 手动写入适用于暂停/未被驱动的骨骼，或每帧覆写场景）
    void this.anim.getBoneTransform("head"); // {position,rotation,scale} 快照
    this.anim.setBoneRotation("head", 0, 15, 0);
    this.anim.resetBone("head");
    this.anim.resetPose();
    void this.anim.getBoneWorldPosition("leftHand");

    // 形态键（0..1 权重；mesh 传 "" 取首个含该目标的网格）
    this.anim.setMorphWeight("", "smile", 0.8);
    void this.anim.getMorphWeight("", "smile");

    // 场景节点绑到骨骼上跟随（装备挂点）
    // this.anim.attachToBone(swordEntity, "rightHand", { keepOffset: true });
    // this.anim.detach(swordEntity);
    void this.anim.attachments;
  }
}
```

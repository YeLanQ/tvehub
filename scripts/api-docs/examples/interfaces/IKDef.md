```ts tve
import { Component, SkeletalAnimation, IKDef } from "tve";

export default class LookAt extends Component {
  anim!: SkeletalAnimation;

  onStart() {
    // 注册 IK 链（CCD 求解）：末端效应器 + 从其父级向根的关节链
    const def: IKDef = {
      name: "headLook",
      effector: "head",
      links: [
        { bone: "neck", rotationMin: [-30, -45, -15], rotationMax: [30, 45, 15] },
        { bone: "spine2", enabled: true },
      ],
      iteration: 2,
    };
    const id = this.anim.addIK(def); // 成功返回 IK id，失败 null
    if (id) {
      // 目标点（模型根局部空间）每帧写入驱动求解
      this.ikId = id;
    }
  }

  private ikId = "";

  onUpdate() {
    if (!this.ikId) return;
    this.anim.setIKTargetPosition(this.ikId, 0.3, 1.6, -0.8);
    // 读取 / 启停 / 清单
    void this.anim.getIKTargetPosition(this.ikId);
    void this.anim.iks; // [{id,name,effector,enabled}]
    // this.anim.setIKEnabled(this.ikId, false);
    // this.anim.removeIK(this.ikId);
  }
}
```

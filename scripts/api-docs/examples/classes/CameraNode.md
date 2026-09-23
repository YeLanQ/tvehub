```ts tve
import { Component, property, CameraNode, math } from "tve";

export default class CameraPick extends Component {
  @property({ type: CameraNode, label: "相机" })
  cam: CameraNode | null = null;

  onStart() {
    // 相机跟随（晚更新阶段覆盖本帧一切位姿写入 → onLateUpdate）
  }

  onLateUpdate(delta: number) {
    if (!this.cam) return;
    const p = this.cam.position;
    this.cam.position = math.lerp(p, this.entity.position, 1 - Math.pow(0.9, delta * 60));
    this.cam.lookAt(this.entity.position);
  }

  onUpdate() {
    if (!this.cam) return;
    // 屏幕坐标 → 世界射线（拾取/视线检测；坐标与 engine.input.pointer 同一空间）
    const ray = this.cam.screenToRay(200, 150);
    if (ray) {
      // ray.origin = 相机世界位置；ray.direction = 归一化世界方向
      void ray.origin;
      void ray.direction;
      // 配合物理射线：engine.physics.castRay({ origin: ray.origin, direction: ray.direction })
    }
    // 相机未就绪/坐标越界 → null
    this.cam.screenToRay(-5, -5); // null：越界
  }
}
```

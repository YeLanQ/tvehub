// @desc: 从相机发射物理射线拾取物体：点击屏幕 → 屏幕坐标转世界射线 → 命中物体高亮/输出（鼠标点击拾取）
import { Component, property, engine, Transform, CameraNode, Entity } from "tve";

// 前提：场景中有挂碰撞体的节点，且项目设置启用物理。
// 用法：把本脚本挂在任意节点，camera 拖入场景中的相机节点。
// 点击屏幕时把点击坐标经相机反投影为世界射线，再用物理 castRay 拾取最近碰撞体。
// castRay 在 Worker 模式下返回 Promise，这里统一 await（主线程模式立即解决）。
export default class {{CLASS_NAME}} extends Component {
  /** 相机节点（提供 screenToRay：屏幕像素 → 世界射线） */
  @property({ type: CameraNode, label: "相机节点" })
  camera: CameraNode | null = null;

  @property({ label: "最大距离（米）", min: 0, step: 1 })
  maxDistance = 100;

  /** 命中标记节点（可选；命中时移到命中点，未命中隐藏） */
  @property({ type: Transform, label: "命中标记（可选）" })
  marker: Transform | null = null;

  /** 最近命中实体（外部脚本可读取；未命中 null） */
  hitEntity: Entity | null = null;

  private offClick?: () => void;

  onEnable() {
    this.offClick = engine.input.onPointerDown((p) => { void this.pick(p.x, p.y); });
  }

  onDisable() {
    this.offClick?.();
    this.hitEntity = null;
    if (this.marker) this.marker.visible = false;
  }

  /** 点击拾取：屏幕坐标 → 世界射线 → 物理 castRay → 最近碰撞体 */
  private async pick(screenX: number, screenY: number): Promise<void> {
    const cam = this.camera;
    if (!cam) return;
    const ray = cam.screenToRay(screenX, screenY);
    if (!ray) return;
    const result = engine.physics.castRay({
      origin: ray.origin,
      direction: ray.direction,
      maxDistance: this.maxDistance,
      excludeNodeIds: [this.entity.id],
    });
    const hits = Array.isArray(result) ? result : await result;
    if (hits.length > 0) {
      const h = hits[0];
      const target = engine.scene.find(h.nodeId);
      this.hitEntity = target;
      if (target) {
        engine.log(`拾取 → ${target.name}（距离 ${h.distance.toFixed(2)}m）`);
      }
      if (this.marker) {
        this.marker.position = h.point;
        this.marker.visible = true;
      }
    } else {
      this.hitEntity = null;
      if (this.marker) this.marker.visible = false;
    }
  }
}

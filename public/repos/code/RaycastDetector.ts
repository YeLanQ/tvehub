// @desc: 物理射线投射：从本节点发射射线检测碰撞体，命中时输出距离/节点并可移动标记到命中点（视线检测/地面检测/点击拾取）
import { Component, property, engine, Transform, math } from "tve";

// 前提：场景中有挂碰撞体的节点，且项目设置启用物理。
// 射线从本节点世界位置出发，方向由 directionMode 决定：
// - "forward" = 节点前向（-Z 经 yaw 旋转到世界空间），适合挂在相机/角色上做视线检测
// - "down"    = 世界向下（-Y），适合地面检测/落地判断
// - "custom"  = 自定义方向向量（经归一化）
// 触发模式：
// - "continuous" = 每帧发射（地面检测/持续视线/放置预览）
// - "click"      = 点击发射（拾取/点击放置）
// 命中时可选把 marker 节点移到命中点（可视化射线落点），未命中隐藏 marker。
// castRay 在 Worker 模式下返回 Promise，这里统一 await 处理（主线程模式 Promise.resolve 立即解决）。
export default class {{CLASS_NAME}} extends Component {
  @property({ label: "射线方向" })
  directionMode: "forward" | "down" | "custom" = "forward";

  @property({ label: "自定义方向（directionMode = custom 时生效）" })
  customDirection = { x: 0, y: -1, z: 0 };

  @property({ label: "最大距离（米）", min: 0, step: 1 })
  maxDistance = 100;

  @property({ label: "触发模式" })
  triggerMode: "continuous" | "click" = "continuous";

  /** 命中标记节点（可选；命中时移到命中点，未命中隐藏） */
  @property({ type: Transform, label: "命中标记（可选）" })
  marker: Transform | null = null;

  /** 排除的节点（可选；如角色自身，避免从体内发射时命中自己） */
  @property({ type: Transform, label: "排除节点（可选）" })
  exclude: Transform | null = null;

  /** 最近一次命中结果（外部脚本可读取；未命中 null） */
  hit: { nodeId: string; distance: number; point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } | null = null;

  private offClick?: () => void;

  onStart() {
    if (this.triggerMode === "click") {
      this.offClick = engine.input.onPointerDown(() => { void this.fire(); });
    }
  }

  onDisable() {
    this.offClick?.();
    if (this.marker) this.marker.visible = false;
  }

  onUpdate() {
    if (this.triggerMode === "continuous") { void this.fire(); }
  }

  /** 发射射线并处理命中 */
  private async fire(): Promise<void> {
    const origin = this.entity.worldPosition;
    const dir = this.computeDirection();
    const excludeIds = this.exclude ? [this.exclude.id] : [];
    const result = engine.physics.castRay({
      origin,
      direction: dir,
      maxDistance: this.maxDistance,
      excludeNodeIds: excludeIds,
    });
    const hits = Array.isArray(result) ? result : await result;
    if (hits.length > 0) {
      const h = hits[0];
      this.hit = { nodeId: h.nodeId, distance: h.distance, point: h.point, normal: h.normal };
      engine.log(`命中 ${h.nodeId}（距离 ${h.distance.toFixed(2)}m）`);
      if (this.marker) {
        this.marker.position = h.point;
        this.marker.visible = true;
      }
    } else {
      this.hit = null;
      if (this.marker) this.marker.visible = false;
    }
  }

  /** 计算射线方向（世界空间；归一化） */
  private computeDirection(): { x: number; y: number; z: number } {
    if (this.directionMode === "down") return { x: 0, y: -1, z: 0 };
    if (this.directionMode === "custom") {
      const d = this.customDirection;
      const len = Math.hypot(d.x, d.y, d.z);
      if (len < 1e-9) return { x: 0, y: -1, z: 0 };
      return { x: d.x / len, y: d.y / len, z: d.z / len };
    }
    // forward = 节点前向（-Z）经 yaw 旋转到世界水平方向
    const rad = math.degToRad(this.entity.rotation.y);
    return { x: -Math.sin(rad), y: 0, z: -Math.cos(rad) };
  }
}
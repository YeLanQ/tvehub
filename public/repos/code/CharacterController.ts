// @desc: 第三人称角色控制器：WASD/方向键 + 虚拟摇杆输入、相机参照方向、平滑转向、跳跃（动力学刚体=物理移动，无刚体=位移移动）
import { Component, property, engine, Transform, math } from "tve";

// 完整用法：目标节点挂本脚本 + 相机节点挂 CameraFollow（target 指向本节点），
// 场景里摆一个虚拟摇杆（VirtualJoystick 原型）——本脚本自动读取其 dirX/dirY。
// 移动方案（onStart 自动探测，同 WASDMove）：
// - 动力学（dynamic）刚体 → 物理速度驱动：会被障碍物阻挡、支持跳跃（带重力），
//   线速度写入在 onFixedUpdate（固定步长、与物理步进同频）。注意：动力学体的
//   位姿由物理步进回写节点，转向放 onLateUpdate（回写后、渲染前）直写旋转——
//   朝向由脚本自治推进、不与求解器形成反馈回路，无抖动；物理体旋转不参与
//   解算（角色碰撞体建议胶囊/球，形状不随视觉转向）；
// - 无刚体 / 运动学 → 位移驱动：onUpdate 平移 + 直写 rotation（渲染帧率平滑；
//   不被阻挡，跳跃需要重力，此方案忽略）。
// 方向合成：输入向量默认按世界轴（W = -Z），给 camera 参照后按参照节点朝向
// （只用水平 yaw）旋转——把 CameraFollow 的相机拖进 camera 即"相机相对移动"。
export default class {{CLASS_NAME}} extends Component {
  @property({ label: "移动速度（米/秒）", min: 0 })
  speed = 5;

  /** 移动方向参照节点（缺省 = 世界轴；拖入跟随相机即相机相对移动） */
  @property({ type: Transform, label: "方向参照（缺省 = 世界轴）" })
  camera: Transform | null = null;

  /** 虚拟摇杆所在节点（可选；节点上需挂 VirtualJoystick 原型脚本） */
  @property({ type: Transform, label: "虚拟摇杆（可选）" })
  joystick: Transform | null = null;

  @property({ label: "转向速度（度/秒，0 = 瞬时）", min: 0, step: 30 })
  turnSpeed = 720;

  @property({ label: "跳跃初速（米/秒，0 = 不跳，仅物理方案）", min: 0, step: 0.5 })
  jumpSpeed = 5;

  @property({ label: "跳跃冷却（秒）", min: 0, step: 0.1 })
  jumpCooldown = 0.3;

  /** 移动方案（onStart 探测一次）：physics = 物理速度驱动 / translate = 位移驱动 */
  private scheme: "physics" | "translate" = "translate";

  /** 世界空间移动意图（onUpdate 合成，physics 方案由 onFixedUpdate 消费） */
  private moveX = 0;
  private moveZ = 0;
  /** 目标朝向（度；有移动输入时更新，两方案各自的转向逻辑消费） */
  private faceYaw = 0;
  private hasFace = false;
  /** 脚本自治的当前朝向（度；物理方案不读节点旋转——插值回写值滞后且带接触噪声） */
  private curYaw = 0;
  /** 跳跃请求（onUpdate 边沿检测置位，onFixedUpdate 消费） */
  private jumpQueued = false;
  private lastJumpAt = -1e9;
  private prevJumpKey = false;

  onStart() {
    const rb = this.entity.getComponent("rigidBody");
    if (rb && rb.mode === "dynamic") this.scheme = "physics";
    this.curYaw = this.entity.rotation.y;
  }

  onUpdate(delta: number) {
    // —— 1) 输入合成：键盘（WASD/方向键）+ 虚拟摇杆（dirX/dirY 可选）——
    const input = engine.input;
    let ix = (input.isKeyDown("KeyD") || input.isKeyDown("ArrowRight") ? 1 : 0)
      - (input.isKeyDown("KeyA") || input.isKeyDown("ArrowLeft") ? 1 : 0);
    let iz = (input.isKeyDown("KeyW") || input.isKeyDown("ArrowUp") ? 1 : 0)
      - (input.isKeyDown("KeyS") || input.isKeyDown("ArrowDown") ? 1 : 0);
    const joy = this.readJoystick();
    if (joy) {
      ix += joy.dirX;
      iz += joy.dirY;
    }
    // 斜向归一（长度截到 1，避免斜向速度更快）
    const ilen = Math.hypot(ix, iz);
    if (ilen > 1) {
      ix /= ilen;
      iz /= ilen;
    }

    // —— 2) 参照朝向：把输入从参照节点本地轴旋到世界轴（缺省 = 世界轴）——
    const refYaw = this.camera ? this.camera.rotation.y : 0;
    const rad = math.degToRad(refYaw);
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // 参照右轴 = (cos, -sin)，前轴 = (-sin, -cos)（前向 = -Z 约定）
    const wx = ix * cos - iz * sin;
    const wz = -ix * sin - iz * cos;
    this.moveX = wx;
    this.moveZ = wz;

    // —— 3) 目标朝向（度；前向 = -Z）：有移动输入时更新 ——
    if (ilen > 0.01) {
      this.faceYaw = math.radToDeg(Math.atan2(-wx, -wz));
      this.hasFace = true;
    } else {
      this.hasFace = false;
    }

    // —— 4) 跳跃：按键边沿检测（按住不连跳）——
    const jumpKey = input.isKeyDown("Space");
    if (jumpKey && !this.prevJumpKey) this.jumpQueued = true;
    this.prevJumpKey = jumpKey;

    // 位移方案：直写旋转转向 + 平移（渲染帧率平滑；无物理位姿回写冲突）
    if (this.scheme !== "physics") {
      if (this.hasFace) {
        const cur = this.entity.rotation.y;
        const next = this.turnSpeed > 0
          ? math.moveTowardsAngle(cur, this.faceYaw, this.turnSpeed * delta)
          : this.faceYaw;
        // rotation 类型为完整 Vec3（运行时容忍部分字段，这里显式写全）
        const r = this.entity.rotation;
        this.entity.rotation = { x: r.x, y: next, z: r.z };
      }
      if (ilen <= 0.01) return;
      const v = (this.speed * delta) / Math.max(1, ilen);
      this.entity.translate(wx * v, 0, wz * v);
    }
  }

  onFixedUpdate(_fixedDelta: number) {
    // 物理方案：固定步长内写线速度，碰撞由引擎解算（转向见 onLateUpdate）
    if (this.scheme !== "physics") return;

    // 线速度：水平 = 意图 × 速度；竖直交给重力，跳跃帧直接置跳跃初速
    const cur = engine.physics.getLinearVelocity(this.entity);
    let vy = cur ? cur.y : 0;
    if (this.jumpQueued) {
      this.jumpQueued = false;
      const now = engine.time.elapsed;
      // 落地启发式：竖直速度接近 0 视为在地面（无射线检测 API 的轻量替代）
      const grounded = Math.abs(vy) < 0.5;
      if (this.jumpSpeed > 0 && grounded && now - this.lastJumpAt >= this.jumpCooldown) {
        vy = this.jumpSpeed;
        this.lastJumpAt = now;
      }
    }
    const moving = this.moveX !== 0 || this.moveZ !== 0;
    engine.physics.setLinearVelocity(
      this.entity,
      moving ? this.moveX * this.speed : 0,
      vy,
      moving ? this.moveZ * this.speed : 0,
    );
  }

  // 物理方案的转向：动力学体的位姿由物理步进回写节点（onUpdate/onFixedUpdate
  // 直写都会被覆盖），而 onLateUpdate 晚于回写、渲染前执行——直写旋转当帧生效。
  // 朝向用脚本自治变量平滑推进（不读节点旋转：插值回写值滞后且带接触噪声，
  // 以它作反馈会形成抖动自旋），物理体旋转完全不参与解算，无反馈回路。
  // 注意每帧都要写（hasFace 只控制是否推进朝向）：停下后若停止写入，下一帧
  // 物理回写会把节点转回物理体自身的初始朝向——表现为「松手弹回原方向」。
  onLateUpdate(delta: number) {
    if (this.scheme !== "physics") return;
    if (this.hasFace) {
      this.curYaw = this.turnSpeed > 0
        ? math.moveTowardsAngle(this.curYaw, this.faceYaw, this.turnSpeed * delta)
        : this.faceYaw;
    }
    // rotation 类型为完整 Vec3（运行时容忍部分字段，这里显式写全）
    const r = this.entity.rotation;
    this.entity.rotation = { x: r.x, y: this.curYaw, z: r.z };
  }

  /**
   * 读取虚拟摇杆输出（可选）：摇杆节点上挂的脚本按类名查找
   * （"VirtualJoystick" 为该原型的默认类名；创建时改过文件名需同步这里），
   * 方向字段按形状读取（dirX/dirY ∈ -1..1，上 = +Y）。
   */
  private readJoystick(): { dirX: number; dirY: number } | null {
    if (!this.joystick) return null;
    const comp = this.joystick.getComponent("VirtualJoystick");
    if (!comp) return null;
    const dir = comp as unknown as { dirX?: number; dirY?: number };
    return { dirX: dir.dirX ?? 0, dirY: dir.dirY ?? 0 };
  }
}

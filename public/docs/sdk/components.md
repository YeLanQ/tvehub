# 内置组件门面

门面 = 组件设置 + 运行时后端的实时视图：属性写入即时生效（预览运行态，不回写场景文件）。门面实例由运行时创建（`getComponent` / `addComponent` / 组件字段声明获得），脚本不要直接 `new`。

每个门面均有 `entity`（宿主实体）与 `id`（组件引用 id）只读属性。

## RigidBody 刚体

```ts
rb.mode;               // 刚体形态："static" | "kinematic" | "dynamic"
rb.gravityScale;       // 当前重力缩放
rb.colliderCount;      // 碰撞体数量
rb.setGravityScale(0); // 设置重力缩放（0 = 不受重力）
rb.setLinearVelocity(x, y, z); // 直接设置线速度（m/s）
rb.getLinearVelocity();        // 读取线速度 → Vec3 | null
rb.applyImpulse(x, y, z);      // 施加冲量（世界空间，N·s）
rb.wakeUp();                   // 唤醒
```

## Collider 碰撞体

只读信息；形状/表面材质在检查器编辑，运行时不可变。

```ts
col.shape;        // 命中的碰撞形状："box"|"sphere"|"capsule"|"cylinder"|"convex"
col.isSensor;     // 是否传感器（只产生触发不产生碰撞响应）
col.friction;     // 摩擦系数
col.restitution;  // 弹性系数
col.count;        // 物理世界中的碰撞体数量
```

## Light 灯光

设置写入即时同步到活动灯光对象；类型切换重建灯光。

```ts
light.enabled;        // 是否启用（禁用 = 灯光对象隐藏）
light.kind;           // "point" | "directional" | "spot" | "ambient"（可写，写入即重建）
light.color;          // 光色 0xRRGGBB
light.intensity;      // 强度
light.distance;       // 点光/聚光：照射距离（0 = 无限远）
light.decay;          // 点光/聚光：物理衰减指数
light.angle;          // 聚光：光束半角（度）
light.penumbra;       // 聚光：边缘柔和度 0~1
light.castShadow;     // 点光/平行光/聚光：投射阴影
light.shadowStrength; // 阴影浓度 0~1
light.shadowBias;     // 阴影深度偏移
light.shadowNormalBias; // 阴影法线偏移（0 = 自动）
light.shadowNear;     // 阴影近裁剪面
light.shadowRadius;   // 阴影软化半径（1 = 硬阴影；Soft = 4）
light.shadowResolution; // 阴影贴图分辨率（0 = 自动：平面 2048 / 点光 1024；512~4096）
light.shadowType;     // Shadow 类型 "off" | "hard" | "soft"（读写投射开关 + 软化半径）
```

## AudioSource 音源

```ts
audio.source;      // 音频资产引用（写入即重载）
audio.autoplay;    // 自动播放
audio.loop;        // 循环播放
audio.volume;      // 音量 0..1
audio.speed;       // 播放倍速 0.1..4
audio.spatial;     // "2d" 全局 / "3d" 位置音源
audio.playing;     // 是否正在播放
audio.paused;      // 是否处于暂停态
audio.ready;       // 缓冲是否就绪
audio.play();      // 暂停态续播；停止/播完态从头播
audio.stop();      // 停止并回到起点
audio.pause();     // 暂停（保留进度）
audio.resume();    // 从暂停处继续
audio.setVolume(0.5); // 运行时音量 0~1
```

## AnimationClip 关键帧动画剪辑

绑定 `.anim` 资产的关键帧动画。

```ts
clip.clip;         // .anim 资产相对路径（写入即重载剪辑；空串解绑）
clip.duration;     // 剪辑时长（秒；未加载 0）
clip.time;         // 播放进度（秒；写入即跳转采样）
clip.speed;        // 播放速度倍率（>0）
clip.loop;         // 循环播放
clip.autoplay;     // 自动播放（加载完成后起播）
clip.playing; clip.paused;
clip.play(); clip.pause(); clip.resume(); clip.stop(); // stop 回初始姿势
```

## SkeletalAnimation 骨骼动画（模型内嵌动画）

仅模型网格节点拥有绑定。支持单剪辑播放与**动画图**（状态机）两种模式。

```ts
sk.clips;          // 模型内嵌剪辑名列表
sk.currentClip;    // 当前播放剪辑名（图模式为当前状态绑定剪辑；未播放 null）
sk.playing;
sk.clip;           // 当前剪辑名（缺省取首个；写入即切换播放，图模式为目标状态名）
sk.speed;          // 播放速度倍率
sk.loop;           // "loop" | "once" | "pingpong"
sk.autoplay;
sk.hasGraph;       // 是否处于动画图模式
sk.graph;          // 动画图活对象（entry/states/transitions/params 可直接改写，下一帧生效；无图 null）

sk.play("Run");    // 单剪辑：剪辑名（缺省首个）；图模式：目标状态名（缺省回入口）
sk.pause(); sk.resume(); sk.stop();

sk.getParam("speedX");        // 图参数读取（无图/未声明 null）
sk.setParam("speedX", 1.5);   // 图参数写入（布尔/数值；条件评估每帧读取）
sk.ensureGraph(def);          // 创建/替换动画图（非法项按引擎规则收敛剔除；成功 true）
sk.removeGraph();             // 移除动画图（回单剪辑语义）
sk.addState({ name, clip });  // 新增图状态（重名拒绝）
sk.removeState("Idle");       // 移除状态（连带剔除涉及它的过渡）
sk.addTransition({ from, to, duration, exitTime, conditions });
sk.removeTransition(id);
```

### 动画图定义

```ts
import type { AnimGraphDef } from "tve";

const graph: AnimGraphDef = {
  entry: "idle",                    // 入口状态（缺省首个状态）
  params: { speedX: 0 },            // 参数表（数值或布尔；条件评估的输入）
  states: [
    { name: "idle", clip: "Idle", speed: 1, loop: "loop" },  // clip 须为模型内嵌剪辑名
    { name: "run", clip: "Run" },
  ],
  transitions: [
    { from: "idle", to: "run", duration: 0.25, exitTime: 0,
      conditions: [{ param: "speedX", op: ">", value: 0.1 }] },
  ],
};

sk.ensureGraph(graph);
```

条件操作符：`> < >= <= == !=`；布尔参数按 0/1 参与数值比较。过渡缺省交叉淡化 0.25 秒；`exitTime` 为归一化退出时间 0..1（>0 表示源状态播放到该进度才允许过渡）。

### 蒙皮完全控制（动作混合 / 加法层 / 骨骼 / 形态键 / IK）

对应 three 官网 `animation/skinning` 系列示例（blending / morph / additive_blending / ik）的完整能力面。除 `anim`/`animGraph` 设置外全部为**运行时控制，不写入场景数据**。

```ts
// —— 动作级：权重混合 / 淡入淡出（blending 示例）——
sk.setWeight("Walk", 0.6);        // 动作权重（确保在播；0 即静默层）
sk.getWeight("Walk");             // 当前有效权重（含淡入淡出实时值）
sk.fadeIn("Run", 0.25);           // 权重 0→1 淡入
sk.fadeOut("Idle", 0.25);         // 权重→0 淡出
sk.crossFade("Walk", "Run", 0.35, true); // warp=true 自动对齐两动作相位
sk.setActionSpeed("Run", 1.2);    // 单动作速度（与 globalSpeed 相乘）
sk.setActionLoop("Jump", "once"); // "loop"|"once"|"pingpong"（once 定格末帧）
sk.stopAction("Walk");            // 停单个动作（不影响其他混合层）
sk.globalSpeed(0.5);              // 全局播放速度（mixer 速度）
sk.playOneShot("Wave", 0.25);     // 一次性动作：定格末帧后自动淡回基础动作
sk.onFinished(({ clip }) => {});  // 动作播完事件（返回注销函数）
sk.onLoop(({ clip }) => {});      // 动作循环事件

// —— 加法层（additive_blending 示例）——
sk.playAdditive("SneakPose", 0.7); // 惰性 makeClipAdditive 后以差值叠加在基础动作上
sk.stopAdditive("SneakPose");

// —— 骨骼级 ——
sk.skinInfo;                      // {boneCount, boneNames, morphMeshes}
sk.bones;                         // 骨骼名列表
sk.boneHierarchy;                 // [{name, parent, children}]
sk.getBoneTransform("Head_4");    // {position, rotation(度), scale}
sk.setBoneRotation("Head_4", 0, 25, 0);   // 度制欧拉
sk.setBonePosition("Head_4", 0, 0.1, 0);
sk.resetBone("Head_4");           // 复位单骨（加载姿势快照）
sk.resetPose();                   // 复位全部骨骼
sk.getBoneWorldPosition("Head_4"); // 世界坐标（瞄准/挂点参考）

// —— 形态键（morph 示例）——
sk.morphs;                        // [{mesh, targets}]
sk.setMorphWeight("", "Angry", 0.8); // mesh 传 "" 取首个含该目标的网格
sk.getMorphWeight("Head_4", "Angry");

// —— IK（skinning_ik 示例，CCD 求解；每帧在动画之后求解）——
const id = sk.addIK({
  name: "左手",
  effector: "hand_l",             // 末端效应器骨骼名
  links: [                        // 关节链：从效应器父级向根方向
    { bone: "lowerarm_l", rotationMin: [0, -90, -30], rotationMax: [15, -60, 0] },
    { bone: "Upperarm_l" },
  ],
  iteration: 3,
});
sk.setIKTargetPosition(id, 0.3, 1.2, 0.4); // 目标点（模型根局部空间）
sk.setIKEnabled(id, false);       // 启停
sk.removeIK(id);
sk.iks;                           // [{id, name, effector, enabled}]
```

骨骼写入的生效时机：动画动作播放中，mixer 每帧覆写被驱动骨骼——手动骨骼写入适用于暂停/未被驱动的骨骼，或需要每帧覆写的场景（IK/头部朝向）。

### 骨骼/IK 目标绑定（物体跟随骨骼）

把场景节点绑到骨骼或 IK 目标上，每帧跟随（对应官方 ik 示例中目标点与挂体的跟随语义）：

```ts
sk.attachToBone(box, "hand_r");          // Entity 或节点 id；骨骼名（IK id / IK 名也可）
sk.attachToBone(box, "hand_r", { keepOffset: false }); // 对象原点对齐骨骼原点
sk.attachToBone(box, "ik1");             // 绑到 IK 目标点（目标移动 → 物体跟随）
sk.detach(box);                          // 解除绑定
sk.attachments;                          // [{node, bone, syncRotation, syncScale, keepOffset}]
```

选项（`BoneAttachOptions`）：

| 选项 | 缺省 | 说明 |
| --- | --- | --- |
| `keepOffset` | `true` | 保持 attach 时刻的相对位姿（骨骼带动下刚性跟随）；`false` = 对象原点对齐骨骼原点 |
| `syncRotation` | `true` | 跟随骨骼旋转；`false` = 仅锚点位置跟随，姿态自主控制 |
| `syncScale` | `false` | 跟随骨骼缩放 |

约束：目标节点须在该模型子树之外（骨骼世界矩阵依赖树外对象才无反馈环）；跟随发生在动画与 IK 求解之后，每帧应用。

两条写入路径：**编辑器皮肤面板**的绑定写入节点 `boneBindings` 数据（随场景保存，预览/发布自动生效，可撤销）；脚本 `attachToBone` 为运行时叠加（不落盘，适合按玩法动态挂接）。

**示例：表情一次性播放，播完自动回落（morph 模式）**

```ts
import { Component, property, engine, SkeletalAnimation } from "tve";

export default class Emotes extends Component {
  @property({ type: SkeletalAnimation })
  skel!: SkeletalAnimation;

  onStart() {
    this.skel.play("Idle"); // 基础状态持续循环
    // 3 秒后挥手：定格末帧，自动淡回 Idle
    setTimeout(() => {
      this.skel.playOneShot("Wave", 0.25);
      this.skel.onFinished(({ clip }) => engine.log(`回落：${clip} 播完`));
    }, 3000);
  }
}
```

**示例：手臂 IK 跟随目标点（ik 模式）**

```ts
import { Component, property, SkeletalAnimation } from "tve";

export default class HandIK extends Component {
  @property({ type: SkeletalAnimation })
  skel!: SkeletalAnimation;

  ikId: string | null = null;
  t = 0;

  onStart() {
    this.skel.play("Idle");
    this.ikId = this.skel.addIK({
      effector: "hand_l",
      links: [{ bone: "lowerarm_l" }, { bone: "Upperarm_l" }],
    });
  }

  onUpdate(delta: number) {
    if (!this.ikId) return;
    this.t += delta;
    // 目标点绕圈（模型根局部空间），手臂持续跟随
    this.skel.setIKTargetPosition(
      this.ikId,
      Math.cos(this.t * 2) * 0.4, 1.2, 0.4 + Math.sin(this.t * 2) * 0.2,
    );
  }
}
```

## addComponent 创建参数速查

| 组件 | 参数 |
| --- | --- |
| `Light` | `kind` / `color` / `intensity` / `cullingMask`（只照亮掩码内层，-1 = 全部）/ `distance` / `decay` / `angle` / `penumbra` / `castShadow` |
| `AudioSource` | `source` / `autoplay` / `loop` / `volume` / `speed` / `spatial` / `refDistance` / `maxDistance` / `rolloff` |
| `AnimationClip` | `clip` / `autoplay` / `loop` / `speed` |
| `SkeletalAnimation`（仅模型网格节点） | `clip` / `autoplay` / `speed` / `loop` / `graph`（传即创建动画图模式） |

`RigidBody` / `Collider` 不支持运行时创建（仅启动期按场景数据构建）。

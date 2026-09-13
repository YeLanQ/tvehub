# 内置组件门面

门面 = 组件设置 + 运行时后端的实时视图：属性写入即时生效（预览运行态，不回写场景文件）。门面实例由运行时创建（`getComponent` / `addComponent` / 组件字段声明获得），脚本不要直接 `new`。

每个门面均有 `entity`（宿主实体）与 `id`（组件引用 id）只读属性。

| 门面 | 对应编辑器组件 | 获取方式 | 运行时创建 |
| --- | --- | --- | --- |
| `RigidBody` | 刚体 | `getComponent(RigidBody)` | ✗（返回 null） |
| `Collider` | 碰撞体（可多） | `getComponent(Collider)` | ✗（返回 null） |
| `Light` | 灯光 | `getComponent(Light)` | ✓（多实例追加） |
| `AudioSource` | 音源 | `getComponent(AudioSource)` | ✓（多实例追加） |
| `AnimationClip` | 动画剪辑 | `getComponent(AnimationClip)` | ✓（多实例追加） |
| `SkeletalAnimation` | Animation 卡（模型内嵌） | `getComponent(SkeletalAnimation)` | ✓（仅模型网格节点） |

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

三形态语义：

- **static**：不动也不受力（隐式静态：只挂碰撞体不挂刚体的节点同属此类）——地面、墙、障碍；
- **kinematic**：不受力，由节点变换/动画**驱动**（每帧把节点世界位姿作为运动目标）——移动平台、推门；接触的动力学体会被推开；
- **dynamic**：完整受力模拟（重力/冲量/摩擦），模拟结果**回写渲染对象**（不写节点数据，停机还原）。

物理按**固定步长 1/60s** 步进（最多 4 子步），播放器对动力学体做帧间插值，任意帧率下运动平滑。物理引擎/重力/启用开关在 项目设置 → 物理（Rapier / Jolt / Ammo.js 三后端同一 API）。

## Collider 碰撞体

只读信息；形状/表面材质在检查器编辑，运行时不可变。

```ts
col.shape;        // 命中的碰撞形状："box"|"sphere"|"capsule"|"cylinder"|"convex"
col.isSensor;     // 是否传感器（只产生触发不产生碰撞响应）
col.friction;     // 摩擦系数（0..4）
col.restitution;  // 弹性系数（0..1）
col.count;        // 物理世界中的碰撞体数量
```

碰撞回调（`onCollisionEnter/Exit`）前提：本节点挂有碰撞体 + 项目设置启用物理；传感器同样触发回调（只有事件、无碰撞响应）。双方实体各收一次回调（参数为对方 `Entity`）。

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
light.cullingMask;    // 灯光 Culling Mask（只照亮掩码内层；-1 = 全部层）
light.castShadow;     // 点光/平行光/聚光：投射阴影
light.shadowStrength; // 阴影浓度 0~1
light.shadowBias;     // 阴影深度偏移
light.shadowNormalBias; // 阴影法线偏移（≤0 = 自动按纹素相对化）
light.shadowNear;     // 阴影近裁剪面
light.shadowRadius;   // 阴影软化半径（1 = 硬阴影；Soft = 4）
light.shadowResolution; // 阴影贴图分辨率（0 = 自动：平面 2048 / 点光 1024；512~4096）
light.shadowType;     // Shadow 类型 "off" | "hard" | "soft"（读写投射开关 + 软化半径）
```

灯光方向 = 节点本地 **-Z**（与相机/粒子发射同约定）。阴影实现细节（贴合范围、分辨率档位）见[编辑器 › 场景编辑 › 阴影](../editor/scene.md)。

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

要点：

- **3D 音源**挂在节点下随变换移动（参数 `refDistance` 参考距离 / `maxDistance` 最大距离 / `rolloff` 衰减系数，`addComponent` 时可传）；听者 = 渲染相机；
- **浏览器自动播放策略**：音频上下文在用户首次指针/键盘交互后解锁—— autoplay 的背景音乐在玩家点击前可能静默延迟起播（属正常行为）；
- 手动 `stop()` 后 `autoplay` 不会再自动起播；`play()` 可恢复；
- 节点隐藏（可见链断开）时自动暂停，恢复可见从暂停处续播（手动暂停不经此路径）。

## AnimationClip 关键帧动画剪辑

绑定 `.anim` 资产的关键帧动画（剪辑经[动画编辑器](../editor/animation.md)制作）。

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

通道只覆盖剪辑中存在的属性（如剪辑只 K 了 `position.x` 就只驱动 x，其余轴不动）；区间外钳制到端点值。同一节点可挂多个动画剪辑组件（`getComponent` 取首个），配合权重思路或分段剪辑分别播放。

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

图评估语义：

- 每帧在 骨骼动画 → IK → 骨骼绑定 **之后**评估（图参数由脚本/检查器注入，条件全满足才切换）；
- **一帧最多走一次过渡**（同一帧内不会级联切换多个状态）；
- 无剪辑的状态（`clip` 为空）= 淡出并保持当前姿势；
- `sk.graph` 是活对象：直接改 `states/transitions/params/entry` 下一帧生效（无需重新 ensureGraph）。

### 蒙皮完全控制（动作混合 / 加法层 / 骨骼 / 形态键 / IK）

对应 three 官网 `animation/skinning` 系列示例（blending / morph / additive_blending / ik）的完整能力面。除 `anim`/`animGraph` 设置外全部为**运行时控制，不写入场景数据**。

```ts
// —— 动作级：权重混合 / 淡入淡出（blending 示例）——
sk.setWeight("Walk", 0.6);        // 动作权重（确保在播；0 即静默层）
sk.getWeight("Walk");             // 当前有效权重（含淡入淡出实时值）
sk.fadeIn("Run", 0.25);           // 权重 0→1 淡入
sk.fadeOut("Idle", 0.25);         // 权重→0 淡出（动作本身不停止）
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
sk.setBoneScale("Head_4", 1, 1, 1);
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
sk.getIKTargetPosition(id);       // 目标点读取
sk.setIKEnabled(id, false);       // 启停
sk.removeIK(id);
sk.iks;                           // [{id, name, effector, enabled}]
```

权重层语义要点：

- 权重混合与 `play/stop` 的「当前剪辑」**相互独立**：`setWeight` 让任意多个动作按权重同时叠加（0.6 走路 + 0.4 跑步）；「停止」清空全部层；
- `playOneShot` 定格末帧后**自动淡回**基础动作（表情/挥手）；`onFinished` 在一次性动作到达末帧时触发；
- 加法层需模型剪辑本身适合做差值叠加（姿态类剪辑）；播放时先经 `makeClipAdditive` 转换（惰性缓存）；
- 骨骼写入的生效时机：动作播放中 mixer 每帧**覆写被驱动骨骼**——手动骨骼写入适用于暂停/未被驱动的骨骼，或需要每帧覆写的场景（IK/头部朝向）；
- 每帧应用顺序：动画 mixer → IK 求解 → 骨骼绑定跟随 → 动画图评估。

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

缺省项回组件默认值；预览运行态创建不回写场景文件。

| 组件 | 参数 |
| --- | --- |
| `Light` | `kind` / `color`（别名 `lightColor`）/ `intensity` / `cullingMask`（只照亮掩码内层，-1 = 全部）/ `distance` / `decay` / `angle` / `penumbra` / `castShadow` / `shadowStrength` / `shadowBias` / `shadowNormalBias` / `shadowNear` / `shadowRadius` / `shadowResolution` / `shadowType`（档位优先于 castShadow/shadowRadius） |
| `AudioSource` | `source` / `autoplay` / `loop` / `volume` / `speed` / `spatial` / `refDistance` / `maxDistance` / `rolloff` |
| `AnimationClip` | `clip` / `autoplay` / `loop` / `speed` |
| `SkeletalAnimation`（仅模型网格节点） | `clip`（剪辑名/状态名）/ `autoplay` / `speed` / `loop` / `graph`（传即创建动画图模式） |

`RigidBody` / `Collider` 不支持运行时创建（仅启动期按场景数据构建，`addComponent` 返回 `null`）。

示例：

```ts
// 爆炸点闪光
const light = entity.addComponent("light", { kind: "point", color: 0xffaa33, intensity: 5, distance: 10 });
tween.value(5, 0, 0.4).onUpdate((v) => { if (light) light.intensity = v; });

// 拾取音效
entity.addComponent("audioSource", { source: "assets/audio/pickup.wav", autoplay: true, spatial: "2d" });
```

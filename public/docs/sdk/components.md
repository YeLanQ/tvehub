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
light.shadowStrength; // 阴影浓度 0~1（Unity Strength）
light.shadowBias;     // 阴影深度偏移（Unity Bias）
light.shadowNormalBias; // 阴影法线偏移（0 = 自动；Unity Normal Bias）
light.shadowNear;     // 阴影近裁剪面（Unity Near Plane）
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

## addComponent 创建参数速查

| 组件 | 参数 |
| --- | --- |
| `Light` | `kind` / `color` / `intensity` / `distance` / `decay` / `angle` / `penumbra` / `castShadow` |
| `AudioSource` | `source` / `autoplay` / `loop` / `volume` / `speed` / `spatial` / `refDistance` / `maxDistance` / `rolloff` |
| `AnimationClip` | `clip` / `autoplay` / `loop` / `speed` |
| `SkeletalAnimation`（仅模型网格节点） | `clip` / `autoplay` / `speed` / `loop` / `graph`（传即创建动画图模式） |

`RigidBody` / `Collider` 不支持运行时创建（仅启动期按场景数据构建）。

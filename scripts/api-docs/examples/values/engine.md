```ts tve
import { engine, VERSION } from "tve";

// 引擎全局入口：时间 / 输入 / 场景 / 动画 / 音频 / 粒子 / 物理 / UI / 逻辑 / 补间 / 日志
engine.time;      // TimeState（delta/elapsed/frame）
engine.input;     // InputApi
engine.scene;     // SceneApi
engine.animation; // AnimationApi
engine.audio;     // AudioApi
engine.particles; // ParticlesApi
engine.physics;   // PhysicsApi
engine.ui;        // UIApi
engine.logic;     // LogicApi
engine.tween;     // TweenApi（与顶层 tween 同一对象）

VERSION; // => "1.3.0"

// 无宿主安全空转（doctest 实测）
engine.scene.root; // => null
```

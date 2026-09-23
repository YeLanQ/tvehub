```ts tve
import { Component, engine, math, tween, MeshNode, CameraNode } from "tve";

export default class EngineTour extends Component {
  onStart() {
    // 时间（只读）
    void engine.time.delta;   // 距上一帧秒数
    void engine.time.elapsed; // 累计秒数
    void engine.time.frame;   // 帧序号（从 1 起）

    // 各系统入口（详见对应专题文档）
    void engine.input;        // 键盘/指针
    void engine.scene;        // 场景查询
    void engine.animation;    // 模型动画
    void engine.audio;        // 音频
    void engine.particles;    // 粒子
    void engine.physics;      // 物理
    void engine.ui;           // UI 运行期
    void engine.logic;        // 状态机/行为树
    void engine.tween;        // 补间（与顶层导出 tween 同一对象）

    // 日志 → 编辑器控制台（预览）/ 浏览器控制台（发布产物）
    engine.log("就绪", engine.time.frame);
    engine.warn("低血量");
    engine.error("异常");

    void math;
    void MeshNode;
    void CameraNode;
  }
}
```

无宿主空转语义（doctest 实测：预览之外的环境安全降级）：

```ts tve
import { engine } from "tve";

// 未注入场景宿主时各查询安全空转，不抛错
engine.scene.root;          // => null
engine.scene.find("任意");   // => null
engine.scene.findAll();     // => []
engine.scene.findAllByTag("x"); // => []
engine.time.frame;          // => 0
```

```ts tve
import { Component, property, math, MeshNode, Entity } from "tve";

export default class EntityDemo extends Component {
  @property({ type: MeshNode, label: "目标" })
  target: MeshNode | null = null;

  onStart() {
    const e = this.entity;
    // 标识（只读）：id 与场景文件一致；name 可写即时生效
    e.id;     // 节点 id（string）
    e.kind;   // 类型键："node"/"meshNode"/"pointLightNode"…
    e.name = "玩家";

    // 变换（读取返回快照副本；写入接受部分字段）
    e.position = { y: 1 };              // 只改 y
    const p = e.position;               // 快照：改 p 不影响实体
    p.x += 100;
    e.position.x;                       // 仍是写入时的 x
    e.rotation = { x: 0, y: 45, z: 0 }; // 度制欧拉角 XYZ
    e.scale = { x: 2 };

    // 世界位置（只读快照）
    e.worldPosition;

    // 增量变换
    e.translate(0, 0, -1);   // 沿本地轴平移
    e.rotate(0, 90, 0);      // 本地旋转叠加（度）
    e.lookAt({ x: 0, y: 0, z: 0 }); // 朝向世界目标（前向 = -Z）

    // 层级
    e.parent;   // 父实体（根节点 null）
    e.children; // 子实体列表（快照）
    const child = e.find("炮塔");        // 子树内按名/路径查找（"父/子/孙"）
    void child;

    // 可见性 / 渲染层
    e.visible = true;
    e.layer = 0; // 0~31

    void p;
  }

  onUpdate() {
    if (!this.target) return;
    // 组件访问：内置门面类 / 类型键字符串 / 脚本类名
    const rigid = this.entity.getComponent("rigidBody");
    void rigid;
    const other = this.target as Entity;
    void other;
    // math 配合实体做方向计算
    const dir = math.normalize(math.sub(this.target.position, this.entity.position));
    void dir;
  }
}
```

`addComponent` 动态挂组件（预览运行态生效，不回写场景文件）：

```ts tve
import { Component, Light, AudioSource, engine } from "tve";

export default class AddComp extends Component {
  onStart() {
    // 追加灯光（多实例；settings 缺省项回默认）
    const light = this.entity.addComponent(Light, {
      kind: "point",
      color: 0xffaa33,
      intensity: 2,
      distance: 10,
    });
    light!.intensity = 3; // 返回门面，写入即时生效

    // 追加音源并播放
    const audio = this.entity.addComponent(AudioSource, { source: "assets/hit.ogg", volume: 0.8 });
    audio!.play();

    // 挂脚本组件（按类名/源路径）
    const hp = this.entity.addComponent("HPBar", { hp: 100 });
    engine.log("挂上了", !!hp);

    // RigidBody/Collider 仅启动期按场景数据构建，运行时创建返回 null
    void this.entity.addComponent("rigidBody"); // null：物理组件不可运行时创建
  }
}
```

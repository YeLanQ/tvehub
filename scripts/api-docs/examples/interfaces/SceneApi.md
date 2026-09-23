```ts tve
import { Component, engine, CameraNode, Light, MeshNode } from "tve";

export default class SceneQuery extends Component {
  onStart() {
    // 根实体（空场景 null）
    void engine.scene.root;

    // 按名称/路径查找（语义同 Entity.find；深度优先）
    const cam = engine.scene.find(" Cameras/Main");
    if (cam instanceof CameraNode) cam.lookAt({ x: 0, y: 0, z: 0 });

    // 全量快照
    void engine.scene.findAll().length;

    // 按标签查（检查器 Node 卡设置 tag）
    const enemy = engine.scene.findByTag("enemy");      // 第一个命中
    void engine.scene.findAllByTag("enemy").length;     // 文档序全量

    // 按类型查组件（token = 脚本类/源路径/类名/内置门面类/类型键）
    const sun = engine.scene.findComponent(Light);      // 文档序第一个
    void engine.scene.findComponents(Light).length;     // 全量
    const hp = engine.scene.findComponent("HPBar");     // 按脚本类名
    void hp;
    void MeshNode;
  }
}
```

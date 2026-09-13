import { Component, property, nodeType, engine } from "tve";

// 节点类型声明（可选）：取消注释后本脚本会出现在层级面板「脚本节点」分组里，
// 创建时生成 kind 对应基础节点并自动挂上本组件。
// @nodeType({ kind: "node", label: "{{CLASS_NAME}}" })
export default class {{CLASS_NAME}} extends Component {
  // 属性声明（可选）：类型按字段初值推断（number/boolean/string/#hex=color/{x,y,z}=vec3）。
  // @property({ label: "速度", min: 0 })
  // speed = 90;

  onStart() {
    engine.log("{{CLASS_NAME}} 已挂载:", this.entity.name);
  }

  onUpdate(delta: number) {
    // 每帧逻辑，例如自转（改用属性字段：this.speed）：
    // this.entity.rotate(0, this.speed * delta, 0);
  }

  // 固定步长更新（每 1/60 秒一次，与物理步进同频、帧率无关；适合施力/速度
  // 等与物理相关的确定性逻辑）：
  // onFixedUpdate(fixedDelta: number) {
  //   this.entity.translate(0, 0, 5 * fixedDelta);
  // }

  // 晚更新（全部脚本/动画/物理更新后、渲染前；适合相机跟随等覆盖性位姿写入）：
  // onLateUpdate(delta: number) {}
}

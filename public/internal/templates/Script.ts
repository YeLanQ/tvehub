// 脚本组件模板（新建脚本用）：默认导出 Component 子类。
// 生命周期：onStart 挂载后调用一次；onUpdate 每帧调用（delta = 秒）。
// 引擎能力经 "tve" 模块访问（Entity / engine.time / engine.input / engine.scene…），
// 不直接接触底层渲染库。
import { Component, engine } from "tve";

export default class {{CLASS_NAME}} extends Component {
  // 属性声明（可选）：检查器按声明渲染编辑控件，未配置时取 default
  // static props = {
  //   speed: { type: "number", default: 90, label: "速度", min: 0 },
  // };

  onStart() {
    engine.log("{{CLASS_NAME}} 已挂载:", this.entity.name);
  }

  onUpdate(delta: number) {
    // 每帧逻辑，例如自转：
    // this.entity.rotate(0, 90 * delta, 0);
  }
}

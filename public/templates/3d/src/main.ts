// 项目入口脚本（脚本模式全局逻辑）：随预览/发布产物运行，挂载在场景根节点。
// 生命周期：onStart 全部脚本就绪后调用一次；onUpdate 每帧调用（delta = 秒）。
// 引擎能力经 "tve" 模块访问（engine.scene / engine.time / engine.input…），
// 节点级行为建议改用脚本组件：在检查器 Components 卡片挂载 src/ 下的脚本。
import { Component, engine } from "tve";

export default class Main extends Component {
  onStart() {
    engine.log("入口脚本已启动");
  }

  onUpdate(delta: number) {
    void delta; // 每帧逻辑
  }
}

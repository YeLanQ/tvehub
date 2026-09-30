// 桥接层 · 安装机器：全局双写与 window 引用。裸赋值（try 包裹）发生在 bundle
// 单一模块作用域内——命中沙箱遮蔽形参时对整包重绑，未命中（严格模式未声明）
// 则回落 globalThis 写入。

/** 全局对象双写：globalThis + GameGlobal（跨全局视图兜底） */
export function setGlobal(name, value) {
  try {
    globalThis[name] = value;
  } catch {
    /* 只读全局按失败处理 */
  }
  try {
    if (typeof GameGlobal !== "undefined" && GameGlobal) GameGlobal[name] = value;
  } catch {
    /* 同上 */
  }
}

/** 安装完成后 free 标识符 window 实际解析到的对象（后续模块向 window 挂键用） */
export const windowRef = { current: null };

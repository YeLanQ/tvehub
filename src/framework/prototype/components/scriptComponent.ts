// 脚本组件描述符：编辑器只持有数据（检查器增删改、随节点序列化）；
// 实例化与生命周期由播放器脚本宿主（web-preview/libs/scripts.mjs）执行。
// 写出约定：executionOrder = 0 为缺省值，序列化时删除该键（旧场景字节兼容）。

import { nextId } from "../../../platform_abstraction/id";
import { cloneRecord, type JsonRecord } from "../types";
import type { ComponentDescriptor, ScriptComponentRef } from "./types";

export const scriptDescriptor: ComponentDescriptor<ScriptComponentRef> = {
  type: "script",
  parse(raw, base) {
    // 脚本路径缺失/为空 = 非法条目（整条剔除）
    if (typeof raw.script !== "string" || !raw.script) return null;
    return {
      id: base.id,
      type: "script",
      script: raw.script,
      enabled: base.enabled,
      executionOrder:
        typeof raw.executionOrder === "number" && Number.isFinite(raw.executionOrder)
          ? raw.executionOrder
          : 0,
      props:
        raw.props && typeof raw.props === "object" ? cloneRecord(raw.props as JsonRecord) : {},
    };
  },
  createDefault() {
    // 脚本组件必须指定脚本路径，走 createScriptComponentRef 专用入口；这里仅占位
    throw new Error("脚本组件请用 createScriptComponentRef(script) 创建");
  },
  cloneForInstance(c) {
    return { ...c, id: nextId("comp"), props: cloneRecord(c.props) };
  },
  cloneForWrite(c) {
    const out: ScriptComponentRef = { ...c, props: cloneRecord(c.props) };
    // 执行顺序 0 = 缺省不写（旧场景文件保持字节兼容）
    if (!c.executionOrder) delete (out as unknown as Record<string, unknown>).executionOrder;
    return out;
  },
  resetSettings(c) {
    c.props = {};
  },
};

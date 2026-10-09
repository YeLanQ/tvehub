// 微信渠道 bundle 入口（桥接层的渠道组装点）。求值顺序即安装顺序（ESM import
// 声明顺序 = 模块求值顺序）：
//   platforms/wechat（注册 host）→ wasm（WebAssembly 垫片）→ env → canvas →
//   codec → url → image → dom → http → events → audio → storage → load-module →
//   data-bridge → engine/tve 门面 → player.mjs（模块体末尾自启 main()）
// 核心模块与平台端点的分工见 ../contract.js；新增渠道 = 平级平台端点 + 本文件的
// 对应组装副本。data.js 由导出期 Rust 生成（esbuild external，产物内保留运行期
// require("./data.js")）。
// 主模块命名空间导出 __tveFacade（= engine/core/tve.mjs 全部导出）：
// 包内 engine/core/tve.js 转发它，用户脚本经 require 消费，不依赖跨模块全局。

import "../platforms/wechat.js";
import "../wasm.js";
import "../env.js";
import "../canvas.js";
import "../codec.js";
import "../url.js";
import "../image.js";
import "../dom.js";
import "../http.js";
import "../events.js";
import "../audio.js";
import "../storage.js";
import "../worker.js";
import "../load-module.js";
import "../data-bridge.js";
import { setInputProbe } from "../audio-diag.js";
import * as tveApi from "../../../public/engine/core/tve.mjs";
import "../../../public/web-preview/player.mjs";

export const __tveFacade = tveApi;

// 引擎探针装配（诊断弹窗「探」行，audio-diag 消费）。三段读数把移动链逐段亮灯：
// ① 输入：engine.input 触点映射快照（桥「触」计数照涨而指恒 0 = canvas 监听面死）；
// ② 线程：player 的 __tveRuntimeStatus（界1=物理 API 就绪；物W/动W = Worker 标识——
//    模拟器 Worker 链已验证、真机若恒物W0 = 走从未验证的主线程物理链）；
// ③ 移动链：findAll 实体数 + 按组件 token 矩阵找 CharacterController/VirtualJoystick
//    （「名」=类名 token、「路」=源路径 token——脚本实例存在而名字找不到 = 类名
//    解析断，控制器读摇杆的 getComponent("VirtualJoystick") 同机制必死；两者都无 =
//    脚本模块没加载/没实例化，配合「志」行的引擎加载报错判读）+ 刚体 mode/线速度/
//    worldPosition。判读：dir≠0 而 m=0 = 找摇杆失败；m≠0 而 v=0/位姿不动 = 主线程
//    物理速度链无效；scheme=translate 而 v 非 null = 物理回写踩平位移。
// 本文件不进层内 tsconfig（见 tsconfig.json 排除注记），tve.mjs 无类型声明，
// 探针全鸭子读法 + try 包裹（探针异常不得波及启动）。
try {
  setInputProbe(() => {
    const engine = (tveApi as { engine?: Record<string, unknown> }).engine;
    const input = engine && (engine as { input?: Record<string, unknown> }).input;
    const pointers = input && (input as { pointers?: unknown }).pointers;
    const p = input && (input as { pointer?: { pointerId?: number; x?: number; y?: number; down?: boolean } }).pointer;
    const primary = p
      ? `${p.pointerId ?? -1}(${Math.round(Number(p.x) || 0)},${Math.round(Number(p.y) || 0)})${p.down ? "d" : "u"}`
      : "-";
    const inputPart = `指${pointers instanceof Map ? pointers.size : -1}#${primary}`;

    const status = (globalThis as { __tveRuntimeStatus?: { physicsReady?: boolean; physicsWorker?: boolean; animationWorker?: boolean } }).__tveRuntimeStatus;
    const statusPart = status
      ? `界${status.physicsReady ? 1 : 0} 物W${status.physicsWorker ? 1 : 0} 动W${status.animationWorker ? 1 : 0}`
      : "状态缺席";

    let chainPart = "链?";
    try {
      const scene = engine && (engine as { scene?: { findAll?: () => unknown[] } }).scene;
      const all = scene && typeof scene.findAll === "function" ? scene.findAll() : [];
      const num1 = (v: unknown): string => (Number(v) || 0).toFixed(2);
      /** 按 token 矩阵找挂某脚本的实体：名（类名）与路（源路径）分色——分辨
       *  「实例不存在」与「按名解析断」（控制器读摇杆用的就是类名 token） */
      const findByScripts = (names: string[], paths: string[]): [Record<string, unknown> | null, string] => {
        for (const e of all) {
          const entLike = e as { getComponent?: (t: unknown) => unknown };
          if (typeof entLike.getComponent !== "function") continue;
          for (const n of names) {
            const c = entLike.getComponent(n) as Record<string, unknown> | null;
            if (c) return [c, "名"];
          }
          for (const pt of paths) {
            const c = entLike.getComponent(pt) as Record<string, unknown> | null;
            if (c) return [c, "路"];
          }
        }
        return [null, "-"];
      };
      const [cc, ccHow] = findByScripts(["CharacterController"], ["src/CharacterController.ts", "src/CharacterController.js"]);
      const [joy, joyHow] = findByScripts(["VirtualJoystick"], ["src/VirtualJoystick.ts", "src/VirtualJoystick.js"]);
      const ccPart = cc ? `${ccHow}:${String(cc.scheme ?? "?")},m${num1(cc.moveX)},${num1(cc.moveZ)}` : "无CC";
      const joyPart = joy ? `${joyHow}:d${num1(joy.dirX)},${num1(joy.dirY)}${joy.dragging ? "*" : ""}` : "无Joy";
      let bodyPart = "无体?";
      const physics = engine && (engine as { physics?: { getLinearVelocity?: (e: unknown) => { x?: number; y?: number; z?: number } | null } }).physics;
      for (const e of all) {
        const entLike = e as { getComponent?: (t: unknown) => unknown; worldPosition?: { x: number; y: number; z: number } };
        if (typeof entLike.getComponent !== "function") continue;
        const rb = entLike.getComponent("rigidBody") as { mode?: string } | null;
        if (!rb) continue;
        const lv = physics && typeof physics.getLinearVelocity === "function" ? physics.getLinearVelocity(e) : null;
        const wp = entLike.worldPosition;
        bodyPart = `体${rb.mode || "?"}${lv ? `,v${num1(lv.x)},${num1(lv.y)},${num1(lv.z)}` : ",vnull"}${
          wp ? `,@${Math.round(wp.x)},${Math.round(wp.y)},${Math.round(wp.z)}` : ""
        }`;
        break;
      }
      chainPart = `N${all.length}|${ccPart}|${joyPart}|${bodyPart}`;
    } catch {
      chainPart = "链ERR";
    }
    return `${inputPart}｜${statusPart}｜${chainPart}`;
  });
} catch {
  /* 探针装配失败静默（诊断面显示「未装配」） */
}

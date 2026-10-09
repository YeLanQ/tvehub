// 桥接层环境全局声明（仅类型层）：wx 沙箱注入的平台全局鸭子形态。
// 运行期这些名字由沙箱/平台提供，declare 会被 esbuild/nodo 剥除，零产物影响。
// 各模块内的局部 declare（如 install.ts 的 GameGlobal）优先于本全局声明。

/** 微信小游戏全局兜底对象（setGlobal 双写目标；跨全局视图兜底） */
declare const GameGlobal: Record<string, unknown> | undefined;

/** wx worker 线程注入的平台全局（worker-relay 消费；主线程不存在） */
declare const worker:
  | {
      postMessage(msg: unknown): void;
      onMessage(cb: (msg: unknown) => void): void;
      [key: string]: unknown;
    }
  | undefined;

/** node 环境标识（wechat-worker 入口的环境探测引用；真机沙箱无此全局） */
declare const process: unknown;

/** worker 线程 importScripts（emscripten 环境探测引用；真机沙箱无此全局） */
declare function importScripts(...urls: string[]): void;

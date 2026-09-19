// ---------------------------------------------------------------------------
// 资产拖拽的「面板外落点」注册表：
// 资产面板的拖拽是自研鼠标拖拽（mousedown/mousemove/mouseup + ghost），不产生
// HTML5 drag 事件，视口等面板外落点收不到 drop——落点侧经此注册接收回调，并在
// 落点元素上标注 data-asset-dispatch="<key>"；面板拖拽结束时按指针下元素的属性
// 查表分派。双向不感知对方（面板不 import 视口，视口不 import 面板）。
// ---------------------------------------------------------------------------

/** 松开鼠标时的窗口客户区坐标（落点侧换算场景位置用） */
export interface AssetDropPoint {
  x: number;
  y: number;
}

/** 落点接收回调：paths = 被拖资产的 rel 列表（保持拖拽选择顺序），at = 松开坐标 */
export type AssetDropReceive = (paths: string[], at: AssetDropPoint) => void | Promise<void>;

const receivers = new Map<string, AssetDropReceive>();

/** 注册面板外落点（返回注销函数，组件卸载时调用） */
export function registerAssetDropTarget(key: string, receive: AssetDropReceive): () => void {
  receivers.set(key, receive);
  return () => {
    if (receivers.get(key) === receive) receivers.delete(key);
  };
}

/** 按落点 key 分派；key 无注册者或列表为空返回 false（调用方按未命中处理） */
export function dispatchAssetDrop(key: string, paths: string[], at: AssetDropPoint): boolean {
  const receive = receivers.get(key);
  if (!receive || paths.length === 0) return false;
  void receive(paths, at);
  return true;
}

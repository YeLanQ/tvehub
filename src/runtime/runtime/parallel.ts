// 加载并发闸：启动期模型/贴图/音频全部同时发起时，ImageBitmap 解码与音频
// decodeAudioData 挤在一起阻塞主线程，首帧反而更晚；6 路与 HTTP1.1 每主机
// 连接数对齐，HTTP2 下也能平滑排队。

let MAX_CONCURRENT = 6;
let active = 0;
const waiters: (() => void)[] = [];

/** 调整并发上限（0 = 不限制；评测/测试可直通） */
export function setLoadConcurrency(max: number): void {
  MAX_CONCURRENT = Math.max(0, Math.round(max));
}

/** 在全局加载并发闸内执行任务（FIFO 排队；释放时唤醒下一个等待者） */
export async function withLoadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (MAX_CONCURRENT <= 0) return task();
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((res) => waiters.push(res));
  }
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

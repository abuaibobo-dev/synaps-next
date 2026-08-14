type Listener = (payload?: any) => void;

const listeners = new Map<string, Set<Listener>>();

/** 发送应用级事件（跨模块通信，如侧栏切换项目） */
export function emit(event: string, payload?: any): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`appBus emit ${event} failed:`, err);
    }
  }
}

/** 订阅事件，返回取消订阅函数 */
export function subscribe(event: string, fn: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(event);
  };
}

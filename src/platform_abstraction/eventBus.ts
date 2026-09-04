type Handler<T> = (payload: T) => void;

export class EventBus<Events> {
  private map = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(type, handler);
  }

  off<K extends keyof Events>(type: K, handler: Handler<Events[K]>): void {
    const set = this.map.get(type);
    if (!set) return;
    set.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    set.forEach((handler) => (handler as Handler<Events[K]>)(payload));
  }

  clear(): void {
    this.map.clear();
  }
}
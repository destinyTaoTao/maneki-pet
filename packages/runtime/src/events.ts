export interface RuntimeEvent {
  eventId: string;
  occurredAt: string;
  kind: string;
  payload: Record<string, unknown>;
}

export type EventListener = (event: RuntimeEvent) => void;

/** 进程内事件源：表达桥通知、勿扰变更、生命周期状态变化都从这里广播给受信 WS 客户端。 */
export class EventFeed {
  private readonly listeners = new Set<EventListener>();
  private nextId = 0;

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(kind: string, payload: Record<string, unknown> = {}): RuntimeEvent {
    this.nextId += 1;
    const event: RuntimeEvent = {
      eventId: `evt-${this.nextId}`,
      occurredAt: new Date().toISOString(),
      kind,
      payload,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }
}

export type RuntimeEventInput =
  | { type: "file.changed"; path: string; changeType: string }
  | { type: "port.changed"; port: number; url: string; status: "open" | "close" }
  | { type: "runtime.failed"; message: string };

export type RuntimeEvent = RuntimeEventInput & { seq: number };

/** An append-only, in-memory, per-runtime event log used for `GET .../events?afterSeq=N` polling. */
export class RuntimeEventLog {
  private events: RuntimeEvent[] = [];
  private nextSeq = 0;

  append(event: RuntimeEventInput): RuntimeEvent {
    const recorded: RuntimeEvent = { ...event, seq: this.nextSeq };
    this.nextSeq += 1;
    this.events.push(recorded);
    return recorded;
  }

  getSince(afterSeq: number): { events: RuntimeEvent[]; nextSeq: number } {
    return { events: this.events.filter((event) => event.seq >= afterSeq), nextSeq: this.nextSeq };
  }
}

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

export interface SseParser {
  /** Feeds a raw text chunk and returns any complete frames it produced. */
  feed(chunk: string): SseEvent[];
}

/**
 * Parses a text/event-stream body into discrete frames. Frames are
 * separated by a blank line; a frame with no `data:` line and no `id:`
 * line (e.g. a `: heartbeat` comment) carries no information and is
 * dropped rather than surfaced as an empty event.
 */
export function createSseParser(): SseParser {
  let buffer = "";

  return {
    feed(chunk) {
      buffer += chunk;
      const events: SseEvent[] = [];
      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        let id: string | undefined;
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }

        if (id === undefined && dataLines.length === 0) continue;
        events.push({ ...(id !== undefined ? { id } : {}), event, data: dataLines.join("\n") });
      }
      return events;
    },
  };
}

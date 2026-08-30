import { z } from "zod";

export const runtimeCreateResponseSchema = z.object({
  runtimeId: z.string(),
  sessionId: z.string(),
  status: z.string(),
});
export type RuntimeCreateResponse = z.infer<typeof runtimeCreateResponseSchema>;

export const fileReadResponseSchema = z.object({ content: z.string() });

export const fileListResponseSchema = z.object({ files: z.array(z.string()) });

export const fileSnapshotResponseSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

export const commandCreateResponseSchema = z.object({
  commandId: z.string(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().optional(),
});

export const commandStatusResponseSchema = z.object({
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().optional(),
});

export const commandEventSchema = z.discriminatedUnion("type", [
  z.object({ seq: z.number().int(), type: z.literal("output"), chunk: z.string() }),
  z.object({ seq: z.number().int(), type: z.literal("exit"), code: z.number().int() }),
]);
export type CommandEvent = z.infer<typeof commandEventSchema>;

export const commandEventsResponseSchema = z.object({
  events: z.array(commandEventSchema),
  nextSeq: z.number().int(),
});

export const previewResponseSchema = z.object({
  port: z.number().int().positive(),
  url: z.string(),
  status: z.enum(["open", "close"]),
});

export const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    seq: z.number().int(),
    type: z.literal("file.changed"),
    path: z.string(),
    changeType: z.string(),
  }),
  z.object({
    seq: z.number().int(),
    type: z.literal("port.changed"),
    port: z.number().int().positive(),
    url: z.string(),
    status: z.enum(["open", "close"]),
  }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const runtimeEventsResponseSchema = z.object({
  events: z.array(runtimeEventSchema),
  nextSeq: z.number().int(),
});

import { type RuntimeAdapter, type RuntimeProcess } from "@ezu/core";
import { type RuntimePort } from "@ezu/protocol";

export interface RemoteRuntimeConfig {
  baseUrl: string;
  projectId: string;
}

export class RemoteRuntimeStub {
  constructor(readonly config: RemoteRuntimeConfig) {}
}

export function createRemoteRuntimeStub(config: RemoteRuntimeConfig): RuntimeAdapter {
  const notImplemented = () => {
    throw new Error(`Remote runtime not implemented for ${config.baseUrl}`);
  };

  return {
    readFile: async () => notImplemented(),
    writeFile: async () => notImplemented(),
    patchFile: async () => notImplemented(),
    listFiles: async () => notImplemented(),
    deleteFile: async () => notImplemented(),
    runCommand: async () => notImplemented() as Promise<RuntimeProcess>,
    openPreview: async () => notImplemented() as Promise<RuntimePort>,
    watchFiles: async () => notImplemented() as Promise<() => void>,
    watchPorts: async () => notImplemented() as Promise<() => void>,
  };
}

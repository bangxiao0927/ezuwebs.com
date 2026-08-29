export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export interface CopyResult {
  ok: boolean;
  message: string;
}

export async function copyText(
  writer: ClipboardWriter | undefined,
  value: string | undefined,
  label: string,
): Promise<CopyResult> {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { ok: false, message: `No ${label} to copy.` };
  }
  if (!writer) {
    return { ok: false, message: "Clipboard is not available in this browser." };
  }
  try {
    await writer.writeText(trimmed);
    return { ok: true, message: `Copied ${label}.` };
  } catch {
    return { ok: false, message: `Failed to copy ${label}.` };
  }
}

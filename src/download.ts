import { writeFile } from "node:fs/promises";

/** Default UA for audio downloads — callers can override it. */
export const DEFAULT_UA =
  "tale-align/0.1 (+https://github.com/samuelcole/tale-align)";

/**
 * Pull one audio file down to a local path, patiently and under our own name.
 * `label` names the file in the error, since a section number means something
 * to a batch job and a job id means something to a single-request caller.
 */
export async function download(
  url: string,
  file: string,
  label: string,
  ua?: string,
): Promise<void> {
  const res = await fetch(url, {
    headers: { "user-agent": ua ?? DEFAULT_UA },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`audio HTTP ${res.status} for ${label}`);
  }
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

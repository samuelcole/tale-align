import { writeFile } from "node:fs/promises";
import { config } from "./config.ts";

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
    headers: { "user-agent": ua ?? config.ua },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`audio HTTP ${res.status} for ${label}`);
  }
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Exact duration of an audio file, via ffprobe — a catalog's advertised
 *  runtime is an estimate, and the whole-book timeline is cumulative over
 *  every section's duration, so rounding here would skew everything after it. */
export async function probeSecs(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const secs = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(secs)) {
    throw new Error(
      `ffprobe produced no readable duration for ${file}: ${stdout.trim() || "(empty output)"}`,
    );
  }
  return secs;
}

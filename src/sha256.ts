import { createHash } from "node:crypto";

/** The hex digest the interchange document keys a text by — the guarantee that
 *  an edited text can never ship yesterday's timings. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

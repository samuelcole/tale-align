import { config } from "./config.ts";

/**
 * Fetch a book's epub from Gutenberg's own cache mirror. Most books ship an
 * "-images" edition; a handful (mostly very old ids) only have the plain
 * one, so that's tried second. Throws if neither exists.
 */
export async function fetchGutenbergEpub(id: string): Promise<Buffer> {
  for (const name of [`pg${id}-images.epub`, `pg${id}.epub`]) {
    const res = await fetch(
      `https://www.gutenberg.org/cache/epub/${id}/${name}`,
      { headers: { "user-agent": config.ua } },
    );
    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }
  }
  throw new Error(`no epub found for Gutenberg id ${id}`);
}

// Ported verbatim from tale.fyi's body slugifier so section ids stay
// byte-identical to the scheme this package's anchor contract depends on.
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

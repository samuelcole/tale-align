import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRecording } from "../src/librivox.ts";

/** Build a fetch-shaped Response for a LibriVox feed body. */
function feedResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchRecording sorts sections by section_number and renumbers positions 1..n, even out of order and gappy", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    feedResponse({
      books: [
        {
          title: "Dracula",
          url_librivox: "https://librivox.org/dracula/",
          sections: [
            {
              section_number: "3",
              title: "Chapter 3",
              listen_url: "https://archive.org/c3.mp3",
            },
            {
              section_number: "1",
              title: "Chapter 1",
              listen_url: "https://archive.org/c1.mp3",
            },
            {
              section_number: "10",
              title: "Chapter 10",
              listen_url: "https://archive.org/c10.mp3",
            },
          ],
        },
      ],
    }),
  );

  const rec = await fetchRecording("123");
  assert.deepEqual(
    rec.sections.map((s) => s.position),
    [1, 2, 3],
  );
  // Numeric order on section_number ("1" < "3" < "10"), not feed order.
  assert.deepEqual(
    rec.sections.map((s) => s.title),
    ["Chapter 1", "Chapter 3", "Chapter 10"],
  );
});

test("fetchRecording normalizes http://www.archive.org listen URLs to https://archive.org", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    feedResponse({
      books: [
        {
          title: "Test Book",
          sections: [
            {
              section_number: "1",
              listen_url: "http://www.archive.org/download/x/x.mp3",
            },
          ],
        },
      ],
    }),
  );

  const rec = await fetchRecording("1");
  assert.equal(
    rec.sections[0].listenUrl,
    "https://archive.org/download/x/x.mp3",
  );
});

test("fetchRecording leaves an already-canonical archive.org URL untouched", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    feedResponse({
      books: [
        {
          title: "Test Book",
          sections: [
            {
              section_number: "1",
              listen_url: "https://archive.org/download/x/x.mp3",
            },
          ],
        },
      ],
    }),
  );

  const rec = await fetchRecording("1");
  assert.equal(
    rec.sections[0].listenUrl,
    "https://archive.org/download/x/x.mp3",
  );
});

test("fetchRecording takes the first reader's display_name, trimmed, and null when there are no readers", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    feedResponse({
      books: [
        {
          title: "Test Book",
          sections: [
            {
              section_number: "1",
              listen_url: "https://archive.org/a.mp3",
              readers: [
                { display_name: " Jane Doe " },
                { display_name: "Second Reader" },
              ],
            },
            {
              section_number: "2",
              listen_url: "https://archive.org/b.mp3",
            },
          ],
        },
      ],
    }),
  );

  const rec = await fetchRecording("1");
  assert.equal(rec.sections[0].reader, "Jane Doe");
  assert.equal(rec.sections[1].reader, null);
});

test("fetchRecording sets title to null when the section title is empty or absent", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    feedResponse({
      books: [
        {
          title: "Test Book",
          sections: [
            {
              section_number: "1",
              title: "",
              listen_url: "https://archive.org/a.mp3",
            },
            {
              section_number: "2",
              listen_url: "https://archive.org/b.mp3",
            },
          ],
        },
      ],
    }),
  );

  const rec = await fetchRecording("1");
  assert.equal(rec.sections[0].title, null);
  assert.equal(rec.sections[1].title, null);
});

test("fetchRecording throws a clear error when the feed's books array is empty", async (t) => {
  t.mock.method(globalThis, "fetch", async () => feedResponse({ books: [] }));
  await assert.rejects(
    () => fetchRecording("999"),
    /librivox: no recording found for id 999/,
  );
});

test("fetchRecording throws a clear error when the feed has no books key at all", async (t) => {
  t.mock.method(globalThis, "fetch", async () => feedResponse({}));
  await assert.rejects(
    () => fetchRecording("999"),
    /librivox: no recording found for id 999/,
  );
});

test("fetchRecording throws a clear error when the HTTP status is not ok", async (t) => {
  t.mock.method(globalThis, "fetch", async () => feedResponse({}, 500));
  await assert.rejects(() => fetchRecording("1"), /librivox HTTP 500/);
});

// Note: downloadSections' real download/resume/skip logic is intentionally
// not covered here. Exercising it faithfully needs either real tiny mp3s
// (ffmpeg can make those, but then probeSecs is testing worker.ts, not
// librivox.ts) or fetch mocked with byte payloads plus a stubbed sleep (the
// module's pacing `sleep` is a local, unexported const — not injectable
// without editing src). Given the fetchRecording coverage above already
// exercises the section-ordering contract downloadSections consumes, the
// added coverage from mocking downloadSections's fetch+ffprobe interplay
// didn't seem worth the complexity here.

/**
 * `graph_chars` the way the TTS API returns it: one string per Unicode code
 * point of the submitted text.
 *
 * An emoji is one entry here and two units of a JavaScript string. The API
 * documents that shape — "one entry per Unicode character, so an emoji takes
 * one place in `graph_chars` and two in a JavaScript string" — and the mock
 * and the tests both have to speak it, or the alignment is only ever checked
 * against a transcript the real replies do not use.
 */
export function graphCharsFor(text) {
  return Array.from(text);
}

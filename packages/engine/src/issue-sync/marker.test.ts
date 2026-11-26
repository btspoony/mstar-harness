import { describe, expect, test } from "bun:test";
import { decodeMarker, encodeMarker } from "./marker.js";

const AUTHOR = "Ada Lovelace <ada@example.com>";

describe("encodeMarker / decodeMarker", () => {
  test("round-trips the three fields in the frozen format", () => {
    const marker = encodeMarker({ repo: "acme/widgets", localId: "I-000123", author: AUTHOR });
    expect(marker).toBe("<!-- mstar-sync: repo=acme/widgets; local=I-000123; author=" + AUTHOR + " -->");
    expect(decodeMarker(marker)).toEqual({ repo: "acme/widgets", localId: "I-000123", author: AUTHOR });
  });

  test("the marker is decoded from the last line of a full description", () => {
    const marker = encodeMarker({ repo: "acme/widgets", localId: "I-1", author: AUTHOR });
    const description = "## Impact\n\nit breaks\n\n## Acceptance\n\nit works\n\n" + marker;
    expect(decodeMarker(description)).toEqual({ repo: "acme/widgets", localId: "I-1", author: AUTHOR });
  });

  test("an author with spaces and angle brackets survives verbatim", () => {
    const marker = encodeMarker({ repo: "acme/widgets", localId: "I-2", author: "Bo Bo <bo@example.test>" });
    expect(decodeMarker(marker)?.author).toBe("Bo Bo <bo@example.test>");
  });

  test("the LAST marker decides, so a quoted marker in operator prose cannot name the issue", () => {
    const quoted = encodeMarker({ repo: "acme/widgets", localId: "I-999", author: "Someone Else <s@example.test>" });
    const real = encodeMarker({ repo: "acme/widgets", localId: "I-3", author: AUTHOR });
    expect(decodeMarker("an operator once pushed\n\n" + quoted + "\n\n" + real)).toEqual({
      repo: "acme/widgets",
      localId: "I-3",
      author: AUTHOR,
    });
  });

  test("no marker, a legacy marker and a malformed one all decode to null", () => {
    expect(decodeMarker(null)).toBeNull();
    expect(decodeMarker(undefined)).toBeNull();
    expect(decodeMarker("## Impact\n\nno marker here")).toBeNull();
    // why: The deleted code's marker shape: a bare slash-joined path, no keys.
    expect(decodeMarker("body\n\n<!-- mstar-sync: acme/ENG/store-alpha/I-000001 -->")).toBeNull();
    expect(decodeMarker("body\n\n<!-- mstar-sync: local=I-1; author=" + AUTHOR + " -->")).toBeNull();
    expect(decodeMarker("body\n\n<!-- mstar-sync: repo=acme/widgets; author=" + AUTHOR + " -->")).toBeNull();
    expect(decodeMarker("body\n\n<!-- mstar-sync: repo= ; local=I-1; author=" + AUTHOR + " -->")).toBeNull();
  });

  test("a marker without an author still decodes, with an empty author", () => {
    expect(decodeMarker("body\n\n<!-- mstar-sync: repo=acme/widgets; local=I-4 -->")).toEqual({
      repo: "acme/widgets",
      localId: "I-4",
      author: "",
    });
  });
});

import { describe, expect, it } from "vitest";
import { chunkKnowledgeSections } from "./ingestion";

describe("knowledge chunking", () => {
  it("keeps section metadata while applying a bounded overlap", () => {
    const sections = [{
      text: `${"甲".repeat(700)}\n\n${"乙".repeat(700)}`,
      heading_path: ["喉癌", "分期"],
    }];

    const chunks = chunkKnowledgeSections(sections, { maxChars: 800, overlapChars: 100 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ heading_path: ["喉癌", "分期"] });
    expect(chunks[1].text.startsWith("甲".repeat(98))).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 800)).toBe(true);
  });

  it("rejects a chunking configuration that cannot make progress", () => {
    expect(() => chunkKnowledgeSections([{ text: "有效文本", heading_path: [] }], {
      maxChars: 300,
      overlapChars: 300,
    })).toThrow("Invalid knowledge chunking limits");
  });
});

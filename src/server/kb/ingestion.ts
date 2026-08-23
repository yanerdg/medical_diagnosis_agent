import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import {
  extractedKnowledgeSectionSchema,
  supportedKnowledgeFileTypeSchema,
  type ExtractedKnowledgeSection,
} from "./local-types";

export type ParsedKnowledgeDocument = {
  file_type: "markdown" | "text" | "docx" | "pdf";
  source_sha256: string;
  sections: ExtractedKnowledgeSection[];
};

export async function parseKnowledgeDocument(filePath: string): Promise<ParsedKnowledgeDocument> {
  const fileType = fileTypeFromPath(filePath);
  const raw = await readFile(filePath);
  const sourceSha256 = createHash("sha256").update(raw).digest("hex");
  let sections: ExtractedKnowledgeSection[];

  if (fileType === "markdown") {
    sections = sectionsFromMarkdown(raw.toString("utf8"));
  } else if (fileType === "text") {
    sections = sectionsFromPlainText(raw.toString("utf8"));
  } else if (fileType === "docx") {
    const result = await mammoth.extractRawText({ buffer: raw });
    sections = sectionsFromPlainText(result.value);
  } else {
    const parser = new PDFParse({ data: raw });
    const result = await parser.getText();
    await parser.destroy();
    sections = sectionsFromPlainText(result.text);
  }

  if (sections.length === 0) {
    throw new Error(`No extractable text found in ${path.basename(filePath)}`);
  }

  return { file_type: fileType, source_sha256: sourceSha256, sections };
}

export function chunkKnowledgeSections(
  sections: ExtractedKnowledgeSection[],
  options: { maxChars?: number; overlapChars?: number } = {},
): ExtractedKnowledgeSection[] {
  const maxChars = options.maxChars ?? 1_200;
  const overlapChars = options.overlapChars ?? 150;
  if (maxChars < 200 || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("Invalid knowledge chunking limits");
  }

  return sections.flatMap((section) => splitSection(section, maxChars, overlapChars));
}

function fileTypeFromPath(filePath: string): ParsedKnowledgeDocument["file_type"] {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  const value = extension === ".md" ? "markdown" : extension === ".txt" ? "text" : extension.slice(1);
  return supportedKnowledgeFileTypeSchema.parse(value);
}

function sectionsFromMarkdown(value: string): ExtractedKnowledgeSection[] {
  const lines = normalizeText(value).split("\n");
  const sections: ExtractedKnowledgeSection[] = [];
  const headings: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) sections.push(extractedKnowledgeSectionSchema.parse({ text, heading_path: [...headings] }));
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const depth = heading[1].length;
    headings.splice(depth - 1);
    headings[depth - 1] = heading[2].trim();
  }
  flush();
  return sections;
}

function sectionsFromPlainText(value: string): ExtractedKnowledgeSection[] {
  const text = normalizeText(value).trim();
  return text ? [extractedKnowledgeSectionSchema.parse({ text, heading_path: [] })] : [];
}

function splitSection(
  section: ExtractedKnowledgeSection,
  maxChars: number,
  overlapChars: number,
): ExtractedKnowledgeSection[] {
  const paragraphs = section.text.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < paragraph.length; offset += maxChars - overlapChars) {
        chunks.push(paragraph.slice(offset, offset + maxChars).trim());
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    const carriedChars = Math.min(overlapChars, Math.max(0, maxChars - paragraph.length - 2));
    current = `${current.slice(-carriedChars)}\n\n${paragraph}`.trim();
  }
  if (current) chunks.push(current);

  return chunks.map((text) => extractedKnowledgeSectionSchema.parse({
    ...section,
    text,
  }));
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

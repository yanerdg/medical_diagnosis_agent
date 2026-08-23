import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getDataDirectory } from "../db";

export interface StoredRawInput {
  raw_text_path: string;
  raw_text_hash: string;
}

export interface SaveRawInputTextParams {
  case_id: string;
  input_id: string;
  raw_text: string;
}

export class RawInputStore {
  constructor(private readonly dataDirectory = getDataDirectory()) {}

  saveText(params: SaveRawInputTextParams): StoredRawInput {
    const rawInputDirectory = join(
      this.dataDirectory,
      "raw-inputs",
      safePathSegment(params.case_id),
    );
    const rawInputPath = join(
      rawInputDirectory,
      `${safePathSegment(params.input_id)}.txt`,
    );

    mkdirSync(rawInputDirectory, { recursive: true });
    writeFileSync(rawInputPath, params.raw_text, { encoding: "utf8", flag: "wx" });

    return {
      raw_text_path: toStoredPath(rawInputPath),
      raw_text_hash: hashText(params.raw_text),
    };
  }

  readText(rawTextPath: string): string {
    return readFileSync(resolveStoredPath(rawTextPath), "utf8");
  }

  deleteText(rawTextPath: string): void {
    rmSync(resolveStoredPath(rawTextPath), { force: true });
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function safePathSegment(value: string): string {
  const safeValue = value.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (safeValue.length === 0 || safeValue === "." || safeValue === "..") {
    throw new Error("Path segment cannot be empty");
  }

  return safeValue;
}

function toStoredPath(absolutePath: string): string {
  const relativePath = relative(process.cwd(), absolutePath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return absolutePath;
  }

  return relativePath.split(sep).join("/");
}

function resolveStoredPath(storedPath: string): string {
  return isAbsolute(storedPath) ? storedPath : join(process.cwd(), storedPath);
}

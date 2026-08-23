import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDataDirectory } from "@/server/db";
import { ingestKnowledgeDocument } from "@/server/kb/ingestion-service";
import { knowledgeDocumentMetadataSchema } from "@/server/kb/local-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Controlled ingestion endpoint for an operator-managed local deployment.
 * It is intentionally disabled until KNOWLEDGE_INGESTION_TOKEN is configured.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "unauthorized", message: "A valid knowledge-ingestion token is required." },
      { status: 401 },
    );
  }

  try {
    const form = await request.formData();
    const upload = form.get("file");
    const metadataRaw = form.get("metadata");
    const knowledgeVersion = form.get("knowledge_version");

    if (!(upload instanceof File) || upload.size === 0) {
      return badRequest("file must be a non-empty uploaded file.");
    }
    if (upload.size > MAX_UPLOAD_BYTES) {
      return badRequest("file exceeds the 50 MiB ingestion limit.");
    }
    if (typeof metadataRaw !== "string" || typeof knowledgeVersion !== "string" || !knowledgeVersion.trim()) {
      return badRequest("metadata JSON and knowledge_version are required.");
    }

    const metadata = knowledgeDocumentMetadataSchema.parse(JSON.parse(metadataRaw));
    const extension = path.extname(upload.name).toLocaleLowerCase("en-US");
    if (!new Set([".md", ".txt", ".docx", ".pdf"]).has(extension)) {
      return badRequest("Only .md, .txt, .docx and .pdf knowledge files are supported.");
    }

    const uploadDirectory = path.join(getDataDirectory(), "knowledge-uploads");
    await mkdir(uploadDirectory, { recursive: true });
    const filePath = path.join(uploadDirectory, `${randomUUID()}${extension}`);
    await writeFile(filePath, Buffer.from(await upload.arrayBuffer()), { flag: "wx" });

    const result = await ingestKnowledgeDocument({
      file_path: filePath,
      metadata,
      knowledge_version: knowledgeVersion.trim(),
      requested_by: "knowledge_ingestion_api",
    });
    return NextResponse.json(result, { status: result.status === "failed" ? 422 : 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return badRequest("metadata must be valid JSON.");
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "bad_request", message: "Knowledge metadata validation failed.", details: error.issues },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "internal_server_error", message: "Unexpected knowledge ingestion error." },
      { status: 500 },
    );
  }
}

function isAuthorized(request: Request): boolean {
  const configuredToken = process.env.KNOWLEDGE_INGESTION_TOKEN;
  if (!configuredToken) return false;
  const suppliedToken = request.headers.get("x-knowledge-ingestion-token") ?? "";
  const expected = Buffer.from(configuredToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: "bad_request", message }, { status: 400 });
}

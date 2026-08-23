import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class InvalidJsonError extends Error {
  constructor() {
    super("Request body must be valid JSON.");
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidJsonError();
  }
}

export function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json(
    {
      error: "bad_request",
      message,
      ...(details === undefined ? {} : { details }),
    },
    { status: 400 },
  );
}

export function notFound(message: string): NextResponse {
  return NextResponse.json(
    {
      error: "not_found",
      message,
    },
    { status: 404 },
  );
}

export function serverError(): NextResponse {
  return NextResponse.json(
    {
      error: "internal_server_error",
      message: "Unexpected server error.",
    },
    { status: 500 },
  );
}

export function validationError(error: ZodError): NextResponse {
  return badRequest(
    "Request validation failed.",
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

export function isValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}

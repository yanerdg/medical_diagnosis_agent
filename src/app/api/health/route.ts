import { NextResponse } from "next/server";
import { appInfo } from "@/lib/app-info";

export function GET() {
  return NextResponse.json({
    ok: true,
    app: appInfo.shortName,
    version: appInfo.version,
  });
}

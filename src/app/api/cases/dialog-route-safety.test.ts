import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

describe("case API route safety", () => {
  it("does not expose a /api/cases/:id/dialog route", () => {
    const casesApiDirectory = join(process.cwd(), "src/app/api/cases");
    const routeFiles = listFiles(casesApiDirectory).map((filePath) =>
      relative(casesApiDirectory, filePath).split(sep).join("/"),
    );

    expect(routeFiles).not.toContain("[caseId]/dialog/route.ts");
    expect(routeFiles).not.toContain("[caseId]/dialog/route.tsx");
    expect(routeFiles).not.toContain("[caseId]/dialog/route.js");
    expect(routeFiles).not.toContain("[caseId]/dialog/route.jsx");
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = join(directory, entry);
    const entryStats = statSync(entryPath);

    return entryStats.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

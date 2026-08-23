import {
  caseInputTypeSchema,
  specialtyStructureSchema,
  type CaseInputType,
  type SpecialtyStructure,
} from "@/domain/schemas";
import { evaluateSafetyRules } from "@/domain/rules";
import { runAssessmentGraph } from "@/server/agent";
import { openDatabase, type SqliteDatabase } from "@/server/db";
import { MedicalRepository } from "@/server/repositories";
import { RawInputStore } from "@/server/storage/raw-input-store";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const timestamp = "2026-07-09T00:00:00.000Z";
const fixtureDirectory = join(process.cwd(), "data/eval/safety");

const structureFixtureSchema = specialtyStructureSchema.omit({
  structure_id: true,
  case_id: true,
  version: true,
  created_at: true,
});

const safetyEvalFixtureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    raw_inputs: z
      .array(
        z
          .object({
            input_id: z.string().min(1),
            input_type: caseInputTypeSchema,
            raw_text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    structure: structureFixtureSchema,
    expected: z
      .object({
        run_status: z.string().optional(),
        assessment_status: z.string().optional(),
        missing_evidence_codes: z.array(z.string()).optional(),
        lab_checker_missing: z.array(z.string()).optional(),
        recommended_missing_tests: z.array(z.string()).optional(),
        forbid_sensitivity_level: z.string().optional(),
        sensitivity_missing_information: z.array(z.string()).optional(),
        forbid_tolerance_level: z.string().optional(),
        contradiction_issue_codes: z.array(z.string()).optional(),
        summary_includes: z.array(z.string()).optional(),
        red_flag_categories: z.array(z.string()).optional(),
        report_red_flag_includes: z.array(z.string()).optional(),
        unsafe_output_text: z.string().optional(),
        safety_issue_codes: z.array(z.string()).optional(),
        agent_output_forbidden_terms: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

type SafetyEvalFixture = z.infer<typeof safetyEvalFixtureSchema>;

describe("safety regression eval fixtures", () => {
  let tempDirectory: string;
  let database: SqliteDatabase;
  let repository: MedicalRepository;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-eval-"));
    database = openDatabase(join(tempDirectory, "app.sqlite"));
    repository = new MedicalRepository(
      database,
      new RawInputStore(tempDirectory),
    );
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  for (const fixture of loadFixtures()) {
    it(`${fixture.id}: ${fixture.description}`, async () => {
      saveFixtureCase(repository, fixture);

      const result = await runAssessmentGraph({
        case_id: fixture.id,
        repository,
        now: () => timestamp,
      });
      const report = result.report?.report_json;

      expect(result.run.status).toBe(fixture.expected.run_status);
      expect(report?.assessment_status).toBe(fixture.expected.assessment_status);
      expect(result.state.tool_outputs.output_schema_validator?.valid).toBe(true);

      if (fixture.expected.missing_evidence_codes) {
        expect(result.state.missing_evidence.map((item) => item.code)).toEqual(
          expect.arrayContaining(fixture.expected.missing_evidence_codes),
        );
      }

      if (fixture.expected.recommended_missing_tests) {
        expect(report?.recommended_missing_tests).toEqual(
          expect.arrayContaining(fixture.expected.recommended_missing_tests),
        );
      }

      if (fixture.expected.lab_checker_missing) {
        expect(result.state.tool_outputs.lab_checker?.missing).toEqual(
          expect.arrayContaining(fixture.expected.lab_checker_missing),
        );
      }

      if (fixture.expected.forbid_sensitivity_level) {
        expect(
          report?.sensitivity_assessment.some(
            (item) => item.level === fixture.expected.forbid_sensitivity_level,
          ),
        ).toBe(false);
      }

      if (fixture.expected.sensitivity_missing_information) {
        const missingInformation = new Set(
          report?.sensitivity_assessment.flatMap(
            (item) => item.missing_information,
          ) ?? [],
        );

        for (const expectedMissing of fixture.expected
          .sensitivity_missing_information) {
          expect(missingInformation.has(expectedMissing)).toBe(true);
        }
      }

      if (fixture.expected.forbid_tolerance_level) {
        expect(
          report?.tolerance_assessment.some(
            (item) => item.level === fixture.expected.forbid_tolerance_level,
          ),
        ).toBe(false);
      }

      if (fixture.expected.contradiction_issue_codes) {
        const contradictionCodes =
          result.state.tool_outputs.contradiction_checker?.contradictions.map(
            (issue) => issue.code,
          ) ?? [];

        expect(contradictionCodes).toEqual(
          expect.arrayContaining(fixture.expected.contradiction_issue_codes),
        );
      }

      if (fixture.expected.summary_includes) {
        for (const expectedText of fixture.expected.summary_includes) {
          expect(report?.summary).toContain(expectedText);
        }
      }

      if (fixture.expected.red_flag_categories) {
        const redFlagCategories =
          result.state.tool_outputs.output_schema_validator?.red_flags.map(
            (redFlag) => redFlag.category,
          ) ?? [];

        expect(redFlagCategories).toEqual(
          expect.arrayContaining(fixture.expected.red_flag_categories),
        );
      }

      if (fixture.expected.report_red_flag_includes) {
        const redFlagText = report?.red_flags.join("\n") ?? "";

        for (const expectedText of fixture.expected.report_red_flag_includes) {
          expect(redFlagText).toContain(expectedText);
        }
      }

      if (fixture.expected.unsafe_output_text) {
        const issueCodes = evaluateSafetyRules(
          fixture.expected.unsafe_output_text,
        ).map((issue) => issue.code);

        expect(issueCodes).toEqual(
          expect.arrayContaining(fixture.expected.safety_issue_codes ?? []),
        );
      }

      if (fixture.expected.agent_output_forbidden_terms) {
        const generatedText = result.report?.report_markdown ?? "";

        for (const forbiddenTerm of fixture.expected
          .agent_output_forbidden_terms) {
          expect(generatedText).not.toContain(forbiddenTerm);
        }
        expect(
          result.state.tool_outputs.output_schema_validator?.safety_issues,
        ).toHaveLength(0);
      }
    });
  }
});

function loadFixtures(): SafetyEvalFixture[] {
  return readdirSync(fixtureDirectory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) =>
      safetyEvalFixtureSchema.parse(
        JSON.parse(readFileSync(join(fixtureDirectory, fileName), "utf8")),
      ),
    );
}

function saveFixtureCase(
  repository: MedicalRepository,
  fixture: SafetyEvalFixture,
): void {
  repository.saveCase({
    case_id: fixture.id,
    display_name: fixture.description,
    status: "ready_for_assessment",
    created_at: timestamp,
    updated_at: timestamp,
  });

  for (const input of fixture.raw_inputs) {
    repository.createCaseInputFromRawText({
      input_id: input.input_id,
      case_id: fixture.id,
      input_type: input.input_type as CaseInputType,
      raw_text: input.raw_text,
      submitted_at: timestamp,
    });
  }

  repository.saveSpecialtyStructure(buildStructure(fixture));
}

function buildStructure(fixture: SafetyEvalFixture): SpecialtyStructure {
  return specialtyStructureSchema.parse({
    structure_id: `${fixture.id}-structure`,
    case_id: fixture.id,
    version: 1,
    created_at: timestamp,
    ...fixture.structure,
  });
}

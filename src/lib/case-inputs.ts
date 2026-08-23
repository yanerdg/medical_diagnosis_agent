import type { CaseInputType } from "@/domain/schemas";

const caseInputTypeLabels: Record<CaseInputType, string> = {
  clinician_note: "History & Chief Concern",
  ct_report: "CT Report",
  pathology_biomarker: "Pathology & Biomarkers",
  lab_report: "Laboratory Results",
  treatment_history: "Treatment History",
  demographics: "Demographics",
  other: "Other",
};

export const initialCaseInputFields = [
  {
    input_type: "clinician_note",
    label: caseInputTypeLabels.clinician_note,
    placeholder:
      "Enter chief concerns, physical findings, illness history, or preliminary clinical impressions.",
  },
  {
    input_type: "ct_report",
    label: caseInputTypeLabels.ct_report,
    placeholder:
      "Enter CT narrative findings, lesion extent, involved structures, and lymph node descriptions.",
  },
  {
    input_type: "pathology_biomarker",
    label: caseInputTypeLabels.pathology_biomarker,
    placeholder:
      "Enter pathology, IHC, HPV/EBV, PD-L1, or other biomarker report text.",
  },
  {
    input_type: "lab_report",
    label: caseInputTypeLabels.lab_report,
    placeholder:
      "Enter CBC, liver and renal function, albumin, infection markers, or other lab text.",
  },
  {
    input_type: "treatment_history",
    label: caseInputTypeLabels.treatment_history,
    placeholder:
      "Enter prior surgery, radiotherapy, chemotherapy, immunotherapy, targeted therapy, or adverse event history.",
  },
] as const satisfies ReadonlyArray<{
  input_type: CaseInputType;
  label: string;
  placeholder: string;
}>;

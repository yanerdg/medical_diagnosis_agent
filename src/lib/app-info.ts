export const appInfo = {
  name: "Throat Cancer Sensitivity and Tolerance Assessment Agent",
  shortName: "ThroatCancerSensitivityToleranceAgent",
  version: "0.1.0",
  description:
    "A TypeScript MVP for otolaryngology and head-and-neck oncology clinicians, supporting case intake, evidence structuring, paused clarification, and clinician review loops.",
} as const;

export const mvpCapabilities = [
  "Case intake and raw text management",
  "Structured preview and clinician correction",
  "Restricted Agent assessment state graph",
  "Paused clarification and assessment resume",
  "Report workspace and clinician review",
] as const;

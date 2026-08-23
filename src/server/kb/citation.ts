import { z } from "zod";
import { knowledgeChunkSchema } from "./loader";

export const knowledgeCitationSchema = knowledgeChunkSchema
  .omit({ source_path: true })
  .extend({
    citation_id: z.string().min(1),
    score: z.number().nonnegative(),
    matched_keywords: z.array(z.string().min(1)),
  })
  .strict();

export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;

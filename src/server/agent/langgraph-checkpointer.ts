import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getDataDirectory } from "@/server/db";

const CHECKPOINT_FILE = "medical-diagnosis-agent.langgraph.sqlite";

/**
 * Durable workflow state is intentionally separate from clinical data tables.
 * The assessment run ID is used as the LangGraph thread ID by the caller.
 */
export function createAssessmentCheckpointer(
  checkpointPath = path.join(getDataDirectory(), CHECKPOINT_FILE),
): SqliteSaver {
  return SqliteSaver.fromConnString(checkpointPath);
}

import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getDataDirectory } from "@/server/db";

const CHECKPOINT_FILE = "medical-diagnosis-agent.langgraph.sqlite";
const savers = new Map<string, SqliteSaver>();

/**
 * Durable workflow state is intentionally separate from clinical data tables.
 * The assessment run ID is used as the LangGraph thread ID by the caller.
 */
export function createAssessmentCheckpointer(
  checkpointPath = path.join(getDataDirectory(), CHECKPOINT_FILE),
): SqliteSaver {
  let saver = savers.get(checkpointPath);
  if (!saver) {
    saver = SqliteSaver.fromConnString(checkpointPath);
    savers.set(checkpointPath, saver);
  }
  return saver;
}

/** Use during controlled shutdown or isolated tests to release the SQLite file. */
export function closeAssessmentCheckpointer(checkpointPath: string): void {
  const saver = savers.get(checkpointPath);
  if (!saver) return;
  saver.db.close();
  savers.delete(checkpointPath);
}

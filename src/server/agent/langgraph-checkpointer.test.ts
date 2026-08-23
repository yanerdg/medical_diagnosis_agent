import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { createAssessmentCheckpointer } from "./langgraph-checkpointer";

const CheckpointState = Annotation.Root({
  count: Annotation<number>,
});

describe("assessment LangGraph checkpointer", () => {
  it("loads a completed thread from a fresh SQLite saver instance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "medical-agent-langgraph-"));
    const checkpointPath = join(directory, "checkpoints.sqlite");
    const buildGraph = () => new StateGraph(CheckpointState)
      .addNode("increment", (state) => ({ count: state.count + 1 }))
      .addEdge(START, "increment")
      .addEdge("increment", END)
      .compile({ checkpointer: createAssessmentCheckpointer(checkpointPath) });
    const config = { configurable: { thread_id: "assessment-run-1" } };

    await buildGraph().invoke({ count: 0 }, config);
    const restored = await buildGraph().getState(config);

    expect(restored.values).toMatchObject({ count: 1 });
    expect(restored.next).toEqual([]);
  });
});

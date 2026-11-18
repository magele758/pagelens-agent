import assert from "node:assert/strict";
import { test } from "node:test";
import { describeClip, topicNeighborhood } from "../lib/clipping-graph.js";

test("[AC:preprocess-knowledge#AC-3] content connects untagged clips with sources and related topics", () => {
  const clips = [{ id: "one", content: "神经网络 机器学习 神经网络", tags: ["实验"] }, { id: "two", content: "机器学习与神经网络" }];
  const rows = clips.map(c => ({ ...c, ...describeClip(c) }));
  const shared = rows[0].topics.find(t => rows[1].topics.includes(t));
  assert.ok(shared);
  assert.ok(rows[0].domains.includes("人工智能"));
  const graph = topicNeighborhood(rows, shared);
  assert.deepEqual(graph.sources.map(s => s.id), ["one", "two"]);
  assert.ok(graph.related.some(r => r.topic === "实验" && r.count === 1));
});

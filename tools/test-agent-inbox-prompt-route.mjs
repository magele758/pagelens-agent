// Routes agent_prompt and cancel through a temporary PAGELENS_HOME. Does not read ~/.pagelens.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cliPath = fileURLToPath(new URL("./agent-inbox.mjs", import.meta.url));
const execute = promisify(execFile);
const extensionId = "c".repeat(32);
const otherId = "d".repeat(32);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-prompt-route-"));
const fixtureHome = path.join(tmp, ".pagelens");
const env = { ...process.env, PAGELENS_HOME: fixtureHome };
delete env.PAGELENS_EXTENSION_ID;
delete env.PAGELENS_MCP;
delete env.PAGELENS_TOKEN;

const sharedInbox = path.join(fixtureHome, "agent-inbox");
const directedInbox = path.join(sharedInbox, extensionId);
const idFile = path.join(fixtureHome, "agent-inbox-extension-id");
const outboxDir = path.join(fixtureHome, "agent-outbox");

function run(args, extraEnv = {}) {
  return execute(process.execPath, [cliPath, ...args], {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });
}

async function fail(args, extraEnv = {}) {
  try {
    await run(args, extraEnv);
  } catch (error) {
    return error;
  }
  assert.fail(`expected failure: ${args.join(" ")}`);
}

async function setIdFile(text) {
  await fs.mkdir(fixtureHome, { recursive: true });
  await fs.writeFile(idFile, text);
}

async function clearIdFile() {
  await fs.rm(idFile, { force: true });
}

async function jsonNames(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

try {
  await setIdFile(`${extensionId}\n`);
  const prompted = JSON.parse((await run(["enqueue", "--action", "agent_prompt", "--prompt", "hi"])).stdout);
  assert.equal(path.dirname(prompted.jobPath), directedInbox);
  assert.equal(await fs.readFile(path.join(sharedInbox, `${prompted.id}.json`), "utf8").catch((error) => error.code), "ENOENT");
  const promptedJob = JSON.parse(await fs.readFile(prompted.jobPath, "utf8"));
  assert.equal(promptedJob.action, "agent_prompt");
  assert.equal(promptedJob.prompt, "hi");

  await clearIdFile();
  const shared = JSON.parse((await run(["enqueue", "--action", "agent_prompt", "--prompt", "hi"])).stdout);
  assert.equal(path.dirname(shared.jobPath), sharedInbox);
  assert.equal(path.basename(shared.jobPath), `${shared.id}.json`);

  await setIdFile("not-an-extension-id\n");
  const invalidFile = JSON.parse((await run(["enqueue", "--action", "agent_prompt", "--prompt", "hi"])).stdout);
  assert.equal(path.dirname(invalidFile.jobPath), sharedInbox);

  await clearIdFile();
  const flagged = JSON.parse((await run([
    "enqueue", "--extension-id", extensionId, "--action", "agent_prompt", "--prompt", "hi",
  ])).stdout);
  assert.equal(path.dirname(flagged.jobPath), directedInbox);
  const flaggedJob = JSON.parse(await fs.readFile(flagged.jobPath, "utf8"));
  assert.equal(flaggedJob.action, "agent_prompt");

  await clearIdFile();
  const cancelFlag = JSON.parse((await run(["cancel", "--extension-id", extensionId])).stdout);
  const flagJobPath = path.join(directedInbox, `${cancelFlag.cancelJobId}.json`);
  assert.equal(JSON.parse(await fs.readFile(flagJobPath, "utf8")).action, "agent_cancel");
  assert.equal(path.dirname(flagJobPath), directedInbox);

  const cancelEnv = JSON.parse((await run(["cancel"], { PAGELENS_EXTENSION_ID: extensionId })).stdout);
  const envJobPath = path.join(directedInbox, `${cancelEnv.cancelJobId}.json`);
  assert.equal(JSON.parse(await fs.readFile(envJobPath, "utf8")).action, "agent_cancel");
  assert.notEqual(cancelEnv.cancelJobId, cancelFlag.cancelJobId);

  await setIdFile(`${extensionId}\n`);
  const cancelFile = JSON.parse((await run(["cancel"])).stdout);
  const fileJobPath = path.join(directedInbox, `${cancelFile.cancelJobId}.json`);
  assert.equal(JSON.parse(await fs.readFile(fileJobPath, "utf8")).action, "agent_cancel");

  await clearIdFile();
  const cancelShared = JSON.parse((await run(["cancel"])).stdout);
  const sharedCancelPath = path.join(sharedInbox, `${cancelShared.cancelJobId}.json`);
  assert.equal(JSON.parse(await fs.readFile(sharedCancelPath, "utf8")).action, "agent_cancel");
  assert.equal(path.dirname(sharedCancelPath), sharedInbox);

  await setIdFile(`${extensionId}\n`);
  const receiptId = "wait-shared-receipt";
  await fs.mkdir(outboxDir, { recursive: true });
  await fs.writeFile(path.join(outboxDir, `${receiptId}.json`), JSON.stringify({
    id: receiptId,
    ok: true,
    action: "agent_prompt",
  }));
  const waited = JSON.parse((await run(["wait", receiptId, "--timeout", "200"])).stdout);
  assert.equal(waited.id, receiptId);
  assert.equal(waited.consumerExtensionId, undefined);
  const status = JSON.parse((await run(["status"])).stdout);
  assert.equal(status.inboxDir, sharedInbox);
  assert.equal(status.outboxDir, outboxDir);
  assert.ok(status.recentOutbox.includes(`${receiptId}.json`));

  const foreignId = "wait-foreign-receipt";
  await fs.writeFile(path.join(outboxDir, `${foreignId}.json`), JSON.stringify({
    id: foreignId,
    ok: true,
    consumerExtensionId: otherId,
  }));
  const foreign = await fail(["wait", foreignId, "--extension-id", extensionId, "--timeout", "200"]);
  assert.match(`${foreign.stderr || ""}\n${foreign.message || ""}`, /handled by a different extension/);

  const beforeShared = await jsonNames(sharedInbox);
  const beforeDirected = await jsonNames(directedInbox);
  const devStatus = await fail(["enqueue", "--action", "dev_status"]);
  assert.match(`${devStatus.stderr || ""}\n${devStatus.message || ""}`, /dev_status requires --extension-id/);
  assert.deepEqual(await jsonNames(sharedInbox), beforeShared);
  assert.deepEqual(await jsonNames(directedInbox), beforeDirected);

  const badId = await fail(["enqueue", "--action", "agent_prompt", "--prompt", "hi", "--extension-id", "z".repeat(32)]);
  assert.match(`${badId.stderr || ""}\n${badId.message || ""}`, /Expected a Chrome extension ID/);
  assert.deepEqual(await jsonNames(directedInbox), beforeDirected);

  console.log("agent-inbox prompt route: ok");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

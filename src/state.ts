import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeState } from "./types.js";

const runtimeDir = path.resolve(process.cwd(), ".runtime");
const statePath = path.join(runtimeDir, "state.json");
let writeQueue = Promise.resolve();

export function createEmptyState(): BridgeState {
  return {
    version: 1,
    lastUpdateId: 0,
    pairedUserId: null,
    conversations: {},
  };
}

export async function loadState(): Promise<BridgeState> {
  await mkdir(runtimeDir, { recursive: true });
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as BridgeState;
    if (
      state.version !== 1 ||
      typeof state.lastUpdateId !== "number" ||
      !state.conversations ||
      typeof state.conversations !== "object"
    ) {
      throw new Error("The bridge state file has an unsupported shape.");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyState();
    }
    throw error;
  }
}

export function saveState(state: BridgeState): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(runtimeDir, { recursive: true });
    const temporaryPath = `${statePath}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, statePath);
  });
  return writeQueue;
}

export function getRuntimeDirectory(): string {
  return runtimeDir;
}

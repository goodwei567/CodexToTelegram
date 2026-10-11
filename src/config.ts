import { readFile } from "node:fs/promises";
import path from "node:path";

export interface BridgeConfig {
  allowedCwdRoots: string[];
  defaultWorkspace: string;
  modelListUrl: string;
  telegramApiBaseUrl: string;
  maxImageBytes: number;
  pollTimeoutSeconds: number;
}

const configPath = path.resolve(process.cwd(), "bridge.config.json");

export async function loadConfig(): Promise<BridgeConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<BridgeConfig>;

  if (!parsed.defaultWorkspace || !path.isAbsolute(parsed.defaultWorkspace)) {
    throw new Error("bridge.config.json must set an absolute defaultWorkspace path.");
  }

  const modelListUrl = new URL(parsed.modelListUrl ?? "");
  if (modelListUrl.protocol !== "http:" && modelListUrl.protocol !== "https:") {
    throw new Error("modelListUrl must use HTTP or HTTPS.");
  }

  const telegramApiBaseUrl = new URL(
    parsed.telegramApiBaseUrl ?? "https://api.telegram.org",
  );
  if (telegramApiBaseUrl.protocol !== "https:" && telegramApiBaseUrl.hostname !== "127.0.0.1") {
    throw new Error("Telegram API must use HTTPS unless it points to localhost.");
  }

  return {
    defaultWorkspace: path.resolve(parsed.defaultWorkspace),
    allowedCwdRoots: Array.isArray(parsed.allowedCwdRoots)
      ? parsed.allowedCwdRoots.map((p: string) => path.resolve(p))
      : [path.resolve(parsed.defaultWorkspace)],
    modelListUrl: modelListUrl.toString().replace(/\/$/, ""),
    telegramApiBaseUrl: telegramApiBaseUrl.toString().replace(/\/$/, ""),
    maxImageBytes: Math.min(
      parsed.maxImageBytes ?? 20 * 1024 * 1024,
      20 * 1024 * 1024,
    ),
    pollTimeoutSeconds: Math.max(
      10,
      Math.min(parsed.pollTimeoutSeconds ?? 50, 50),
    ),
  };
}

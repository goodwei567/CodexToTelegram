import { loadConfig } from "./config.js";
import { CodexRpc } from "./codex-rpc.js";
import { Bridge } from "./bridge.js";
import { loadState } from "./state.js";
import { TelegramApi } from "./telegram-api.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";



// Global error handler
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`Unhandled promise rejection: ${message}`);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
});

const logFile = path.join(process.cwd(), ".runtime", "bridge.log");

async function initLog(): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(message);
  writeFile(logFile, line, { flag: "a" }).catch(() => {});
}

async function startWithRetry(maxAttempts = 3): Promise<void> {
  await initLog();
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await main();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown startup error.";
      log(`Startup failed (attempt ${attempt}/${maxAttempts}): ${message}`);
      
      if (attempt < maxAttempts) {
        const delay = Math.min(2000 * attempt, 10000);
        log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        log("All startup attempts failed. Exiting.");
        process.exitCode = 1;
      }
    }
  }
}
async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN. Save it with scripts/save-token.ps1, then run scripts/start.ps1.",
    );
  }

  const config = await loadConfig();
  const state = await loadState();
  const telegram = new TelegramApi(token, config.telegramApiBaseUrl);
  let bot: { id: number; username?: string } | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      bot = await telegram.call<{ id: number; username?: string }>("getMe");
      break;
    } catch (error) {
      if (i === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (!bot) throw new Error("Failed to connect to Telegram");
  const webhook = await telegram.call<{ url?: string }>("getWebhookInfo");
  if (webhook.url) {
    throw new Error(
      "This bot token currently has a webhook. Remove that webhook before using this long-polling Bridge.",
    );
  }

  const codex = new CodexRpc();
  await codex.connect();
  const bridge = new Bridge(config, state, telegram, codex);

  log(`Telegram bot connected: @${bot.username ?? bot.id}`);
  log("Codex app-server connected through the existing local daemon.");
  if (bridge.pairingCodeForConsole()) {
    log(`One-time Telegram pairing code (expires in 20 minutes): ${bridge.pairingCodeForConsole()}`);
  } else {
    log("Telegram account pairing is already configured.");
  }

  await bridge.start();
  const shutdown = (): void => {
    log("Stopping Codex Telegram Bridge.");
    bridge.stop();
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startWithRetry().catch(() => {
  // Error already logged
});

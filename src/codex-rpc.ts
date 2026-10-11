import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { RpcMessage } from "./types.js";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface DaemonStatus {
  status?: string;
  pid?: number;
  failure?: unknown;
}

// The daemon CLI prints human-readable lines first and one JSON status line last.
function parseDaemonStatus(output: string): DaemonStatus | null {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{"))
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as DaemonStatus;
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private incoming = Buffer.alloc(0);
  private upgraded = false;
  private expectedAccept = "";
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private fragmentOpcode = 0;
  private fragments: Buffer[] = [];
  private closed = false;

  async connect(): Promise<void> {
    if (this.child && !this.closed) return;
    this.closed = false;
    this.upgraded = false;
    this.incoming = Buffer.alloc(0);
    this.fragmentOpcode = 0;
    this.fragments = [];
    const executable = this.findCodexExecutable();
    this.ensureCodexDaemon(executable);
    const childEnv = { ...process.env };
    delete childEnv.TELEGRAM_BOT_TOKEN;
    delete childEnv.TELEGRAM_API_BASE_URL;
    delete childEnv.CODEX_MODEL_LIST_URL;

    this.child = spawn(executable, ["app-server", "proxy"], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let resolveUpgrade!: () => void;
    let rejectUpgrade!: (error: Error) => void;
    const upgrade = new Promise<void>((resolve, reject) => {
      resolveUpgrade = resolve;
      rejectUpgrade = reject;
    });
    const onUpgraded = (): void => resolveUpgrade();
    const onConnectionError = (error: Error): void => rejectUpgrade(error);
    this.once("upgraded", onUpgraded);
    this.once("connectionError", onConnectionError);
    const timeout = setTimeout(() => {
      this.child?.kill();
      rejectUpgrade(new Error("Codex daemon connection timed out."));
    }, 15_000);

    this.child.on("error", (error) => {
      this.rejectPending(error);
      this.emit("connectionError", new Error(`Could not start Codex CLI: ${error.message}`));
    });
    this.child.on("close", (code) => {
      this.closed = true;
      this.rejectPending(new Error(`Codex app-server proxy exited (${code ?? "unknown"}).`));
      if (!this.upgraded) {
        this.emit(
          "connectionError",
          new Error(`Codex app-server proxy exited before connecting (${code ?? "unknown"}).`),
        );
      }
      this.emit("closed", code);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.error(`[codex] ${message}`);
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));

    const key = randomBytes(16).toString("base64");
    this.expectedAccept = createHash("sha1")
      .update(`${key}${websocketGuid}`)
      .digest("base64");
    this.child.stdin.write(
      [
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "Origin: http://localhost",
        "",
        "",
      ].join("\r\n"),
    );

    try {
      await upgrade;
      clearTimeout(timeout);
      this.off("upgraded", onUpgraded);
      this.off("connectionError", onConnectionError);
      await this.request("initialize", {
        clientInfo: {
          name: "codex-telegram-bridge",
          title: "Codex Telegram Bridge",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.notify("initialized");
      this.emit("ready");
    } catch (error) {
      clearTimeout(timeout);
      this.off("upgraded", onUpgraded);
      this.off("connectionError", onConnectionError);
      this.child.kill();
      throw error;
    }
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<T> {
    if (!this.child || this.closed || !this.upgraded) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }
    const id = this.nextId++;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Codex ${method} request timed out.`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.writeJson({ id, method, params });
    });
  }

  notify(method: string): void {
    this.writeJson({ method });
  }

  respondToServerRequest(id: string | number, result: unknown): void {
    this.writeJson({ id, result });
  }

  rejectServerRequest(id: string | number, message: string): void {
    this.writeJson({ id, error: { code: -32601, message } });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.writeFrame(0x8, Buffer.from([0x03, 0xe8]));
      this.child?.stdin.end();
    } catch {
      this.child?.kill();
    }
    setTimeout(() => this.child?.kill(), 2_000).unref();
  }

  private findCodexExecutable(): string {
    const configured = process.env.CODEX_EXECUTABLE;
    if (configured) return configured;
    try {
      const paths = execFileSync("where.exe", ["codex"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const executable = paths.find((value) => /\.exe$/i.test(value));
      if (executable) return executable;
    } catch {
      // Fall back to checking PATH directly if where.exe is unavailable.
    }
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(directory, executableName);
      if (existsSync(candidate)) return candidate;
    }
    if (process.platform === "win32") {
      const userProfile = process.env.USERPROFILE;
      if (userProfile) {
        const daemonExecutable = path.join(
          userProfile,
          ".codex",
          "packages",
          "app-server-daemon",
          "current",
          "bin",
          "codex.exe",
        );
        if (existsSync(daemonExecutable)) return daemonExecutable;
      }

      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        const codexBin = path.join(localAppData, "OpenAI", "Codex", "bin");
        try {
          const managedExecutables = readdirSync(codexBin, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".staging-"))
            .map((entry) => {
              const executable = path.join(codexBin, entry.name, "codex.exe");
              return existsSync(executable)
                ? { executable, modifiedAt: statSync(executable).mtimeMs }
                : undefined;
            })
            .filter((entry): entry is { executable: string; modifiedAt: number } => entry !== undefined)
            .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
          if (managedExecutables) return managedExecutables.executable;
        } catch {
          // The managed install directory may not exist on every Windows machine.
        }
      }
    }
    throw new Error(
      `Could not locate ${executableName}. Add Codex CLI to PATH or set CODEX_EXECUTABLE.`,
    );
  }

  private ensureCodexDaemon(executable: string): void {
    if (process.platform !== "win32") return;
    if (this.probeCodexDaemon(executable)) return;

    let startError: unknown;
    try {
      const output = execFileSync(executable, ["app-server", "daemon", "start"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true,
      });
      const status = parseDaemonStatus(output);
      if (status) {
        if (status.pid && status.status !== "alreadyRunning") {
          console.log(`Codex app-server daemon is ready (PID ${status.pid}).`);
        }
        return;
      }
      startError = new Error("Codex daemon start returned no status.");
    } catch (error) {
      startError = error;
    }

    // On a cold boot, the desktop app and this script can race to start the
    // daemon; the losing side sees a transient error while the winner holds
    // the startup lock. Give the winner a moment, then re-check.
    for (let attempt = 0; attempt < 4; attempt++) {
      sleepSync(1_500 * (attempt + 1));
      if (this.probeCodexDaemon(executable)) return;
    }

    const detail =
      startError instanceof Error ? startError.message : String(startError ?? "unknown error");
    throw new Error(`Could not start the Codex app-server daemon: ${detail}`);
  }

  private probeCodexDaemon(executable: string): boolean {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const output = execFileSync(executable, ["app-server", "daemon", "version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
          windowsHide: true,
        });
        const status = parseDaemonStatus(output);
        if (status?.status === "running") return true;
      } catch {
        // The daemon is not reachable yet; retry below.
      }
      if (attempt < 2) {
        sleepSync(500);
      }
    }
    return false;
  }

  private onStdout(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    if (!this.upgraded) {
      const headerEnd = this.incoming.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.incoming.subarray(0, headerEnd).toString("latin1");
      this.incoming = this.incoming.subarray(headerEnd + 4);
      const accept = headerText.match(/\r\nsec-websocket-accept:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (!headerText.startsWith("HTTP/1.1 101") || accept !== this.expectedAccept) {
        this.emit("connectionError", new Error("Codex daemon rejected the local WebSocket connection."));
        this.child?.kill();
        return;
      }
      this.upgraded = true;
      this.emit("upgraded");
    }
    this.readFrames();
  }

  private readFrames(): void {
    while (this.incoming.length >= 2) {
      const first = this.incoming[0]!;
      const second = this.incoming[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.incoming.length < 4) return;
        length = this.incoming.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.incoming.length < 10) return;
        const largeLength = this.incoming.readBigUInt64BE(2);
        if (largeLength > 64n * 1024n * 1024n) {
          this.child?.kill();
          this.emit("connectionError", new Error("Codex sent an oversized WebSocket frame."));
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.incoming.length < offset + length) return;

      const mask = masked ? this.incoming.subarray(maskOffset, maskOffset + 4) : undefined;
      const payload = Buffer.from(this.incoming.subarray(offset, offset + length));
      this.incoming = this.incoming.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }

      if (opcode === 0x9) {
        this.writeFrame(0x0a, payload);
        continue;
      }
      if (opcode === 0x8) {
        this.child?.stdin.end();
        continue;
      }
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragments);
          const originalOpcode = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          if (originalOpcode === 0x1 || originalOpcode === 0x2) {
            this.onJsonPayload(message);
          }
        }
        continue;
      }
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) this.onJsonPayload(payload);
    }
  }

  private onJsonPayload(payload: Buffer): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(payload.toString("utf8")) as RpcMessage;
    } catch {
      this.emit("protocolError", new Error("Codex sent an invalid JSON-RPC message."));
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  private writeJson(value: unknown): void {
    this.writeFrame(0x1, Buffer.from(JSON.stringify(value)));
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return;
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0xfe;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const maskedPayload = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index++) {
      maskedPayload[index] = payload[index]! ^ mask[index % 4]!;
    }
    child.stdin.write(Buffer.concat([header, mask, maskedPayload]));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

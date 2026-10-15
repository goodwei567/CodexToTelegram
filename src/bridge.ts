import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { CodexRpc } from "./codex-rpc.js";
import { splitMathSegments } from "./latex.js";
import { renderReplyImages } from "./render.js";
import { getRuntimeDirectory, saveState } from "./state.js";
import { TelegramApi } from "./telegram-api.js";
import type {
  BridgeState,
  CodexThread,
  ConversationRecord,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  PermissionMode,
  RpcMessage,
  TelegramCallbackQuery,
  TelegramFile,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
} from "./types.js";

interface ConversationContext {
  chatId: number;
  topicId: number;
}

interface BotAction {
  kind:
    | "openThread"
    | "historyPage"
    | "searchPage"
    | "model"
    | "modelPage"
    | "permission"
    | "permissionApproval"
    | "confirmFullAccess"
    | "approval"
    | "userInputOption"
    | "userInputOther"
    | "dismiss"
    | "changeCwd"
    | "setEffort";
  context: ConversationContext;
  threadId?: string;
  cwd?: string;
  effort?: string;
  cursor?: string;
  searchTerm?: string;
  model?: string;
  page?: number;
  mode?: PermissionMode;
  serverRequestId?: string | number;
  serverRequestMethod?: string;
  decision?: string;
  permissionGrant?: unknown;
  inputQuestionIndex?: number;
  inputValue?: string;
}

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  context: ConversationContext;
  conversationKey: string;
  statusMessageId?: number;
  output: string;
  lastEditAt: number;
  lastActivityAt: number;
  editTimer?: NodeJS.Timeout;
  watchdogTimer?: NodeJS.Timeout;
  queuedInputs: Array<Array<Record<string, unknown>>>;
}

interface InputFlow {
  startedAt: number;
  requestId: string | number;
  context: ConversationContext;
  conversationKey: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description: string }> | null;
  }>;
  answers: Record<string, { answers: string[] }>;
  index: number;
}

interface ProxyModel {
  id: string;
  name?: string;
}

interface ExtractedAttachment {
  fileId: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  isImage: boolean;
}

const BITMAP_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function isBitmapImage(fileName: string, mimeType?: string): boolean {
  if (mimeType) {
    const lower = mimeType.toLowerCase();
    if (lower.startsWith("image/") && !lower.includes("svg")) return true;
  }
  const ext = path.extname(fileName).toLowerCase();
  return BITMAP_IMAGE_EXTS.has(ext);
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PAGE_SIZE = 8;
const TELEGRAM_TEXT_LIMIT = 3_800;
const TURN_SILENCE_MS = 8 * 60_000;

// Older conversations persisted the auto-routing group models. Those routes
// can silently bill another account, so they are rewritten to the direct
// upstream model on resume.
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "group/auto-deepseek-v4-1-flash": "qwen-cn/deepseek-v4.1-flash",
};

function isStaleTurnError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /expectedTurnId|no (?:active|such) turn|turn (?:not found|no longer exists|has already (?:completed|finished|ended)|is not active)/i.test(
    text,
  );
}
const ACTION_TTL_MS = 15 * 60 * 1000;

export class Bridge {
  private readonly actions = new Map<string, { action: BotAction; expiresAt: number }>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly inputFlows = new Map<string, InputFlow>();
  private readonly loadedThreads = new Set<string>();
  private readonly attachmentsDir = path.join(getRuntimeDirectory(), "attachments");
  private readonly pairingCode: string;
  private readonly pairingExpiresAt: number;
  private stopping = false;
  private reconnecting = false;
  private modelCache: { expiresAt: number; models: ProxyModel[] } | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly state: BridgeState,
    private readonly telegram: TelegramApi,
    private readonly codex: CodexRpc,
  ) {
    this.pairingCode = randomBytes(12).toString("base64url");
    // Clean up expired input flows every 5 minutes
    setInterval(() => {
      const now = Date.now();
      const FLOW_TIMEOUT = 20 * 60 * 1000; // 20 minutes
      for (const [key, flow] of this.inputFlows) {
        if (now - flow.startedAt > FLOW_TIMEOUT) {
          this.inputFlows.delete(key);
        }
      }
    }, 5 * 60 * 1000);

    this.pairingExpiresAt = Date.now() + 20 * 60 * 1000;
    this.codex.on("notification", (message: RpcMessage) => {
      this.onCodexNotification(message).catch((error) => {
        console.error(`Codex notification handler failed: ${this.errorText(error)}`);
      });
    });
    this.codex.on("serverRequest", (message: RpcMessage) => {
      this.onCodexServerRequest(message).catch((error) => {
        console.error(`Codex server request handler failed: ${this.errorText(error)}`);
        if (message.id !== undefined) {
          this.codex.rejectServerRequest(message.id, "Internal Bridge error.");
        }
      });
    });
    this.codex.on("closed", () => {
      console.error("Codex app-server connection closed.");
      if (!this.stopping) {
        this.reconnectCodex().catch((error) => {
          console.error(`Codex reconnection failed: ${this.errorText(error)}`);
        });
      }
    });
  }

  pairingCodeForConsole(): string | null {
    return this.state.pairedUserId === null ? this.pairingCode : null;
  }

  async start(): Promise<void> {
    await mkdir(this.attachmentsDir, { recursive: true });
    await this.registerCommands();
    await this.resumeSavedThreads();
    this.pollUpdates().catch((error) => {
      console.error(`Telegram polling failed fatally: ${this.errorText(error)}`);
    });
  }

  stop(): void {
    this.stopping = true;
    for (const turn of this.activeTurns.values()) {
      if (turn.editTimer) clearTimeout(turn.editTimer);
      if (turn.watchdogTimer) clearTimeout(turn.watchdogTimer);
    }
    this.codex.close();
  }

  private async resumeSavedThreads(): Promise<void> {
    const unique = new Map<string, ConversationRecord>();
    for (const conversation of Object.values(this.state.conversations)) {
      unique.set(conversation.threadId, conversation);
    }
    for (const [threadId, conversation] of unique) {
      try {
        const result = await this.codex.request<Record<string, unknown>>(
          "thread/resume",
          { threadId, excludeTurns: true },
        );
        this.loadedThreads.add(threadId);
        if (typeof result.cwd === "string") conversation.cwd = result.cwd;
        await this.reconcileThreadModel(conversation, result.model);
        const mode = this.permissionModeFromSandbox(result.sandbox);
        if (mode) conversation.permissionMode = mode;
      } catch (error) {
        console.warn(
          `Could not resume saved Codex thread ${threadId}: ${this.errorText(error)}`,
        );
        if (/no rollout found/i.test(this.errorText(error))) {
          try {
            const replacement = await this.startThread(
              conversation.cwd || this.config.defaultWorkspace,
            );
            for (const [key, record] of Object.entries(this.state.conversations)) {
              if (record.threadId === threadId) this.state.conversations[key] = replacement;
            }
            this.loadedThreads.add(replacement.threadId);
            console.warn(
              `Replaced unavailable Codex thread ${threadId} with ${replacement.threadId}.`,
            );
          } catch (replacementError) {
            console.warn(
              `Could not replace unavailable Codex thread ${threadId}: ${this.errorText(replacementError)}`,
            );
          }
        }
      }
    }
    await saveState(this.state);
  }

  private async reconnectCodex(): Promise<void> {
    if (this.reconnecting || this.stopping) return;
    this.reconnecting = true;

    const interrupted = [...this.activeTurns.values()];
    this.activeTurns.clear();
    for (const turn of interrupted) {
      if (turn.editTimer) clearTimeout(turn.editTimer);
      if (turn.watchdogTimer) clearTimeout(turn.watchdogTimer);
      await this.replaceProgressMessage(
        turn,
        "与本机 Codex 的连接中断了。连接恢复后可在此 Topic 继续发送消息。",
      );
    }

    let delayMs = 2_000;
    try {
      while (!this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          await this.codex.connect();
          this.loadedThreads.clear();
          await this.resumeSavedThreads();
          console.log("Codex app-server connection restored.");
          return;
        } catch (error) {
          console.error(`Codex reconnect failed: ${this.errorText(error)}`);
          delayMs = Math.min(delayMs * 2, 30_000);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private async pollUpdates(): Promise<void> {
    while (!this.stopping) {
      try {
        const updates = await this.telegram.getUpdates(
          this.state.lastUpdateId + 1,
          this.config.pollTimeoutSeconds,
        );
        for (const update of updates) {
          try {
            if (update.message) await this.onMessage(update.message);
            if (update.callback_query) {
              await this.onCallbackQuery(update.callback_query);
            }
          } catch (error) {
            console.error(`Telegram update ${update.update_id} failed: ${this.errorText(error)}`);
            const message = update.message;
            if (message?.chat.type === "private" && message.from) {
              await this.safeSend(
                this.contextFor(message),
                `处理失败：${this.errorText(error)}`,
              );
            }
          } finally {
            this.state.lastUpdateId = update.update_id;
            await saveState(this.state);
          }
        }
      } catch (error) {
        if (this.stopping) return;
        console.error(`Telegram polling failed: ${this.errorText(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private async onMessage(message: TelegramMessage): Promise<void> {
    if (message.chat.type !== "private" || !message.from || message.from.is_bot) return;
    const context = this.contextFor(message);
    const text = message.text ?? message.caption ?? "";

    if (this.state.pairedUserId === null) {
      await this.tryPair(message, text, context);
      return;
    }
    if (message.from.id !== this.state.pairedUserId) return;

    const conversationKey = this.conversationKey(context);
    
    // Check for commands first, before input flow handling
    const command = message.text ? this.parseCommand(message.text) : null;
    if (command) {
      await this.handleCommand(command.name, command.argument, context);
      return;
    }

    const pendingFlow = this.inputFlows.get(conversationKey);
    if (pendingFlow) {
      if (text.trim()) await this.acceptFreeformInput(pendingFlow, text.trim());
      else await this.send(context, "请用文字回答 Codex 的问题。");
      return;
    }

    

    const attachment = this.extractAttachment(message);
    if (!text.trim() && !attachment) return;
    const conversation = await this.ensureConversation(context);
    let filePath: string | undefined;
    if (attachment) {
      try {
        filePath = await this.downloadAttachment(attachment);
      } catch (error) {
        await this.send(context, `文件接收失败：${this.errorText(error)}`);
        return;
      }
    }

    const input: Array<Record<string, unknown>> = [];
    if (attachment?.isImage && filePath) {
      input.push({ type: "localImage", path: filePath });
      const prompt = text.trim() || "请查看这张图片并说明内容。";
      input.unshift({ type: "text", text: prompt, text_elements: [] });
    } else if (attachment && filePath) {
      const sizeStr = formatFileSize(attachment.fileSize);
      const userPrompt = text.trim();
      let fileSnippet = "";

      const ext = path.extname(attachment.fileName).toLowerCase();
      const TEXT_EXTS = new Set([
        ".txt", ".md", ".json", ".csv", ".py", ".js", ".ts", ".jsx", ".tsx",
        ".html", ".css", ".c", ".cpp", ".h", ".hpp", ".rs", ".go", ".java",
        ".sh", ".bat", ".ps1", ".sql", ".xml", ".yaml", ".yml", ".ini", ".toml", ".log"
      ]);
      if (TEXT_EXTS.has(ext) && (attachment.fileSize ?? 0) <= 65536) {
        try {
          const content = await readFile(filePath, "utf8");
          if (content.length <= 65536) {
            const lang = ext.replace(/^\./, "");
            fileSnippet = `\n\n文件内容如下：\n\`\`\`${lang}\n${content}\n\`\`\``;
          }
        } catch {
          // Binary or encoding error, skip inline snippet
        }
      }

      const promptLines = [
        `用户上传了文件：${attachment.fileName}${sizeStr ? ` (${sizeStr})` : ""}`,
        `本地已保存至：${filePath}`,
        userPrompt ? `用户要求：${userPrompt}` : "请查看并分析该文件内容，向用户说明或提供帮助。",
      ];
      if (fileSnippet) {
        promptLines.push(fileSnippet);
      }
      input.push({ type: "text", text: promptLines.join("\n"), text_elements: [] });
    } else {
      input.push({ type: "text", text: text.trim(), text_elements: [] });
    }

    await this.startOrSteerTurn(conversationKey, context, conversation, input);
  }

  private async tryPair(
    message: TelegramMessage,
    text: string,
    context: ConversationContext,
  ): Promise<void> {
    const match = text.match(/^\/pair(?:@\w+)?\s+(\S+)\s*$/i);
    if (!match) {
      await this.send(
        context,
        "此 bot 尚未配对。请先在运行 Bridge 的电脑终端查看一次性配对码，再发送 /pair 配对码。",
      );
      return;
    }
    if (Date.now() > this.pairingExpiresAt) {
      await this.send(context, "配对码已过期。请在电脑上重启 Bridge 获取新配对码。");
      return;
    }

    const supplied = Buffer.from(match[1]!, "utf8");
    const expected = Buffer.from(this.pairingCode, "utf8");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      await this.send(context, "配对码不正确。");
      return;
    }

    this.state.pairedUserId = message.from!.id;
    await saveState(this.state);
    await this.send(
      context,
      "配对成功。这个 bot 现在只响应你的私聊账号。发送 /help 查看命令；建议启用私聊 Topics，再用 /new 为每个 Codex 会话创建独立主题。",
    );
  }

  private async handleCommand(
    name: string,
    argument: string,
    context: ConversationContext,
  ): Promise<void> {
    switch (name) {
      case "start":
      case "help":
        await this.sendHelp(context);
        return;
      case "new":
        await this.createNewConversation(context, argument);
        return;
      case "history":
      case "sessions":
        await this.showHistory(context);
        return;
      case "search":
        if (!argument) {
          await this.send(context, "用法：/search 搜索词");
          return;
        }
        await this.searchHistory(context, argument);
        return;
      case "open":
        if (!argument) {
          await this.send(context, "用法：/open 会话ID，也可以用 /history 按钮选择。");
          return;
        }
        await this.openThread(context, argument.trim());
        return;
      case "model":
        await this.showModels(context, 0);
        return;
      case "permission":
        await this.showPermissions(context);
        return;
      case "status":
        await this.showStatus(context);
        return;
      case "stop":
        await this.stopTurn(context);
        return;
      case "cwd":
        await this.handleCwdCommand(context, argument);
        return;
      case "rename":
        if (!argument) {
          await this.send(context, "用法：/rename 新名称");
          return;
        }
        await this.renameThread(context, argument);
        return;
      case "archive":
        await this.archiveThread(context);
        return;
      case "fork":
        await this.forkThread(context, argument);
        return;
      case "compact":
        await this.compactThread(context);
        return;
      case "effort":
        await this.showEffortOptions(context);
        return;

      default:
        await this.send(context, "不认识这个命令。发送 /help 查看可用命令。");
    }
  }

  private async sendHelp(context: ConversationContext): Promise<void> {
    await this.send(
      context,
      [
        "Codex Bridge 命令",
        "/new [主题名] — 新建 Codex 会话",
        "/history — 浏览最近的 Codex 会话",
        "/search 关键词 — 搜索会话历史",
        "/open 会话ID — 恢复指定会话",
        "/model — 切换代理当前可用的模型",
        "/permission — 切换当前会话权限",
        "/status — 查看当前会话、模型和权限",
        "/stop — 中断当前回合",
        "/cwd [路径] — 切换或查看工作目录",
        "/rename 名称 — 重命名当前会话",
        "/archive — 归档当前会话",
        "/fork [主题] — 分叉当前会话到新主题",
        "/compact — 压缩会话历史",
        "/effort — 设置推理强度(low/medium/high/ultra)",
        "",
        "直接发送文字、图片或文件（PDF、代码、文档等）即可交给 Codex。",
      ].join("\n"),
    );
  }

  private async createNewConversation(
    context: ConversationContext,
    requestedName: string,
  ): Promise<void> {
    const record = await this.startThread(this.config.defaultWorkspace);
    let targetContext = context;
    let topicCreated = false;
    const topicName =
      requestedName.trim().slice(0, 70) ||
      `Codex ${new Date().toLocaleString("zh-CN", { hour12: false })}`;

    try {
      const topic = await this.telegram.call<{ message_thread_id: number }>(
        "createForumTopic",
        { chat_id: context.chatId, name: topicName },
      );
      targetContext = { chatId: context.chatId, topicId: topic.message_thread_id };
      topicCreated = true;
    } catch {
      // Continue in the current private chat if private Topics are not enabled.
    }

    const key = this.conversationKey(targetContext);
    this.state.conversations[key] = record;
    this.loadedThreads.add(record.threadId);
    await saveState(this.state);
    const topicNote = topicCreated
      ? "已创建独立 Topic。"
      : "未能创建 Topic；已把当前私聊绑定到新会话。启用 BotFather 私聊 Topics 后，每个任务可各自保留上下文。";
    await this.send(
      targetContext,
      `${topicNote}\n会话：${record.threadId}\n工作目录：${record.cwd}\n权限：项目内可编辑`,
    );
  }

  private async showHistory(
    context: ConversationContext,
    cursor?: string,
  ): Promise<void> {
    const result = await this.codex.request<{
      data: CodexThread[];
      nextCursor: string | null;
    }>("thread/list", {
      limit: PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      ...(cursor ? { cursor } : {}),
    });
    await this.sendThreadPage(context, result.data, result.nextCursor, undefined);
  }

  private async searchHistory(
    context: ConversationContext,
    searchTerm: string,
    cursor?: string,
  ): Promise<void> {
    const result = await this.codex.request<{
      data: Array<{ thread: CodexThread; snippet: string }>;
      nextCursor: string | null;
    }>("thread/search", {
      searchTerm,
      limit: PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      ...(cursor ? { cursor } : {}),
    });
    await this.sendThreadPage(
      context,
      result.data.map((item) => ({
        ...item.thread,
        preview: item.snippet || item.thread.preview,
      })),
      result.nextCursor,
      searchTerm,
    );
  }

  private async sendThreadPage(
    context: ConversationContext,
    threads: CodexThread[],
    nextCursor: string | null,
    searchTerm: string | undefined,
  ): Promise<void> {
    if (threads.length === 0) {
      await this.send(context, "没有找到会话。");
      return;
    }

    const rows: InlineKeyboardButton[][] = [];
    for (const thread of threads) {
      const title = (thread.name?.trim() || thread.preview?.trim() || "未命名会话")
        .replace(/\s+/g, " ")
        .slice(0, 55);
      const timestamp = thread.updatedAt
        ? new Date(thread.updatedAt * 1000).toLocaleString("zh-CN", { hour12: false })
        : "";
      const label = timestamp ? `${title} · ${timestamp}`.slice(0, 64) : title;
      rows.push([
        {
          text: label,
          callback_data: this.addAction({
            kind: "openThread",
            context,
            threadId: thread.id,
          }),
        },
      ]);
    }
    if (nextCursor) {
      rows.push([
        {
          text: "下一页",
          callback_data: this.addAction({
            kind: searchTerm ? "searchPage" : "historyPage",
            context,
            cursor: nextCursor,
            ...(searchTerm ? { searchTerm } : {}),
          }),
        },
      ]);
    }
    await this.send(
      context,
      searchTerm ? `搜索结果：${searchTerm}` : "最近的 Codex 会话：",
      { inline_keyboard: rows },
    );
  }

  private async openThread(
    context: ConversationContext,
    threadId: string,
  ): Promise<void> {
    const result = await this.codex.request<Record<string, unknown>>(
      "thread/resume",
      { threadId, excludeTurns: true },
    );
    const thread = result.thread as CodexThread | undefined;
    if (!thread?.id) throw new Error("Codex did not return the requested session.");

    const mode =
      this.permissionModeFromSandbox(result.sandbox) ?? "workspaceWrite";
    const record: ConversationRecord = {
      threadId,
      cwd: typeof result.cwd === "string" ? result.cwd : thread.cwd,
      model: typeof result.model === "string" ? result.model : thread.model ?? undefined,
      permissionMode: mode,
    };
    this.state.conversations[this.conversationKey(context)] = record;
    this.loadedThreads.add(threadId);
    await saveState(this.state);
    await this.send(
      context,
      `已恢复会话：${thread.name?.trim() || thread.preview?.trim() || threadId}\n工作目录：${record.cwd}\n模型：${record.model ?? "使用 Codex 默认模型"}\n权限：${this.permissionLabel(mode)}`,
    );
  }

  private async showModels(context: ConversationContext, page: number): Promise<void> {
    const conversation = await this.ensureConversation(context);
    const models = (await this.getProxyModels(true)).filter(
      (model) => !model.id.startsWith("group/"),
    );
    if (models.length === 0) {
      await this.send(context, "本机代理当前没有返回可用模型。");
      return;
    }

    const pageCount = Math.ceil(models.length / PAGE_SIZE);
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const start = safePage * PAGE_SIZE;
    const rows: InlineKeyboardButton[][] = [];
    for (let index = start; index < Math.min(start + PAGE_SIZE, models.length); index++) {
      const model = models[index]!;
      const marker = model.id === conversation.model ? "✓ " : "";
      rows.push([
        {
          text: `${marker}${(model.name || model.id).slice(0, 58)}`,
          callback_data: this.addAction({
            kind: "model",
            context,
            model: model.id,
          }),
        },
      ]);
    }
    if (pageCount > 1) {
      const navigation: InlineKeyboardButton[] = [];
      if (safePage > 0) {
        navigation.push({
          text: "上一页",
          callback_data: this.addAction({
            kind: "modelPage",
            context,
            page: safePage - 1,
          }),
        });
      }
      navigation.push({
        text: `${safePage + 1}/${pageCount}`,
        callback_data: this.addAction({
          kind: "modelPage",
          context,
          page: safePage,
        }),
      });
      if (safePage < pageCount - 1) {
        navigation.push({
          text: "下一页",
          callback_data: this.addAction({
            kind: "modelPage",
            context,
            page: safePage + 1,
          }),
        });
      }
      rows.push(navigation);
    }
    await this.send(
      context,
      `当前模型：${conversation.model ?? "Codex 默认模型"}\n以下为代理中可直接调用的模型；自动路由组已隐藏，避免请求被转给其他账号。`,
      { inline_keyboard: rows },
    );
  }

  private async showPermissions(context: ConversationContext): Promise<void> {
    const conversation = await this.ensureConversation(context);
    const choices: Array<{ mode: PermissionMode; label: string }> = [
      { mode: "readOnly", label: "只读" },
      { mode: "workspaceWrite", label: "项目内可编辑" },
      { mode: "fullAccess", label: "完全访问…" },
    ];
    const rows = choices.map(({ mode, label }) => [
      {
        text: `${conversation.permissionMode === mode ? "✓ " : ""}${label}`,
        callback_data: this.addAction({ kind: "permission", context, mode }),
      },
    ]);
    await this.send(
      context,
      `当前权限：${this.permissionLabel(conversation.permissionMode)}\n选择后从下一回合生效。完全访问需要再次确认。`,
      { inline_keyboard: rows },
    );
  }

  private async showStatus(context: ConversationContext): Promise<void> {
    const conversation = await this.ensureConversation(context);
    const active = this.activeTurns.get(conversation.threadId);
    await this.send(
      context,
      [
        `会话：${conversation.threadId}`,
        `模型：${conversation.model ?? "Codex 默认模型"}`,
        `权限：${this.permissionLabel(conversation.permissionMode)}`,
        `工作目录：${conversation.cwd}`,
        `状态：${active ? "正在运行" : "空闲"}`,
      ].join("\n"),
    );
  }

  private async stopTurn(context: ConversationContext): Promise<void> {
    const conversation = this.state.conversations[this.conversationKey(context)];
    if (!conversation) {
      await this.send(context, "当前 Topic 还没有绑定 Codex 会话。");
      return;
    }
    const active = this.activeTurns.get(conversation.threadId);
    if (!active?.turnId) {
      await this.send(context, "当前没有正在运行的 Codex 回合。");
      return;
    }
    await this.codex.request("turn/interrupt", {
      threadId: conversation.threadId,
      turnId: active.turnId,
    });
    await this.send(context, "已请求中断当前回合。");
  }

  private async startOrSteerTurn(
    conversationKey: string,
    context: ConversationContext,
    conversation: ConversationRecord,
    input: Array<Record<string, unknown>>,
  ): Promise<void> {
    const active = this.activeTurns.get(conversation.threadId);
    if (active) {
      if (!active.turnId) {
        active.queuedInputs.push(input);
        await this.send(context, "已排在当前回合之后。");
        return;
      }
      try {
        await this.codex.request("turn/steer", {
          threadId: conversation.threadId,
          expectedTurnId: active.turnId,
          input,
        });
        await this.send(context, "已把补充内容交给正在运行的 Codex。");
        return;
      } catch (error) {
        if (!isStaleTurnError(error)) throw error;
        // The daemon no longer knows this turn: its completion notification
        // was lost. Clear the stale record and handle this message as a new
        // turn instead of blocking the topic forever.
        this.activeTurns.delete(conversation.threadId);
        if (active.editTimer) clearTimeout(active.editTimer);
        if (active.watchdogTimer) clearTimeout(active.watchdogTimer);
        const preview = active.output.trim().slice(0, TELEGRAM_TEXT_LIMIT - 80);
        await this.replaceProgressMessage(
          active,
          `${preview}${preview ? "\n\n" : ""}⚠️ 上一个回合实际已结束（完成通知丢失）。这条消息已作为新回合继续处理。`,
        );
      }
    }

    const status = await this.send(context, "⏳ Codex 正在处理…");
    const turn: ActiveTurn = {
      threadId: conversation.threadId,
      context,
      conversationKey,
      statusMessageId: status.message_id,
      output: "",
      lastEditAt: 0,
      lastActivityAt: Date.now(),
      queuedInputs: [],
    };
    this.activeTurns.set(conversation.threadId, turn);
    this.armTurnWatchdog(turn);
    try {
      const result = await this.codex.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId: conversation.threadId,
          input,
          ...(conversation.model ? { model: conversation.model } : {}),
        },
      );
      turn.turnId = result.turn.id;
      while (turn.queuedInputs.length > 0) {
        const queued = turn.queuedInputs.shift()!;
        await this.codex.request("turn/steer", {
          threadId: conversation.threadId,
          expectedTurnId: turn.turnId,
          input: queued,
        });
      }
    } catch (error) {
      this.activeTurns.delete(conversation.threadId);
      await this.replaceProgressMessage(
        turn,
        `Codex 无法开始这个回合：${this.errorText(error)}`,
      );
    }
  }

  private async onCodexNotification(message: RpcMessage): Promise<void> {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    if (!threadId) return;

    if (message.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      const current = this.activeTurns.get(threadId);
      if (current && turn?.id) current.turnId = turn.id;
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const current = this.activeTurns.get(threadId);
      if (!current || typeof params.delta !== "string") return;
      if (current.turnId && params.turnId !== current.turnId) return;
      current.output += params.delta;
      current.lastActivityAt = Date.now();
      this.scheduleProgressEdit(current);
      return;
    }

    if (message.method === "turn/completed") {
      const current = this.activeTurns.get(threadId);
      const completedTurn = params.turn as {
        id?: string;
        status?: string;
        error?: { message?: string } | null;
      } | undefined;
      if (!current || !completedTurn) return;
      if (current.turnId && completedTurn.id !== current.turnId) return;
      this.activeTurns.delete(threadId);
      if (current.editTimer) clearTimeout(current.editTimer);
      if (current.watchdogTimer) clearTimeout(current.watchdogTimer);

      let response = current.output.trim();
      if (completedTurn.status === "failed") {
        const failure = completedTurn.error?.message || "Codex 回合失败。";
        response = response ? `${response}\n\n${failure}` : failure;
      } else if (completedTurn.status === "interrupted" && !response) {
        response = "Codex 回合已中断。";
      }
      if (!response) response = "Codex 已完成，但没有返回文字内容。";
      await this.finishTurnMessage(current, response);
      return;
    }
  }

  private async onCodexServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined || !message.method) return;
    const params = message.params ?? {};
    const threadId =
      typeof params.threadId === "string"
        ? params.threadId
        : typeof params.conversationId === "string"
          ? params.conversationId
          : "";
    const entry = Object.entries(this.state.conversations).find(
      ([, conversation]) => conversation.threadId === threadId,
    );
    if (!entry) {
      if (message.method === "item/permissions/requestApproval") {
        this.codex.respondToServerRequest(message.id, {
          permissions: {},
          scope: "turn",
        });
      } else if (message.method === "item/tool/requestUserInput") {
        this.codex.respondToServerRequest(message.id, { answers: {} });
      } else if (message.method === "mcpServer/elicitation/request") {
        this.codex.respondToServerRequest(message.id, {
          action: "cancel",
          content: null,
          _meta: null,
        });
      } else {
        this.codex.respondToServerRequest(
          message.id,
          this.approvalResult(message.method, "decline"),
        );
      }
      return;
    }
    const context = this.contextFromKey(entry[0]);

    if (message.method === "item/permissions/requestApproval") {
      const requested =
        params.permissions && typeof params.permissions === "object"
          ? (params.permissions as Record<string, unknown>)
          : {};
      await this.send(
        context,
        `Codex 请求临时扩展权限：\n${JSON.stringify(requested, null, 2).slice(0, 1_600)}`,
        {
          inline_keyboard: [
            [
              {
                text: "仅本回合允许",
                callback_data: this.addAction({
                  kind: "permissionApproval",
                  context,
                  serverRequestId: message.id,
                  permissionGrant: requested,
                  decision: "accept",
                }),
              },
              {
                text: "拒绝",
                callback_data: this.addAction({
                  kind: "permissionApproval",
                  context,
                  serverRequestId: message.id,
                  decision: "decline",
                }),
              },
            ],
          ],
        },
      );
      return;
    }

    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval" ||
      message.method === "applyPatchApproval" ||
      message.method === "execCommandApproval"
    ) {
      const command =
        typeof params.command === "string"
          ? params.command.slice(0, 1_000)
          : Array.isArray(params.command)
            ? params.command
                .filter((part): part is string => typeof part === "string")
                .join(" ")
                .slice(0, 1_000)
          : typeof params.reason === "string"
            ? params.reason.slice(0, 1_000)
            : "Codex 请求执行一项需要批准的操作。";
      const rows: InlineKeyboardButton[][] = [
        [
          {
            text: "允许一次",
            callback_data: this.addAction({
              kind: "approval",
              context,
              serverRequestId: message.id,
              serverRequestMethod: message.method,
              decision: "accept",
            }),
          },
          {
            text: "拒绝",
            callback_data: this.addAction({
              kind: "approval",
              context,
              serverRequestId: message.id,
              serverRequestMethod: message.method,
              decision: "decline",
            }),
          },
        ],
      ];
      await this.send(
        context,
        `Codex 请求批准：\n${command}`,
        { inline_keyboard: rows },
      );
      return;
    }

    if (message.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions)
        ? (params.questions as InputFlow["questions"])
        : [];
      if (questions.length === 0) {
        this.codex.respondToServerRequest(message.id, { answers: {} });
        return;
      }
      const flow: InputFlow = {
        requestId: message.id,
        context,
        conversationKey: entry[0],
        questions,
        answers: {},
        index: 0,
        startedAt: Date.now(),
      };
      this.inputFlows.set(entry[0], flow);
      await this.presentInputQuestion(flow);
      return;
    }

    if (message.method === "mcpServer/elicitation/request") {
      this.codex.respondToServerRequest(message.id, {
        action: "cancel",
        content: null,
        _meta: null,
      });
      await this.send(
        context,
        "Codex 的外部工具请求了额外输入；Bridge 暂不支持该类表单，已取消此请求。",
      );
      return;
    }

    if (message.method === "currentTime/read") {
      this.codex.respondToServerRequest(message.id, {
        currentTimeAt: Math.floor(Date.now() / 1000),
      });
      return;
    }

    this.codex.rejectServerRequest(message.id, "This Telegram Bridge does not support this server request.");
  }

  private async presentInputQuestion(flow: InputFlow): Promise<void> {
    const question = flow.questions[flow.index];
    if (!question) {
      this.inputFlows.delete(flow.conversationKey);
      this.codex.respondToServerRequest(flow.requestId, {
        answers: flow.answers,
      });
      await this.send(flow.context, "已把你的回答交给 Codex。");
      return;
    }
    const heading = question.header ? `${question.header}\n` : "";
    const text = `${heading}${question.question}${question.isSecret ? "\n（回答会作为私聊内容发送给 Codex。）" : ""}`;
    const options = question.options ?? [];
    if (options.length === 0) {
      await this.send(flow.context, `${text}\n请直接回复文字。`);
      return;
    }

    const rows: InlineKeyboardButton[][] = [];
    for (const option of options.slice(0, 8)) {
      rows.push([
        {
          text: option.label.slice(0, 60),
          callback_data: this.addAction({
            kind: "userInputOption",
            context: flow.context,
            serverRequestId: flow.requestId,
            inputQuestionIndex: flow.index,
            inputValue: option.label,
          }),
        },
      ]);
    }
    if (question.isOther) {
      rows.push([
        {
          text: "其他：输入文字",
          callback_data: this.addAction({
            kind: "userInputOther",
            context: flow.context,
            serverRequestId: flow.requestId,
            inputQuestionIndex: flow.index,
          }),
        },
      ]);
    }
    await this.send(flow.context, text, { inline_keyboard: rows });
  }

  private async acceptFreeformInput(
    flow: InputFlow,
    answer: string,
  ): Promise<void> {
    const question = flow.questions[flow.index];
    if (!question) return;
    flow.answers[question.id] = { answers: [answer] };
    flow.index++;
    await this.presentInputQuestion(flow);
  }

  private async onCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const context = query.message
      ? this.contextFor(query.message)
      : { chatId: 0, topicId: 0 };
    const token = query.data?.match(/^a:([A-Za-z0-9_-]+)$/)?.[1];
    const stored = token ? this.actions.get(token) : undefined;
    if (token) this.actions.delete(token);

    if (
      this.state.pairedUserId === null ||
      query.from.id !== this.state.pairedUserId ||
      !stored ||
      stored.expiresAt < Date.now()
    ) {
      await this.telegram.answerCallbackQuery(query.id, "此按钮已失效。");
      return;
    }
    await this.telegram.answerCallbackQuery(query.id);
    await this.runAction(stored.action);
  }

  private async runAction(action: BotAction): Promise<void> {
    switch (action.kind) {
      case "openThread":
        if (action.threadId) await this.openThread(action.context, action.threadId);
        return;
      case "historyPage":
        await this.showHistory(action.context, action.cursor);
        return;
      case "searchPage":
        if (action.searchTerm) {
          await this.searchHistory(action.context, action.searchTerm, action.cursor);
        }
        return;
      case "model":
        if (action.model) await this.applyModel(action.context, action.model);
        return;
      case "modelPage":
        await this.showModels(action.context, action.page ?? 0);
        return;
      case "permission":
        if (action.mode === "fullAccess") {
          await this.confirmFullAccess(action.context);
        } else if (action.mode) {
          await this.applyPermission(action.context, action.mode);
        }
        return;
      case "confirmFullAccess":
        await this.applyPermission(action.context, "fullAccess");
        return;
      case "dismiss":
        return;
        case "changeCwd":
          if (action.cwd) await this.changeCwd(action.context, action.cwd);
          return;
        case "setEffort":
          if (action.effort) await this.setEffort(action.context, action.effort);
          return;

      case "permissionApproval":
        if (action.serverRequestId !== undefined) {
          const accepted = action.decision === "accept";
          this.codex.respondToServerRequest(action.serverRequestId, {
            permissions: accepted ? action.permissionGrant ?? {} : {},
            scope: "turn",
          });
          await this.send(
            action.context,
            accepted
              ? "已按本回合授权该项临时权限。"
              : "已拒绝这项临时权限。",
          );
        }
        return;
      case "approval":
        if (action.serverRequestId !== undefined) {
          const result = this.approvalResult(
            action.serverRequestMethod ?? "",
            action.decision ?? "decline",
          );
          this.codex.respondToServerRequest(action.serverRequestId, result);
          await this.send(
            action.context,
            action.decision === "accept"
              ? "已允许这一次操作。"
              : "已拒绝这次操作。",
          );
        }
        return;
      case "userInputOption":
      case "userInputOther": {
        const flow = this.inputFlows.get(this.conversationKey(action.context));
        if (
          !flow ||
          String(flow.requestId) !== String(action.serverRequestId) ||
          flow.index !== action.inputQuestionIndex
        ) {
          await this.send(action.context, "这个问题已经失效。");
          return;
        }
        if (action.kind === "userInputOther") {
          await this.send(action.context, "请直接回复你的答案。");
          return;
        }
        const question = flow.questions[flow.index];
        if (question && action.inputValue) {
          flow.answers[question.id] = { answers: [action.inputValue] };
          flow.index++;
          await this.presentInputQuestion(flow);
        }
      }
    }
  }

  private async confirmFullAccess(context: ConversationContext): Promise<void> {
    await this.send(context, "完全访问会取消项目沙箱限制。确认只对当前 Codex 会话启用？", {
      inline_keyboard: [
        [
          {
            text: "确认完全访问",
            callback_data: this.addAction({ kind: "confirmFullAccess", context }),
          },
          {
            text: "取消",
            callback_data: this.addAction({ kind: "dismiss", context }),
          },
        ],
      ],
    });
  }

  private async applyPermission(
    context: ConversationContext,
    mode: PermissionMode,
  ): Promise<void> {
    const conversation = await this.ensureConversation(context);
    const sandboxPolicy =
      mode === "readOnly"
        ? { type: "readOnly", networkAccess: false }
        : mode === "fullAccess"
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: [conversation.cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            };
    await this.codex.request("thread/settings/update", {
      threadId: conversation.threadId,
      sandboxPolicy,
      approvalPolicy: "on-request",
    });
    conversation.permissionMode = mode;
    await saveState(this.state);
    await this.send(context, `权限已切换为：${this.permissionLabel(mode)}。`);
  }

  private async applyModel(context: ConversationContext, model: string): Promise<void> {
    const models = await this.getProxyModels(true);
    if (!models.some((candidate) => candidate.id === model)) {
      await this.send(context, "这个模型已不在代理的当前可用清单中。");
      return;
    }
    const conversation = await this.ensureConversation(context);
    await this.codex.request("thread/settings/update", {
      threadId: conversation.threadId,
      model,
    });
    conversation.model = model;
    await saveState(this.state);
    await this.send(context, `本会话后续回合将使用：${model}`);
  }

  private async getProxyModels(refresh = false): Promise<ProxyModel[]> {
    if (!refresh && this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return this.modelCache.models;
    }
    let response: Response;
    try {
      response = await fetch(this.config.modelListUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new Error("无法连接本机模型代理的模型清单。");
    }
    if (!response.ok) throw new Error(`模型代理返回 HTTP ${response.status}。`);
    const payload = (await response.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
    };
    const seen = new Set<string>();
    const models = (payload.data ?? [])
      .filter(
        (item): item is { id: string; name?: string } =>
          typeof item.id === "string" && item.id.length > 0,
      )
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .map((item) => ({
        id: item.id,
        ...(typeof item.name === "string" ? { name: item.name } : {}),
      }));
    this.modelCache = { expiresAt: Date.now() + 30_000, models };
    return models;
  }

  private async ensureConversation(
    context: ConversationContext,
  ): Promise<ConversationRecord> {
    const key = this.conversationKey(context);
    const existing = this.state.conversations[key];
    if (existing) {
      if (!this.loadedThreads.has(existing.threadId)) {
        await this.resumeConversation(existing);
      }
      return existing;
    }
    const conversation = await this.startThread(this.config.defaultWorkspace);
    this.state.conversations[key] = conversation;
    this.loadedThreads.add(conversation.threadId);
    await saveState(this.state);
    return conversation;
  }

  private async resumeConversation(conversation: ConversationRecord): Promise<void> {
    try {
      const result = await this.codex.request<Record<string, unknown>>(
        "thread/resume",
        { threadId: conversation.threadId, excludeTurns: true },
      );
      this.loadedThreads.add(conversation.threadId);
      if (typeof result.cwd === "string") conversation.cwd = result.cwd;
      await this.reconcileThreadModel(conversation, result.model);
      const mode = this.permissionModeFromSandbox(result.sandbox);
      if (mode) conversation.permissionMode = mode;
      await saveState(this.state);
    } catch (error) {
      if (!/no rollout found/i.test(this.errorText(error))) throw error;
      const replacement = await this.startThread(
        conversation.cwd || this.config.defaultWorkspace,
      );
      Object.assign(conversation, replacement);
      this.loadedThreads.add(replacement.threadId);
      await saveState(this.state);
      console.warn(
        `Codex thread ${replacement.threadId} replaced an unavailable session.`,
      );
    }
  }

  private async reconcileThreadModel(
    conversation: ConversationRecord,
    threadModel: unknown,
  ): Promise<void> {
    if (typeof threadModel === "string" && threadModel && !conversation.model) {
      conversation.model = threadModel;
    }
    const desired = conversation.model
      ? LEGACY_MODEL_ALIASES[conversation.model] ?? conversation.model
      : undefined;
    if (!desired) return;
    conversation.model = desired;
    if (desired === threadModel) return;
    // Keep the daemon-side thread model in sync with the stored choice so a
    // later resume cannot revert it to an older model.
    try {
      await this.codex.request("thread/settings/update", {
        threadId: conversation.threadId,
        model: desired,
      });
    } catch (error) {
      console.warn(
        `Could not restore model ${desired} on thread ${conversation.threadId}: ${this.errorText(error)}`,
      );
    }
  }

  private async startThread(cwd: string): Promise<ConversationRecord> {
    const result = await this.codex.request<{
      thread: CodexThread;
      cwd?: string;
      model?: string;
    }>("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    if (!result.thread?.id) throw new Error("Codex did not create a new session.");
    return {
      threadId: result.thread.id,
      cwd: result.cwd ?? result.thread.cwd ?? cwd,
      ...(result.model ? { model: result.model } : {}),
      permissionMode: "workspaceWrite",
    };
  }

  private extractAttachment(message: TelegramMessage): ExtractedAttachment | null {
    const photo = message.photo?.at(-1);
    if (photo) {
      return {
        fileId: photo.file_id,
        fileName: "photo.jpg",
        fileSize: photo.file_size,
        mimeType: "image/jpeg",
        isImage: true,
      };
    }
    const doc = message.document;
    if (doc) {
      const rawName = doc.file_name?.trim() || "";
      const isImage = isBitmapImage(rawName, doc.mime_type);
      return {
        fileId: doc.file_id,
        fileName: rawName || (isImage ? "image.png" : "file.bin"),
        fileSize: doc.file_size,
        mimeType: doc.mime_type,
        isImage,
      };
    }
    const audio = message.audio;
    if (audio) {
      return {
        fileId: audio.file_id,
        fileName: audio.file_name?.trim() || "audio.mp3",
        fileSize: audio.file_size,
        mimeType: audio.mime_type,
        isImage: false,
      };
    }
    const voice = message.voice;
    if (voice) {
      return {
        fileId: voice.file_id,
        fileName: "voice.ogg",
        fileSize: voice.file_size,
        mimeType: voice.mime_type ?? "audio/ogg",
        isImage: false,
      };
    }
    const video = message.video;
    if (video) {
      return {
        fileId: video.file_id,
        fileName: video.file_name?.trim() || "video.mp4",
        fileSize: video.file_size,
        mimeType: video.mime_type,
        isImage: false,
      };
    }
    const videoNote = message.video_note;
    if (videoNote) {
      return {
        fileId: videoNote.file_id,
        fileName: "video_note.mp4",
        fileSize: videoNote.file_size,
        mimeType: "video/mp4",
        isImage: false,
      };
    }
    return null;
  }

  private async downloadAttachment(attachment: ExtractedAttachment): Promise<string> {
    const maxBytes = this.config.maxImageBytes;
    if (attachment.fileSize && attachment.fileSize > maxBytes) {
      throw new Error(`文件大小（${formatFileSize(attachment.fileSize)}）超过 Telegram Bot 限制（最大 20 MB）。`);
    }

    const file = await this.telegram.getFile(attachment.fileId);
    if (!file.file_path) {
      throw new Error("Telegram 没有返回文件下载路径。");
    }
    if (file.file_size && file.file_size > maxBytes) {
      throw new Error(`文件大小超过限制（最大 ${(maxBytes / (1024 * 1024)).toFixed(0)} MB）。`);
    }

    const buffer = await this.telegram.downloadFile(file.file_path, maxBytes);

    let safeName = path.basename(attachment.fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    if (!safeName) safeName = "attachment";
    let ext = path.extname(safeName);
    if (!ext && file.file_path) {
      ext = path.extname(file.file_path);
      if (ext) safeName += ext;
    }

    const uploadDir = path.join(this.attachmentsDir, randomUUID());
    await mkdir(uploadDir, { recursive: true });
    const target = path.join(uploadDir, safeName);
    await writeFile(target, buffer, { mode: 0o600 });
    return target;
  }

  private addAction(action: BotAction): string {
    const now = Date.now();
    for (const [key, value] of this.actions) {
      if (value.expiresAt < now) this.actions.delete(key);
    }
    const token = randomBytes(7).toString("base64url");
    this.actions.set(token, { action, expiresAt: now + ACTION_TTL_MS });
    return `a:${token}`;
  }

  private approvalResult(method: string, decision: string): unknown {
    if (method === "item/fileChange/requestApproval") {
      return { decision: decision === "accept" ? "accept" : "decline" };
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      return {
        decision:
          decision === "accept"
            ? "approved"
            : { denied: { rejection: "Denied from Telegram." } },
      };
    }
    return { decision: decision === "accept" ? "accept" : "decline" };
  }

  private permissionModeFromSandbox(value: unknown): PermissionMode | null {
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    const type = (value as { type?: unknown }).type;
    if (type === "readOnly") return "readOnly";
    if (type === "workspaceWrite") return "workspaceWrite";
    if (type === "dangerFullAccess") return "fullAccess";
    return null;
  }

  private permissionLabel(mode: PermissionMode): string {
    switch (mode) {
      case "readOnly":
        return "只读";
      case "workspaceWrite":
        return "项目内可编辑";
      case "fullAccess":
        return "完全访问";
    }
  }

  private contextFor(message: TelegramMessage): ConversationContext {
    return {
      chatId: message.chat.id,
      topicId: message.message_thread_id ?? 0,
    };
  }

  private contextFromKey(key: string): ConversationContext {
    const [chatId, topicId] = key.split(":");
    return { chatId: Number(chatId), topicId: Number(topicId) };
  }

  private conversationKey(context: ConversationContext): string {
    return `${context.chatId}:${context.topicId}`;
  }

  private async send(
    context: ConversationContext,
    text: string,
    markup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage> {
    return this.telegram.sendMessage(
      context.chatId,
      text,
      context.topicId || undefined,
      markup,
    );
  }

  private async safeSend(
    context: ConversationContext,
    text: string,
  ): Promise<void> {
    try {
      await this.send(context, text);
    } catch (error) {
      console.error(`Could not send Telegram reply: ${this.errorText(error)}`);
    }
  }

  private parseCommand(text: string): { name: string; argument: string } | null {
    const match = text.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    return {
      name: match[1]!.toLowerCase(),
      argument: match[2]?.trim() ?? "",
    };
  }

  private scheduleProgressEdit(turn: ActiveTurn): void {
    if (!turn.statusMessageId || turn.editTimer) return;
    const delay = Math.max(0, 1_200 - (Date.now() - turn.lastEditAt));
    turn.editTimer = setTimeout(() => {
      turn.editTimer = undefined;
      this.editProgress(turn).catch((error) => {
        console.error(`Progress edit failed: ${this.errorText(error)}`);
      });
    }, delay);
  }

  private armTurnWatchdog(turn: ActiveTurn): void {
    if (turn.watchdogTimer) clearTimeout(turn.watchdogTimer);
    turn.watchdogTimer = setTimeout(() => {
      turn.watchdogTimer = undefined;
      this.checkTurnWatchdog(turn).catch((error) => {
        console.error(`Turn watchdog check failed: ${this.errorText(error)}`);
      });
    }, TURN_SILENCE_MS);
  }

  private async checkTurnWatchdog(turn: ActiveTurn): Promise<void> {
    if (!this.activeTurns.has(turn.threadId)) return;
    const silentFor = Date.now() - turn.lastActivityAt;
    if (silentFor < TURN_SILENCE_MS) {
      turn.watchdogTimer = setTimeout(() => {
      turn.watchdogTimer = undefined;
      this.checkTurnWatchdog(turn).catch((error) => {
        console.error(`Turn watchdog check failed: ${this.errorText(error)}`);
      });
      }, TURN_SILENCE_MS - silentFor);
      return;
    }
    if (!turn.statusMessageId) return;
    const preview = turn.output.trim().slice(0, TELEGRAM_TEXT_LIMIT - 120);
    const text = preview
      ? `${preview}\n\n⏱ 已较长时间没有更新。若确认卡住，直接发送下一条消息即可自动恢复。`
      : "⏱ Codex 长时间没有响应。若确认卡住，直接发送下一条消息即可自动恢复。";
    try {
      await this.telegram.editMessageText(
        turn.context.chatId,
        turn.statusMessageId,
        text,
      );
    } catch {
      // Advisory only; the next delta or completion still updates the message.
    }
    if (this.activeTurns.has(turn.threadId)) this.armTurnWatchdog(turn);
  }

  private async editProgress(turn: ActiveTurn): Promise<void> {
    if (!turn.statusMessageId || !this.activeTurns.has(turn.threadId)) return;
    const preview = turn.output.trim().slice(0, TELEGRAM_TEXT_LIMIT - 20);
    const text = preview ? `${preview}\n\n…Codex 仍在处理` : "⏳ Codex 正在处理…";
    try {
      await this.telegram.editMessageText(
        turn.context.chatId,
        turn.statusMessageId,
        text,
      );
      turn.lastEditAt = Date.now();
    } catch {
      // Telegram can reject an unchanged or stale progress message.
    }
  }

  private async replaceProgressMessage(
    turn: ActiveTurn,
    text: string,
  ): Promise<void> {
    if (!turn.statusMessageId) {
      await this.safeSend(turn.context, text);
      return;
    }
    try {
      await this.telegram.editMessageText(
        turn.context.chatId,
        turn.statusMessageId,
        text.slice(0, TELEGRAM_TEXT_LIMIT),
      );
    } catch {
      await this.safeSend(turn.context, text);
    }
  }

  private async finishTurnMessage(turn: ActiveTurn, response: string): Promise<void> {
    const segments = splitMathSegments(response);
    if (segments.some((segment) => segment.kind === "math")) {
      await this.deliverRichMessage(turn, response);
      return;
    }
    await this.deliverPlainText(turn, response);
  }

  private async deliverPlainText(turn: ActiveTurn, response: string): Promise<void> {
    const chunks = this.splitMessage(response);
    if (turn.statusMessageId) {
      const firstChunk = chunks.shift()!;
      let edited = await this.tryEditProgressMessage(turn, firstChunk);
      if (!edited) {
        // The final edit can land right behind a progress edit and get
        // rate-limited; wait a moment and retry before falling back.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        edited = await this.tryEditProgressMessage(turn, firstChunk);
      }
      if (!edited) {
        await this.safeSend(turn.context, firstChunk);
      }
    }
    for (const chunk of chunks) await this.safeSend(turn.context, chunk);
  }

  // Replies that contain LaTeX are rendered into page images (text and
  // formulas together) so Telegram shows actual math instead of raw TeX.
  private async deliverRichMessage(turn: ActiveTurn, response: string): Promise<void> {
    let images: Buffer[] | null = null;
    try {
      images = await renderReplyImages(response, getRuntimeDirectory());
    } catch (error) {
      console.warn(`Could not render reply images: ${this.errorText(error)}`);
    }
    if (!images || images.length === 0) {
      await this.deliverPlainText(turn, response);
      return;
    }
    if (turn.statusMessageId) {
      try {
        await this.telegram.deleteMessage(turn.context.chatId, turn.statusMessageId);
      } catch {
        await this.replaceProgressMessage(turn, "📐 本条回复以图片发送：");
      }
    }
    for (const image of images) await this.sendImageMessage(turn, image);
  }

  private async sendImageMessage(turn: ActiveTurn, png: Buffer): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.telegram.sendPhoto(
          turn.context.chatId,
          turn.context.topicId,
          png,
        );
        // Give Telegram room to breathe between consecutive images.
        await new Promise((resolve) => setTimeout(resolve, 650));
        return;
      } catch (error) {
        const retryAfter = this.errorText(error).match(/retry after (\d+)/i)?.[1];
        if (attempt === 0 && retryAfter) {
          await new Promise((resolve) =>
            setTimeout(resolve, (Number(retryAfter) + 1) * 1_000),
          );
          continue;
        }
        console.error(`Could not send reply image: ${this.errorText(error)}`);
        await this.safeSend(
          turn.context,
          `（回复图片发送失败：${this.errorText(error)}）`,
        );
        return;
      }
    }
  }

  private async tryEditProgressMessage(turn: ActiveTurn, text: string): Promise<boolean> {
    if (!turn.statusMessageId) return false;
    try {
      await this.telegram.editMessageText(
        turn.context.chatId,
        turn.statusMessageId,
        text.slice(0, TELEGRAM_TEXT_LIMIT),
      );
      return true;
    } catch {
      return false;
    }
  }

  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > TELEGRAM_TEXT_LIMIT) {
      let splitAt = remaining.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
      if (splitAt < TELEGRAM_TEXT_LIMIT / 2) splitAt = TELEGRAM_TEXT_LIMIT;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks.length > 0 ? chunks : [" "];
  }

  
  private async handleCwdCommand(
    context: ConversationContext,
    argument: string,
  ): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    if (!argument) {
      // Show current cwd and allowed roots
      await this.showCwdOptions(context, conversation);
      return;
    }

    // User provided a path, try to change to it
    await this.changeCwd(context, argument);
  }

  private async showCwdOptions(
    context: ConversationContext,
    conversation: ConversationRecord,
  ): Promise<void> {
    const allowedRoots = conversation.allowedCwdRoots || 
      this.config.allowedCwdRoots || 
      [this.config.defaultWorkspace];
    
    const buttons: InlineKeyboardButton[][] = allowedRoots.map((root) => [
      {
        text: root === conversation.cwd ? `✓ ${root}` : root,
        callback_data: this.addAction({
          kind: "changeCwd",
          context,
          cwd: root,
        }),
      },
    ]);

    await this.send(
      context,
      `当前工作目录：${conversation.cwd}

选择新的工作目录：`,
      { inline_keyboard: buttons },
    );
  }

  private async changeCwd(
    context: ConversationContext,
    newCwd: string,
  ): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    const allowedRoots = conversation.allowedCwdRoots || 
      this.config.allowedCwdRoots || 
      [this.config.defaultWorkspace];
    
    // Validate the new path
    const isAllowed = allowedRoots.some((root) => 
      newCwd === root || newCwd.startsWith(root + path.sep)
    );
    
    if (!isAllowed) {
      await this.send(
        context,
        `路径 ${newCwd} 不在允许的目录范围内。
允许的根目录：${allowedRoots.join(", ")}`,
      );
      return;
    }

    try {
      const params = {
        threadId: conversation.threadId,
        cwd: newCwd,
      };
      await this.codex.request("thread/settings/update", params);
      conversation.cwd = newCwd;
      saveState(this.state).catch((error: unknown) => {
        console.error(`Failed to save state after cwd change:`, error);
      });
      await this.send(context, `工作目录已切换到：${newCwd}`);
    } catch (error) {
      await this.send(context, `切换目录失败：${this.errorText(error)}`);
    }
  }

  private async renameThread(
    context: ConversationContext,
    newName: string,
  ): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    try {
      await this.codex.request("thread/name/set", {
        threadId: conversation.threadId,
        name: newName,
      });
      await this.send(context, `会话已重命名为：${newName}`);
    } catch (error) {
      await this.send(context, `重命名失败：${this.errorText(error)}`);
    }
  }

  private async archiveThread(context: ConversationContext): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    try {
      await this.codex.request("thread/archive", {
        threadId: conversation.threadId,
      });
      delete this.state.conversations[conversationKey];
      this.loadedThreads.delete(conversation.threadId);
      saveState(this.state).catch((error: unknown) => {
        console.error(`Failed to save state after archiving:`, error);
      });
      await this.send(context, "当前会话已归档。使用 /new 开始新会话。");
    } catch (error) {
      await this.send(context, `归档失败：${this.errorText(error)}`);
    }
  }

  private async forkThread(
    context: ConversationContext,
    topic: string,
  ): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    try {
      const params: Record<string, unknown> = {
        threadId: conversation.threadId,
      };
      if (topic && context.topicId) {
        params.topicId = context.topicId;
      }
      const result = await this.codex.request("thread/fork", params);
      const forkedThread = result as { id?: string };
      if (forkedThread.id) {
        await this.send(
          context,
          topic
            ? `已分叉到新主题，新会话ID：${forkedThread.id}`
            : `会话已分叉，新会话ID：${forkedThread.id}`,
        );
      } else {
        await this.send(context, "会话已分叉。");
      }
    } catch (error) {
      await this.send(context, `分叉失败：${this.errorText(error)}`);
    }
  }

  private async compactThread(context: ConversationContext): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    try {
      await this.codex.request("thread/compact/start", {
        threadId: conversation.threadId,
      });
      await this.send(context, "会话历史压缩已开始...");
    } catch (error) {
      await this.send(context, `压缩失败：${this.errorText(error)}`);
    }
  }

  private async showEffortOptions(context: ConversationContext): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    const efforts = [
      { value: "low", label: "低 (Low)", desc: "快速响应" },
      { value: "medium", label: "中 (Medium)", desc: "平衡速度和质量" },
      { value: "high", label: "高 (High)", desc: "更深入的思考" },
      { value: "ultra", label: "极高 (Ultra)", desc: "最深入的推理" },
    ];

    const buttons: InlineKeyboardButton[][] = efforts.map((effort) => [
      {
        text:
          conversation.reasoningEffort === effort.value
            ? `✓ ${effort.label}`
            : effort.label,
        callback_data: this.addAction({
          kind: "setEffort",
          context,
          effort: effort.value,
        }),
      },
    ]);

    await this.send(
      context,
      `当前推理强度：${conversation.reasoningEffort || "默认"}

选择新的推理强度：`,
      { inline_keyboard: buttons },
    );
  }

  private async setEffort(
    context: ConversationContext,
    effort: string,
  ): Promise<void> {
    const conversationKey = this.conversationKey(context);
    const conversation = this.state.conversations[conversationKey];
    if (!conversation) {
      await this.send(context, "当前没有活跃的会话。");
      return;
    }

    try {
      await this.codex.request("thread/settings/update", {
        threadId: conversation.threadId,
        reasoningEffort: effort,
      });
      conversation.reasoningEffort = effort;
      saveState(this.state).catch((error: unknown) => {
        console.error(`Failed to save state after effort change:`, error);
      });
      await this.send(context, `推理强度已设置为：${effort}`);
    } catch (error) {
      await this.send(context, `设置失败：${this.errorText(error)}`);
    }
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 700);
    return "未知错误";
  }

  private async registerCommands(): Promise<void> {
    try {
      const commands = [
        { command: "new", description: "新建 Codex 会话" },
        { command: "history", description: "浏览最近的会话" },
        { command: "search", description: "搜索会话历史" },
        { command: "open", description: "恢复指定会话" },
        { command: "model", description: "切换模型" },
        { command: "permission", description: "切换权限模式" },
        { command: "status", description: "查看当前会话状态" },
        { command: "stop", description: "中断当前回合" },
        { command: "cwd", description: "切换或查看工作目录" },
        { command: "rename", description: "重命名当前会话" },
        { command: "archive", description: "归档当前会话" },
        { command: "fork", description: "分叉会话到新主题" },
        { command: "compact", description: "压缩会话历史" },
        { command: "effort", description: "设置推理强度" },
      ];
      await this.telegram.call("setMyCommands", { commands });
    } catch (error) {
      console.error("Failed to register Telegram commands:", error);
    }
  }

}

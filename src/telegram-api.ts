import type {
  InlineKeyboardMarkup,
  TelegramApiResult,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly apiBaseUrl: string,
  ) {}

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20_000,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(
        `${this.apiBaseUrl}/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      throw this.networkError(method, error);
    }
    return this.readResult<T>(method, response);
  }

  private networkError(method: string, error: unknown): Error {
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: { code?: unknown } }).cause
        : undefined;
    const detail =
      typeof cause?.code === "string"
        ? cause.code
        : error instanceof Error
          ? error.name
          : "network error";
    return new Error(
      `Telegram ${method} request failed (${detail}); check outbound HTTPS and proxy settings.`,
    );
  }

  private async readResult<T>(method: string, response: Response): Promise<T> {
    let payload: TelegramApiResult<T>;
    try {
      payload = (await response.json()) as TelegramApiResult<T>;
    } catch {
      throw new Error(`Telegram ${method} returned an unreadable response.`);
    }

    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new Error(
        `Telegram ${method} failed: ${payload.description ?? response.statusText}.`,
      );
    }
    return payload.result;
  }

  private async callMultipart<T>(
    method: string,
    form: FormData,
    timeoutMs = 60_000,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw this.networkError(method, error);
    }
    return this.readResult<T>(method, response);
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      (timeoutSeconds + 10) * 1000,
    );
  }

  sendMessage(
    chatId: number,
    text: string,
    threadId?: number,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<TelegramMessage | boolean> {
    return this.call<TelegramMessage | boolean>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  sendPhoto(
    chatId: number,
    threadId: number,
    photo: Buffer,
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (threadId) form.append("message_thread_id", String(threadId));
    form.append(
      "photo",
      new Blob([new Uint8Array(photo)], { type: "image/png" }),
      "formula.png",
    );
    return this.callMultipart<TelegramMessage>("sendPhoto", form);
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }
}

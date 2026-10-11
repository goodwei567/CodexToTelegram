// Enhanced types for new features
export type PermissionMode = "readOnly" | "workspaceWrite" | "fullAccess";

export interface ConversationRecord {
  threadId: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  reasoningEffort?: string;
  allowedCwdRoots?: string[];
}

export interface BridgeState {
  version: 1;
  lastUpdateId: number;
  pairedUserId: number | null;
  conversations: Record<string, ConversationRecord>;
  pendingApprovals?: Record<string, { expiresAt: number; context: ConversationContext }>;
}

export interface ConversationContext {
  chatId: number;
  topicId: number;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
  model?: string | null;
  updatedAt?: number;
  status?: { type?: string } | string;
  [key: string]: unknown;
}

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface ThreadItem {
  id?: string;
  type?: string;
  status?: string;
  command?: string | string[];
  cwd?: string;
  changes?: Array<{ path?: string; kind?: { type?: string }; diff?: string }>;
  [key: string]: unknown;
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env";
import type {
  AttachedDocumentMeta,
  ChatMessageRecord,
  SessionState,
  TravelState,
} from "../types/index";
import type { IChatSessionRepository } from "./interfaces/repositories.interface";

export class ChatSessionRepository implements IChatSessionRepository {
  private supabase: SupabaseClient | null = null;
  private readonly localSessions = new Map<string, SessionState>();
  private readonly localMessages = new Map<string, ChatMessageRecord[]>();

  constructor() {
    if (
      env.supabaseUrl &&
      env.supabaseServiceRoleKey &&
      !env.supabaseUrl.includes("your-project")
    ) {
      this.supabase = createClient(
        env.supabaseUrl,
        env.supabaseServiceRoleKey,
        {
          auth: { persistSession: false },
        }
      );
    }
  }

  public async getOrCreateSession(
    sessionId: string,
    userId: string
  ): Promise<SessionState> {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from("mia_chat_sessions")
          .select("*")
          .eq("session_id", sessionId)
          .maybeSingle();

        if (!error && data) {
          const session: SessionState = {
            sessionId: data.session_id,
            userId: data.user_id,
            messagesUsed: Number(data.messages_used ?? 0),
            maxMessages: env.maxMessagesPerSession,
            filesUploaded: Number(data.files_uploaded ?? 0),
            maxFiles: env.maxFilesPerSession,
            attachedDocuments: (data.attached_documents || []) as AttachedDocumentMeta[],
            travelState: (data.travel_state || {}) as TravelState,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
          };
          this.localSessions.set(sessionId, session);
          return session;
        }

        const now = new Date().toISOString();
        const newSession: SessionState = {
          sessionId,
          userId,
          messagesUsed: 0,
          maxMessages: env.maxMessagesPerSession,
          filesUploaded: 0,
          maxFiles: env.maxFilesPerSession,
          attachedDocuments: [],
          travelState: {},
          createdAt: now,
          updatedAt: now,
        };

        const { error: insertError } = await this.supabase
          .from("mia_chat_sessions")
          .insert({
            session_id: sessionId,
            user_id: userId,
            messages_used: 0,
            files_uploaded: 0,
            attached_documents: [],
            travel_state: {},
          });

        if (!insertError) {
          this.localSessions.set(sessionId, newSession);
          return newSession;
        }
      } catch {
        // Fallback to local session store
      }
    }

    const existing = this.localSessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const created: SessionState = {
      sessionId,
      userId,
      messagesUsed: 0,
      maxMessages: env.maxMessagesPerSession,
      filesUploaded: 0,
      maxFiles: env.maxFilesPerSession,
      attachedDocuments: [],
      travelState: {},
      createdAt: now,
      updatedAt: now,
    };
    this.localSessions.set(sessionId, created);
    return created;
  }

  public async updateSessionState(
    sessionId: string,
    partial: Partial<
      Pick<
        SessionState,
        "messagesUsed" | "filesUploaded" | "attachedDocuments" | "travelState"
      >
    >
  ): Promise<SessionState> {
    const current =
      this.localSessions.get(sessionId) ||
      (await this.getOrCreateSession(sessionId, "anonymous"));

    const updated: SessionState = {
      ...current,
      messagesUsed:
        partial.messagesUsed !== undefined
          ? partial.messagesUsed
          : current.messagesUsed,
      filesUploaded:
        partial.filesUploaded !== undefined
          ? partial.filesUploaded
          : current.filesUploaded,
      attachedDocuments:
        partial.attachedDocuments !== undefined
          ? partial.attachedDocuments
          : current.attachedDocuments,
      travelState:
        partial.travelState !== undefined
          ? partial.travelState
          : current.travelState,
      updatedAt: new Date().toISOString(),
    };

    this.localSessions.set(sessionId, updated);

    if (this.supabase) {
      try {
        await this.supabase
          .from("mia_chat_sessions")
          .update({
            messages_used: updated.messagesUsed,
            files_uploaded: updated.filesUploaded,
            attached_documents: updated.attachedDocuments,
            travel_state: updated.travelState,
            updated_at: updated.updatedAt,
          })
          .eq("session_id", sessionId);
      } catch {
        // Ignore DB error if using local fallback
      }
    }

    return updated;
  }

  public async saveMessage(message: ChatMessageRecord): Promise<void> {
    const list = this.localMessages.get(message.sessionId) || [];
    list.push(message);
    this.localMessages.set(message.sessionId, list);

    if (this.supabase) {
      try {
        await this.supabase.from("mia_chat_messages").insert({
          session_id: message.sessionId,
          role: message.role,
          content: message.content,
          ui_payload: message.uiPayload ?? null,
          metadata: message.metadata ?? null,
          created_at: message.createdAt,
        });
      } catch {
        // Fallback already stored in localMessages
      }
    }
  }

  public async getRecentMessages(
    sessionId: string,
    limit: number = env.slidingWindowMessages
  ): Promise<ChatMessageRecord[]> {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from("mia_chat_messages")
          .select("*")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!error && Array.isArray(data) && data.length > 0) {
          return data
            .reverse()
            .map((row) => ({
              id: row.id,
              sessionId: row.session_id,
              role: row.role,
              content: row.content,
              uiPayload: row.ui_payload ?? undefined,
              metadata: row.metadata ?? undefined,
              createdAt: row.created_at,
            }));
        }
      } catch {
        // Use local fallback
      }
    }

    const list = this.localMessages.get(sessionId) || [];
    return list.slice(-limit);
  }

  public async getAllSessionMessages(
    sessionId: string
  ): Promise<ChatMessageRecord[]> {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from("mia_chat_messages")
          .select("*")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: true });

        if (!error && Array.isArray(data) && data.length > 0) {
          return data.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            uiPayload: row.ui_payload ?? undefined,
            metadata: row.metadata ?? undefined,
            createdAt: row.created_at,
          }));
        }
      } catch {
        // Use local fallback
      }
    }

    return this.localMessages.get(sessionId) || [];
  }
}

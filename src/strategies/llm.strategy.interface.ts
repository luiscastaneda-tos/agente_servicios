import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { LLMProviderType, TokenUsageMeta } from "../types";

export interface LLMModelOptions {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ILLMStrategy {
  readonly providerName: LLMProviderType;
  getChatModelName(): string;
  getChatModel(options?: LLMModelOptions): BaseChatModel;
  getEmbeddings(): Embeddings;
}

export interface LLMExecutionResult<T = string> {
  output: T;
  providerUsed: LLMProviderType;
  modelUsed: string;
  fallbackTriggered: boolean;
  tokenUsage: TokenUsageMeta;
}

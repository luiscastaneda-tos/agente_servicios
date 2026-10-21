import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { env } from "../config/env";
import { LLMProviderType } from "../types";
import { ILLMStrategy, LLMModelOptions } from "./llm.strategy.interface";

class ValidatedOpenAIEmbeddings extends Embeddings {
  private readonly inner: OpenAIEmbeddings;

  constructor(apiKey: string, model: string, dimensions: number) {
    super({});
    this.inner = new OpenAIEmbeddings({
      apiKey,
      model,
      dimensions,
      maxRetries: 1,
    });
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (!env.openaiApiKey || env.openaiApiKey.includes("your-openai")) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }
    return this.inner.embedDocuments(documents);
  }

  async embedQuery(document: string): Promise<number[]> {
    if (!env.openaiApiKey || env.openaiApiKey.includes("your-openai")) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }
    return this.inner.embedQuery(document);
  }
}

export class OpenAIStrategy implements ILLMStrategy {
  public readonly providerName: LLMProviderType = "openai";

  public getChatModelName(): string {
    return env.openaiChatModel;
  }

  public getChatModel(options?: LLMModelOptions): BaseChatModel {
    if (!env.openaiApiKey || env.openaiApiKey.includes("your-openai")) {
      throw new Error("OPENAI_API_KEY is missing or unconfigured.");
    }

    return new ChatOpenAI({
      apiKey: env.openaiApiKey,
      model: env.openaiChatModel,
      temperature: options?.temperature ?? 0.2,
      maxTokens: options?.maxOutputTokens ?? 2048,
      timeout: options?.timeoutMs ?? 25000,
      maxRetries: 1,
    }) as unknown as BaseChatModel;
  }

  public getEmbeddings(): Embeddings {
    return new ValidatedOpenAIEmbeddings(
      env.openaiApiKey,
      env.openaiEmbeddingModel,
      env.embeddingDimensions
    );
  }
}

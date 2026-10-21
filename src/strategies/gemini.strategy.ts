import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Embeddings } from "@langchain/core/embeddings";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { env } from "../config/env";
import { LLMProviderType } from "../types";
import { ILLMStrategy, LLMModelOptions } from "./llm.strategy.interface";

function normalizeVectorDimensions(vector: number[], targetDim: number): number[] {
  if (vector.length === targetDim) {
    return vector;
  }
  if (vector.length > targetDim) {
    return vector.slice(0, targetDim);
  }
  const padded = new Array<number>(targetDim).fill(0);
  for (let i = 0; i < vector.length; i++) {
    padded[i] = vector[i];
  }
  return padded;
}

class FixedDimensionGeminiEmbeddings extends Embeddings {
  private readonly inner: GoogleGenerativeAIEmbeddings;
  private readonly targetDimensions: number;

  constructor(apiKey: string, model: string, targetDimensions: number) {
    super({});
    this.targetDimensions = targetDimensions;
    this.inner = new GoogleGenerativeAIEmbeddings({
      apiKey,
      model,
    });
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (!env.geminiApiKey || env.geminiApiKey.includes("your-gemini")) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    const vectors = await this.inner.embedDocuments(documents);
    return vectors.map((vec) => normalizeVectorDimensions(vec, this.targetDimensions));
  }

  async embedQuery(document: string): Promise<number[]> {
    if (!env.geminiApiKey || env.geminiApiKey.includes("your-gemini")) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    const vector = await this.inner.embedQuery(document);
    return normalizeVectorDimensions(vector, this.targetDimensions);
  }
}

export class GeminiStrategy implements ILLMStrategy {
  public readonly providerName: LLMProviderType = "gemini";

  public getChatModelName(): string {
    return env.geminiChatModel;
  }

  public getChatModel(options?: LLMModelOptions): BaseChatModel {
    if (!env.geminiApiKey || env.geminiApiKey.includes("your-gemini")) {
      throw new Error("GEMINI_API_KEY is missing or unconfigured.");
    }

    return new ChatGoogleGenerativeAI({
      apiKey: env.geminiApiKey,
      model: env.geminiChatModel,
      temperature: options?.temperature ?? 0.2,
      maxOutputTokens: options?.maxOutputTokens ?? 2048,
      maxRetries: 1,
    }) as unknown as BaseChatModel;
  }

  public getEmbeddings(): Embeddings {
    return new FixedDimensionGeminiEmbeddings(
      env.geminiApiKey,
      env.geminiEmbeddingModel,
      env.embeddingDimensions
    );
  }
}

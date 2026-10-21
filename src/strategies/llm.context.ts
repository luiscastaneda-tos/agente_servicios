import { BaseMessage } from "@langchain/core/messages";
import { Embeddings } from "@langchain/core/embeddings";
import { env } from "../config/env";
import { LLMProviderType, TokenUsageMeta } from "../types";
import { createProvidersUnavailableError } from "../utils/errors";
import { GeminiStrategy } from "./gemini.strategy";
import { OpenAIStrategy } from "./openai.strategy";
import { ILLMStrategy, LLMExecutionResult, LLMModelOptions } from "./llm.strategy.interface";

class FallbackEmbeddings extends Embeddings {
  constructor(
    private readonly primaryStrategy: ILLMStrategy,
    private readonly fallbackStrategy: ILLMStrategy
  ) {
    super({});
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    try {
      return await this.primaryStrategy.getEmbeddings().embedDocuments(documents);
    } catch (primaryError) {
      console.warn(
        `[LLMStrategyContext] Primary embeddings (${this.primaryStrategy.providerName}) failed. Falling back to ${this.fallbackStrategy.providerName}:`,
        primaryError instanceof Error ? primaryError.message : primaryError
      );
      try {
        return await this.fallbackStrategy.getEmbeddings().embedDocuments(documents);
      } catch (fallbackError) {
        throw createProvidersUnavailableError({
          operation: "embedDocuments",
          primaryProvider: this.primaryStrategy.providerName,
          fallbackProvider: this.fallbackStrategy.providerName,
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
          fallbackError:
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
    }
  }

  async embedQuery(document: string): Promise<number[]> {
    try {
      return await this.primaryStrategy.getEmbeddings().embedQuery(document);
    } catch (primaryError) {
      console.warn(
        `[LLMStrategyContext] Primary query embedding (${this.primaryStrategy.providerName}) failed. Falling back to ${this.fallbackStrategy.providerName}:`,
        primaryError instanceof Error ? primaryError.message : primaryError
      );
      try {
        return await this.fallbackStrategy.getEmbeddings().embedQuery(document);
      } catch (fallbackError) {
        throw createProvidersUnavailableError({
          operation: "embedQuery",
          primaryProvider: this.primaryStrategy.providerName,
          fallbackProvider: this.fallbackStrategy.providerName,
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
          fallbackError:
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
    }
  }
}

export class LLMStrategyContext {
  private readonly strategies: Record<LLMProviderType, ILLMStrategy>;

  constructor() {
    this.strategies = {
      gemini: new GeminiStrategy(),
      openai: new OpenAIStrategy(),
    };
  }

  public getStrategy(provider?: LLMProviderType): ILLMStrategy {
    const target = provider || env.defaultProvider;
    return this.strategies[target] || this.strategies.gemini;
  }

  private getFallbackProvider(primary: LLMProviderType): LLMProviderType {
    if (env.fallbackProvider && env.fallbackProvider !== primary) {
      return env.fallbackProvider;
    }
    return primary === "gemini" ? "openai" : "gemini";
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            return String((part as { text?: unknown }).text ?? "");
          }
          return "";
        })
        .join("");
    }
    return String(content ?? "");
  }

  private extractTokenUsage(response: unknown, rawText: string): TokenUsageMeta {
    const msg = response as {
      usage_metadata?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
      response_metadata?: {
        tokenUsage?: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        };
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
    };

    if (msg?.usage_metadata) {
      const promptTokens = msg.usage_metadata.input_tokens ?? 0;
      const completionTokens = msg.usage_metadata.output_tokens ?? 0;
      const totalTokens = msg.usage_metadata.total_tokens ?? promptTokens + completionTokens;
      return { promptTokens, completionTokens, totalTokens };
    }

    const tokenUsage = msg?.response_metadata?.tokenUsage;
    if (tokenUsage) {
      const promptTokens = tokenUsage.promptTokens ?? 0;
      const completionTokens = tokenUsage.completionTokens ?? 0;
      const totalTokens = tokenUsage.totalTokens ?? promptTokens + completionTokens;
      return { promptTokens, completionTokens, totalTokens };
    }

    const usage = msg?.response_metadata?.usage;
    if (usage) {
      const promptTokens = usage.prompt_tokens ?? 0;
      const completionTokens = usage.completion_tokens ?? 0;
      const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
      return { promptTokens, completionTokens, totalTokens };
    }

    const estimatedCompletion = Math.ceil(rawText.length / 4);
    return {
      promptTokens: 0,
      completionTokens: estimatedCompletion,
      totalTokens: estimatedCompletion,
    };
  }

  public async invokeWithFallback(
    messages: BaseMessage[],
    options?: LLMModelOptions & { preferredProvider?: LLMProviderType }
  ): Promise<LLMExecutionResult<string>> {
    const primaryProvider = options?.preferredProvider || env.defaultProvider;
    const fallbackProvider = this.getFallbackProvider(primaryProvider);

    const primaryStrategy = this.getStrategy(primaryProvider);
    const fallbackStrategy = this.getStrategy(fallbackProvider);

    try {
      const model = primaryStrategy.getChatModel(options);
      const response = await model.invoke(messages);
      const output = this.extractTextContent(response.content);
      return {
        output,
        providerUsed: primaryStrategy.providerName,
        modelUsed: primaryStrategy.getChatModelName(),
        fallbackTriggered: false,
        tokenUsage: this.extractTokenUsage(response, output),
      };
    } catch (primaryError) {
      console.warn(
        `[LLMStrategyContext] Primary LLM (${primaryStrategy.providerName}) failed. Retrying with fallback (${fallbackStrategy.providerName}):`,
        primaryError instanceof Error ? primaryError.message : primaryError
      );

      try {
        const fallbackModel = fallbackStrategy.getChatModel(options);
        const response = await fallbackModel.invoke(messages);
        const output = this.extractTextContent(response.content);
        return {
          output,
          providerUsed: fallbackStrategy.providerName,
          modelUsed: fallbackStrategy.getChatModelName(),
          fallbackTriggered: true,
          tokenUsage: this.extractTokenUsage(response, output),
        };
      } catch (fallbackError) {
        console.error(
          `[LLMStrategyContext] Fallback LLM (${fallbackStrategy.providerName}) also failed:`,
          fallbackError instanceof Error ? fallbackError.message : fallbackError
        );
        throw createProvidersUnavailableError({
          primaryProvider: primaryStrategy.providerName,
          fallbackProvider: fallbackStrategy.providerName,
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
          fallbackError:
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
    }
  }

  public getEmbeddingsWithFallback(preferredProvider?: LLMProviderType): Embeddings {
    const primaryProvider = preferredProvider || env.defaultProvider;
    const fallbackProvider = this.getFallbackProvider(primaryProvider);

    return new FallbackEmbeddings(
      this.getStrategy(primaryProvider),
      this.getStrategy(fallbackProvider)
    );
  }
}

export const llmContext = new LLMStrategyContext();

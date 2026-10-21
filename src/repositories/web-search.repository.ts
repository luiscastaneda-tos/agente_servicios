import axios from "axios";
import * as cheerio from "cheerio";
import type { WebSearchResultItem } from "../types/index";
import type { IWebSearchRepository } from "./interfaces/repositories.interface";

export class WebSearchRepository implements IWebSearchRepository {
  private readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  public async searchWeb(
    query: string,
    maxResults: number = 6
  ): Promise<WebSearchResultItem[]> {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      try {
        const tavilyResults = await this.searchWithTavily(
          query,
          maxResults,
          tavilyKey
        );
        if (tavilyResults.length > 0) {
          return tavilyResults;
        }
      } catch {
        // Fallback to DuckDuckGo HTML scraping
      }
    }

    return this.searchWithDuckDuckGoHtml(query, maxResults);
  }

  private async searchWithTavily(
    query: string,
    maxResults: number,
    apiKey: string
  ): Promise<WebSearchResultItem[]> {
    const response = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
      },
      { timeout: 8000 }
    );

    const results = response.data?.results;
    if (!Array.isArray(results)) return [];

    return results.slice(0, maxResults).map((r: Record<string, unknown>) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
      snippet: String(r.content || ""),
    }));
  }

  private async searchWithDuckDuckGoHtml(
    query: string,
    maxResults: number
  ): Promise<WebSearchResultItem[]> {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
      const response = await axios.get<string>(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        timeout: 8000,
      });

      const $ = cheerio.load(response.data);
      const items: WebSearchResultItem[] = [];

      $(".result").each((_, element) => {
        if (items.length >= maxResults) return;

        const titleEl = $(element).find(".result__a").first();
        const snippetEl = $(element).find(".result__snippet").first();

        const title = titleEl.text().trim();
        const rawHref = titleEl.attr("href") || "";
        const snippet = snippetEl.text().trim();

        const resolvedUrl = this.extractRealUrl(rawHref);
        if (title && resolvedUrl) {
          items.push({
            title,
            url: resolvedUrl,
            snippet: snippet || title,
          });
        }
      });

      return items;
    } catch (error) {
      console.warn(
        `[WebSearchRepository] Error en búsqueda web para "${query}":`,
        error instanceof Error ? error.message : error
      );
      return [];
    }
  }

  private extractRealUrl(rawHref: string): string {
    if (!rawHref) return "";
    try {
      if (rawHref.includes("uddg=")) {
        const match = rawHref.match(/[?&]uddg=([^&]+)/);
        if (match && match[1]) {
          return decodeURIComponent(match[1]);
        }
      }
      if (rawHref.startsWith("//")) {
        return `https:${rawHref}`;
      }
      return rawHref;
    } catch {
      return rawHref;
    }
  }
}

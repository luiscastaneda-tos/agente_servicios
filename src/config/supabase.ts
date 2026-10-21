import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let supabaseInstance: SupabaseClient | null = null;

/**
 * Checks whether Supabase credentials are properly configured and not placeholders.
 */
export function isSupabaseConfigured(): boolean {
  const url = env.supabaseUrl.trim();
  const key = env.supabaseServiceRoleKey.trim();

  if (!url || !key) {
    return false;
  }

  if (
    url.includes("your-project") ||
    url.includes("placeholder") ||
    key.includes("your-service-role-key") ||
    key.includes("placeholder")
  ) {
    return false;
  }

  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Returns a singleton SupabaseClient instance if configured, or throws if unconfigured.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Please set valid SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables."
    );
  }

  if (!supabaseInstance) {
    supabaseInstance = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return supabaseInstance;
}

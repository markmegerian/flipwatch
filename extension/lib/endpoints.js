import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

export const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
export const REST_URL = `${SUPABASE_URL}/rest/v1`;
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export const ANON_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
};

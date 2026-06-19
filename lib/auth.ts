// Placeholder password gate. Hardcoded default for now; override via env later.
// The same check guards /api/generate so the LLM API keys can't be abused by
// anyone hitting the endpoint directly (not just the UI).
export const APP_PASSWORD = process.env.APP_PASSWORD ?? "Sales123@"; // TODO: move fully to env

export const checkPassword = (pw?: string): boolean => pw === APP_PASSWORD;

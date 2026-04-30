const rawBaseUrl = process.env.NEXT_PUBLIC_BV_API_URL?.trim();
const rawUserKey = process.env.NEXT_PUBLIC_BV_USER_KEY?.trim();

export const apiBaseUrl: string | null =
  rawBaseUrl && rawBaseUrl.length > 0 ? rawBaseUrl.replace(/\/+$/, "") : null;

export const userKey: string | null =
  rawUserKey && rawUserKey.length > 0 ? rawUserKey : null;

export const isApiConfigured: boolean = apiBaseUrl !== null;

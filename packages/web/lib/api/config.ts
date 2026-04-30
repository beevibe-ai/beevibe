const raw = process.env.NEXT_PUBLIC_BV_API_URL?.trim();

export const apiBaseUrl: string | null =
  raw && raw.length > 0 ? raw.replace(/\/+$/, "") : null;

export const isApiConfigured: boolean = apiBaseUrl !== null;

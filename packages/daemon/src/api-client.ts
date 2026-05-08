/**
 * Thin HTTP + WS client for the /runtime/* surface. The daemon is the
 * sole consumer; bearer auth is bv_d_ throughout.
 */

import WebSocket from "ws";

export interface ApiClientConfig {
  /** Base URL, e.g. http://localhost:3000. No trailing slash. */
  apiUrl: string;
  daemonToken: string;
}

export class ApiClient {
  constructor(private readonly cfg: ApiClientConfig) {}

  /** GET /runtime/* with Authorization: Bearer <bv_d_token>. */
  async get<T = unknown>(path: string): Promise<T | undefined> {
    const res = await fetch(this.url(path), {
      headers: { authorization: `Bearer ${this.cfg.daemonToken}` },
    });
    if (res.status === 204 || res.status >= 400) return undefined;
    return (await res.json()) as T;
  }

  /** POST /runtime/* with Authorization: Bearer <bv_d_token>. */
  async post<T = unknown>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: T | undefined }> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.daemonToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { status: 204, body: undefined };
    const text = await res.text();
    if (!text) return { status: res.status, body: undefined };
    try {
      return { status: res.status, body: JSON.parse(text) as T };
    } catch {
      return { status: res.status, body: undefined };
    }
  }

  /**
   * POST /runtime/claim?runtime_id=R. Returns the dispatch payload on
   * 200, undefined on 204 (nothing pending) or 4xx (already-claimed
   * race, missing runtime, etc — caller logs and continues).
   */
  async claim<T = unknown>(runtimeId: string): Promise<T | undefined> {
    const res = await fetch(
      `${this.url("/runtime/claim")}?runtime_id=${encodeURIComponent(runtimeId)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.daemonToken}` },
      },
    );
    if (res.status === 204) return undefined;
    if (res.status >= 400) return undefined;
    return (await res.json()) as T;
  }

  /** Open the WSS connection for `runtimeIds`. Caller wires events. */
  openWebSocket(runtimeIds: readonly string[]): WebSocket {
    const wsUrl = this.cfg.apiUrl.replace(/^http/, "ws");
    const url =
      `${wsUrl}/runtime/ws?runtime_ids=${runtimeIds.map(encodeURIComponent).join(",")}`;
    return new WebSocket(url, {
      headers: { authorization: `Bearer ${this.cfg.daemonToken}` },
    });
  }

  private url(path: string): string {
    return `${this.cfg.apiUrl}${path}`;
  }
}

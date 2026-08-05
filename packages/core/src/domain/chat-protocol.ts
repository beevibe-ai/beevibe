/**
 * Wire types for the chat surface — the contract between the api server
 * (`packages/api/src/routes/chat.ts` and `room.ts`, which parse agent
 * output into directives) and the web client that renders them
 * (`packages/web/lib/api/client.ts`, `lib/hooks/use-chat.ts`).
 *
 * Every shape here was declared twice, once per package, because web has
 * no way to import from api. The copies had already started to drift in
 * the ways hand-copied types always do: the api spells the repo card
 * `RepoCard` and web spells it `ChatRepoCard`, api gave `OpenView` a
 * name while web inlined `{ path: string; label?: string }` at four
 * separate call sites, and the `source` union on the repo card is
 * written out twice — so adding a fifth source tier in the parser would
 * leave the renderer's badge/label maps silently missing a case.
 *
 * The message shape had drifted three ways: `HistoryMessage` in the api
 * route, `ChatHistoryMessage` in the web api client, and `ChatMessage`
 * in the web chat hook, all with the same eight fields.
 *
 * Types only, no runtime values: safe anywhere core is importable.
 */

/** A `<suggest_action>` directive — rendered as a clickable chip. */
export interface SuggestedAction {
  /** Short text shown on the chip. */
  label: string;
  /** Optional fuller text sent on click — defaults to label. */
  prompt?: string;
}

/** A resolved `<open_view>` directive — rendered as an "Open this →" CTA. */
export interface OpenView {
  /** Absolute in-app path, validated against the allowed-prefix list. */
  path: string;
  label?: string;
}

/**
 * Where a repo card came from. The renderer keys its badge and label
 * maps off this union, so the parser's accepted values and the UI's
 * cases stay in lockstep.
 */
export type RepoCardSource = "learned" | "trending" | "community" | "github";

/**
 * A `<repo_card>` directive. Agents emit one per find_repo result after
 * grouping; the chat UI renders them as styled rows with stars +
 * language + source-tier badge instead of a markdown bullet list.
 */
export interface RepoCard {
  /** Canonical https://github.com/owner/name. */
  repo_url: string;
  /** Owner/name parsed out of repo_url; convenience for the renderer. */
  owner: string;
  name: string;
  /** Stars (lifetime, from GitHub search) when the agent knew it. */
  stars?: number;
  /** Primary language label when known. */
  language?: string;
  /** Source tier — one of learned / trending / community / github. */
  source?: RepoCardSource;
  /** Short description string for the card body. */
  description?: string;
}

/**
 * The four directive-derived fields that travel together on every chat
 * payload — the parser's output, a turn response, a room message and a
 * history message all carry exactly this set.
 */
export interface ChatDirectives {
  /** Entity ids referenced inline (e.g. task_xxx, agent_yyy). */
  view_refs?: string[];
  open_view?: OpenView;
  suggested_actions?: SuggestedAction[];
  repo_cards?: RepoCard[];
}

/**
 * `system` marks autonomous trigger annotations (e.g. watch_tasks fired —
 * "2 tasks completed: …"). The UI renders them as a compact pill between
 * user/agent bubbles so the user can see *why* the agent is suddenly
 * running. Agents never produce system messages directly — they're
 * derived from the wake session's `<system-wake>`-wrapped intent.
 */
export type ChatMessageRole = "user" | "agent" | "system";

/**
 * One rendered message in a chat transcript. Reconstructed server-side
 * from a conversation chain (`chainToMessages`) and minted client-side
 * for optimistic local turns, which is why `id` is only a stable render
 * key — it is not a persisted entity id.
 */
export interface ChatHistoryMessage extends ChatDirectives {
  /** Stable key for React; not a persisted id. */
  id: string;
  role: ChatMessageRole;
  content: string;
  /** Set on agent messages so the UI can link to the session detail page. */
  session_id?: string;
}

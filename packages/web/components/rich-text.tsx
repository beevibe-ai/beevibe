import { Fragment } from "react";
import type { RichText } from "@beevibe/api/views/types";

/**
 * The wire shape comes from `@beevibe/api`, which owns the contract and
 * serializes these values — re-exported here so the existing
 * `@/components/rich-text` import sites keep resolving. Both packages used
 * to declare it; structural typing hid the duplication, but a `mono`
 * rename on the api side would still have silently split the two.
 */
export type { RichSegment, RichText } from "@beevibe/api/views/types";

export function RichTextRender({ value }: { value: RichText }) {
  if (typeof value === "string") return <>{value}</>;
  return (
    <>
      {value.map((seg, i) => (
        <Fragment key={i}>
          {typeof seg === "string" ? (
            seg
          ) : (
            <span className="font-mono text-xs px-1 py-0.5 rounded bg-secondary text-foreground">
              {seg.mono}
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Convert a single RichText value to a markdown source string.
 * `{mono: "x"}` segments render as `` `x` `` so a downstream markdown
 * renderer (e.g. ChatMarkdown) shows them as inline code. Plain
 * strings pass through verbatim — task descriptions are usually
 * already markdown source, so this preserves the formatting.
 */
export function richTextToMarkdown(value: RichText): string {
  if (typeof value === "string") return value;
  return value
    .map((seg) => (typeof seg === "string" ? seg : `\`${seg.mono}\``))
    .join("");
}

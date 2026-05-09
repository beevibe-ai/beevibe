import { Fragment } from "react";

export type RichSegment = string | { mono: string };
export type RichText = string | RichSegment[];

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

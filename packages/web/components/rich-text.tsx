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

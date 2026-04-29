import { formatRelativeTime } from "@/lib/format";

export function RelativeTime({ date }: { date: Date }) {
  return <span>{formatRelativeTime(date)}</span>;
}

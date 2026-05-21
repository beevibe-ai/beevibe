/**
 * Renders a "Couldn't <verb>: <error message>" line when a mutation
 * failed. Returns null when the mutation isn't in an error state, so
 * callers can drop it inline without a surrounding conditional.
 */
export function MutationError({
  mutation,
  verb,
}: {
  mutation: { isError: boolean; error: Error | null };
  verb: string;
}) {
  if (!mutation.isError) return null;
  return (
    <div className="text-xs text-status-failed text-right mb-2">
      Couldn&apos;t {verb}: {mutation.error?.message}
    </div>
  );
}

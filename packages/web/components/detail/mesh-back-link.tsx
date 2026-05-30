import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function MeshBackLink() {
  return (
    <Link
      href="/mesh"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
    >
      <ArrowLeft className="h-3 w-3" />
      Mesh
    </Link>
  );
}

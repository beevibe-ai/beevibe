import type { Metadata } from "next";
import { WorkProductDetailClient } from "./work-product-detail-client";

export const metadata: Metadata = { title: "Work product" };

export default function WorkProductDetailPage({
  params,
}: {
  params: { id: string };
}) {
  return <WorkProductDetailClient workProductId={params.id} />;
}

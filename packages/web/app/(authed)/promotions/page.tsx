import type { Metadata } from "next";
import { PromotionsClient } from "./promotions-client";

export const metadata: Metadata = { title: "Promotions" };

export default function PromotionsPage() {
  return <PromotionsClient />;
}

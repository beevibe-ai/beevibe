import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Task" };

export default function TaskDetailPage(_props: { params: { id: string } }) {
  notFound();
}

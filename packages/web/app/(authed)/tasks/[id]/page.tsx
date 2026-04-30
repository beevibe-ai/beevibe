import type { Metadata } from "next";
import { TaskDetailClient } from "./task-detail-client";

export const metadata: Metadata = { title: "Task" };

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  return <TaskDetailClient taskId={params.id} />;
}

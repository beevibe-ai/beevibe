import type { Metadata } from "next";
import { TasksClient } from "./tasks-client";

export const metadata: Metadata = { title: "Tasks" };

export default function TasksPage() {
  return <TasksClient />;
}

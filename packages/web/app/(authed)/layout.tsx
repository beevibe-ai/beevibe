import { Sidebar } from "@/components/sidebar";
import { AuthGate } from "@/components/auth-gate";
import { MemoryToastHost } from "@/components/toast/memory-toast-host";

export default function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</main>
      </div>
      {/* Global bottom-right notifications. Listens to SSE memory
          events so users see when an agent learned something instead
          of the cache silently updating. */}
      <MemoryToastHost />
    </AuthGate>
  );
}

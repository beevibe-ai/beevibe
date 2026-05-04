import { Sidebar } from "@/components/sidebar";
import { LivePanel } from "@/components/chat/live-panel";
import { AuthGate } from "@/components/auth-gate";

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
        {/* LivePanel here (not inside chat-client) so the at-a-glance
            team roster + active work is reachable from every route.
            Default-collapsed to a thin rail; user expands when peeking
            at activity. Previously chat-only — that meant going to
            /chat just to see who was busy was the only path. */}
        <LivePanel />
      </div>
    </AuthGate>
  );
}

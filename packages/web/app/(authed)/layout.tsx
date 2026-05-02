import { Sidebar } from "@/components/sidebar";
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
      </div>
    </AuthGate>
  );
}

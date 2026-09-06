"use client";

import { useWallet } from "./lib/wallet/context";
import { ThemeToggle } from "./components/theme-toggle";
import { ClusterSelect } from "./components/cluster-select";
import { WalletButton } from "./components/wallet-button";
import { RoleSection } from "./components/role-section";

export default function Home() {
  const { status } = useWallet();
  const enabled = status === "connected";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="text-sm font-semibold tracking-tight">Piñata</span>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <ClusterSelect />
          <WalletButton />
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-4.5rem)] max-w-6xl items-center justify-center px-6">
        <div className="grid w-full max-w-xl grid-cols-1 gap-12 md:grid-cols-2">
          <RoleSection
            title="Game Master"
            actions={["Init", "Close"]}
            enabled={enabled}
          />
          <RoleSection
            title="Player"
            actions={["Register", "Strike"]}
            enabled={enabled}
          />
        </div>
      </main>
    </div>
  );
}

"use client";

import { useWallet } from "./lib/wallet/context";
import { ThemeToggle } from "./components/theme-toggle";
import { ClusterSelect } from "./components/cluster-select";
import { WalletButton } from "./components/wallet-button";
import { RoleSection } from "./components/role-section";
import { GmInitialize } from "./components/gm-initialize";

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
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium tracking-tight text-muted">
              Game Master
            </h2>
            <GmInitialize enabled={enabled} />
            <div className="flex gap-3">
              <button
                type="button"
                disabled={!enabled}
                className="rounded-lg border border-neutral-400 bg-card px-5 py-2.5 text-sm font-medium shadow-xs transition enabled:hover:border-neutral-600 enabled:hover:bg-cream disabled:pointer-events-none dark:border-neutral-600 dark:enabled:hover:border-neutral-500"
              >
                Close
              </button>
            </div>
          </section>
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

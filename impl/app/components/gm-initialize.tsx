"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useWallet } from "../lib/wallet/context";
import { useSignAndSendPartialTransaction } from "../lib/hooks/use-sign-and-send-partial-transaction";

type InitializeErrorBody = {
  error?: {
    code?: string;
    message?: string;
    field?: string;
  };
};

type InitializeSuccessBody = {
  transaction?: string;
};

export function GmInitialize({ enabled }: { enabled: boolean }) {
  const { wallet } = useWallet();
  const { signAndSend, isSending } = useSignAndSendPartialTransaction();
  const [rewardMint, setRewardMint] = useState("");
  const [rewardAmount, setRewardAmount] = useState("");
  const [strikeFeeSol, setStrikeFeeSol] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [isRequesting, setIsRequesting] = useState(false);

  const busy = isRequesting || isSending;

  async function onInitialize() {
    if (!wallet || busy) return;
    setIsRequesting(true);
    try {
      const response = await fetch("/api/initialize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gm: wallet.account.address,
          sessionId,
          rewardMint,
          rewardAmount,
          strikeFeeSol,
        }),
      });
      const json: unknown = await response.json();
      if (!response.ok) {
        const err = json as InitializeErrorBody;
        toast.error(err.error?.message ?? "Initialize failed");
        return;
      }
      const transaction = (json as InitializeSuccessBody).transaction;
      if (typeof transaction !== "string") {
        toast.error("Initialize did not return a transaction");
        return;
      }
      await signAndSend(transaction);
      toast.success("Initialize submitted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Initialize failed");
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Reward mint
        <input
          type="text"
          value={rewardMint}
          onChange={(event) => setRewardMint(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="rounded-lg border border-neutral-400 bg-card px-3 py-2 text-sm text-foreground dark:border-neutral-600"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Reward amount
        <input
          type="text"
          inputMode="decimal"
          value={rewardAmount}
          onChange={(event) => setRewardAmount(event.target.value)}
          autoComplete="off"
          className="rounded-lg border border-neutral-400 bg-card px-3 py-2 text-sm text-foreground dark:border-neutral-600"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Strike fee (SOL)
        <input
          type="text"
          inputMode="decimal"
          value={strikeFeeSol}
          onChange={(event) => setStrikeFeeSol(event.target.value)}
          autoComplete="off"
          className="rounded-lg border border-neutral-400 bg-card px-3 py-2 text-sm text-foreground dark:border-neutral-600"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Session ID
        <input
          type="text"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          autoComplete="off"
          className="rounded-lg border border-neutral-400 bg-card px-3 py-2 text-sm text-foreground dark:border-neutral-600"
        />
      </label>
      <button
        type="button"
        disabled={!enabled}
        onClick={() => void onInitialize()}
        className="rounded-lg border border-neutral-400 bg-card px-5 py-2.5 text-sm font-medium shadow-xs transition enabled:hover:border-neutral-600 enabled:hover:bg-cream disabled:pointer-events-none dark:border-neutral-600 dark:enabled:hover:border-neutral-500"
      >
        {busy ? "Initializing…" : "Initialize"}
      </button>
    </div>
  );
}

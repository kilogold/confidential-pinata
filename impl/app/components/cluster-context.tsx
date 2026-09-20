"use client";

import {
  createContext,
  useContext,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ClusterMoniker } from "../lib/solana-client";
import { CLUSTERS } from "../lib/solana-client";
import { getExplorerUrl } from "../lib/explorer";

type ClusterContextValue = {
  cluster: ClusterMoniker;
  setCluster: (cluster: ClusterMoniker) => void;
  getExplorerUrl: (path: string) => string;
};

const ClusterContext = createContext<ClusterContextValue | null>(null);

const STORAGE_KEY = "solana-cluster";
const CLUSTER_CHANGE_EVENT = "solana-cluster-change";

function getStoredCluster(): ClusterMoniker {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && CLUSTERS.includes(stored as ClusterMoniker)
    ? (stored as ClusterMoniker)
    : "devnet";
}

function getServerCluster(): ClusterMoniker {
  return "devnet";
}

function subscribeToCluster(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CLUSTER_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CLUSTER_CHANGE_EVENT, onStoreChange);
  };
}

export { CLUSTERS };

export function ClusterProvider({ children }: { children: ReactNode }) {
  // Use the server snapshot during hydration, then restore browser preference.
  const cluster = useSyncExternalStore(
    subscribeToCluster,
    getStoredCluster,
    getServerCluster
  );

  const setCluster = useCallback((c: ClusterMoniker) => {
    localStorage.setItem(STORAGE_KEY, c);
    window.dispatchEvent(new Event(CLUSTER_CHANGE_EVENT));
  }, []);

  const explorerUrl = useCallback(
    (path: string) => getExplorerUrl(path, cluster),
    [cluster]
  );

  return (
    <ClusterContext.Provider
      value={{ cluster, setCluster, getExplorerUrl: explorerUrl }}
    >
      {children}
    </ClusterContext.Provider>
  );
}

export function useCluster() {
  const ctx = useContext(ClusterContext);
  if (!ctx) throw new Error("useCluster must be used within ClusterProvider");
  return ctx;
}

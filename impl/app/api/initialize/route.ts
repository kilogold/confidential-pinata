import { NextResponse } from "next/server";
import { loadArbiterEnv } from "@/app/lib/server/env";
import { createRpc } from "@/app/lib/server/rpc";
import { orchestrateInitialize } from "@/app/lib/server/initialize";
import { InitializeApiError } from "@/app/lib/server/initialize/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  try {
    const env = loadArbiterEnv();
    const rpc = createRpc(env.rpcUrl);
    const result = await orchestrateInitialize(rpc, env, body);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InitializeApiError) {
      return NextResponse.json(err.toJson(), { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Initialize failed";
    return NextResponse.json(
      { error: { code: "TRANSACTION_BUILD_FAILED", message } },
      { status: 500 }
    );
  }
}

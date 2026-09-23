import { NextResponse } from "next/server";
import { loadArbiterEnv } from "@/app/lib/server/env";
import { createRpc } from "@/app/lib/server/rpc";
import { orchestrateAttack } from "@/app/lib/server/attack";
import { AttackApiError } from "@/app/lib/server/attack/errors";
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
    const result = await orchestrateAttack(rpc, env, body);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AttackApiError || err instanceof InitializeApiError) {
      return NextResponse.json(err.toJson(), { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Strike failed";
    return NextResponse.json(
      { error: { code: "TRANSACTION_BUILD_FAILED", message } },
      { status: 500 }
    );
  }
}

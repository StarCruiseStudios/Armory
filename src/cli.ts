#!/usr/bin/env node
import { runArmory } from "./armory.ts";
import { ArmoryFailure } from "./runtime.ts";

runArmory().catch((err: unknown) => {
  if (!(err instanceof ArmoryFailure)) {
    process.stderr.write(`armory: Unexpected error: ${String(err)}\n`);
  }
  process.exit(1);
});

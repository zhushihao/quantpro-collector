// Deploy wrapper: stamp DEPLOYED_GIT_SHA with the checked-out git sha.
//
// npm scripts run under cmd.exe on Windows, so "$(git rev-parse HEAD)" does
// not expand inline. This wrapper resolves the sha once and hands it to
// wrangler. This identifies the Collector build only, never an Automation
// Prompt version (#47). The stamp reflects the COMMIT — working-tree drift is
// not accounted for, same as any batch stamp; deploy from a clean checkout.
import { execFileSync, spawnSync } from "node:child_process";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) {
	console.error(`[deploy] refusing: git rev-parse HEAD returned "${sha}"`);
	process.exit(2);
}
console.log(`[deploy] DEPLOYED_GIT_SHA=${sha}`);
const result = spawnSync("npx", ["wrangler", "deploy", "--var", `DEPLOYED_GIT_SHA:${sha}`], {
	stdio: "inherit",
	shell: process.platform === "win32",
});
process.exit(result.status ?? 1);

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piBinary = execFileSync("/bin/sh", ["-c", "command -v pi"], {
  encoding: "utf8",
}).trim();
const piPackageRoot = dirname(dirname(realpathSync(piBinary)));
const requireFromPi = createRequire(join(piPackageRoot, "package.json"));
const typeboxUrl = pathToFileURL(requireFromPi.resolve("typebox")).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "typebox") {
    return { url: typeboxUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

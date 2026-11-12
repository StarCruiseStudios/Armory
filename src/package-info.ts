import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  name: string;
  version: string;
};

// package.json sits one level above both src/ and dist/.
const manifest = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

/** Directory that holds package.json. For an `npm link` install this is the source checkout. */
export const PACKAGE_ROOT: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PACKAGE_NAME: string = manifest.name;
export const PACKAGE_VERSION: string = manifest.version;

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

let cachedVersion;

function readPackageVersion() {
  try {
    const moduleDir = fileURLToPath(new URL(".", import.meta.url));
    const pkgPath = join(moduleDir, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version;
  } catch (error) {
    return undefined;
  }
}

export function resolveVersion() {
  if (cachedVersion) {
    return cachedVersion;
  }

  const definedVersion = typeof process !== "undefined" ? process.env.VERSION : undefined;
  if (definedVersion) {
    cachedVersion = definedVersion;
    return cachedVersion;
  }

  if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
    cachedVersion = readPackageVersion();
    return cachedVersion;
  }

  return undefined;
}

export function versionOrDefault(defaultValue = "v0.0.0") {
  return resolveVersion() ?? defaultValue;
}

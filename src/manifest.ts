// The manifest is the package's `capabilities` key, read once. It is the one declaration the register, the access rules
// and the conformance kit read, so no source file keeps a second copy of a name, a class or a source.
import { readFileSync } from "node:fs";
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest";

interface PackageFile {
  readonly name: string;
  readonly version: string;
  readonly capabilities: Manifest;
}

/** The installed package.json: its name, version and capabilities. */
export const packageFile: PackageFile = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageFile;

/** The validated shape the register takes. Validated by the contract at setup and by the kit in CI. */
export const manifest: Manifest = packageFile.capabilities;

/** The installed version, for status. */
export const version: string = packageFile.version;

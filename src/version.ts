/** Kept in step with package.json by a test, so the built file never has to find package.json at run time. */
export const VERSION = "0.2.1";

/** What every request says it is: the contract's `memtro-cli/<version> (<platform>; node <version>)`. */
export function userAgent(platform: string = process.platform, node: string = process.versions.node): string {
  return `memtro-cli/${VERSION} (${platform}; node ${node})`;
}

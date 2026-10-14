// Types for scripts/verify-zip.js, for test/zip.test.ts.
export const MAX_ZIP_BYTES: number;
export function readZip(buffer: Buffer): Map<string, Buffer>;
export function zipKind(path: string): "sources" | "firefox" | "chrome" | "edge";
export function checkExtension(
  files: ReadonlyMap<string, Buffer>,
  options: { version: string; browser: string; zipBytes?: number },
): string[];
export function checkSources(files: ReadonlyMap<string, Buffer>, options?: { zipBytes?: number }): string[];
export function diffFiles(expected: ReadonlyMap<string, Buffer>, actual: ReadonlyMap<string, Buffer>): string[];

// tldts's prebuilt minified bundle has the same API as the package entry but ships no types of its own.
// host.ts imports it because Vite's build of the package's ES module source comes out about twice the size.
declare module "tldts/dist/index.esm.min.js" {
  export * from "tldts";
}

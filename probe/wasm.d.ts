// A `.wasm` imported `with { type: "file" }` resolves to its path (embedded in compiled builds).
declare module "*.wasm" {
  const path: string;
  export default path;
}

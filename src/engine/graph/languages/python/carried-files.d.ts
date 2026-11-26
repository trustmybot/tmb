// The files of pyright's package that carried.ts imports `with { type: "file" }`: each is the
// file's path, in the compiled program or in node_modules.
declare module "pyright/dist/*" {
  const file: string;
  export default file;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.wasm' {
  const initWasm: (options?: any) => Promise<any>;
  export default initWasm;
}

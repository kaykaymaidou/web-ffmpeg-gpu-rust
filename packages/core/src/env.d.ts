declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.wasm' {
  const initWasm: (options?: any) => Promise<any>;
  export default initWasm;
}

declare const process: any;
declare module 'node:fs';
declare module 'node:url';


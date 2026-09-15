import { loadRustCore } from '../wasm/rust-core.js';

export interface FilterNodePlan {
  name: string;
  target: 'webgpu' | 'cpu' | 'passthrough';
}

/**
 * FFmpeg Filtergraph Parser & Execution Planner.
 *
 * Parses complex `-vf` strings and partitions filter operations into WebGPU shaders,
 * CPU SIMD routines, or passthrough metadata transforms.
 */
export class FilterGraphPlanner {
  private wasmGraph: any = null;

  constructor(private filterString: string) {}

  async plan(): Promise<FilterNodePlan[]> {
    const mod = await loadRustCore();
    // @ts-ignore
    this.wasmGraph = new mod.RustWasmFilterGraph(this.filterString);

    const count: number = this.wasmGraph.node_count();
    const nodes: FilterNodePlan[] = [];

    for (let i = 0; i < count; i++) {
      const name: string = this.wasmGraph.get_node_name(i) || '';
      const target: 'webgpu' | 'cpu' | 'passthrough' =
        this.wasmGraph.get_node_target(i) || 'cpu';
      nodes.push({ name, target });
    }

    return nodes;
  }
}

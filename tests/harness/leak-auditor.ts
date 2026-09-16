/**
 * Leak Auditor & Resource Lifecycle Tracker
 * Enforces Zero VRAM Leak invariant.
 */

export interface AuditSnapshot {
  activeHandles: number;
  totalAllocated: number;
  totalClosed: number;
  heapUsedBytes?: number;
}

export class VramLeakAuditor {
  private allocatedCount = 0;
  private closedCount = 0;

  public recordAlloc(): void {
    this.allocatedCount++;
  }

  public recordClose(): void {
    this.closedCount++;
  }

  public get activeHandles(): number {
    return this.allocatedCount - this.closedCount;
  }

  public snapshot(): AuditSnapshot {
    const memory = (performance as any).memory;
    return {
      activeHandles: this.activeHandles,
      totalAllocated: this.allocatedCount,
      totalClosed: this.closedCount,
      heapUsedBytes: memory ? memory.usedJSHeapSize : undefined,
    };
  }

  /**
   * Asserts that all allocated handles have been cleanly closed.
   * Throws if any dangling handle remains.
   */
  public assertZeroLeak(contextName: string = 'Pipeline'): void {
    if (this.activeHandles !== 0) {
      throw new Error(
        `[VRAM Leak Detected in ${contextName}]: ${this.activeHandles} VideoFrame handle(s) remained unclosed! Allocated: ${this.allocatedCount}, Closed: ${this.closedCount}`
      );
    }
  }
}

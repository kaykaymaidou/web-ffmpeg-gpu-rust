import type {
  AgentEvent,
  AgentEventListener,
  AgentThoughtStep,
  AutopilotDirective,
  AutopilotReport,
  StreamAlert,
} from './types';

/**
 * Traceable Session Trajectory Log inspired by DeepSeek Harness (dsh).
 * 
 * Provides:
 * - Append-only sequential tracking of thoughts, tool-calls, observations, and directives.
 * - Reactive event subscription for streaming cockpit terminals and telemetry collectors.
 * - Exportable structured execution traces for auditability and replay.
 */
export class SessionTrajectory {
  private steps: AgentThoughtStep[] = [];
  private directives: AutopilotDirective[] = [];
  private listeners: Set<AgentEventListener> = new Set();
  private startTime: number = Date.now();

  constructor() {
    this.startTime = Date.now();
  }

  public recordThought(iteration: number, thought: string, action?: any): void {
    let currentStep = this.steps.find((s) => s.iteration === iteration);
    if (!currentStep) {
      currentStep = { iteration, thought, action };
      this.steps.push(currentStep);
    } else {
      currentStep.thought = thought;
      if (action) currentStep.action = action;
    }
    this.emit({ type: 'thought', data: currentStep, timestamp: Date.now() });
  }

  public recordAction(iteration: number, tool: string, input: Record<string, any>): void {
    let currentStep = this.steps.find((s) => s.iteration === iteration);
    if (!currentStep) {
      currentStep = { iteration, thought: '' };
      this.steps.push(currentStep);
    }
    currentStep.action = { tool, input };
    this.emit({ type: 'action', data: { iteration, tool, input }, timestamp: Date.now() });
  }

  public recordObservation(iteration: number, observation: string): void {
    let currentStep = this.steps.find((s) => s.iteration === iteration);
    if (!currentStep) {
      currentStep = { iteration, thought: '' };
      this.steps.push(currentStep);
    }
    currentStep.observation = observation;
    this.emit({ type: 'observation', data: { iteration, observation }, timestamp: Date.now() });
  }

  public recordDirective(directive: AutopilotDirective): void {
    this.directives.push(directive);
    this.emit({ type: 'directive', data: directive, timestamp: Date.now() });
  }

  public subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[SessionTrajectory] Listener error:', err);
      }
    }
  }

  public buildReport(alert: StreamAlert, engineMode: any, resolved: boolean): AutopilotReport {
    const report: AutopilotReport = {
      alert,
      resolved,
      engineMode,
      steps: [...this.steps],
      directives: [...this.directives],
      durationMs: Date.now() - this.startTime,
    };
    this.emit({ type: 'report_finish', data: report, timestamp: Date.now() });
    return report;
  }

  public getSteps(): AgentThoughtStep[] {
    return [...this.steps];
  }

  public getDirectives(): AutopilotDirective[] {
    return [...this.directives];
  }

  public clear(): void {
    this.steps = [];
    this.directives = [];
    this.startTime = Date.now();
  }
}

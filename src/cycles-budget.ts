import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Per-session ICP cycles spending cap.
 *
 * Tracks estimated cycles consumed by ICP update calls. Each update call
 * costs at minimum BASE_CYCLES_PER_UPDATE (590_000) cycles for message
 * ingress. When a budget is configured, charge() must be called before
 * each update call — it throws McpError if the budget would be exceeded.
 *
 * State flow:
 *
 *   new CyclesBudget(budget?)
 *           │
 *        spent=0
 *           │
 *      charge(estimate)
 *           │
 *      spent += estimate
 *           │
 *   budget undefined? ──yes──▶ (no-op, never throws)
 *           │ no
 *   spent > budget? ────yes──▶ throw McpError("Cycles budget exceeded")
 *           │ no
 *        (ok — ICP call proceeds)
 *
 * Note: CYCLES_BUDGET_E8S env var name uses "_E8S" as a denomination suffix;
 * the value is in raw ICP cycles, not ICP token e8s. The naming is a legacy
 * holdover from initial development.
 */
export const BASE_CYCLES_PER_UPDATE = 590_000;

export class CyclesBudget {
  private spent = 0;

  constructor(private readonly budgetCycles?: number) {}

  /**
   * Pre-charge an estimated cycles cost before an ICP update call.
   * Throws McpError if the budget is set and would be exceeded.
   * No-op if no budget is configured.
   */
  charge(estimatedCycles = BASE_CYCLES_PER_UPDATE): void {
    if (this.budgetCycles === undefined) return;
    this.spent += estimatedCycles;
    if (this.spent > this.budgetCycles) {
      throw new McpError(
        ErrorCode.InternalError,
        `Cycles budget exceeded: ${this.spent.toLocaleString()} of ${this.budgetCycles.toLocaleString()} cycles used this session. ` +
          `Increase CYCLES_BUDGET_E8S or restart the server to reset.`,
      );
    }
  }

  /** Returns remaining cycles if a budget is set, undefined otherwise. */
  get remaining(): number | undefined {
    if (this.budgetCycles === undefined) return undefined;
    return Math.max(0, this.budgetCycles - this.spent);
  }
}

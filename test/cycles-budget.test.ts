import { describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CyclesBudget, BASE_CYCLES_PER_UPDATE } from '../src/cycles-budget.js';

describe('CyclesBudget', () => {
  it('does nothing when no budget is configured', () => {
    const budget = new CyclesBudget();
    expect(() => budget.charge()).not.toThrow();
    expect(() => budget.charge()).not.toThrow();
    expect(budget.remaining).toBeUndefined();
  });

  it('returns remaining cycles after a charge', () => {
    const budget = new CyclesBudget(1_000_000);
    budget.charge(590_000);
    expect(budget.remaining).toBe(410_000);
  });

  it('allows charge at the exact budget boundary', () => {
    const budget = new CyclesBudget(590_000);
    expect(() => budget.charge(590_000)).not.toThrow();
    expect(budget.remaining).toBe(0);
  });

  it('throws McpError when a single charge exceeds the budget', () => {
    const budget = new CyclesBudget(500_000);
    expect(() => budget.charge(590_000)).toThrow(McpError);
  });

  it('throws McpError on second charge when cumulative exceeds budget', () => {
    const budget = new CyclesBudget(1_000_000);
    budget.charge(590_000); // ok — 590k of 1M spent
    expect(() => budget.charge(590_000)).toThrow(McpError); // 1_180_000 > 1_000_000
  });

  it('error message includes spent and budget amounts', () => {
    const budget = new CyclesBudget(500_000);
    expect(() => budget.charge()).toThrowError(/500,000/);
  });

  it('uses BASE_CYCLES_PER_UPDATE as default charge estimate', () => {
    const budget = new CyclesBudget(BASE_CYCLES_PER_UPDATE - 1);
    expect(() => budget.charge()).toThrow(McpError);
  });
});

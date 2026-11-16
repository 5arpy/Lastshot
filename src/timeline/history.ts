/**
 * Timeline engine: undo/redo. Keeps whole states (they are immutable and
 * share structure, so this is cheap). A drag pushes once at its start and
 * changes the live state until it ends: one Undo step per drag. Each step
 * can carry a label for an "Undo split" tooltip or a history list.
 */
export interface Step<T> {
  state: T;
  label: string;
}

export class History<T> {
  past: Step<T>[] = [];
  future: Step<T>[] = [];
  constructor(public limit = 200) {}

  /** Records `prev` (the state before a change). */
  push(prev: T, label = "Edit"): void {
    this.past.push({ state: prev, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): T | undefined {
    const s = this.past.pop();
    if (!s) return undefined;
    this.future.push({ state: current, label: s.label });
    return s.state;
  }

  redo(current: T): T | undefined {
    const s = this.future.pop();
    if (!s) return undefined;
    this.past.push({ state: current, label: s.label });
    return s.state;
  }

  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}

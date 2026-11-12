export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock the seeder and the tests can move by hand. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Time source. Deadlines use `monotonicMs`; timestamps shown or stored use `now` (AD-18). */
export interface Clock {
  /** Monotonic milliseconds since an arbitrary origin; never jumps with the wall clock. */
  monotonicMs(): number;
  /** Current wall-clock time. */
  now(): Date;
}

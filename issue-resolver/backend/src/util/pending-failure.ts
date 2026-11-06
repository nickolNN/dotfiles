export class PendingFailure {
  private pendingError: Error | null = null;

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  protected throwIfPending(): void {
    const err = this.pendingError;
    if (!err) return;
    this.pendingError = null;
    throw err;
  }
}
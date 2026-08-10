export async function settleWithin(
  operation: Promise<void>,
  timeoutMillis: number,
  timeoutMessage: string,
): Promise<void> {
  await new Promise<void>((resolve: () => void, reject: (error: unknown) => void): void => {
    let settled: boolean = false;
    const timeout: ReturnType<typeof setTimeout> = setTimeout((): void => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMillis);
    void operation.then(
      (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

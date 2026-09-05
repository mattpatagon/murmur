export type ClipboardWriter = (text: string) => Promise<void>;
export type CopyReporter = (message: string) => void;

export class ClipboardCopy {
  private generation: number = 0;
  private readonly write: ClipboardWriter;

  constructor(write: ClipboardWriter) {
    this.write = write;
  }

  clear(): void {
    this.generation += 1;
  }

  async copy(command: string, report: CopyReporter): Promise<void> {
    this.generation += 1;
    const generation: number = this.generation;
    let message: string;
    try {
      await this.write(command);
      message = "Copied. Paste it into your terminal or MCP configuration.";
    } catch (_error: unknown) {
      message = "Select and copy the command below.";
    }
    if (generation === this.generation) report(message);
  }
}

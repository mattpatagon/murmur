import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../materialization-budget.js";
import { responseWithFinish } from "./response-lifecycle.js";

export const HTTP_MATERIALIZATION_BYTES: number = 32 * 1024 * 1024;

export class HttpMaterializationBudget {
  private readonly bytes: MaterializationByteBudget;

  public constructor() {
    this.bytes = new MaterializationByteBudget(HTTP_MATERIALIZATION_BYTES);
  }

  public async handle(action: () => Promise<Response>): Promise<Response> {
    const scope: MaterializationScope = new MaterializationScope(this.bytes);
    try {
      const response: Response = await withMaterializationScope(scope, action);
      return responseWithFinish(response, (): void => scope.finishResponse());
    } catch (error: unknown) {
      scope.finishResponse();
      throw error;
    }
  }
}

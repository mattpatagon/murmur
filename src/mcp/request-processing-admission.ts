import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type AnyObjectSchema,
  type SchemaOutput,
  safeParse,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { getMethodLiteral } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  isTaskAugmentedRequestParams,
  type JSONRPCRequest,
  McpError,
  type Notification,
  type Request,
  type Result,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import {
  MaterializationCapacityError,
  startMaterializationHandler,
} from "../materialization-budget.js";
import { startRequestIdHandler } from "../request-id-admission.js";

type ProcessingCapacity = (() => (() => void) | null) | undefined;
type Preflight = (request: JSONRPCRequest) => boolean;
const SCHEMAS: WeakMap<Server, Map<string, AnyObjectSchema>> = new WeakMap<
  Server,
  Map<string, AnyObjectSchema>
>();
const PREFLIGHTS: WeakMap<Transport, Preflight> = new WeakMap<Transport, Preflight>();

export function preflightHttpRequest(transport: Transport, request: JSONRPCRequest): boolean {
  const preflight: Preflight | undefined = PREFLIGHTS.get(transport);
  if (preflight === undefined)
    throw new Error("MCP request-ID admission requires request preflight");
  return preflight(request);
}

export class RequestProcessingServer extends Server {
  private processingCapacity: ProcessingCapacity;

  public configureProcessingAdmission(reserveCapacity: ProcessingCapacity): void {
    this.processingCapacity = reserveCapacity;
  }

  public override async connect(transport: Transport): Promise<void> {
    await super.connect(transport);
    PREFLIGHTS.set(transport, (request: JSONRPCRequest): boolean => this.preflight(request));
  }

  private preflight(request: JSONRPCRequest): boolean {
    const schemas: Map<string, AnyObjectSchema> | undefined = SCHEMAS.get(this);
    if (schemas === undefined) throw new Error("MCP request schemas are unavailable");
    const schema: AnyObjectSchema | undefined = schemas.get(request.method);
    // Unknown methods send a synchronous SDK error without creating an abort controller.
    if (schema === undefined) return true;
    if (!safeParse(schema, request).success) return false;
    if (request.method === "tools/call" && !CallToolRequestSchema.safeParse(request).success)
      return false;
    if (isTaskAugmentedRequestParams(request.params) && request.params.task !== undefined) {
      try {
        super.assertTaskHandlerCapability(request.method);
      } catch (_error: unknown) {
        // Reject before SDK dispatch: cancellation can otherwise suppress this early error send.
        return false;
      }
    }
    return true;
  }

  public override removeRequestHandler(method: string): void {
    super.removeRequestHandler(method);
    const schemas: Map<string, AnyObjectSchema> | undefined = SCHEMAS.get(this);
    if (schemas !== undefined) schemas.delete(method);
  }

  public override setRequestHandler<T extends AnyObjectSchema>(
    schema: T,
    handler: (
      request: SchemaOutput<T>,
      extra: RequestHandlerExtra<ServerRequest | Request, ServerNotification | Notification>,
    ) => Result | Promise<Result>,
  ): void {
    super.setRequestHandler(
      schema,
      async (
        request: SchemaOutput<T>,
        extra: RequestHandlerExtra<ServerRequest | Request, ServerNotification | Notification>,
      ): Promise<Result> => {
        // Super constructors register initialize/ping before subclass fields exist.
        // Read capacity only when a request actually invokes the lazy wrapper.
        const finishRequestId: () => void = startRequestIdHandler(extra.requestId, extra.signal);
        let release: () => void = (): void => {};
        let finishMaterialization: () => void = (): void => {};
        try {
          const reserveCapacity: ProcessingCapacity = this.processingCapacity;
          if (reserveCapacity !== undefined) {
            const reserved: (() => void) | null = reserveCapacity();
            if (reserved === null) {
              throw new McpError(-32003, "MCP processing capacity reached; retry later.", {
                retryable: true,
                retry_after_ms: 1000,
              });
            }
            release = reserved;
            finishMaterialization = startMaterializationHandler();
          }
          return await handler(request, extra);
        } catch (error: unknown) {
          if (error instanceof MaterializationCapacityError) {
            throw new McpError(-32003, error.message, { retryable: true, retry_after_ms: 1000 });
          }
          throw error;
        } finally {
          // Neither HTTP cancellation nor session close terminates an already-issued query.
          finishMaterialization();
          release();
          finishRequestId();
        }
      },
    );
    // A module WeakMap also captures registrations made by the SDK super constructors.
    const schemas: Map<string, AnyObjectSchema> =
      SCHEMAS.get(this) ?? new Map<string, AnyObjectSchema>();
    schemas.set(getMethodLiteral(schema), schema);
    SCHEMAS.set(this, schemas);
  }
}

export function installProcessingAdmission(
  server: Server,
  reserveCapacity: ProcessingCapacity,
): void {
  if (!(server instanceof RequestProcessingServer)) {
    throw new Error("MCP processing admission requires RequestProcessingServer");
  }
  server.configureProcessingAdmission(reserveCapacity);
}

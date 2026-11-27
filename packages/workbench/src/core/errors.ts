export type WorkbenchErrorCode =
  | "exists"
  | "not_found"
  | "move_into_self"
  | "readonly"
  | "conflict"
  | "invalid_path"
  | "unavailable"
  | "cancelled";

export interface WorkbenchErrorDetail {
  readonly code: WorkbenchErrorCode;
  readonly message: string;
  readonly why?: string;
  readonly fix?: string;
  readonly cause?: unknown;
}

export class WorkbenchError extends Error {
  readonly code: WorkbenchErrorCode;
  readonly why?: string;
  readonly fix?: string;

  constructor(detail: WorkbenchErrorDetail) {
    super(detail.message, detail.cause !== undefined ? { cause: detail.cause } : undefined);
    this.name = "WorkbenchError";
    this.code = detail.code;
    this.why = detail.why;
    this.fix = detail.fix;
  }
}

export function createWorkbenchError(detail: WorkbenchErrorDetail): WorkbenchError {
  return new WorkbenchError(detail);
}

export function isWorkbenchError(value: unknown, code?: WorkbenchErrorCode): value is WorkbenchError {
  if (!(value instanceof WorkbenchError)) return false;
  return code === undefined || value.code === code;
}

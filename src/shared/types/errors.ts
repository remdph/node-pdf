export type IpcErrorCode =
  | 'INVALID_PATH'
  | 'FILE_NOT_FOUND'
  | 'INVALID_PDF'
  | 'READ_FAILED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN';

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  cause?: string;
}

export class NodePdfError extends Error {
  readonly code: IpcErrorCode;
  override readonly cause?: unknown;

  constructor(code: IpcErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'NodePdfError';
    this.code = code;
    this.cause = cause;
  }

  toIpc(): IpcError {
    return {
      code: this.code,
      message: this.message,
      cause: this.cause instanceof Error ? this.cause.message : undefined,
    };
  }
}

import { TRPCError } from "@trpc/server";

export const Errors = {
  // Database errors
  notFound: (entity: string, identifier?: string | number) =>
    new TRPCError({
      code: "NOT_FOUND",
      message: identifier ? `${entity} with id '${identifier}' not found` : `${entity} not found`,
    }),

  conflict: (message: string, cause?: unknown) =>
    new TRPCError({
      code: "CONFLICT",
      message,
      cause,
    }),

  staleVersion: (entity: string) =>
    new TRPCError({
      code: "CONFLICT",
      message: `${entity} changed in another session. Refresh and try again.`,
    }),

  duplicate: (field: string, value: string) =>
    new TRPCError({
      code: "CONFLICT",
      message: `${field} '${value}' already exists.`,
    }),

  // Validation errors
  badRequest: (message: string) =>
    new TRPCError({
      code: "BAD_REQUEST",
      message,
    }),

  invalidInput: (field: string, message: string) =>
    new TRPCError({
      code: "BAD_REQUEST",
      message: `${field}: ${message}`,
    }),

  // Authentication/Authorization errors
  unauthorized: (message = "Unauthorized") =>
    new TRPCError({
      code: "UNAUTHORIZED",
      message,
    }),

  forbidden: (message = "Forbidden") =>
    new TRPCError({
      code: "FORBIDDEN",
      message,
    }),

  // Service errors
  serviceUnavailable: (message = "Service temporarily unavailable") =>
    new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message,
    }),

  payloadTooLarge: (message = "Payload too large") =>
    new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message,
    }),

  // Internal errors
  internal: (message: string, cause?: unknown) =>
    new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message,
      cause,
    }),
};

// Helper to assert entity exists
export function assertEntityExists<T>(
  entity: T | undefined | null,
  entityName: string,
  identifier?: string | number
): asserts entity is T {
  if (!entity) {
    throw Errors.notFound(entityName, identifier);
  }
}

// Helper to assert version matches
export function assertVersionMatches(
  currentVersion: number,
  expectedVersion: number,
  entityName: string
): void {
  if (currentVersion !== expectedVersion) {
    throw Errors.staleVersion(entityName);
  }
}

// Helper to assert positive quantity
export function assertPositiveQuantity(
  quantity: number,
  fieldName: string = "quantity"
): void {
  if (quantity < 0) {
    throw Errors.invalidInput(fieldName, "must be non-negative");
  }
}

// Helper to assert non-empty string
export function assertNonEmptyString(
  value: string | undefined | null,
  fieldName: string
): asserts value is string {
  if (!value?.trim()) {
    throw Errors.invalidInput(fieldName, "cannot be empty");
  }
}

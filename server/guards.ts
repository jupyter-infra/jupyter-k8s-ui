// Runtime type guards for untrusted request data.
//
// Request bodies arrive as JSON and are cast to typed interfaces without any
// runtime check, so these guards re-validate the values the CRD actually accepts
// at our boundary — turning a cryptic K8s 422 into a clear 400 (see #39).

import {
  ACCESS_TYPES,
  OWNERSHIP_TYPES,
  DESIRED_STATUSES,
  type AccessType,
  type OwnershipType,
  type DesiredStatus,
  type CreateWorkspaceBody,
  type AdvancedWorkspaceBody,
} from './types';

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function isAccessType(value: unknown): value is AccessType {
  return isOneOf(ACCESS_TYPES, value);
}

export function isOwnershipType(value: unknown): value is OwnershipType {
  return isOneOf(OWNERSHIP_TYPES, value);
}

export function isDesiredStatus(value: unknown): value is DesiredStatus {
  return isOneOf(DESIRED_STATUSES, value);
}

// Reject any CRD enum field whose value the API server wouldn't accept, turning a
// cryptic 422 into a clear 400 at our boundary (see #39). Bodies are cast from
// untrusted JSON, so the declared types are aspirational — the guards re-check at
// runtime. Returns an error message for the first invalid field, or null if valid.
type WorkspaceEnumFields = Pick<CreateWorkspaceBody, 'accessType' | 'ownershipType' | 'desiredStatus'>;

export function validateWorkspaceEnums(body: WorkspaceEnumFields): string | null {
  if (body.accessType !== undefined && !isAccessType(body.accessType)) {
    return `Invalid accessType — must be one of: ${ACCESS_TYPES.join(', ')}`;
  }
  if (body.ownershipType !== undefined && !isOwnershipType(body.ownershipType)) {
    return `Invalid ownershipType — must be one of: ${OWNERSHIP_TYPES.join(', ')}`;
  }
  if (body.desiredStatus !== undefined && !isDesiredStatus(body.desiredStatus)) {
    return `Invalid desiredStatus — must be one of: ${DESIRED_STATUSES.join(', ')}`;
  }
  return null;
}

// K8s name validation — single regex, parameterized by max length.
const K8S_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Default 253: K8s resource name limit. Frontend uses 63 (DNS label / label-value safe).
export function isValidK8sName(name: unknown, maxLength = 253): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= maxLength && K8S_NAME_PATTERN.test(name);
}

// The advanced editor sends { name, templateRef?, spec }; the simple form sends a flat
// field body. Presence of an object `spec` distinguishes the raw-spec shape.
export function isAdvancedCreateOrEditWorkspaceBody(body: unknown): body is AdvancedWorkspaceBody {
  return typeof body === 'object' && body !== null && 'spec' in body && typeof (body as { spec?: unknown }).spec === 'object';
}

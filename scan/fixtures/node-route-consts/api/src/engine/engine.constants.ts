export const CONTROL_PLANE_PREFIX = '/internal';

export const STATUS_CALLBACK_PATH = `${CONTROL_PLANE_PREFIX}/status-callback`;
export const RESOLVE_PATH = `${CONTROL_PLANE_PREFIX}/credentials/resolve` as const;
export const NESTED_PATH = `${STATUS_CALLBACK_PATH}/x`;

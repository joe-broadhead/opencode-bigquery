// The validated reference shapes a call names, and the patterns that keep them out of `message` and `next` (design
// §5.6): a name is shown only when it fits its own pattern.

/** A Google Cloud project id: 6 to 30 characters, or a domain-scoped `example.com:project` one. */
export const PROJECT_ID = /^(?:[a-z][a-z0-9.-]{0,61}[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** A dataset id. */
export const DATASET_ID = /^[A-Za-z0-9_]{1,1024}$/;
/** A table id: flexible names allow almost anything but a control character or a backquote. */
export const TABLE_ID = /^[^\u0000-\u001f`]{1,1024}$/;
/** A job id the plugin or Google issued. */
export const JOB_ID = /^[A-Za-z0-9_-]{1,1024}$/;
/** A BigQuery location. */
export const LOCATION = /^[A-Za-z0-9-]{2,64}$/;
/** A byte size: a whole number of bytes, or a number and a unit (`10GiB`, `512MiB`). */
export const BYTE_SIZE = /^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/;

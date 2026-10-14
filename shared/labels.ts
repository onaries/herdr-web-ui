/**
 * The longest workspace or tab name the bridge sets, in UTF-16 code units (what an input's
 * `maxLength` counts). The server refuses a longer one and the name fields stop there (#927).
 */
export const MAX_LABEL_CHARS = 80;

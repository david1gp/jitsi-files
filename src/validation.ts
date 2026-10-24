/**
 * Upload validation: extension allowlist + executable magic-byte rejection.
 *
 * HTML/script and executables are never allowed. SVG images ARE allowed:
 * meeting users routinely share .svg logos/seals/diagrams, and stored files
 * are served with `Content-Disposition: attachment` (plus `nosniff`), so a
 * downloaded SVG never executes in the service origin. SVGs with embedded
 * `<script>` are still rejected, as is SVG markup hiding behind any other
 * allowed extension. Magic-byte screening catches executables that were
 * renamed to an allowed extension.
 */

const ALLOWED: Record<string, string[]> = {
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  odt: ["application/vnd.oasis.opendocument.text"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet"],
  odp: ["application/vnd.oasis.opendocument.presentation"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
  csv: ["text/csv", "text/plain"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  svg: ["image/svg+xml"],
  mp3: ["audio/mpeg"],
  wav: ["audio/wav", "audio/x-wav"],
  ogg: ["audio/ogg"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  mp4: ["video/mp4"],
  webm: ["video/webm"],
  mov: ["video/quicktime"],
  zip: ["application/zip", "application/x-zip-compressed"],
}

/** Extensions that are always rejected, even if a client sends an innocent MIME type. */
const BLOCKED_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "js",
  "mjs",
  "cjs",
  "exe",
  "dll",
  "msi",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "bash",
  "jar",
  "apk",
  "dmg",
  "com",
  "scr",
  "pif",
  "cpl",
  "wsf",
  "vbs",
  "hta",
  "swf",
  "elf",
  "o",
  "so",
  "dylib",
])

export function fileExtension(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return ""
  return base.slice(dot + 1).toLowerCase()
}

/** Magic signatures of executable content (MZ, ELF, Mach-O, shebang). */
function hasExecutableMagic(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true // MZ (PE/DOS)
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    return true // ELF
  }
  if (bytes.length >= 4 && bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) {
    return true // Mach-O fat binary
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && (bytes[3] === 0xce || bytes[3] === 0xcf)) ||
      (bytes[0] === 0xce && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe))
  ) {
    return true // Mach-O
  }
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true // #! shebang
  return false
}

/** Sniff for HTML/script payloads hiding behind an allowed extension. */
function hasMarkupMagic(bytes: Uint8Array, extension: string): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512)).trimStart().toLowerCase()
  if (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<script") ||
    head.startsWith("<?php")
  ) {
    return true
  }
  // SVG markup is expected in genuine .svg files, but must not smuggle itself
  // in behind any other allowed extension.
  return extension !== "svg" && head.startsWith("<svg")
}

/** Reject SVGs carrying embedded script (defense in depth: downloads are attachment-dispositioned). */
function hasScriptContent(bytes: Uint8Array): boolean {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).toLowerCase().includes("<script")
}

export type ValidationResult = { ok: true; extension: string } | { ok: false; reason: string }

export interface ValidationOptions {
  /**
   * When true, accept every file type: skip the extension allowlist,
   * BLOCKED_EXTENSIONS, executable magic-byte rejection, and
   * markup/script sniffing. Basic safety stays in the HTTP layer
   * regardless (auth, size cap, attachment disposition, nosniff,
   * filename sanitization). Default false.
   */
  allowAllFileTypes?: boolean
}

export function validateUpload(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
  options: ValidationOptions = {},
): ValidationResult {
  const extension = fileExtension(fileName)
  if (options.allowAllFileTypes) return { ok: true, extension }
  if (extension === "") return { ok: false, reason: "missing file extension" }
  if (BLOCKED_EXTENSIONS.has(extension)) return { ok: false, reason: `file type .${extension} is not allowed` }
  const allowedMimes = ALLOWED[extension]
  if (!allowedMimes) return { ok: false, reason: `file type .${extension} is not allowed` }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? ""
  if (normalized !== "" && normalized !== "application/octet-stream" && !allowedMimes.includes(normalized)) {
    return { ok: false, reason: `MIME type ${mimeType} does not match .${extension}` }
  }
  if (hasExecutableMagic(bytes)) return { ok: false, reason: "executable content detected" }
  if (extension === "svg" && hasScriptContent(bytes)) return { ok: false, reason: "script content detected" }
  if (hasMarkupMagic(bytes, extension)) return { ok: false, reason: "markup/script content detected" }
  return { ok: true, extension }
}

export function allowedExtensions(): string[] {
  return Object.keys(ALLOWED).sort()
}

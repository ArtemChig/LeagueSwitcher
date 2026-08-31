/**
 * P1.1 — lockfile parsing for both local APIs.
 *
 * A lockfile is `name:pid:port:password:protocol`, written when a client starts and *usually*
 * removed when it stops. "Usually" is the whole problem: the lockfile observed on this machine
 * during research was two days stale, pointing at a long-dead PID. Connecting to the port it
 * names then either fails or, worse, reaches whatever process has since inherited that port.
 *
 * So a lockfile is never trusted on the strength of existing. The PID is checked for life, and
 * a lockfile whose process is gone is reported as stale rather than returned as usable.
 */
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { registerSecret } from "../log/redact.js";
import { riotPaths } from "./paths.js";

export type LockfileKind = "riot-client" | "lcu";

export interface Lockfile {
  kind: LockfileKind;
  path: string;
  /** Process name as the client wrote it, e.g. "Riot Client" or "LeagueClient". */
  name: string;
  pid: number;
  port: number;
  /** Basic-auth password. Registered with the redactor the moment it is parsed. */
  password: string;
  protocol: "http" | "https";
  mtime: Date;
}

export type LockfileState =
  | { status: "absent"; path: string }
  | { status: "malformed"; path: string; fieldCount: number }
  | { status: "stale"; path: string; pid: number; lockfile: Lockfile }
  | { status: "live"; path: string; lockfile: Lockfile };

/**
 * Is this PID alive? Signal 0 performs the permission/existence check without delivering
 * anything. EPERM means the process exists but belongs to someone we cannot signal, which
 * still counts as alive.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Parse a lockfile's contents. Exported separately from reading so it is unit-testable
 * without a running client.
 *
 * The password may itself contain colons, so the split is bounded: the first three fields and
 * the last field are fixed, and everything between them is the password.
 */
export function parseLockfile(raw: string, kind: LockfileKind, path: string): Lockfile | null {
  const text = raw.trim();
  if (!text) return null;

  const parts = text.split(":");
  if (parts.length < 5) return null;

  const name = parts[0] ?? "";
  const pid = Number(parts[1]);
  const port = Number(parts[2]);
  const protocol = parts[parts.length - 1] ?? "";
  const password = parts.slice(3, parts.length - 1).join(":");

  if (!name || !Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (protocol !== "http" && protocol !== "https") return null;
  if (!password) return null;

  registerSecret(password);

  return {
    kind,
    path,
    name,
    pid,
    port,
    password,
    protocol,
    mtime: existsSync(path) ? statSync(path).mtime : new Date(0),
  };
}

/** Read a lockfile and classify it. Never throws for the ordinary "not running" case. */
export function readLockfileState(kind: LockfileKind): LockfileState {
  const path = kind === "riot-client" ? riotPaths.rcLockfile : riotPaths.lcuLockfile;

  if (!existsSync(path)) return { status: "absent", path };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // A client mid-write can hold the file briefly; treat as absent and let the caller retry.
    return { status: "absent", path };
  }

  const lockfile = parseLockfile(raw, kind, path);
  if (!lockfile) {
    return { status: "malformed", path, fieldCount: raw.trim().split(":").length };
  }
  if (!isPidAlive(lockfile.pid)) {
    return { status: "stale", path, pid: lockfile.pid, lockfile };
  }
  return { status: "live", path, lockfile };
}

/** The lockfile if and only if it is usable. */
export function readLockfile(kind: LockfileKind): Lockfile | null {
  const state = readLockfileState(kind);
  return state.status === "live" ? state.lockfile : null;
}

/** Human-readable, and safe to log — the password is never included. */
export function describeLockfile(state: LockfileState): string {
  switch (state.status) {
    case "absent":
      return "absent (client not running)";
    case "malformed":
      return `malformed (${state.fieldCount} fields, expected 5)`;
    case "stale":
      return `STALE — pid ${state.pid} is dead, ignoring (file dated ${state.lockfile.mtime.toISOString()})`;
    case "live":
      return `live — ${state.lockfile.name} pid=${state.lockfile.pid} port=${state.lockfile.port}`;
  }
}

/**
 * Wait for a usable lockfile. Used after launching the client: the file appears well before
 * the client is ready to answer, so callers still have to poll the API afterwards.
 */
export async function waitForLockfile(
  kind: LockfileKind,
  { timeoutMs = 120_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<Lockfile | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = readLockfile(kind);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Watch for a lockfile appearing, changing or vanishing.
 *
 * Watches the containing DIRECTORY rather than the file: the file does not exist while the
 * client is closed, and a watcher on a missing path never fires. Returns a disposer.
 */
export function watchLockfile(kind: LockfileKind, onChange: (state: LockfileState) => void): () => void {
  const path = kind === "riot-client" ? riotPaths.rcLockfile : riotPaths.lcuLockfile;
  const dir = path.slice(0, path.lastIndexOf("\\"));
  const filename = path.slice(path.lastIndexOf("\\") + 1);

  let watcher: FSWatcher | null = null;
  let lastSerialised = "";
  let timer: NodeJS.Timeout | null = null;

  const emitIfChanged = () => {
    const state = readLockfileState(kind);
    // Compare on identity, not object equality — mtime alone changing is not interesting.
    const key =
      state.status === "live"
        ? `live:${state.lockfile.pid}:${state.lockfile.port}`
        : state.status;
    if (key === lastSerialised) return;
    lastSerialised = key;
    onChange(state);
  };

  try {
    watcher = watch(dir, (_event, changed) => {
      if (changed && changed !== filename) return;
      // Debounce: a client start writes the file more than once in quick succession.
      if (timer) clearTimeout(timer);
      timer = setTimeout(emitIfChanged, 150);
    });
  } catch {
    // The directory may not exist if Riot is not installed; fall back to polling.
    const poll = setInterval(emitIfChanged, 2000);
    return () => clearInterval(poll);
  }

  emitIfChanged();

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

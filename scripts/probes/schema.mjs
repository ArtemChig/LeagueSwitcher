/**
 * Print the request/response schema for a Riot Client local endpoint, straight from the
 * spec the running client served. Hard rule 6 — check, never assume.
 *
 *   node scripts/probes/schema.mjs /rso-auth/v1/authorization/refresh-token
 *   node scripts/probes/schema.mjs /rso-auth/v1/session/credentials put
 *
 * Reads the cached spec written by swagger-dump.mjs; run that first.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS, log } from "./lib/riotlocal.mjs";

const specFile = join(PATHS.probeOut, "openapi-riotclient.json");
if (!existsSync(specFile)) {
  log(`no cached spec at ${specFile} — run: node scripts/probes/swagger-dump.mjs`);
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specFile, "utf8"));

const target = process.argv[2];
const onlyMethod = process.argv[3]?.toLowerCase() ?? null;
if (!target) {
  log("usage: node scripts/probes/schema.mjs <path> [method]");
  process.exit(2);
}

const entry = spec.paths[target];
if (!entry) {
  const near = Object.keys(spec.paths).filter((p) => p.includes(target)).slice(0, 20);
  log(`path not in spec: ${target}`);
  if (near.length) { log("did you mean:"); for (const n of near) log("  " + n); }
  process.exit(1);
}

const deref = (ref) => (ref ? spec.components?.schemas?.[ref.split("/").pop()] : null);

/** Render a schema a couple of levels deep — enough to build a request without guessing. */
function render(schema, indent = "    ", depth = 0) {
  if (!schema) return;
  if (schema.$ref) return render(deref(schema.$ref), indent, depth);
  if (schema.enum) { log(`${indent}enum: ${JSON.stringify(schema.enum)}`); return; }
  if (schema.type === "array") {
    log(`${indent}array of:`);
    render(schema.items, indent + "  ", depth + 1);
    return;
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const resolved = prop.$ref ? deref(prop.$ref) : prop;
    let kind = resolved?.type ?? (prop.$ref ? prop.$ref.split("/").pop() : "?");
    if (kind === "array") {
      const item = resolved.items?.$ref ? resolved.items.$ref.split("/").pop() : resolved.items?.type ?? "?";
      kind = `array<${item}>`;
    }
    const req = (schema.required ?? []).includes(key) ? " (required)" : "";
    log(`${indent}${key}: ${kind}${req}`);
    if (resolved?.enum) log(`${indent}  = ${JSON.stringify(resolved.enum)}`);
    if (depth < 2 && resolved?.properties) render(resolved, indent + "  ", depth + 1);
  }
}

log(`== ${target} ==`);
for (const [method, op] of Object.entries(entry)) {
  if (onlyMethod && method.toLowerCase() !== onlyMethod) continue;
  if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
  log(`\n${method.toUpperCase()}  ${op.summary ?? op.operationId ?? ""}`);

  const body = op.requestBody?.content?.["application/json"]?.schema;
  if (body) { log("  request:"); render(body); } else { log("  request: (none)"); }

  for (const [code, res] of Object.entries(op.responses ?? {})) {
    const sch = res.content?.["application/json"]?.schema;
    log(`  response ${code}:${sch ? "" : " (no body)"}`);
    if (sch) render(sch);
  }
}

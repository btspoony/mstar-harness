import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExecutionError, withExecutionTransaction } from "./execution-store.js";
import { storeDbPath, StoreError, type StoreContext } from "./store-db.js";
import { importDshHostStateRows, type DshHostStateRows } from "./host-state-store.js";
const FLOW = "agent-flow.jsonl";
const IDS = "agent-flow-ids.jsonl";
const CURSORS = "workflow-ledger-cursors.json";
const JOURNAL = "agent-flow-compaction.json";
const HISTORY = "agent-flow-history";
const STATUS = "snapshots/engine-status.json";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type Finding = Record<string, unknown> & { source: string };
type Refusal = { selector: string; facts: string; reason: string; source: string };
export type DshHostStateImportReport = {
  verdict: "imported" | "partially-imported" | "nothing-to-import";
  imported: { workflows: number; identities: number; ledgerRows: number; scanBounds: number; bindings: number; emissions: number };
  merged: { scanBoundsAdvanced: number; bindingFloorsRaised: number };
  findings: Finding[];
  sourceDigest: string;
};
type Evaluation = { rows: DshHostStateRows; findings: Finding[]; refusals: Refusal[]; sourceDigest: string };
function refused(refusals: readonly Refusal[]): never {
  throw new StoreError("store.upgrade-dsh-source-refused", `store upgrade refused: ${refusals.length} legacy DSH host-state fact group(s) could not be imported.\n${refusals.map((r) => `- ${r.selector}: ${r.facts}: ${r.reason}`).join("\n")}\nRecovery (supported path): rerun \`mstar store upgrade\` with \`--ack-skip-dsh <selector>\` for each listed selector. The invocation imports every other decidable fact and drops only the refused facts for acknowledged selectors. Original bytes remain unchanged; ordinary upgrade remains retryable.`);
}
function lossStatement(refusal: Refusal): string {
  if (refusal.selector === "dsh-status") return "Loss: legacy session bindings (workflow picks, execution witnesses, and exclusion floors) and newest emissions were not imported; consumers may require a workflow re-pick or may backfill rows below the old exclusion floor.";
  if (refusal.selector.startsWith("dsh-bounds:")) return "Loss: the named workflow's legacy scan bounds were not imported; affected sessions re-scan native session logs, verified identities replay as no-ops, and duplicate live evidence rows remain possible.";
  return refusal.facts.includes("tail")
    ? `Loss: ${refusal.facts} were not imported; the held-back display rows remain absent. Verified identities and scan bounds are independent facts.`
    : `Loss: ${refusal.facts} were not imported; omitted verified identities will not deduplicate later native replay.`;
}
function readBytes(path: string): Buffer {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`not a regular file: ${path}`);
  return readFileSync(path);
}
function evaluate(context: StoreContext, now: string): Evaluation {
  const root = dirname(storeDbPath(context));
  const allFiles: Array<[string, string]> = [];
  const workflows: DshHostStateRows["workflows"][number][] = [];
  const findings: Finding[] = [];
  const refusals: Refusal[] = [];
  const dirs = join(root, "workflows");
  try {
    const rootInfo = lstatSync(dirs);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) findings.push({ source: "workflows", kind: "ignored" });
    else for (const entry of readdirSync(dirs, { withFileTypes: true })) {
      const dir = join(dirs, entry.name), source = `workflows/${entry.name}`;
      if (entry.isSymbolicLink() || !entry.isDirectory()) { findings.push({ source, kind: "ignored" }); continue; }
      const names = [FLOW, IDS, CURSORS, JOURNAL];
      const present: Record<string, Buffer> = {};
      let identityReadRefused = false;
      let tailReadRefused = false;
      for (const name of names) {
        try { const b = readBytes(join(dir, name)); present[name] = b; allFiles.push([`${source}/${name}`, hash(b)]); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            if (name === IDS) identityReadRefused = true;
            if (name === FLOW) tailReadRefused = true;
            refusals.push({ selector: name === CURSORS ? `dsh-bounds:${entry.name}` : `dsh-ledger:${entry.name}`, facts: name === CURSORS ? "scan bounds" : name, reason: String(e), source });
          }
        }
      }
      const historyIdentities = new Map<string, string>();
      let historyUnreadable = false;
      const historyDir = join(dir, HISTORY);
      try {
        const hs = lstatSync(historyDir);
        if (hs.isSymbolicLink() || !hs.isDirectory()) throw new Error("history path is not a real directory");
        for (const h of readdirSync(historyDir).filter(n => n.startsWith("chunk-") && n.endsWith(".jsonl")).sort()) {
          const b = readBytes(join(historyDir, h)); allFiles.push([`${source}/${HISTORY}/${h}`, hash(b)]);
          for (const line of b.toString("utf8").split("\n")) if (line) {
            try {
              const parsed: unknown = JSON.parse(line);
              const eventId = parsed && typeof parsed === "object" && "eventId" in parsed ? parsed.eventId : undefined;
              if (typeof eventId === "string" && eventId.startsWith("wfe1:")) {
                const digest = hash(line).slice(0, 32);
                const prior = historyIdentities.get(eventId);
                if (prior !== undefined && prior !== digest) throw new Error(`conflicting archived identity ${eventId}`);
                historyIdentities.set(eventId, digest);
              }
            } catch { historyUnreadable = true; }
          }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") historyUnreadable = true;
      }
      const identityRows: Array<{eventId:string;digest:string;acceptedAt:string}> = [];
      let identityRefused = identityReadRefused;
      if (historyUnreadable) {
        identityRefused = true;
        refusals.push({ selector: `dsh-ledger:${entry.name}`, facts: "identity history completeness", reason: "retained history could not be completely validated", source });
      }
      if (present[IDS] === undefined) {
        if (historyIdentities.size > 0) { identityRefused = true; refusals.push({ selector: `dsh-ledger:${entry.name}`, facts: "identities", reason: "identity index absent while retained history holds identified rows", source }); }
      } else {
        const seen = new Map<string,string>();
        for (const [i,line] of present[IDS].toString("utf8").split("\n").entries()) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as {id?:unknown;d?:unknown};
            if (typeof rec.id !== "string" || !rec.id || typeof rec.d !== "string" || !rec.d) throw new Error("malformed identity line");
            const prior=seen.get(rec.id); if (prior !== undefined && prior !== rec.d) throw new Error(`conflicting duplicate identity ${rec.id}`);
            if (prior === undefined) { seen.set(rec.id,rec.d); identityRows.push({eventId:rec.id,digest:rec.d,acceptedAt:now}); }
          } catch (e) { identityRefused = true; refusals.push({ selector:`dsh-ledger:${entry.name}`, facts:`identities (line ${i+1})`, reason:String(e), source }); break; }
        }
        for (const [eventId, digest] of historyIdentities) {
          if (seen.get(eventId) !== digest) {
            identityRefused = true;
            refusals.push({ selector: `dsh-ledger:${entry.name}`, facts: `identity ${eventId}`, reason: "accepted identity index does not cover retained history bytes", source });
          }
        }
      }
      if (identityRefused) identityRows.length = 0;
      const ledgerRows: Array<{eventId:string|null;lineJson:string;lineIndex:number;recordedAt:string}> = [];
      let tailDigest: string|null = null;
      if (tailReadRefused) refusals.push({ selector: `dsh-ledger:${entry.name}`, facts: "tail rows", reason: "display tail could not be safely read", source });
      if (present[JOURNAL] !== undefined && present[FLOW] === undefined && !tailReadRefused) {
        refusals.push({ selector: `dsh-ledger:${entry.name}`, facts: "tail rows", reason: "compaction journal exists without a readable display tail", source });
      }
      if (present[FLOW] !== undefined) {
        tailDigest=hash(present[FLOW]);
        let journalDecision: "clean"|"before"|"landed"|"invalid"="clean";
        if (present[JOURNAL] !== undefined) {
          try {
            const parsed: unknown = JSON.parse(present[JOURNAL].toString("utf8"));
            if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 ||
              !("tailBefore" in parsed) || !parsed.tailBefore || typeof parsed.tailBefore !== "object" ||
              !("tailAfter" in parsed) || !parsed.tailAfter || typeof parsed.tailAfter !== "object" ||
              !("archive" in parsed) || !parsed.archive || typeof parsed.archive !== "object") throw new Error("invalid journal shape");
            const journal = parsed as Record<string, unknown>;
            const before = journal.tailBefore as Record<string, unknown>;
            const after = journal.tailAfter as Record<string, unknown>;
            const archive = journal.archive as Record<string, unknown>;
            const tail = present[FLOW];
            const fingerprint = { bytes: tail.length, sha256: hash(tail) };
            if (before.bytes === fingerprint.bytes && before.sha256 === fingerprint.sha256) journalDecision = "before";
            else if (after.bytes === fingerprint.bytes && after.sha256 === fingerprint.sha256 &&
              typeof archive.chunk === "string" && /^chunk-[0-9]{6}\.jsonl$/.test(archive.chunk) &&
              typeof archive.offset === "number" && Number.isSafeInteger(archive.offset) && archive.offset >= 0 &&
              typeof archive.bytes === "number" && Number.isSafeInteger(archive.bytes) && archive.bytes >= 0 &&
              typeof archive.sha256 === "string" && /^[a-f0-9]{64}$/.test(archive.sha256)) {
              const archived = readBytes(join(historyDir, archive.chunk));
              allFiles.push([`${source}/${HISTORY}/${archive.chunk}`, hash(archived)]);
              const chunk = archived.subarray(archive.offset, archive.offset + archive.bytes);
              if (archived.length === archive.offset + archive.bytes && hash(chunk) === archive.sha256) journalDecision = "landed";
              else journalDecision = "invalid";
            } else journalDecision = "invalid";
          } catch { journalDecision = "invalid"; }
          if (journalDecision === "invalid") refusals.push({ selector: `dsh-ledger:${entry.name}`, facts: "tail rows", reason: "compaction journal is not decidable from the observed tail and archive", source });
          else findings.push({ source, kind: "journal", decision: journalDecision });
        }
        if (!identityRefused && journalDecision!=="invalid") {
          for (const [i,line] of present[FLOW].toString("utf8").split("\n").entries()) if (line.trim()!=="") {
            let eventId:string|null=null; try { const id=(JSON.parse(line) as {eventId?:unknown}).eventId; if(typeof id==="string") eventId=id; } catch {}
            ledgerRows.push({eventId,lineJson:line,lineIndex:i+1,recordedAt:now});
          }
        } else if(identityRefused) refusals.push({selector:`dsh-ledger:${entry.name}`,facts:"tail rows",reason:"blocked by refused identity index",source});
      }
      const scanBounds: Array<{sessionId:string;next:number;stream:string|null}> = [];
      if(present[CURSORS]!==undefined) {
        try {
          const value: unknown = JSON.parse(present[CURSORS].toString("utf8"));
          if (!value || typeof value !== "object" || !("v" in value) || !("cursors" in value) || (value.v !== 1 && value.v !== 2) || !value.cursors || typeof value.cursors !== "object" || Array.isArray(value.cursors)) throw new Error("invalid cursor sidecar");
          for (const [sessionId, raw] of Object.entries(value.cursors)) {
            let next: unknown;
            let stream: unknown = null;
            if (value.v === 1) next = raw;
            else if (raw && typeof raw === "object" && !Array.isArray(raw) && "next" in raw) {
              next = raw.next;
              stream = "stream" in raw ? raw.stream : null;
            }
            if (!sessionId || typeof next !== "number" || !Number.isSafeInteger(next) || next < 1 || (stream !== null && (typeof stream !== "string" || stream.length === 0))) throw new Error(`invalid cursor for ${sessionId}`);
            scanBounds.push({ sessionId, next, stream: typeof stream === "string" ? stream : null });
          }
        } catch (error) {
          refusals.push({ selector: `dsh-bounds:${entry.name}`, facts: "scan bounds", reason: String(error), source });
        }
      }
      if(identityRows.length||ledgerRows.length||scanBounds.length||present[IDS]||present[FLOW]||present[CURSORS]) workflows.push({workflowId:entry.name,identities:identityRefused?[]:identityRows,tailSourceDigest:ledgerRows.length?tailDigest:null,ledgerRows,scanBounds});
      if(identityRows.length) findings.push({source,kind:"identities",count:identityRows.length});
      if(ledgerRows.length) findings.push({source,kind:"ledgerRows",count:ledgerRows.length});
      if(scanBounds.length) findings.push({source,kind:"scanBounds",count:scanBounds.length});
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const bindings: DshHostStateRows["bindings"][number][]=[];
  const emissions: DshHostStateRows["emissions"][number][]=[];
  const statusPath=join(root,STATUS);
  try {
    const b=readBytes(statusPath); allFiles.push([STATUS,hash(b)]);
    try {
      const value: unknown=JSON.parse(b.toString("utf8"));
      if(!value||typeof value!=="object"||!("sv" in value)||value.sv!==1||!("entries" in value)||!value.entries||typeof value.entries!=="object"||Array.isArray(value.entries)) throw new Error("unrecognized engine-status envelope schema");
      const buckets=value.entries as Record<string, unknown>;
      const bindingRows="bindings" in value?value.bindings:{};
      if(!bindingRows||typeof bindingRows!=="object"||Array.isArray(bindingRows)) throw new Error("invalid engine-status bindings map");
      for(const [sessionId,b] of Object.entries(bindingRows)) {
        if(!sessionId||!b||typeof b!=="object"||Array.isArray(b)) throw new Error("invalid engine-status binding");
        const binding=b as Record<string, unknown>;
        if(typeof binding.cwd!=="string"||!binding.cwd||!Number.isSafeInteger(binding.excludedBeforeSeq)||Number(binding.excludedBeforeSeq)<0) throw new Error("invalid engine-status binding");
        const witness=binding.executionBinding;
        if(witness!==undefined&&witness!==null) {
          if(typeof witness!=="object"||Array.isArray(witness)||!("version" in witness)||witness.version!==1||!("session" in witness)||!witness.session||typeof witness.session!=="object"||Array.isArray(witness.session)) throw new Error("invalid engine-status execution binding");
          const session=witness.session as Record<string,unknown>;
          if(!("harnessRoot" in witness)||typeof witness.harnessRoot!=="string"||!witness.harnessRoot||typeof session.storeId!=="string"||!session.storeId||typeof session.workflowId!=="string"||!session.workflowId||typeof session.sessionId!=="string"||!session.sessionId||session.role!=="coordinator"||typeof session.epoch!=="number"||!Number.isSafeInteger(session.epoch)||session.epoch<=0) throw new Error("invalid engine-status execution binding");
        }
        if(binding.selectedWorkflowId!==undefined&&(typeof binding.selectedWorkflowId!=="string"||!binding.selectedWorkflowId)) throw new Error("invalid engine-status selected workflow");
        bindings.push({sessionId,cwd:binding.cwd,selectedWorkflowId:typeof binding.selectedWorkflowId==="string"?binding.selectedWorkflowId:null,executionBindingJson:witness==null?null:JSON.stringify(witness),excludedBeforeSeq:Number(binding.excludedBeforeSeq),updatedAt:now});
      }
      for(const [sessionId,bucket] of Object.entries(buckets)) {
        if(!Array.isArray(bucket)) throw new Error("invalid engine-status emission bucket");
        for(const candidate of bucket) {
          if(!candidate||typeof candidate!=="object"||Array.isArray(candidate)) throw new Error("invalid engine-status emission");
          const entry=candidate as Record<string,unknown>;
          if(entry.rv!==1||typeof entry.cwd!=="string"||!entry.cwd||typeof entry.at!=="string"||!entry.at||typeof entry.turn!=="number"||!Number.isFinite(entry.turn)||!entry.payload||typeof entry.payload!=="object"||Array.isArray(entry.payload)) throw new Error("invalid engine-status emission");
        }
        const newest=bucket.at(-1);
        if(newest===undefined) continue;
        const emission=newest as Record<string,unknown>;
        emissions.push({sessionId,cwd:emission.cwd as string,turn:emission.turn as number,emittedAt:emission.at as string,payloadJson:JSON.stringify(emission.payload)});
      }
    } catch(e) { refusals.push({selector:"dsh-status",facts:"bindings and emissions",reason:String(e),source:STATUS}); }
  } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT") refusals.push({selector:"dsh-status",facts:"bindings and emissions",reason:String(e),source:STATUS}); }
  const sourceDigest=hash(JSON.stringify(allFiles.sort(([a],[b])=>a.localeCompare(b))));
  return {rows:{workflows,bindings,emissions},findings,refusals,sourceDigest};
}

export async function importDshHostStateFiles(input: { context: StoreContext; operator: string; operationId: string; acknowledgedSkips?: readonly string[] }): Promise<DshHostStateImportReport> {
  const evaluated = evaluate(input.context, new Date().toISOString());
  const acknowledgements = input.acknowledgedSkips ?? [];
  const invalid = acknowledgements.filter((selector) => {
    if (selector === "dsh-status") return false;
    const match = /^dsh-(?:ledger|bounds):(.+)$/.exec(selector);
    return !match || match[1] === "." || match[1] === ".." || match[1]!.includes("/");
  });
  if (invalid.length) throw new StoreError("store.upgrade-dsh-ack-unmatched", `Invalid --ack-skip-dsh selector ${invalid.join(", ")}; use dsh-status, dsh-ledger:<workflowId>, or dsh-bounds:<workflowId>.`);
  const runAt = new Date().toISOString();
  return withExecutionTransaction(input.context, (tx) => {
    const requestHash = hash(JSON.stringify({
      operation: "store.upgrade.dsh-host-state",
      root: input.context.harnessDir,
      operator: input.operator,
      sourceDigest: evaluated.sourceDigest,
      acknowledgedSkips: [...acknowledgements].sort(),
    }));
    const prior = tx.db.prepare("select request_hash, result_json from store_operations where operation_id = ?")
      .get(`${input.operationId}#dsh-host-state`) as { request_hash?: unknown; result_json?: unknown } | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ExecutionError("execution.operation-conflict", `operationId ${input.operationId} was already used for a different DSH import request.`);
      return JSON.parse(String(prior.result_json)) as DshHostStateImportReport;
    }
    const outcome = importDshHostStateRows({ db: tx.db, storeId: tx.storeId, epoch: tx.epoch }, evaluated.rows, runAt);
    const allRefusals = [...evaluated.refusals, ...outcome.refused];
    const refusedSelectors = new Set(allRefusals.map((refusal) => refusal.selector));
    const unmatched = acknowledgements.filter((selector) => !refusedSelectors.has(selector));
    if (unmatched.length) throw new StoreError("store.upgrade-dsh-ack-unmatched", `--ack-skip-dsh selector(s) matched no refused facts in this run: ${unmatched.join(", ")}. Refused selectors: ${[...refusedSelectors].join(", ") || "none"}.`);
    const notAcknowledged = allRefusals.filter((refusal) => !acknowledgements.includes(refusal.selector));
    if (notAcknowledged.length) refused(notAcknowledged);
    for (const refusal of allRefusals) {
      evaluated.findings.push({
        source: refusal.source,
        kind: "dropped-by-ack",
        selector: refusal.selector,
        droppedFacts: refusal.facts,
        loss: `${refusal.reason}. ${lossStatement(refusal)}`,
      });
    }
    for (const fact of outcome.reusedOrPresent) evaluated.findings.push({ source: "native-store", kind: "reused-or-shadowed", fact });
    const hasWrites = Object.values(outcome.written).some((count) => count > 0) ||
      outcome.merged.scanBoundsAdvanced > 0 || outcome.merged.bindingFloorsRaised > 0;
    const report: DshHostStateImportReport = {
      verdict: allRefusals.length ? "partially-imported" : hasWrites ? "imported" : "nothing-to-import",
      imported: outcome.written,
      merged: outcome.merged,
      findings: evaluated.findings,
      sourceDigest: evaluated.sourceDigest,
    };
    if (outcome.revisionAdvanced) tx.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    tx.db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)")
      .run(`${input.operationId}#dsh-host-state`, requestHash, JSON.stringify(report), runAt);
    return report;
  });
}

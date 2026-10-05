import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, registerCatalogEntity } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions } from "../src/index.js";
import { failure } from "../src/families/milestone.js";
import type { InvocationContext } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "commands-milestone-"));
afterAll(() => rmSync(root,{recursive:true,force:true}));
function invocation(cwd:string): InvocationContext { return { cwd,controlRoot:null,versions:{engine:null,cli:null,plugin:null,host:null,platform:null},signal:new AbortController().signal,effects:{spawnProcess:async()=>({exitCode:0,stdout:"",stderr:""})} } as InvocationContext; }
test("milestone refusal preserves engine code and verbatim first line", () => {
 const result=failure("milestone.update",Object.assign(new Error("engine milestone refusal detail"),{code:"milestone.engine-refused"}));
 expect(result.status).toBe("refused");
 expect(result.code).toBe("milestone.engine-refused");
 expect(result.message.split("\n",1)[0]).toBe("engine milestone refusal detail");
 expect(result.details).toHaveProperty("helpRoute");
});
test("milestone commands register and use store revision CAS with replay", async () => {
 const commands=getCommandDefinitions().filter(item=>item.id.startsWith("milestone."));
 expect(commands.map(item=>item.id)).toEqual(["milestone.add","milestone.update","milestone.assign","milestone.list","milestone.status"]);
 const cwd=join(root,"fixture"), harness=join(cwd,".mstar"); mkdirSync(harness,{recursive:true});
 const store=await initializeStore({harnessDir:harness}); store.close();
 await registerCatalogEntity({harnessDir:harness},{kind:"project",id:"proj",title:"Project",rootKind:"projects",relativePath:"proj"},{operationId:"project",actor:"test"});
 const call=(id:string,input:unknown)=>executeCommand(id,input,invocation(cwd));
 const base={project:"proj",name:"First",ordinal:0,expectStore:1,operation:"add-1"};
 const added=await call("milestone.add",base); expect(added.status,JSON.stringify(added)).toBe("ok");
 const receipt=added.data as {milestoneId:string;storeRevision:number}; expect(receipt.storeRevision).toBe(2);
 const replay=await call("milestone.add",base); expect(replay.data).toEqual(added.data);
 const stale=await call("milestone.add",{...base,name:"Second",operation:"add-2"}); expect(stale.status).toBe("refused"); expect(stale.code).toBe("milestone.revision-conflict");
 const list=await call("milestone.list",{project:"proj"}); expect(list.status).toBe("ok"); expect((list.data as {data:{milestones:Array<{name:string}>}}).data.milestones.map(row=>row.name)).toEqual(["First"]);
 const bad=await call("milestone.update",{project:"proj",id:receipt.milestoneId,expectStore:2,operation:"bad"}); expect(bad.exitCode).toBe(2);
});

test("milestone family help succeeds without opening a store", () => {
 const cwd=join(root,"help-without-store");
 mkdirSync(cwd,{recursive:true});
 const result=spawnSync(process.execPath,[join(import.meta.dir,"../../cli/src/index.ts"),"milestone","--help"],{cwd,encoding:"utf8"});
 expect(result.status).toBe(0);
 expect(result.stdout).toContain("milestone");
 expect(existsSync(join(cwd,".mstar","store.db"))).toBe(false);
});

test("unknown milestone command and malformed flags do not open a store", () => {
 const cwd=join(root,"invalid-without-store");
 mkdirSync(cwd,{recursive:true});
 const cli=join(import.meta.dir,"../../cli/src/index.ts");
 const unknown=spawnSync(process.execPath,[cli,"milestone","unknown"],{cwd,encoding:"utf8"});
 expect(unknown.status).not.toBe(0);
 const malformed=spawnSync(process.execPath,[cli,"milestone","add","--project"],{cwd,encoding:"utf8"});
 expect(malformed.status).not.toBe(0);
 expect(existsSync(join(cwd,".mstar","store.db"))).toBe(false);
});

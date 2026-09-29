import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, registerCatalogEntity } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "commands-milestone-"));
afterAll(() => rmSync(root,{recursive:true,force:true}));
function invocation(cwd:string): InvocationContext { return { cwd,controlRoot:null,versions:{engine:null,cli:null,plugin:null,host:null,platform:null},signal:new AbortController().signal,effects:{spawnProcess:async()=>({exitCode:0,stdout:"",stderr:""})} } as InvocationContext; }
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
 const helpWithoutStore=await call("milestone.list",{project:"proj",harness:join(root,"missing")}); expect(helpWithoutStore.status).toBe("refused");
 const bad=await call("milestone.update",{project:"proj",id:receipt.milestoneId,expectStore:2,operation:"bad"}); expect(bad.exitCode).toBe(2);
});
